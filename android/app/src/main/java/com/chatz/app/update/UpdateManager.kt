package com.chatz.app.update

import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.util.Log
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Source
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * Core update manager that fetches Firestore metadata, compares version codes,
 * manages local cache with 6-hour cooldown, and validates APK integrity.
 */
class UpdateManager(private val context: Context) {

    companion object {
        private const val TAG = "UpdateManager"
        private const val PREFS_NAME = "ChatZPrefs"
        private const val CACHE_KEY_METADATA = "update_metadata_cache"
        private const val CACHE_KEY_TIMESTAMP = "update_cache_timestamp"
        private const val CACHE_KEY_LAST_NOTIFIED_VERSION = "update_last_notified_version"
        // 2h keeps a published update visible on the next cold start soon after
        // release while still collapsing app-spam restarts into one network read.
        private const val COOLDOWN_HOURS = 2L
        private const val DOWNLOAD_TIMEOUT_MS = 30_000L

        // Metadata field names in Firestore document appConfig/updateMetadata
        private const val FIELD_LATEST_VERSION_CODE = "latestVersionCode"
        private const val FIELD_LATEST_VERSION_NAME = "latestVersionName"
        private const val FIELD_MIN_SUPPORTED_VERSION_CODE = "minimumSupportedVersionCode"
        private const val FIELD_DOWNLOAD_URL = "downloadUrl"
        private const val FIELD_SHA256 = "sha256"
        private const val FIELD_TITLE = "title"
        private const val FIELD_DESCRIPTION = "description"
        private const val FIELD_RELEASE_DATE = "releaseDate"
        private const val FIELD_MANDATORY = "mandatory"
        private const val FIELD_CHANGES = "changes"
    }

    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /**
     * Check for updates with cooldown logic. Returns UpdateState based on
     * current version vs latest metadata from Firestore.
     *
     * @param forceCheck If true, bypasses cooldown cache (used for manual "Check for updates")
     * @return UpdateState indicating current status
     */
    suspend fun checkForUpdates(forceCheck: Boolean = false): UpdateState =
        withContext(Dispatchers.IO) {
            try {
                // Get version code from PackageInfo (BuildConfig not available in Kotlin)
                val packageInfo = try {
                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
                        context.packageManager.getPackageInfo(
                            context.packageName,
                            PackageManager.PackageInfoFlags.of(0)
                        )
                    } else {
                        @Suppress("DEPRECATION")
                        context.packageManager.getPackageInfo(context.packageName, 0)
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to get package info", e)
                    return@withContext UpdateState.CHECK_FAILED("Cannot determine app version")
                }
                
                val currentVersionCode = packageInfo.longVersionCode.toInt()
                Log.d(TAG, "Current version code: $currentVersionCode")

                // Fetch metadata (from cache or network)
                val metadata = fetchMetadata(forceCheck)
                    ?: return@withContext UpdateState.CHECK_FAILED("No update metadata available")

                // Validate required fields
                if (!validateMetadata(metadata)) {
                    return@withContext UpdateState.CHECK_FAILED("Malformed update metadata")
                }

                val latestVersionCode = metadata[FIELD_LATEST_VERSION_CODE] as? Long ?: 0L
                val minSupportedVersionCode = metadata[FIELD_MIN_SUPPORTED_VERSION_CODE] as? Long ?: 0L
                val downloadUrl = metadata[FIELD_DOWNLOAD_URL] as? String ?: ""
                val sha256 = metadata[FIELD_SHA256] as? String ?: ""
                val title = metadata[FIELD_TITLE] as? String ?: ""
                val description = metadata[FIELD_DESCRIPTION] as? String ?: ""
                val releaseDate = metadata[FIELD_RELEASE_DATE] as? String ?: ""
                val mandatory = metadata[FIELD_MANDATORY] as? Boolean ?: false
                val changes = (metadata[FIELD_CHANGES] as? List<*>)?.filterIsInstance<String>() ?: emptyList()

                // Mandatory update blocks access regardless of current version
                if (mandatory && currentVersionCode < minSupportedVersionCode) {
                    return@withContext UpdateState.MANDATORY_UPDATE(
                        UpdateInfo(
                            latestVersionCode = latestVersionCode.toInt(),
                            latestVersionName = metadata[FIELD_LATEST_VERSION_NAME] as? String ?: "",
                            downloadUrl = downloadUrl,
                            sha256 = sha256,
                            title = title,
                            description = description,
                            releaseDate = releaseDate,
                            changes = changes,
                            isMandatory = true
                        )
                    )
                }

                // Optional update available
                if (currentVersionCode < latestVersionCode) {
                    return@withContext UpdateState.OPTIONAL_UPDATE(
                        UpdateInfo(
                            latestVersionCode = latestVersionCode.toInt(),
                            latestVersionName = metadata[FIELD_LATEST_VERSION_NAME] as? String ?: "",
                            downloadUrl = downloadUrl,
                            sha256 = sha256,
                            title = title,
                            description = description,
                            releaseDate = releaseDate,
                            changes = changes,
                            isMandatory = false
                        )
                    )
                }

                // Up to date
                UpdateState.UP_TO_DATE
            } catch (e: Exception) {
                Log.e(TAG, "Update check failed: ${e.javaClass.simpleName}", e)
                UpdateState.CHECK_FAILED(e.localizedMessage ?: "Unknown error")
            }
        }

