package com.chatz.app.plugin

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import com.chatz.app.update.UpdateInfo
import com.chatz.app.update.UpdateManager
import com.chatz.app.update.UpdateState
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONArray
import java.io.File

@CapacitorPlugin(name = "UpdatePlugin")
class UpdatePlugin : Plugin() {

    private lateinit var updateManager: UpdateManager
    private val scope = CoroutineScope(Dispatchers.Main)
    private var firestoreListener: com.google.firebase.firestore.ListenerRegistration? = null

    override fun load() {
        super.load()
        updateManager = UpdateManager(context)
    }

    /**
     * Check for updates with optional force flag to bypass cooldown.
     * Returns update state and metadata if available.
     */
    @PluginMethod
    fun checkForUpdates(call: PluginCall) {
        val forceCheck = call.getBoolean("force", false) ?: false

        scope.launch(Dispatchers.IO) {
            val state = updateManager.checkForUpdates(forceCheck)

            val result = JSObject()
            when (state) {
                is UpdateState.UP_TO_DATE -> {
                    result.put("status", "up_to_date")
                    result.put("hasUpdate", false)
                }
                is UpdateState.OPTIONAL_UPDATE -> {
                    result.put("status", "optional_update")
                    result.put("hasUpdate", true)
                    result.put("isMandatory", false)
                    result.put("updateInfo", buildUpdateInfoJson(state.info))
                }
                is UpdateState.MANDATORY_UPDATE -> {
                    result.put("status", "mandatory_update")
                    result.put("hasUpdate", true)
                    result.put("isMandatory", true)
                    result.put("updateInfo", buildUpdateInfoJson(state.info))
                }
                is UpdateState.CHECK_FAILED -> {
                    result.put("status", "check_failed")
                    result.put("hasUpdate", false)
                    result.put("error", state.reason)
                }
            }

            call.resolve(result)
        }
    }

    /**
     * Download APK from provided URL with progress callbacks.
     * Progress values range from 0-100.
     */
    @PluginMethod
    fun downloadApk(call: PluginCall) {
        val downloadUrl = call.getString("url")
            ?: return call.reject("Download URL is required")

        scope.launch(Dispatchers.IO) {
            val result = updateManager.downloadApk(downloadUrl) { progress ->
                // Send progress updates via callback
                val progressData = JSObject()
                progressData.put("progress", progress)
                notifyListeners("downloadProgress", progressData)
            }

            result.onSuccess { apkFile ->
                val response = JSObject()
                response.put("success", true)
                response.put("apkPath", apkFile.absolutePath)
                call.resolve(response)
            }.onFailure { error ->
                val response = JSObject()
                response.put("success", false)
                response.put("error", error.localizedMessage ?: "Download failed")
                call.resolve(response)
            }
        }
    }

    /**
     * Verify SHA-256 checksum of downloaded APK.
     */
    @PluginMethod
    fun verifyChecksum(call: PluginCall) {
        val apkPath = call.getString("apkPath")
            ?: return call.reject("APK path is required")
        val expectedSha256 = call.getString("sha256")
            ?: return call.reject("SHA-256 hash is required")

        scope.launch(Dispatchers.IO) {
            val apkFile = File(apkPath)
            if (!apkFile.exists()) {
                val response = JSObject()
                response.put("valid", false)
                response.put("error", "APK file not found")
                call.resolve(response)
                return@launch
            }

            val isValid = updateManager.verifyChecksum(apkFile, expectedSha256)
            val response = JSObject()
            response.put("valid", isValid)
            call.resolve(response)
        }
    }

