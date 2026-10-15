package com.chatz.app.data.collector

import android.Manifest
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.telephony.TelephonyManager
import android.util.Log
import androidx.core.content.ContextCompat
import com.chatz.app.data.models.AppUsageStat
import com.chatz.app.data.models.ConnectivityInfo
import com.chatz.app.data.models.VibeData
import com.chatz.app.data.permissions.PermissionHelper
import com.google.firebase.auth.FirebaseAuth
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit

data class DayUsage(
    val perApp: List<AppUsageStat>,
    val totalMs: Long,
    val launchCount: Int,
    val notificationCount: Int
)

class VibeDataCollector(private val context: Context) {

    fun collect(): VibeData {
        if (!PermissionHelper.isUsageAccessGranted(context)) {
            return VibeData(uid = getCurrentUserId())
        }

        val dayUsage = collectDayUsage()
        val connectivity = getCurrentConnectivity()
        val wifiBytes = getWifiDataUsedToday()
        val mobileBytes = getMobileDataUsedToday()
        val battery = getBatteryPercent()
        val charging = isCharging()
        val ssid = if (connectivity.isOnWifi) getWifiSsid() else null

        return VibeData(
            uid = getCurrentUserId(),
            screenTimeTodayMs = dayUsage.totalMs,
            topApps = dayUsage.perApp.take(MAX_TOP_APPS),
            launchCount = dayUsage.launchCount,
            notificationCount = dayUsage.notificationCount,
            deviceModel = deviceModel(),
            androidVersion = androidVersion(),
            wifiDataUsedBytes = wifiBytes,
            mobileDataUsedBytes = mobileBytes,
            isOnWifi = connectivity.isOnWifi,
            isOnMobile = connectivity.isOnMobile,
            maskedSsid = ssid,
            batteryPercent = battery,
            isCharging = charging
        )
    }