    /**
     * Download APK file from URL to app cache directory with progress tracking.
     * Returns File reference to downloaded APK.
     */
    suspend fun downloadApk(downloadUrl: String, onProgress: (Int) -> Unit = {}): Result<File> =
        withContext(Dispatchers.IO) {
            try {
                Log.d(TAG, "Downloading APK from: $downloadUrl")

                // Enforce HTTPS only
                if (!downloadUrl.startsWith("https://")) {
                    return@withContext Result.failure(IllegalStateException("Download URL must use HTTPS"))
                }

                val connection = URL(downloadUrl).openConnection() as HttpURLConnection
                connection.requestMethod = "GET"
                connection.connectTimeout = DOWNLOAD_TIMEOUT_MS.toInt()
                connection.readTimeout = DOWNLOAD_TIMEOUT_MS.toInt()
                connection.instanceFollowRedirects = true
                connection.connect()

                val responseCode = connection.responseCode
                if (responseCode != HttpURLConnection.HTTP_OK) {
                    return@withContext Result.failure(IllegalStateException("HTTP $responseCode"))
                }

                val contentLength = connection.contentLengthLong
                val inputStream = connection.inputStream

                // Create temp file in cache directory
                val cacheDir = context.cacheDir
                val apkFile = File(cacheDir, "chatz_update_${System.currentTimeMillis()}.apk")

                val outputStream = apkFile.outputStream()
                val buffer = ByteArray(8192)
                var bytesRead: Int
                var totalBytesRead = 0L

                while (inputStream.read(buffer).also { bytesRead = it } != -1) {
                    outputStream.write(buffer, 0, bytesRead)
                    totalBytesRead += bytesRead
                    if (contentLength > 0) {
                        val progress = ((totalBytesRead * 100) / contentLength).toInt()
                        onProgress(progress)
                    }
                }

                outputStream.flush()
                outputStream.close()
                inputStream.close()
                connection.disconnect()

                Log.d(TAG, "APK downloaded: ${apkFile.absolutePath} (${totalBytesRead} bytes)")
                Result.success(apkFile)
            } catch (e: Exception) {
                Log.e(TAG, "Download failed: ${e.javaClass.simpleName}", e)
                Result.failure(e)
            }
        }

    /**
     * Verify SHA-256 checksum of downloaded APK against expected hash.
     * Returns true if checksum matches.
     */
    suspend fun verifyChecksum(apkFile: File, expectedSha256: String): Boolean =
        withContext(Dispatchers.IO) {
            try {
                if (expectedSha256.isBlank()) {
                    Log.w(TAG, "Empty SHA-256 provided, skipping verification")
                    return@withContext false
                }

                val digest = MessageDigest.getInstance("SHA-256")
                val inputStream = apkFile.inputStream()
                val buffer = ByteArray(8192)
                var bytesRead: Int

                while (inputStream.read(buffer).also { bytesRead = it } != -1) {
                    digest.update(buffer, 0, bytesRead)
                }
                inputStream.close()

                val actualHash = digest.digest().joinToString("") { "%02x".format(it) }
                val matches = actualHash.equals(expectedSha256, ignoreCase = true)

                Log.d(TAG, "SHA-256 verification: ${if (matches) "PASS" else "FAIL"}")
                Log.d(TAG, "Expected: $expectedSha256")
                Log.d(TAG, "Actual:   $actualHash")

                if (!matches) {
                    // Delete corrupted APK
                    apkFile.delete()
                    Log.w(TAG, "Deleted APK due to checksum mismatch")
                }

                matches
            } catch (e: Exception) {
                Log.e(TAG, "Checksum verification failed: ${e.javaClass.simpleName}", e)
                false
            }
        }