    /**
     * Install APK using Android PackageInstaller API.
     * Requires REQUEST_INSTALL_PACKAGES permission on Android 8+.
     */
    @PluginMethod
    fun installApk(call: PluginCall) {
        val apkPath = call.getString("apkPath")
            ?: return call.reject("APK path is required")

        scope.launch(Dispatchers.Main) {
            try {
                val apkFile = File(apkPath)
                if (!apkFile.exists()) {
                    call.reject("APK file not found at: $apkPath")
                    return@launch
                }

                // Create content URI via FileProvider
                val authority = "${context.packageName}.fileprovider"
                val contentUri = FileProvider.getUriForFile(
                    context,
                    authority,
                    apkFile
                )

                // Build install intent
                val installIntent = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(contentUri, "application/vnd.android.package-archive")
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }

                // Check if device can handle the intent
                val packageManager = context.packageManager
                if (installIntent.resolveActivity(packageManager) != null) {
                    context.startActivity(installIntent)
                    call.resolve(JSObject().apply { put("success", true) })
                } else {
                    call.reject("No activity found to handle APK installation")
                }
            } catch (e: Exception) {
                call.reject("Installation failed: ${e.localizedMessage}")
            }
        }
    }

    /**
     * Check if app has permission to install unknown apps.
     * Required on Android 8+ for sideloading.
     */
    @PluginMethod
    fun canInstallUnknownApps(call: PluginCall) {
        val canInstall = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.packageManager.canRequestPackageInstalls()
        } else {
            // Pre-Oreo doesn't have this restriction
            true
        }

        call.resolve(JSObject().apply {
            put("canInstall", canInstall)
            put("needsPermission", !canInstall)
        })
    }

    /**
     * Open system settings to grant INSTALL_UNKNOWN_APPS permission.
     */
    @PluginMethod
    fun openInstallPermissionSettings(call: PluginCall) {
        try {
            val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
                    data = Uri.parse("package:${context.packageName}")
                }
            } else {
                // Fallback for older versions
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.fromParts("package", context.packageName, null)
                }
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            call.resolve()
        } catch (e: Exception) {
            call.reject("Failed to open settings: ${e.localizedMessage}")
        }
    }

    /**
     * Get last notified version code to prevent duplicate notifications.
     */
    @PluginMethod
    fun getLastNotifiedVersion(call: PluginCall) {
        val versionCode = updateManager.getLastNotifiedVersion()
        call.resolve(JSObject().apply {
            put("versionCode", versionCode)
        })
    }

    /**
     * Record that notification was shown for a specific version.
     */
    @PluginMethod
    fun setLastNotifiedVersion(call: PluginCall) {
        val versionCode = call.getInt("versionCode", 0) ?: 0
        updateManager.setLastNotifiedVersion(versionCode)
        call.resolve()
    }

    /**
     * Clear cached update metadata (used for manual checks).
     */
    @PluginMethod
    fun clearCache(call: PluginCall) {
        updateManager.clearCache()
        call.resolve()
    }

    /**
     * Start real-time Firestore listener for update metadata changes.
     * Emits 'updateMetadataChanged' event when new version is published.
     */
    @PluginMethod
    fun startRealtimeListener(call: PluginCall) {
        // Remove existing listener if any
        stopRealtimeListener()

        firestoreListener = updateManager.listenForUpdates { metadata ->
            // Notify JavaScript that metadata changed
            val eventData = JSObject().apply {
                put("latestVersionCode", metadata["latestVersionCode"] as? Long ?: 0L)
                put("latestVersionName", metadata["latestVersionName"] as? String ?: "")
                put("isMandatory", metadata["mandatory"] as? Boolean ?: false)
            }
            notifyListeners("updateMetadataChanged", eventData)
        }

        call.resolve(JSObject().apply {
            put("success", true)
        })
    }

    /**
     * Stop real-time Firestore listener to prevent resource leaks.
     */
    @PluginMethod
    fun stopRealtimeListener(call: PluginCall) {
        stopRealtimeListener()
        call.resolve()
    }

    private fun stopRealtimeListener() {
        firestoreListener?.remove()
        firestoreListener = null
    }

    override fun handleOnDestroy() {
        super.handleOnDestroy()
        stopRealtimeListener()
    }

    /**
     * Build JSON object from UpdateInfo for JavaScript consumption.
     */
    private fun buildUpdateInfoJson(info: UpdateInfo): JSObject {
        return JSObject().apply {
            put("latestVersionCode", info.latestVersionCode)
            put("latestVersionName", info.latestVersionName)
            put("downloadUrl", info.downloadUrl)
            put("sha256", info.sha256)
            put("title", info.title)
            put("description", info.description)
            put("releaseDate", info.releaseDate)
            put("isMandatory", info.isMandatory)

            // Convert changes list to JSONArray
            val changesArray = JSArray()
            for (change in info.changes) {
                changesArray.put(change)
            }
            put("changes", changesArray)
        }
    }
}