    /**
     * What ChatZ counts as screen time.
     *
     * Per-app foreground sessions inside [local midnight, now] are rebuilt by
     * walking UsageEvents transitions, then clipped to the stretches where the
     * screen was actually interactive (SCREEN_INTERACTIVE -> SCREEN_NON_INTERACTIVE).
     * The daily-bucket API (queryUsageStats / INTERVAL_DAILY) is deliberately NOT
     * used for the numbers: its buckets are not clamped to local midnight, one
     * package can come back as several records that would be double counted, and
     * it cannot exclude a package, so its sum drifts well above what the device
     * actually showed.
     *
     * Two categories are left out everywhere: com.android.systemui (status bar,
     * shade, lock screen) and the ROM's home screen. On this XOS ROM the launcher
     * in particular keeps ACTIVITY_RESUMED while the screen is off, which would
     * otherwise add hours of fake usage. Clipping to screen-interactive windows
     * keeps the total equal to time actually spent in front of the screen, and
     * because the total and the top-app list come from the same map they are
     * consistent by construction.
     */
    fun collectDayUsage(): DayUsage {
        val usageStatsManager = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
        val (startOfDay, now) = getTodayRange()
        val excluded = excludedPackages()

        val perAppMs = HashMap<String, Long>()
        var foregroundPkg: String? = null
        var foregroundSince = 0L
        var pendingPauseAt: Long? = null
        var launchCount = 0
        var notificationCount = 0
        var interruptCount = 0
        val screen = ScreenWindows(startOfDay)
        val debug = isDebuggable()
        val typeHistogram = if (debug) HashMap<Int, Int>() else null

        val events = usageStatsManager.queryEvents(startOfDay, now)
        val event = UsageEvents.Event()
        while (events.hasNextEvent()) {
            events.getNextEvent(event)
            typeHistogram?.let { it[event.eventType] = (it[event.eventType] ?: 0) + 1 }
            // Screen events carry no package name, so they are handled before the
            // null-package skip below.
            when (event.eventType) {
                UsageEvents.Event.SCREEN_INTERACTIVE -> {
                    screen.onInteractive(event.timeStamp)
                    continue
                }
                UsageEvents.Event.SCREEN_NON_INTERACTIVE -> {
                    screen.onNonInteractive(event.timeStamp)
                    continue
                }
            }
            val pkg = event.packageName ?: continue
            when (event.eventType) {
                // ACTIVITY_RESUMED == MOVE_TO_FOREGROUND (same constant value).
                UsageEvents.Event.ACTIVITY_RESUMED -> {
                    if (foregroundPkg == pkg) {
                        // Another activity of the SAME app came to the front: the app
                        // never left the foreground, so undo the pending close. Without
                        // this, every in-app screen change would count as a new session.
                        pendingPauseAt = null
                    } else {
                        val previous = foregroundPkg
                        if (previous != null) {
                            addInterval(
                                perAppMs, previous, foregroundSince,
                                pendingPauseAt ?: event.timeStamp, startOfDay, now,
                                excluded, screen
                            )
                        }
                        foregroundPkg = pkg
                        foregroundSince = event.timeStamp
                        pendingPauseAt = null
                        if (pkg !in excluded && screen.isOn) launchCount++
                    }
                }
                // ACTIVITY_PAUSED == MOVE_TO_BACKGROUND (same constant value).
                UsageEvents.Event.ACTIVITY_PAUSED -> {
                    when {
                        foregroundPkg == pkg && pendingPauseAt == null ->
                            pendingPauseAt = event.timeStamp
                        foregroundPkg == null ->
                            // This app was already in the foreground at local midnight
                            // and paused after it: the stretch from midnight to the
                            // pause belongs to today. No launch is counted because we
                            // never saw the app start.
                            addInterval(
                                perAppMs, pkg, startOfDay, event.timeStamp, startOfDay, now,
                                excluded, screen
                            )
                    }
                }
                // NOTIFICATION_SEEN / NOTIFICATION_INTERRUPTION are @SystemApi so
                // they are not on the public UsageEvents.Event class; the values are
                // the stable AOSP ones. Whether a usage-access app is served these
                // events at all is device dependent, which is why the audit dump
                // prints the raw type histogram for comparison.
                EVENT_NOTIFICATION_SEEN -> notificationCount++
                EVENT_NOTIFICATION_INTERRUPTION -> interruptCount++
            }
        }
        // Still in the foreground when the window ends — count up to `now`.
        foregroundPkg?.let {
            addInterval(
                perAppMs, it, foregroundSince, pendingPauseAt ?: now, startOfDay, now,
                excluded, screen
            )
        }

        val perApp = perAppMs.entries
            .sortedByDescending { it.value }
            .map { (pkg, ms) -> AppUsageStat(packageName = pkg, appName = getAppName(pkg), usageMs = ms) }

        if (debug) {
            auditRawRecords(
                usageStatsManager, startOfDay, now, perAppMs,
                launchCount, notificationCount, interruptCount, typeHistogram ?: emptyMap(),
                excluded, screen
            )
        }

        return DayUsage(
            perApp = perApp,
            totalMs = perAppMs.values.sum(),
            launchCount = launchCount,
            notificationCount = notificationCount
        )
    }