    /**
     * Get last notified version code to prevent duplicate notifications.
     */
    fun getLastNotifiedVersion(): Int =
        prefs.getInt(CACHE_KEY_LAST_NOTIFIED_VERSION, 0)

    /**
     * Record that notification was shown for a specific version.
     */
    fun setLastNotifiedVersion(versionCode: Int) {
        prefs.edit().putInt(CACHE_KEY_LAST_NOTIFIED_VERSION, versionCode).apply()
    }

    /**
     * Start listening to Firestore metadata changes in real-time.
     * Calls onMetadataChanged callback whenever the document is updated.
     * Returns a ListenerRegistration that can be removed to stop listening.
     */
    fun listenForUpdates(onMetadataChanged: (Map<String, Any>) -> Unit): com.google.firebase.firestore.ListenerRegistration {
        val db = FirebaseFirestore.getInstance()
        val docRef = db.collection("appConfig").document("updateMetadata")

        return docRef.addSnapshotListener { snapshot, error ->
            if (error != null) {
                Log.e(TAG, "Real-time listener error: ${error.javaClass.simpleName}", error)
                return@addSnapshotListener
            }

            if (snapshot != null && snapshot.exists()) {
                val data = snapshot.data
                if (data != null && validateMetadata(data)) {
                    Log.d(TAG, "Real-time metadata update detected")
                    cacheMetadata(data)
                    onMetadataChanged(data)
                }
            }
        }
    }

    /**
     * Clear cached metadata (used when user manually checks for updates).
     */
    fun clearCache() {
        prefs.edit()
            .remove(CACHE_KEY_METADATA)
            .remove(CACHE_KEY_TIMESTAMP)
            .apply()
        Log.d(TAG, "Update cache cleared")
    }

    /**
     * Fetch update metadata from Firestore, respecting cache cooldown unless forced.
     */
    private suspend fun fetchMetadata(forceCheck: Boolean): Map<String, Any>? {
        // Check cache first (unless forced)
        if (!forceCheck) {
            val cachedTimestamp = prefs.getLong(CACHE_KEY_TIMESTAMP, 0L)
            val now = System.currentTimeMillis()
            val cooldownMs = TimeUnit.HOURS.toMillis(COOLDOWN_HOURS)

            if (now - cachedTimestamp < cooldownMs) {
                val cachedJson = prefs.getString(CACHE_KEY_METADATA, null)
                if (cachedJson != null) {
                    Log.d(TAG, "Using cached metadata (${(now - cachedTimestamp) / 1000}s old)")
                    return parseCachedMetadata(cachedJson)
                }
            }
        }

        // Fetch from Firestore
        Log.d(TAG, "Fetching update metadata from Firestore")
        return try {
            val db = FirebaseFirestore.getInstance()
            val docRef = db.collection("appConfig").document("updateMetadata")

            // Use SERVER source to detect offline state immediately
            val snapshot = docRef.get(Source.SERVER).await()

            if (!snapshot.exists()) {
                Log.w(TAG, "Update metadata document not found")
                return null
            }

            val data = snapshot.data ?: return null

            // Cache the metadata
            cacheMetadata(data)

            data
        } catch (e: Exception) {
            Log.e(TAG, "Firestore fetch failed: ${e.javaClass.simpleName}", e)
            // Return cached data as fallback if available
            val cachedJson = prefs.getString(CACHE_KEY_METADATA, null)
            if (cachedJson != null) {
                Log.d(TAG, "Using stale cache as fallback")
                return parseCachedMetadata(cachedJson)
            }
            null
        }
    }

