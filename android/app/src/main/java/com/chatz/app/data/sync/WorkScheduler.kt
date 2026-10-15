package com.chatz.app.data.sync

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

object WorkScheduler {

    private const val WORK_NAME = "VibeSyncWork"

    fun scheduleVibeSyncWork(context: Context) {
        // Network-only on purpose: no battery-not-low constraint (Android 12-15
        // battery saver and OEM battery panels mark devices "low" aggressively,
        // which would silently stretch a 15-minute sync to hours), no charging
        // requirement, no storage gate. The worker itself is idempotent and
        // fails closed, so running a bit more often is always safe.
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        val syncRequest = PeriodicWorkRequestBuilder<UsageStatsSyncWorker>(
            repeatInterval = 15,
            repeatIntervalTimeUnit = TimeUnit.MINUTES
        )
            .setConstraints(constraints)
            .setBackoffCriteria(
                BackoffPolicy.EXPONENTIAL,
                androidx.work.WorkRequest.MIN_BACKOFF_MILLIS,
                TimeUnit.MILLISECONDS
            )
            .addTag("vibe_sync")
            .build()

        // UPDATE (not REPLACE): re-evaluates constraints without resetting the
        // 15-minute window, so opening the app frequently never postpones the
        // next background run.
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            WORK_NAME,
            ExistingPeriodicWorkPolicy.UPDATE,
            syncRequest
        )
    }

    fun cancelVibeSyncWork(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
    }
}