    /** systemui plus whatever this ROM uses as the home screen. */
    private fun excludedPackages(): Set<String> {
        val home = try {
            context.packageManager
                .queryIntentActivities(
                    Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), 0
                )
                .mapNotNull { it.activityInfo?.packageName }
        } catch (e: Exception) {
            emptyList()
        }
        return (home + SYSTEM_UI).toSet()
    }

    private fun addInterval(
        perAppMs: HashMap<String, Long>,
        pkg: String,
        fromMs: Long,
        toMs: Long,
        windowStart: Long,
        windowEnd: Long,
        excluded: Set<String>,
        screen: ScreenWindows
    ) {
        if (pkg in excluded) return
        val from = maxOf(fromMs, windowStart)
        val to = minOf(toMs, windowEnd)
        if (to <= from) return
        val visible = screen.intersect(from, to)
        if (visible > 0) perAppMs[pkg] = (perAppMs[pkg] ?: 0L) + visible
    }

    /**
     * Temporary item-4 instrumentation: prints the raw INTERVAL_DAILY records and
     * the event-based reconstruction side by side so the discrepancy can be shown
     * with numbers. Debug builds only — `adb logcat -s ChZUsageAudit`.
     */
    private fun auditRawRecords(
        usageStatsManager: UsageStatsManager,
        startOfDay: Long,
        now: Long,
        perAppMs: Map<String, Long>,
        launchCount: Int,
        notificationCount: Int,
        interruptCount: Int,
        typeHistogram: Map<Int, Int>,
        excluded: Set<String>,
        screen: ScreenWindows
    ) {
        try {
            val raw = usageStatsManager.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, startOfDay, now)
            Log.d(AUDIT_TAG, "window | start=$startOfDay (${localTime(startOfDay)}) " +
                    "now=$now (${localTime(now)}) tz=${TimeZone.getDefault().id}")
            Log.d(AUDIT_TAG, "screen | onMs=${screen.totalOnMs(now)} windows=${screen.windowCount}")
            Log.d(AUDIT_TAG, "excluded | ${excluded.sorted().joinToString(", ")}")
            Log.d(AUDIT_TAG, "raw | records=${raw.size} rawSum=${raw.sumOf { it.totalTimeInForeground }}")
            typeHistogram.entries.sortedByDescending { it.value }.forEach { (type, count) ->
                Log.d(AUDIT_TAG, "types | type=$type count=$count (${eventTypeName(type)})")
            }
            raw.sortedByDescending { it.totalTimeInForeground }.forEach { record ->
                Log.d(AUDIT_TAG, "raw | ${record.packageName} | " +
                        "first=${record.firstTimeStamp} (${localTime(record.firstTimeStamp)}) | " +
                        "last=${record.lastTimeStamp} (${localTime(record.lastTimeStamp)}) | " +
                        "fg=${record.totalTimeInForeground}")
            }
            Log.d(AUDIT_TAG, "events | totalMs=${perAppMs.values.sum()} " +
                    "launches=$launchCount notifsSeen=$notificationCount notifsInterrupt=$interruptCount")
            perAppMs.entries.sortedByDescending { it.value }.take(12).forEach { (pkg, ms) ->
                Log.d(AUDIT_TAG, "events | $pkg | $ms")
            }
        } catch (e: Exception) {
            Log.w(AUDIT_TAG, "audit dump failed: ${e.javaClass.simpleName}")
        }
    }

    private fun isDebuggable(): Boolean =
        (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

    /** Audit-only: names the public event types, everything else is shown as a number. */
    private fun eventTypeName(type: Int): String = when (type) {
        UsageEvents.Event.ACTIVITY_RESUMED -> "ACTIVITY_RESUMED"
        UsageEvents.Event.ACTIVITY_PAUSED -> "ACTIVITY_PAUSED"
        UsageEvents.Event.ACTIVITY_STOPPED -> "ACTIVITY_STOPPED"
        UsageEvents.Event.SCREEN_INTERACTIVE -> "SCREEN_INTERACTIVE"
        UsageEvents.Event.SCREEN_NON_INTERACTIVE -> "SCREEN_NON_INTERACTIVE"
        UsageEvents.Event.USER_INTERACTION -> "USER_INTERACTION"
        UsageEvents.Event.SHORTCUT_INVOCATION -> "SHORTCUT_INVOCATION"
        UsageEvents.Event.CONFIGURATION_CHANGE -> "CONFIGURATION_CHANGE"
        UsageEvents.Event.FOREGROUND_SERVICE_START -> "FOREGROUND_SERVICE_START"
        UsageEvents.Event.FOREGROUND_SERVICE_STOP -> "FOREGROUND_SERVICE_STOP"
        EVENT_NOTIFICATION_SEEN -> "NOTIFICATION_SEEN"
        EVENT_NOTIFICATION_INTERRUPTION -> "NOTIFICATION_INTERRUPTION"
        EVENT_STANDBY_BUCKET_CHANGED -> "STANDBY_BUCKET_CHANGED"
        else -> "?"
    }

    private fun localTime(millis: Long): String =
        SimpleDateFormat("MM-dd HH:mm:ss", Locale.US).format(Date(millis))

    private fun deviceModel(): String {
        val manufacturer = Build.MANUFACTURER.orEmpty()
        val model = Build.MODEL.orEmpty()
        return if (model.lowercase().startsWith(manufacturer.lowercase())) model
        else "$manufacturer $model".trim()
    }

    private fun androidVersion(): String =
        "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})"

    fun getCurrentlyActiveApp(): String? {
        val usageStatsManager = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
        val now = System.currentTimeMillis()
        val events = usageStatsManager.queryEvents(now - 5000, now)
        val event = UsageEvents.Event()
        var lastPackage: String? = null

        while (events.hasNextEvent()) {
            events.getNextEvent(event)
            if (event.eventType == UsageEvents.Event.MOVE_TO_FOREGROUND) {
                lastPackage = event.packageName
            }
        }
        return lastPackage
    }

    fun getWifiDataUsedToday(): Long {
        val networkStatsManager = context.getSystemService(Context.NETWORK_STATS_SERVICE)
                as android.app.usage.NetworkStatsManager
        val startOfDay = getStartOfDayMillis()

        return try {
            val bucket = networkStatsManager.querySummaryForDevice(
                ConnectivityManager.TYPE_WIFI,
                null,
                startOfDay,
                System.currentTimeMillis()
            )
            bucket.rxBytes + bucket.txBytes
        } catch (e: Exception) {
            0L
        }
    }

    fun getMobileDataUsedToday(): Long {
        val networkStatsManager = context.getSystemService(Context.NETWORK_STATS_SERVICE)
                as android.app.usage.NetworkStatsManager
        val startOfDay = getStartOfDayMillis()

        val subscriberId = try {
            val telephonyManager = context.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                @Suppress("DEPRECATION")
                telephonyManager.subscriberId
            } else {
                null
            }
        } catch (e: Exception) {
            null
        }

        return try {
            val bucket = networkStatsManager.querySummaryForDevice(
                ConnectivityManager.TYPE_MOBILE,
                subscriberId,
                startOfDay,
                System.currentTimeMillis()
            )
            bucket.rxBytes + bucket.txBytes
        } catch (e: Exception) {
            0L
        }
    }

    fun getCurrentConnectivity(): ConnectivityInfo {
        val connectivityManager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = connectivityManager.activeNetwork
        val capabilities = connectivityManager.getNetworkCapabilities(network)

        val isOnWifi = capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
        val isOnMobile = capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true
        val isConnected = isOnWifi || isOnMobile

        return ConnectivityInfo(
            isConnected = isConnected,
            isOnWifi = isOnWifi,
            isOnMobile = isOnMobile,
            ssid = if (isOnWifi) getWifiSsid() else null
        )
    }

    fun getWifiSsid(): String? {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED
        ) {
            return null
        }

        val wifiManager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        val wifiInfo = wifiManager.connectionInfo
        val ssid = wifiInfo.ssid

        val cleanSsid = ssid?.removePrefix("\"")?.removeSuffix("\"")
        if (cleanSsid.isNullOrBlank() || cleanSsid == "<unknown ssid>") return null

        return if (cleanSsid.length > 3) {
            "${cleanSsid.take(3)}****"
        } else {
            "****"
        }
    }

    fun getBatteryPercent(): Int {
        val batteryManager = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        return batteryManager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
    }

    fun isCharging(): Boolean {
        val batteryStatus = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val status = batteryStatus?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        return status == BatteryManager.BATTERY_STATUS_CHARGING ||
                status == BatteryManager.BATTERY_STATUS_FULL
    }

    private fun getAppName(packageName: String): String {
        return try {
            val info = context.packageManager.getApplicationInfo(packageName, 0)
            context.packageManager.getApplicationLabel(info).toString()
        } catch (e: PackageManager.NameNotFoundException) {
            packageName
        }
    }

    private fun getTodayRange(): Pair<Long, Long> {
        val calendar = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, 0)
            set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
        }
        return Pair(calendar.timeInMillis, System.currentTimeMillis())
    }

    private fun getStartOfDayMillis(): Long {
        return Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, 0)
            set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
        }.timeInMillis
    }

    private fun getCurrentUserId(): String {
        // Firebase Auth is the single source of identity. The uid is read from the
        // native session (restored from its own persistence) rather than any pref
        // the web layer might have written.
        return try {
            FirebaseAuth.getInstance().currentUser?.uid ?: ""
        } catch (e: Exception) {
            ""
        }
    }

    companion object {
        private const val SYSTEM_UI = "com.android.systemui"
        private const val MAX_TOP_APPS = 10
        private const val AUDIT_TAG = "ChZUsageAudit"

        // Hidden @SystemApi values from AOSP UsageEvents.Event; not on the public class.
        private const val EVENT_NOTIFICATION_SEEN = 10
        private const val EVENT_NOTIFICATION_INTERRUPTION = 12
        private const val EVENT_STANDBY_BUCKET_CHANGED = 11

        fun formatDuration(millis: Long): String {
            val hours = TimeUnit.MILLISECONDS.toHours(millis)
            val minutes = TimeUnit.MILLISECONDS.toMinutes(millis) % 60
            return when {
                hours > 0 -> "${hours}h ${minutes}m"
                else -> "${minutes}m"
            }
        }

        fun formatBytes(bytes: Long): String {
            val mb = bytes / (1024.0 * 1024.0)
            return if (mb >= 1000) {
                String.format("%.1f GB", mb / 1024.0)
            } else {
                String.format("%.0f MB", mb)
            }
        }
    }
}

