package com.chatz.app.data.sync

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.chatz.app.data.collector.VibeDataCollector
import com.chatz.app.data.models.VibeData
import com.chatz.app.data.permissions.PermissionHelper
import com.google.android.gms.tasks.Tasks
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.SetOptions
import com.google.firebase.firestore.Source
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

class UsageStatsSyncWorker(
    appContext: Context,
    workerParams: WorkerParameters
) : CoroutineWorker(appContext, workerParams) {

    companion object {
        private const val TAG = "VibeSync"
        private const val PREFS_NAME = "ChatZPrefs"
        private const val TIMEOUT_SECONDS = 45L

        // Privacy is stored per account: privacy:<uid>:share_* and privacy:<uid>:mode.
        // A missing key is treated as "do not upload" (fail-closed) — the foreground
        // app writes them, so a fresh install or a different account simply waits
        // until the app has pushed its settings once.
        private val SHARE_SUFFIXES = listOf(
            "share_screen_time",
            "share_data_usage",
            "share_wifi_status",
            "share_most_used_apps",
            "share_launches",
            "share_notifications",
            "share_device_info",
            "share_battery"
        )

        // Local fingerprint cache: avoids unnecessary SERVER reads when stats haven't changed.
        // Keyed by uid + day so each user/day combo gets its own cache entry.
        private fun lastFingerprintKey(uid: String, day: String) = "fingerprint:$uid:$day"

        // Left on disk by the removed Supabase worker / pre-account-scoped builds;
        // cleared once so no stale value is ever read.
        private const val LEGACY_PREF_UID = "supabase_uid"
        private const val LEGACY_PREF_URL = "supabase_url"
        private const val LEGACY_PREF_KEY = "supabase_anon_key"
        private val LEGACY_PRIVACY_KEYS = listOf(
            "privacy_share_screen_time",
            "privacy_share_data_usage",
            "privacy_share_wifi_status",
            "privacy_share_most_used_apps",
            "privacy_share_launches",
            "privacy_share_notifications",
            "privacy_share_device_info",
            "privacy_share_battery",
            "privacy_paused_until"
        )
    }

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        clearLegacyPrefs()

        // The native Firebase session is the only identity source. adoptExistingSession
        // mirrors the web sign-in on the native SDK, so this is already restored from
        // disk long before the first periodic run.
        val uid = FirebaseAuth.getInstance().currentUser?.uid

        // Not signed in yet. Periodic work is never terminal, so let the next interval
        // (15 min later) pick it up rather than burning retries now.
        if (uid.isNullOrBlank()) {
            Log.i(TAG, "Skipped: no native session")
            return@withContext Result.success()
        }

        if (!PermissionHelper.isUsageAccessGranted(applicationContext)) {
            Log.i(TAG, "Skipped: usage access not granted")
            return@withContext Result.success()
        }

        try {
            val prefs = applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

            // Fail closed: without a complete per-account privacy record there is no
            // safe payload to build, so upload nothing until the app pushes settings.
            val modeKey = "privacy:$uid:mode"
            val shareKeys = SHARE_SUFFIXES.map { "privacy:$uid:$it" }
            if (!prefs.contains(modeKey) || shareKeys.any { !prefs.contains(it) }) {
                Log.i(TAG, "Skipped: privacy not configured for this account")
                return@withContext Result.success()
            }

            // Silent mode: the client already wrote the friend-facing paused snapshot
            // when the mode changed; the worker neither uploads nor overwrites it.
            val mode = prefs.getString(modeKey, null)
            if (mode != "active") {
                Log.i(TAG, "Skipped: sharing paused")
                return@withContext Result.success()
            }

            val data = VibeDataCollector(applicationContext).collect()

            val payload = buildPayload(
                data = data,
                mode = "active",
                shareScreenTime = prefs.getBoolean(shareKeys[0], false),
                shareDataUsage = prefs.getBoolean(shareKeys[1], false),
                shareWifiStatus = prefs.getBoolean(shareKeys[2], false),
                shareMostUsedApps = prefs.getBoolean(shareKeys[3], false),
                shareLaunches = prefs.getBoolean(shareKeys[4], false),
                shareNotifications = prefs.getBoolean(shareKeys[5], false),
                shareDeviceInfo = prefs.getBoolean(shareKeys[6], false),
                shareBattery = prefs.getBoolean(shareKeys[7], false)
            )

            val docRef = FirebaseFirestore.getInstance()
                .collection("usageStats")
                .document(uid)

            val currentFingerprint = fingerprintOf(payload)
            val day = localDay()
            val cacheKey = lastFingerprintKey(uid, day)
            val cachedFingerprint = prefs.getString(cacheKey, null)

            // Only read from SERVER if the local fingerprint has changed since the last
            // successful upload. This avoids an unnecessary Firestore read when stats
            // are unchanged (e.g., user hasn't used the phone in 15 min).
            val needsServerCheck = cachedFingerprint != currentFingerprint

            if (!needsServerCheck) {
                Log.i(TAG, "Local fingerprint matches last upload — skipping server read")
                return@withContext Result.success()
            }

            // Source.SERVER doubles as a connectivity probe: it fails fast when the
            // device is offline instead of silently comparing against a stale cache.
            val existing = Tasks.await(docRef.get(Source.SERVER), TIMEOUT_SECONDS, TimeUnit.SECONDS)
            if (existing.exists() && fingerprintOf(existing.data) == currentFingerprint) {
                Log.i(TAG, "Server snapshot matches local fingerprint — no upload needed")
                // Update local cache so we don't check again until something changes
                prefs.edit().putString(cacheKey, currentFingerprint).apply()
                return@withContext Result.success()
            }

            Tasks.await(docRef.set(payload, SetOptions.merge()), TIMEOUT_SECONDS, TimeUnit.SECONDS)
            Log.i(TAG, "Snapshot uploaded")
            // Cache the fingerprint of what we just uploaded
            prefs.edit().putString(cacheKey, currentFingerprint).apply()
            Result.success()
        } catch (e: ExecutionException) {
            handleFailure(e.cause)
        } catch (e: Exception) {
            Log.e(TAG, "Snapshot failed: ${e.javaClass.simpleName}")
            if (runAttemptCount < 3) Result.retry() else Result.failure()
        }
    }

    private fun handleFailure(cause: Throwable?): Result {
        if (cause is FirebaseFirestoreException
            && cause.code == FirebaseFirestoreException.Code.PERMISSION_DENIED
        ) {
            // The rules only allow usageStats/{own uid}; a denial means the native
            // session belongs to someone else, which retrying cannot fix.
            Log.e(TAG, "Snapshot denied by security rules")
            return Result.failure()
        }
        Log.e(TAG, "Snapshot error: ${cause?.javaClass?.simpleName ?: "unknown"}")
        return if (runAttemptCount < 3) Result.retry() else Result.failure()
    }

    /**
     * A toggled-off field is written as its neutral value rather than omitted, so a
     * value shared earlier does not linger where friends can still read it.
     */
    private fun buildPayload(
        data: VibeData,
        mode: String,
        shareScreenTime: Boolean,
        shareDataUsage: Boolean,
        shareWifiStatus: Boolean,
        shareMostUsedApps: Boolean,
        shareLaunches: Boolean,
        shareNotifications: Boolean,
        shareDeviceInfo: Boolean,
        shareBattery: Boolean
    ): Map<String, Any> = hashMapOf(
        "mode" to mode,
        "day" to localDay(),
        "screenTimeTodayMs" to if (shareScreenTime) data.screenTimeTodayMs else 0L,
        "launchCount" to if (shareLaunches) data.launchCount else 0,
        "notificationCount" to if (shareNotifications) data.notificationCount else 0,
        "deviceModel" to if (shareDeviceInfo) data.deviceModel else "",
        "androidVersion" to if (shareDeviceInfo) data.androidVersion else "",
        "wifiDataUsedBytes" to if (shareDataUsage) data.wifiDataUsedBytes else 0L,
        "mobileDataUsedBytes" to if (shareDataUsage) data.mobileDataUsedBytes else 0L,
        "isOnWifi" to (shareWifiStatus && data.isOnWifi),
        "isOnMobile" to (shareWifiStatus && data.isOnMobile),
        "maskedSsid" to if (shareWifiStatus) (data.maskedSsid ?: "") else "",
        "batteryPercent" to if (shareBattery) data.batteryPercent else 0,
        "isCharging" to (shareBattery && data.isCharging),
        "topApps" to if (shareMostUsedApps) {
            data.topApps.map { app ->
                hashMapOf<String, Any>(
                    "packageName" to app.packageName,
                    "appName" to app.appName,
                    "usageMs" to app.usageMs
                )
            }
        } else {
            emptyList<Map<String, Any>>()
        },
        // The flags ride along with the snapshot so the friend side can show
        // "Hidden" instead of a fake zero for a gated field.
        "shared" to hashMapOf(
            "screenTime" to shareScreenTime,
            "topApps" to shareMostUsedApps,
            "dataUsage" to shareDataUsage,
            "wifi" to shareWifiStatus,
            "battery" to shareBattery,
            "launches" to shareLaunches,
            "notifications" to shareNotifications,
            "deviceInfo" to shareDeviceInfo
        ),
        // A real upload means the owner is collecting again: clear any
        // "active but couldn't collect" marker the foreground app left behind.
        "blocked" to false,
        // Server timestamp so the friend side can order snapshots without trusting
        // the device clock.
        "syncedAt" to FieldValue.serverTimestamp()
    )

    private fun localDay(): String {
        // Device-local zone on purpose: src/lib/usage-repo.ts clears screen time when
        // day != localDay(), so a UTC date here would report 0 for most of the day.
        val format = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        format.timeZone = TimeZone.getDefault()
        return format.format(Date())
    }

    /**
     * Content digest that ignores syncedAt, so an unchanged snapshot is not uploaded
     * every 15 minutes. Numbers are read back through Number because Firestore may
     * hand back a Double for a value written as a Long.
     */
    private fun fingerprintOf(data: Map<String, Any?>?): String {
        if (data == null) return ""
        val topApps = (data["topApps"] as? List<*>)
            ?.mapNotNull { it as? Map<*, *> }
            ?.joinToString(",") { entry ->
                val pkg = entry["packageName"]?.toString() ?: ""
                val ms = (entry["usageMs"] as? Number)?.toLong() ?: 0L
                "$pkg=$ms"
            }
            .orEmpty()

        val shared = (data["shared"] as? Map<*, *>)
            ?.entries
            ?.sortedBy { it.key.toString() }
            ?.joinToString(",") { "${it.key}=${it.value}" }
            .orEmpty()

        return listOf(
            data["mode"]?.toString() ?: "",
            data["day"]?.toString() ?: "",
            (data["screenTimeTodayMs"] as? Number)?.toLong() ?: 0L,
            (data["launchCount"] as? Number)?.toInt() ?: 0,
            (data["notificationCount"] as? Number)?.toInt() ?: 0,
            data["deviceModel"]?.toString() ?: "",
            data["androidVersion"]?.toString() ?: "",
            (data["wifiDataUsedBytes"] as? Number)?.toLong() ?: 0L,
            (data["mobileDataUsedBytes"] as? Number)?.toLong() ?: 0L,
            data["isOnWifi"]?.toString() ?: "false",
            data["isOnMobile"]?.toString() ?: "false",
            data["maskedSsid"]?.toString() ?: "",
            (data["batteryPercent"] as? Number)?.toInt() ?: 0,
            data["isCharging"]?.toString() ?: "false",
            topApps,
            shared,
            data["blocked"]?.toString() ?: "false"
        ).joinToString("|")
    }

    private fun clearLegacyPrefs() {
        try {
            val prefs = applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val hasLegacy = prefs.contains(LEGACY_PREF_UID)
                || prefs.contains(LEGACY_PREF_URL)
                || prefs.contains(LEGACY_PREF_KEY)
                || LEGACY_PRIVACY_KEYS.any { prefs.contains(it) }
            if (!hasLegacy) return
            val editor = prefs.edit()
                .remove(LEGACY_PREF_UID)
                .remove(LEGACY_PREF_URL)
                .remove(LEGACY_PREF_KEY)
            for (key in LEGACY_PRIVACY_KEYS) editor.remove(key)
            editor.apply()
        } catch (e: Exception) {
            Log.w(TAG, "Could not clear legacy prefs: ${e.javaClass.simpleName}")
        }
    }
}
