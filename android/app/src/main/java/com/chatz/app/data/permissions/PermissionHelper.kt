package com.chatz.app.data.permissions

import android.Manifest
import android.app.AppOpsManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log

/**
 * Every jump into Android settings funnels through here. Two hard rules for
 * OEM compatibility (MIUI, ColorOS, Funtouch, EMUI, XOS, One UI, stock):
 *
 *  1. Never assume a settings screen exists. OEM ROMs ship, rename, protect
 *     (SecurityException) or remove the classes below across versions, so
 *     every candidate is tried with try/catch and the next one is used.
 *  2. Never use the OEM screen as the only path. The platform intent works on
 *     every device, so it is always in the chain — worst case the user lands
 *     on Settings and finds the toggle manually.
 */
object PermissionHelper {

    private const val TAG = "ChatZPerms"
    private const val PREFS = "ChatZPrefs"
    private const val KEY_BATTERY_DIALOG = "battery_dialog_shown"

    private fun startActivitySafe(context: Context, intent: Intent): Boolean {
        return try {
            context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            true
        } catch (e: Exception) {
            Log.w(TAG, "Cannot open ${intent.component ?: intent.action}: ${e.message}")
            false
        }
    }

    /** Tries each candidate in order; always lands somewhere openable. */
    private fun openFirstWorking(context: Context, vararg candidates: Intent) {
        for (intent in candidates) {
            if (startActivitySafe(context, intent)) return
        }
        if (!startActivitySafe(context, buildAppSettingsIntent(context))) {
            startActivitySafe(context, Intent(Settings.ACTION_SETTINGS))
        }
    }

    fun openSpecificSettings(context: Context, action: String) {
        val candidates = when (action) {
            "notifications", "notifs" -> listOf(
                buildNotificationSettingsIntent(context),
                buildAppSettingsIntent(context),
            )
            "usage" -> usageAccessIntents(context)
            "data" -> listOf(buildDataUsageIntent(context), buildAppSettingsIntent(context))
            else -> listOf(buildAppSettingsIntent(context))
        }
        openFirstWorking(context, *candidates.toTypedArray())
    }