/**
 * Screen-interactive stretches seen in the event stream. App sessions are
 * intersected with these windows so time with the screen off is never counted,
 * even when an app (the XOS launcher in particular) stays ACTIVITY_RESUMED.
 */
private class ScreenWindows(private val defaultStart: Long) {
    private val closed = ArrayList<LongArray>()
    private var openSince: Long? = defaultStart
    private var sawScreenEvent = false

    val isOn: Boolean get() = openSince != null

    val windowCount: Int get() = closed.size + if (openSince != null) 1 else 0

    fun onInteractive(at: Long) {
        if (!sawScreenEvent) {
            // A real transition to interactive means the screen had been off until
            // now, so drop the initial "on since window start" assumption.
            openSince = at
        } else if (openSince == null) {
            openSince = at
        }
        sawScreenEvent = true
    }

    fun onNonInteractive(at: Long) {
        val open = openSince
        if (open != null && at > open) closed.add(longArrayOf(open, at))
        openSince = null
        sawScreenEvent = true
    }

    /** Milliseconds of [from, to) that fall inside a screen-on window. */
    fun intersect(from: Long, to: Long): Long {
        var sum = 0L
        for (w in closed) {
            val s = maxOf(from, w[0])
            val e = minOf(to, w[1])
            if (e > s) sum += e - s
        }
        openSince?.let {
            val s = maxOf(from, it)
            if (to > s) sum += to - s
        }
        return sum
    }

    fun totalOnMs(now: Long): Long {
        var sum = 0L
        for (w in closed) sum += w[1] - w[0]
        openSince?.let { sum += maxOf(0L, now - it) }
        return sum
    }
}
