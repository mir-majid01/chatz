package com.chatz.app.plugin

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.chatz.app.data.collector.VibeDataCollector
import com.chatz.app.data.permissions.PermissionHelper
import com.chatz.app.data.push.ChatzPushService
import com.chatz.app.data.sync.WorkScheduler
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.google.android.gms.auth.api.signin.GoogleSignInOptions
import com.google.android.gms.common.api.ApiException
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.GoogleAuthProvider
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONArray
import org.json.JSONObject

// requestCodes MUST include GOOGLE_SIGN_IN_RC (9001). Bridge.getPluginWithRequestCode()
// only routes an activity result to a plugin whose annotation declares that code; without
// it the Google account-picker result is dropped and handleOnActivityResult never fires,
// so the signInWithGoogle() promise hangs and the app never redirects.
@CapacitorPlugin(
    name = "VibeStats",
    requestCodes = [VibeStatsPlugin.GOOGLE_SIGN_IN_RC],
    permissions = [
        Permission(alias = "notifs", strings = [Manifest.permission.POST_NOTIFICATIONS])
    ],
)
class VibeStatsPlugin : Plugin() {

    private var googleSignInCall: PluginCall? = null

    // Asking for the token is what makes Firebase mint it, so a device that has
    // never opened the push path still has something to register by the time
    // JS calls getFcmToken().
    override fun load() {
        super.load()
        ChatzPushService.refreshToken(context)
    }

    @PluginMethod
    fun requestPermission(call: PluginCall) {
        val action = call.getString("action") ?: ""
        val permissions = getPermissionsForAction(action)

        if (permissions.isEmpty()) {
            PermissionHelper.openSpecificSettings(context, action)
            call.resolve(JSObject().apply {
                put("granted", false)
                put("needsSettings", true)
            })
            return
        }

        val allGranted = permissions.all {
            ActivityCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
        }

        if (allGranted) {
            call.resolve(JSObject().apply {
                put("granted", true)
                put("needsSettings", false)
            })
            return
        }

        // Runtime-grantable permission (notifications on Android 13+): show the
        // real system dialog first — it is the only path that flips the grant
        // without a settings detour. Settings is the fallback when the user
        // permanently denied, handled in the callback below.
        if (action == "notifs" && getActivity() != null) {
            requestPermissionForAlias("notifs", call, "notifsCallback")
            return
        }

        // Route to the settings screen that matches the requested permission,
        // not the generic app-info page.
        PermissionHelper.openSpecificSettings(context, action)
        call.resolve(JSObject().apply {
            put("granted", false)
            put("needsSettings", true)
        })
    }

    @PermissionCallback
    private fun notifsCallback(call: PluginCall) {
        val granted = ActivityCompat.checkSelfPermission(
            context,
            Manifest.permission.POST_NOTIFICATIONS
        ) == PackageManager.PERMISSION_GRANTED

        if (granted) {
            call.resolve(JSObject().apply {
                put("granted", true)
                put("needsSettings", false)
            })
            return
        }

        // Rationale false right after a denial means "don't ask again" — the
        // dialog can never reappear, so settings is the only way back.
        val activity = getActivity()
        val canAskAgain = activity != null && ActivityCompat.shouldShowRequestPermissionRationale(
            activity,
            Manifest.permission.POST_NOTIFICATIONS
        )
        if (!canAskAgain) {
            PermissionHelper.openSpecificSettings(context, "notifs")
            call.resolve(JSObject().apply {
                put("granted", false)
                put("needsSettings", true)
            })
        } else {
            call.resolve(JSObject().apply {
                put("granted", false)
                put("needsSettings", false)
            })
        }
    }