    private fun buildNotificationSettingsIntent(context: Context): Intent {
        // Android 8+ (API 26) has dedicated notification settings
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        } else {
            // Older Android: go to app details where user can find notifications
            buildAppSettingsIntent(context)
        }
    }

    private fun buildDataUsageIntent(context: Context): Intent {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            Intent(Settings.ACTION_DATA_USAGE_SETTINGS).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        } else {
            buildAppSettingsIntent(context)
        }
    }

    private fun buildAppSettingsIntent(context: Context): Intent {
        return Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.parse("package:${context.packageName}")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
    }

    private fun usageAccessIntents(context: Context): List<Intent> {
        val list = mutableListOf<Intent>()
        // Android 10+ (API 29) supports the direct package link; some OEM
        // variants ignore the data URI and need the plain list screen instead.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            list.add(
                Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).apply {
                    data = Uri.parse("package:${context.packageName}")
                }
            )
        }
        list.add(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS))
        return list
    }

    fun requestUsageAccessPermission(context: Context) {
        openFirstWorking(context, *usageAccessIntents(context).toTypedArray())
    }

    fun isUsageAccessGranted(context: Context): Boolean {
        return try {
            val appOpsManager = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
            val mode = appOpsManager.checkOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                android.os.Process.myUid(),
                context.packageName
            )
            mode == AppOpsManager.MODE_ALLOWED
        } catch (e: Exception) {
            // A missing AppOps service or vendor override must read as "not
            // granted" — the app then shows the honest locked state, never
            // fake data collected without access.
            Log.w(TAG, "isUsageAccessGranted failed: ${e.message}")
            false
        }
    }

    /** True when Android will not battery-optimize (i.e. will not freeze) ChatZ. */
    fun isIgnoringBatteryOptimizations(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
        return try {
            val powerManager = context.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
            powerManager.isIgnoringBatteryOptimizations(context.packageName)
        } catch (e: Exception) {
            Log.w(TAG, "isIgnoringBatteryOptimizations failed: ${e.message}")
            false
        }
    }

    /**
     * Android's own exemption dialog is the only screen whose toggle matches
     * the check above, so it is asked first — exactly once, tracked in prefs
     * so a second tap escalates to the OEM screens that control auto-start,
     * which is the flag that actually matters on MIUI/ColorOS/XOS.
     */
    fun showBatteryOptimizationGuide(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            openFirstWorking(context, buildAppSettingsIntent(context))
            return
        }
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!prefs.getBoolean(KEY_BATTERY_DIALOG, false)) {
            val dialog = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:${context.packageName}")
            }
            if (startActivitySafe(context, dialog)) {
                prefs.edit().putBoolean(KEY_BATTERY_DIALOG, true).apply()
                return
            }
        }
        val candidates = oemBatteryIntents(context).toMutableList()
        candidates.add(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        openFirstWorking(context, *candidates.toTypedArray())
    }

    private fun component(
        pkg: String,
        cls: String,
        extras: Map<String, String>? = null,
    ): Intent {
        val intent = Intent().setComponent(ComponentName(pkg, cls))
        extras?.forEach { (key, value) -> intent.putExtra(key, value) }
        return intent
    }

    private fun appLabel(context: Context): String {
        return try {
            val pm = context.packageManager
            pm.getApplicationLabel(pm.getApplicationInfo(context.packageName, 0)).toString()
        } catch (_: Exception) {
            "ChatZ"
        }
    }

    /**
     * Ordered OEM candidates for auto-start / background-activity screens.
     * Ordering favours classes with the strongest field evidence; entries that
     * do not exist on a given ROM/version simply fail over to the next one.
     * Stock-and-motorola devices intentionally fall through to the platform
     * screen — no OEM deep link exists there.
     */
    private fun oemBatteryIntents(context: Context): List<Intent> {
        val m = Build.MANUFACTURER.lowercase()
        val pkg = context.packageName
        return when {
            m.contains("xiaomi") || m.contains("redmi") || m.contains("poco") -> listOf(
                component("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"),
                Intent("miui.intent.action.OP_AUTO_START")
                    .addCategory(Intent.CATEGORY_DEFAULT)
                    .putExtra("extra_pkgname", pkg),
                Intent("miui.intent.action.POWER_HIDE_MODE_APP_LIST"),
                component("com.miui.securitycenter", "com.miui.powercenter.PowerSettings"),
                component(
                    "com.miui.powerkeeper",
                    "com.miui.powerkeeper.ui.HiddenAppsConfigActivity",
                    mapOf("package_name" to pkg, "package_label" to appLabel(context)),
                ),
            )
            m.contains("oneplus") -> listOf(
                component("com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity"),
                component("com.oplus.battery", "com.oplus.powermanager.fuelgaue.PowerUsageModelActivity"),
                component("com.oplus.battery", "com.oplus.startupapp.view.StartupAppListActivity"),
                component("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
                component("com.coloros.oppoguardelf", "com.coloros.powermanager.fuelgaue.PowerUsageModelActivity"),
            )
            m.contains("oppo") || m.contains("realme") -> listOf(
                component("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
                component("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"),
                component("com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"),
                component("com.oplus.battery", "com.oplus.startupapp.view.StartupAppListActivity"),
                component("com.coloros.oppoguardelf", "com.coloros.powermanager.fuelgaue.PowerUsageModelActivity"),
                component("com.oplus.battery", "com.oplus.powermanager.fuelgaue.PowerUsageModelActivity"),
            )
            m.contains("vivo") || m.contains("iqoo") -> listOf(
                component("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"),
                component("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity"),
                component("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.PurviewTabActivity"),
                component("com.vivo.abeui", "com.vivo.abeui.manager.VivoAutoLaunchManagerActivity"),
            )
            m.contains("honor") -> listOf(
                component("com.hihonor.systemmanager", "com.hihonor.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
                component("com.hihonor.systemmanager", "com.hihonor.systemmanager.appcontrol.activity.StartupAppControlActivity"),
                component("com.hihonor.systemmanager", "com.hihonor.systemmanager.optimize.process.ProtectActivity"),
            )
            m.contains("huawei") -> listOf(
                component("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
                component("com.huawei.systemmanager", "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity"),
                component("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity"),
            )
            m.contains("infinix") || m.contains("tecno") || m.contains("itel") || m.contains("transsion") -> listOf(
                // Modern XOS (Android 12+) moved autostart into system Settings
                // behind APPBOOTSERB; older Transsion builds used the legacy
                // activities below. Missing or exported=false targets (verified
                // on XOS/Android 16) fall through automatically via try/catch.
                Intent("android.settings.APPBOOTSERB").addCategory(Intent.CATEGORY_DEFAULT),
                component("com.android.settings", "transsion.tranapplicationofquick.AppBootserActivity"),
                component("com.transsion.phonemaster", "com.cyin.himgr.autostart.AutoStartActivity"),
                component("com.transsion.phonemaster", "com.cyin.himgr.applicationmanager.view.activities.AutoStartActivity"),
                component("com.transsion.phonemanager", "com.itel.autobootmanager.activity.AutoBootMgrActivity"),
                component("com.mediatek.autobootcontroller", "com.mediatek.autobootcontroller.AutoBootAppManageActivity"),
            )
            m.contains("samsung") -> listOf(
                // Official One UI deeplink (activity_type: 2 = never sleeping).
                Intent("com.samsung.android.sm.ACTION_OPEN_CHECKABLE_LISTACTIVITY")
                    .setPackage("com.samsung.android.lool")
                    .putExtra("activity_type", 2),
                component("com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity"),
                component("com.samsung.android.sm_cn", "com.samsung.android.sm_cn.autorun.ui.AutoRunActivity"),
            )
            else -> emptyList()
        }
    }

    fun getManufacturer(): String = Build.MANUFACTURER

    fun openAppSettings(context: Context) {
        openFirstWorking(context, buildAppSettingsIntent(context))
    }
}