    /**
     * Parse cached metadata JSON string back to Map.
     */
    private fun parseCachedMetadata(json: String): Map<String, Any>? {
        return try {
            val obj = JSONObject(json)
            val map = mutableMapOf<String, Any>()

            // Extract fields from JSONObject
            if (obj.has(FIELD_LATEST_VERSION_CODE)) {
                map[FIELD_LATEST_VERSION_CODE] = obj.getLong(FIELD_LATEST_VERSION_CODE)
            }
            if (obj.has(FIELD_LATEST_VERSION_NAME)) {
                map[FIELD_LATEST_VERSION_NAME] = obj.getString(FIELD_LATEST_VERSION_NAME)
            }
            if (obj.has(FIELD_MIN_SUPPORTED_VERSION_CODE)) {
                map[FIELD_MIN_SUPPORTED_VERSION_CODE] = obj.getLong(FIELD_MIN_SUPPORTED_VERSION_CODE)
            }
            if (obj.has(FIELD_DOWNLOAD_URL)) {
                map[FIELD_DOWNLOAD_URL] = obj.getString(FIELD_DOWNLOAD_URL)
            }
            if (obj.has(FIELD_SHA256)) {
                map[FIELD_SHA256] = obj.getString(FIELD_SHA256)
            }
            if (obj.has(FIELD_TITLE)) {
                map[FIELD_TITLE] = obj.getString(FIELD_TITLE)
            }
            if (obj.has(FIELD_DESCRIPTION)) {
                map[FIELD_DESCRIPTION] = obj.getString(FIELD_DESCRIPTION)
            }
            if (obj.has(FIELD_RELEASE_DATE)) {
                map[FIELD_RELEASE_DATE] = obj.getString(FIELD_RELEASE_DATE)
            }
            if (obj.has(FIELD_MANDATORY)) {
                map[FIELD_MANDATORY] = obj.getBoolean(FIELD_MANDATORY)
            }
            if (obj.has(FIELD_CHANGES)) {
                val changesArray = obj.getJSONArray(FIELD_CHANGES)
                val changes = mutableListOf<String>()
                for (i in 0 until changesArray.length()) {
                    changes.add(changesArray.getString(i))
                }
                map[FIELD_CHANGES] = changes
            }

            map
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse cached metadata", e)
            null
        }
    }

    /**
     * Cache metadata to SharedPreferences with timestamp.
     */
    private fun cacheMetadata(data: Map<String, Any>) {
        try {
            val json = serializeMetadata(data)
            prefs.edit()
                .putString(CACHE_KEY_METADATA, json)
                .putLong(CACHE_KEY_TIMESTAMP, System.currentTimeMillis())
                .apply()
            Log.d(TAG, "Metadata cached successfully")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to cache metadata", e)
        }
    }

    /**
     * Serialize metadata Map to JSON string.
     */
    private fun serializeMetadata(data: Map<String, Any>): String {
        val obj = JSONObject()
        for ((key, value) in data) {
            when (value) {
                is String -> obj.put(key, value)
                is Long -> obj.put(key, value)
                is Int -> obj.put(key, value)
                is Boolean -> obj.put(key, value)
                is List<*> -> {
                    val array = JSONArray()
                    for (item in value) {
                        if (item is String) array.put(item)
                    }
                    obj.put(key, array)
                }
            }
        }
        return obj.toString()
    }

    /**
     * Validate that all required metadata fields are present and valid.
     */
    private fun validateMetadata(metadata: Map<String, Any>): Boolean {
        val requiredFields = listOf(
            FIELD_LATEST_VERSION_CODE,
            FIELD_LATEST_VERSION_NAME,
            FIELD_MIN_SUPPORTED_VERSION_CODE,
            FIELD_DOWNLOAD_URL,
            FIELD_SHA256,
            FIELD_TITLE
        )

        for (field in requiredFields) {
            if (!metadata.containsKey(field) || metadata[field].toString().isBlank()) {
                Log.w(TAG, "Missing or blank required field: $field")
                return false
            }
        }

        // Validate version codes are numeric
        val latestCode = metadata[FIELD_LATEST_VERSION_CODE] as? Long
        val minCode = metadata[FIELD_MIN_SUPPORTED_VERSION_CODE] as? Long
        if (latestCode == null || minCode == null || latestCode <= 0 || minCode <= 0) {
            Log.w(TAG, "Invalid version codes")
            return false
        }

        // Validate download URL format
        val url = metadata[FIELD_DOWNLOAD_URL] as? String
        if (url.isNullOrBlank() || !url.startsWith("https://")) {
            Log.w(TAG, "Invalid download URL")
            return false
        }

        // Validate SHA-256 format (64 hex characters)
        val sha256 = metadata[FIELD_SHA256] as? String
        if (sha256.isNullOrBlank() || !sha256.matches(Regex("^[a-fA-F0-9]{64}$"))) {
            Log.w(TAG, "Invalid SHA-256 format")
            return false
        }

        return true
    }
}

/**
 * Represents the current update state after checking.
 */
sealed class UpdateState {
    object UP_TO_DATE : UpdateState()
    data class OPTIONAL_UPDATE(val info: UpdateInfo) : UpdateState()
    data class MANDATORY_UPDATE(val info: UpdateInfo) : UpdateState()
    data class CHECK_FAILED(val reason: String) : UpdateState()
}

/**
 * Update information payload.
 */
data class UpdateInfo(
    val latestVersionCode: Int,
    val latestVersionName: String,
    val downloadUrl: String,
    val sha256: String,
    val title: String,
    val description: String,
    val releaseDate: String,
    val changes: List<String>,
    val isMandatory: Boolean
)
