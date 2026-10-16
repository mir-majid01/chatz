package com.chatz.app.data.push

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Receives data-only FCM messages sent by the chatz-push Cloudflare Worker.
 * Data-only is deliberate: Android hands every message to onMessageReceived
 * regardless of app state, so the app — not the OS — decides. A foregrounded
 * ChatZ stays silent (the in-app listener already badges the event); anything
 * else posts into the same channels the client-side notifier uses.
 */
class ChatzPushService : FirebaseMessagingService() {

    companion object {
        private const val TAG = "ChatzPush"
        private const val PREFS = "ChatZPrefs"
        private const val KEY_TOKEN = "fcm:device_token"
        private const val CHANNEL_MESSAGES = "chatz_messages"
        private const val CHANNEL_SOCIAL = "chatz_social"
        private const val CHANNEL_UPDATES = "chatz_updates"

        /** Token captured at last launch/rotation; null before Firebase answers. */
        fun storedToken(context: Context): String? =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_TOKEN, null)

        fun saveToken(context: Context, token: String) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(KEY_TOKEN, token).apply()
        }

        /** Best-effort refresh into prefs so the JS layer can register it quickly. */
        fun refreshToken(context: Context) {
            try {
                FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                    if (task.isSuccessful) saveToken(context, task.result)
                }
            } catch (e: Exception) {
                Log.w(TAG, "token refresh failed: ${e.message}")
            }
        }
    }

    override fun onNewToken(token: String) {
        saveToken(this, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val body = data["body"]?.takeIf { it.isNotBlank() } ?: return
        val title = data["title"]?.takeIf { it.isNotBlank() } ?: "ChatZ"
        val kind = data["kind"] ?: "social"
        val isMessage = kind == "message"

        // Foreground: the Firestore listener is live and badges the event
        // already — a heads-up on top of the open app is noise.
        if (isAppInForeground()) {
            Log.i(TAG, "Skipped (foreground): $kind")
            return
        }

        val manager = NotificationManagerCompat.from(this)
        if (!manager.areNotificationsEnabled()) return

        val channelId = if (isMessage) CHANNEL_MESSAGES else CHANNEL_SOCIAL
        ensureChannel(
            manager,
            channelId,
            if (isMessage) "Messages" else "Social activity",
            if (isMessage) NotificationManager.IMPORTANCE_HIGH else NotificationManager.IMPORTANCE_DEFAULT,
        )

        val notifId = (data["notifId"] ?: body).hashCode()
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        val pending = launch?.let {
            PendingIntent.getActivity(
                this, notifId, it,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
        }

        val notification = NotificationCompat.Builder(this, channelId)
            .setSmallIcon(applicationInfo.icon)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(
                if (isMessage) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT
            )
            .setCategory(if (isMessage) NotificationCompat.CATEGORY_MESSAGE else NotificationCompat.CATEGORY_SOCIAL)
            .setAutoCancel(true)
            // Push payloads carry the DM text straight from Firestore, so the
            // locked-device copy must be sanitized too — otherwise the two
            // notification paths would disagree about what leaks on a lock screen.
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(
                NotificationCompat.Builder(this, channelId)
                    .setSmallIcon(applicationInfo.icon)
                    .setContentTitle("ChatZ")
                    .setContentText("You have a new notification")
                    .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                    .apply { pending?.let { setContentIntent(it) } }
                    .build()
            )
            .apply { pending?.let { setContentIntent(it) } }
            .build()

        try {
            manager.notify(notifId, notification)
        } catch (e: SecurityException) {
            Log.w(TAG, "notify denied: ${e.message}")
        }
    }

    private fun ensureChannel(
        manager: NotificationManagerCompat,
        id: String,
        name: String,
        importance: Int,
    ) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val system = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        system.createNotificationChannel(
            NotificationChannel(id, name, importance).apply {
                setLockscreenVisibility(Notification.VISIBILITY_PRIVATE)
            }
        ) // idempotent
    }

    // Since API 21 this only ever lists the calling app's own process, which is
    // exactly the question being asked.
    private fun isAppInForeground(): Boolean {
        val am = getSystemService(Context.ACTIVITY_SERVICE) as? android.app.ActivityManager
            ?: return false
        val processes = am.runningAppProcesses ?: return false
        return processes.any {
            it.processName == packageName &&
                it.importance <= android.app.ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
        }
    }
}
