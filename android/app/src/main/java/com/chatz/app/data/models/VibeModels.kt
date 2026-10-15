package com.chatz.app.data.models

data class AppUsageStat(
    val packageName: String = "",
    val appName: String = "",
    val usageMs: Long = 0L
)

data class ConnectivityInfo(
    val isConnected: Boolean = false,
    val isOnWifi: Boolean = false,
    val isOnMobile: Boolean = false,
    val ssid: String? = null
)

data class VibeData(
    val uid: String = "",
    val screenTimeTodayMs: Long = 0L,
    val topApps: List<AppUsageStat> = emptyList(),
    val launchCount: Int = 0,
    val notificationCount: Int = 0,
    val deviceModel: String = "",
    val androidVersion: String = "",
    val wifiDataUsedBytes: Long = 0L,
    val mobileDataUsedBytes: Long = 0L,
    val isOnWifi: Boolean = false,
    val isOnMobile: Boolean = false,
    val maskedSsid: String? = null,
    val batteryPercent: Int = 0,
    val isCharging: Boolean = false
)