    private fun getPermissionsForAction(action: String): Array<String> {
        return when (action) {
            "notifs" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                arrayOf(Manifest.permission.POST_NOTIFICATIONS)
            } else emptyArray()
            "location" -> arrayOf(
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
            )
            "camera" -> arrayOf(Manifest.permission.CAMERA)
            "mic" -> arrayOf(Manifest.permission.RECORD_AUDIO)
            "usage" -> emptyArray()
            "data" -> emptyArray()
            else -> emptyArray()
        }
    }

    @PluginMethod
    fun checkPermission(call: PluginCall) {
        val action = call.getString("action") ?: ""

        // Notifications are the one "permission" that can be off even without a
        // runtime permission (Android < 13, or the user switched them off in
        // settings). areNotificationsEnabled() reports the honest state on every
        // version, so a mandatory gate never reads a false "not granted" forever.
        if (action == "notifs") {
            val enabled = NotificationManagerCompat.from(context).areNotificationsEnabled()
            call.resolve(JSObject().apply {
                put("granted", enabled)
                put("needsSettings", !enabled)
            })
            return
        }

        val permissions = getPermissionsForAction(action)

        if (permissions.isEmpty()) {
            call.resolve(JSObject().apply {
                put("granted", false)
                put("needsSettings", true)
            })
            return
        }

        val allGranted = permissions.all {
            ActivityCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
        }

        call.resolve(JSObject().apply {
            put("granted", allGranted)
            put("needsSettings", false)
        })
    }

    @PluginMethod
    fun checkUsageAccess(call: PluginCall) {
        val granted = PermissionHelper.isUsageAccessGranted(context)
        call.resolve(JSObject().apply { put("granted", granted) })
    }

    @PluginMethod
    fun requestUsageAccess(call: PluginCall) {
        PermissionHelper.requestUsageAccessPermission(context)
        call.resolve()
    }

    @PluginMethod
    fun collectStats(call: PluginCall) {
        val collector = VibeDataCollector(context)
        val vibeData = collector.collect()

        val topAppsArray = JSONArray()
        for (app in vibeData.topApps) {
            val appObj = JSONObject().apply {
                put("packageName", app.packageName)
                put("appName", app.appName)
                put("usageMs", app.usageMs)
            }
            topAppsArray.put(appObj)
        }

        val result = JSObject().apply {
            put("uid", vibeData.uid)
            put("screenTimeTodayMs", vibeData.screenTimeTodayMs)
            put("screenTimeFormatted", VibeDataCollector.formatDuration(vibeData.screenTimeTodayMs))
            put("topApps", topAppsArray)
            put("launchCount", vibeData.launchCount)
            put("notificationCount", vibeData.notificationCount)
            put("deviceModel", vibeData.deviceModel)
            put("androidVersion", vibeData.androidVersion)
            put("wifiDataUsedBytes", vibeData.wifiDataUsedBytes)
            put("wifiDataFormatted", VibeDataCollector.formatBytes(vibeData.wifiDataUsedBytes))
            put("mobileDataUsedBytes", vibeData.mobileDataUsedBytes)
            put("mobileDataFormatted", VibeDataCollector.formatBytes(vibeData.mobileDataUsedBytes))
            put("isOnWifi", vibeData.isOnWifi)
            put("isOnMobile", vibeData.isOnMobile)
            put("maskedSsid", vibeData.maskedSsid ?: "")
            put("batteryPercent", vibeData.batteryPercent)
            put("isCharging", vibeData.isCharging)
        }

        call.resolve(result)
    }

    @PluginMethod
    fun startBackgroundSync(call: PluginCall) {
        WorkScheduler.scheduleVibeSyncWork(context)
        call.resolve()
    }

    @PluginMethod
    fun stopBackgroundSync(call: PluginCall) {
        WorkScheduler.cancelVibeSyncWork(context)
        call.resolve()
    }

    @PluginMethod
    fun getManufacturer(call: PluginCall) {
        call.resolve(JSObject().apply { put("manufacturer", PermissionHelper.getManufacturer()) })
    }

    @PluginMethod
    fun requestBatteryOptimization(call: PluginCall) {
        PermissionHelper.showBatteryOptimizationGuide(context)
        call.resolve()
    }

    @PluginMethod
    fun checkBatteryOptimization(call: PluginCall) {
        val granted = PermissionHelper.isIgnoringBatteryOptimizations(context)
        call.resolve(JSObject().apply { put("granted", granted) })
    }

    /**
     * Post a system notification for an in-app social event ("Majid sent you a
     * message: hii"). The WebView listener detects genuinely new notifications
     * while the app is alive; this is the Android half that surfaces them like
     * Instagram/WhatsApp do.
     *
     * Tapping the notification opens the app (singleTask launch intent) — the
     * unread state is then in the in-app feed. POST_NOTIFICATIONS is one of the
     * three core permissions; when it is off this resolves shown:false instead
     * of throwing (notify() never throws for a missing grant).
     */
    @PluginMethod
    fun notify(call: PluginCall) {
        val title = call.getString("title") ?: ""
        val body = call.getString("body") ?: ""
        val key = call.getString("id") ?: "$title:$body"
        val channel = call.getString("channel") ?: "social"
        val isMessage = channel == "message"
        val isUpdate = channel == "update"

        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) {
            call.resolve(JSObject().apply { put("shown", false); put("reason", "permission") })
            return
        }
        if (body.isBlank() && title.isBlank()) {
            call.resolve(JSObject().apply { put("shown", false); put("reason", "empty") })
            return
        }

        val channelId = when {
            isMessage -> CHANNEL_MESSAGES
            isUpdate -> CHANNEL_UPDATES
            else -> CHANNEL_SOCIAL
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channelName = when {
                isMessage -> "Messages"
                isUpdate -> "App updates"
                else -> "Social activity"
            }
            val channelDesc = when {
                isMessage -> "Direct messages from friends"
                isUpdate -> "New ChatZ version notifications"
                else -> "Friend requests, reactions and comments"
            }
            val importance = if (isMessage) {
                NotificationManager.IMPORTANCE_HIGH
            } else if (isUpdate) {
                NotificationManager.IMPORTANCE_DEFAULT
            } else {
                NotificationManager.IMPORTANCE_DEFAULT
            }
            val notificationChannel = NotificationChannel(channelId, channelName, importance).apply {
                description = channelDesc
            }
            manager.createNotificationChannel(notificationChannel)
        }

        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
        val pending = PendingIntent.getActivity(
            context,
            0,
            launch,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val notification = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(context.applicationInfo.icon)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(
                if (isMessage) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT
            )
            .setCategory(if (isMessage) NotificationCompat.CATEGORY_MESSAGE else NotificationCompat.CATEGORY_SOCIAL)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()

        try {
            // Stable per-notification id: the same Firestore doc never stacks
            // twice, distinct docs get their own slot in the shade.
            manager.notify(key.hashCode(), notification)
            call.resolve(JSObject().apply { put("shown", true) })
        } catch (e: SecurityException) {
            call.resolve(JSObject().apply { put("shown", false); put("reason", "permission") })
        }
    }

    @PluginMethod
    fun openAppSettings(call: PluginCall) {
        PermissionHelper.openAppSettings(context)
        call.resolve()
    }

    /**
     * Mirror a WebView session into the native Firebase instance, which is the one the
     * background sync worker authenticates with.
     *
     * The native SDK only accepts a *Google-issued* ID token, and a session restored
     * from disk cannot mint one — so the only repair that needs no UI is a silent
     * Google sign-in for the account the app is already signed in as.
     *
     * Best effort by design: it resolves with an empty uid when it could not adopt,
     * and never rejects for a plain miss. If the native instance holds a *different*
     * account it is signed out rather than left to upload under the wrong uid.
     */
    @PluginMethod
    fun adoptExistingSession(call: PluginCall) {
        val expectedUid = call.getString("uid") ?: return call.reject("uid is required")
        val expectedEmail = call.getString("email") ?: return call.reject("email is required")
        val auth = FirebaseAuth.getInstance()

        if (auth.currentUser?.uid == expectedUid) {
            call.resolve(JSObject().apply { put("uid", expectedUid) })
            return
        }

        val gso = GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
            .requestIdToken(WEB_CLIENT_ID)
            .requestEmail()
            .build()

        GoogleSignIn.getClient(context, gso).silentSignIn()
            .addOnCompleteListener { task ->
                // Task.getResult() throws when the task failed, so isSuccessful has to
                // be checked before the result is read.
                val account = if (task.isSuccessful) task.result else null
                val idToken = account?.idToken

                if (account == null || idToken == null
                    || !expectedEmail.equals(account.email, ignoreCase = true)
                ) {
                    // Nothing to resume, or Google resumed a different account than the
                    // one the app is signed in as. Drop any stale native session so the
                    // worker cannot keep uploading as the wrong user.
                    auth.signOut()
                    call.resolve(JSObject().apply { put("uid", "") })
                    return@addOnCompleteListener
                }

                auth.signInWithCredential(GoogleAuthProvider.getCredential(idToken, null))
                    .addOnCompleteListener { signIn ->
                        val uid = if (signIn.isSuccessful) signIn.result?.user?.uid else null
                        if (uid == null) {
                            android.util.Log.w(
                                "VibeStats",
                                "Silent session adoption failed: ${signIn.exception?.javaClass?.simpleName ?: "unknown"}"
                            )
                        }
                        call.resolve(JSObject().apply { put("uid", uid ?: "") })
                    }
            }
    }

    /**
     * The device's FCM registration token — what the chatz-push Worker targets.
     * Resolves with an empty string when messaging is unavailable (no Play
     * services, Firebase project not provisioned) so the caller can skip
     * registration silently instead of surfacing an error the user can't act on.
     */
    @PluginMethod
    fun getFcmToken(call: PluginCall) {
        val cached = ChatzPushService.storedToken(context)
        if (!cached.isNullOrBlank()) {
            call.resolve(JSObject().apply { put("token", cached) })
            return
        }
        try {
            FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                val token = if (task.isSuccessful) task.result else null
                if (token != null) ChatzPushService.saveToken(context, token)
                call.resolve(JSObject().apply { put("token", token ?: "") })
            }
        } catch (e: Exception) {
            call.resolve(JSObject().apply { put("token", "") })
        }
    }

    @PluginMethod
    fun getNativeAuthUid(call: PluginCall) {
        val uid = FirebaseAuth.getInstance().currentUser?.uid ?: ""
        call.resolve(JSObject().apply { put("uid", uid) })
    }

    @PluginMethod
    fun signOutNative(call: PluginCall) {
        FirebaseAuth.getInstance().signOut()
        // Also drop Google's cached account. Without this, Google Play services
        // silently reuses the last account on the next explicit sign-in instead of
        // showing the account chooser.
        runCatching { googleSignInClient().signOut() }
        call.resolve()
    }

    private fun googleSignInClient() = GoogleSignIn.getClient(
        context,
        GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
            .requestIdToken(WEB_CLIENT_ID)
            .requestEmail()
            .build()
    )

    @PluginMethod
    fun openSettings(call: PluginCall) {
        val action = call.getString("action") ?: ""
        PermissionHelper.openSpecificSettings(context, action)
        call.resolve()
    }

    @PluginMethod
    fun setPrivacySettings(call: PluginCall) {
        // Per-uid keys: a shared device can host two accounts, and one account's
        // toggles must never become the other's defaults. Missing keys make the
        // background worker skip, so a partial write can only under-share.
        val uid = call.getString("uid") ?: ""
        if (uid.isBlank()) {
            call.resolve()
            return
        }
        val mode = if (call.getString("mode") == "silent") "silent" else "active"
        val prefs = context.getSharedPreferences("ChatZPrefs", android.content.Context.MODE_PRIVATE)
        prefs.edit()
            .putString("privacy:$uid:mode", mode)
            .putBoolean("privacy:$uid:share_screen_time", call.getBoolean("shareScreenTime", false) ?: false)
            .putBoolean("privacy:$uid:share_data_usage", call.getBoolean("shareDataUsage", false) ?: false)
            .putBoolean("privacy:$uid:share_wifi_status", call.getBoolean("shareWifiStatus", false) ?: false)
            .putBoolean("privacy:$uid:share_most_used_apps", call.getBoolean("shareMostUsedApps", false) ?: false)
            .putBoolean("privacy:$uid:share_launches", call.getBoolean("shareLaunches", false) ?: false)
            .putBoolean("privacy:$uid:share_notifications", call.getBoolean("shareNotifications", false) ?: false)
            .putBoolean("privacy:$uid:share_device_info", call.getBoolean("shareDeviceInfo", false) ?: false)
            .putBoolean("privacy:$uid:share_battery", call.getBoolean("shareBattery", false) ?: false)
            // Drop the pre-account-scoped keys so no stale value is ever read.
            .remove("privacy_share_screen_time")
            .remove("privacy_share_data_usage")
            .remove("privacy_share_wifi_status")
            .remove("privacy_share_most_used_apps")
            .remove("privacy_share_launches")
            .remove("privacy_share_notifications")
            .remove("privacy_share_device_info")
            .remove("privacy_share_battery")
            .remove("privacy_paused_until")
            .apply()
        call.resolve()
    }

    @PluginMethod
    fun signInWithGoogle(call: PluginCall) {
        try {
            googleSignInCall = call
            val client = googleSignInClient()
            // Clear any cached Google account first so the chooser is always shown
            // on an explicit sign-in. signOut() only clears the local cache; it does
            // not revoke anything server-side.
            client.signOut().addOnCompleteListener {
                try {
                    startActivityForResult(call, client.signInIntent, GOOGLE_SIGN_IN_RC)
                } catch (e: Exception) {
                    googleSignInCall = null
                    call.reject("Failed to start Google Sign-In: ${e.localizedMessage}")
                }
            }
        } catch (e: Exception) {
            googleSignInCall = null
            call.reject("Failed to start Google Sign-In: ${e.localizedMessage}")
        }
    }

    override fun handleOnActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.handleOnActivityResult(requestCode, resultCode, data)
        if (requestCode != GOOGLE_SIGN_IN_RC) return
        val call = googleSignInCall ?: return
        googleSignInCall = null
        if (resultCode != Activity.RESULT_OK || data == null) {
            call.reject("Google sign-in cancelled")
            return
        }
        try {
            val task = GoogleSignIn.getSignedInAccountFromIntent(data)
            val account = task.getResult(ApiException::class.java)
            val idToken = account?.idToken
            if (idToken == null) {
                call.reject("No ID token received from Google")
                return
            }
            // Sign the NATIVE Firebase instance in first. The background sync worker
            // authenticates with it, so a WebView-only session is not enough. If this
            // step fails the whole sign-in fails, because a half-signed-in install
            // would silently stop syncing. The token itself is never logged.
            val credential = GoogleAuthProvider.getCredential(idToken, null)
            FirebaseAuth.getInstance().signInWithCredential(credential)
                .addOnCompleteListener { task ->
                    if (task.isSuccessful) {
                        call.resolve(JSObject().apply { put("idToken", idToken) })
                    } else {
                        call.reject("Could not sign in on the device: ${task.exception?.localizedMessage ?: "unknown error"}")
                    }
                }
        } catch (e: ApiException) {
            // Include the numeric status so the JS side (and the user) can see WHY it
            // failed instead of a blank message. Common codes:
            //   10 DEVELOPER_ERROR  -> SHA-1 / web OAuth client not registered in Firebase
            //   7  NETWORK_ERROR     8  INTERNAL_ERROR    13 SIGN_IN_FAILED
            android.util.Log.e("VibeStats", "GoogleSignIn failed status=${e.statusCode}", e)
            call.reject("Google sign-in failed (status ${e.statusCode}): ${hintForStatus(e.statusCode)}")
        }
    }

    private fun hintForStatus(status: Int): String = when (status) {
        10 -> "Add this build's SHA-1 to Firebase Console → Project settings → Your Android app."
        7 -> "Network error — check the connection and try again."
        8 -> "Google Play services error — update Google Play services."
        else -> "Unexpected error from Google Sign-In."
    }

    companion object {
        const val GOOGLE_SIGN_IN_RC = 9001

        private const val CHANNEL_MESSAGES = "chatz_messages"
        private const val CHANNEL_SOCIAL = "chatz_social"
        private const val CHANNEL_UPDATES = "chatz_updates"

        // The audience MUST be this project's Web OAuth client (client_type 3 in
        // google-services.json). Using the wrong/old web client is what produces
        // ApiException status 10 (DEVELOPER_ERROR) even when the SHA-1 is registered.
        private const val WEB_CLIENT_ID =
            "626880059849-3ktfefr5tsjqmgiehfhba4rmtofkt6gt.apps.googleusercontent.com"
    }
}
