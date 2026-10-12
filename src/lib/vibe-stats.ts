import { registerPlugin } from "@capacitor/core";

export interface AppUsageStat {
  packageName: string;
  appName: string;
  usageMs: number;
}

export interface VibeStatsData {
  uid: string;
  screenTimeTodayMs: number;
  screenTimeFormatted: string;
  topApps: AppUsageStat[];
  launchCount: number;
  notificationCount: number;
  deviceModel: string;
  androidVersion: string;
  wifiDataUsedBytes: number;
  wifiDataFormatted: string;
  mobileDataUsedBytes: number;
  mobileDataFormatted: string;
  isOnWifi: boolean;
  isOnMobile: boolean;
  maskedSsid: string;
  batteryPercent: number;
  isCharging: boolean;
}

export interface PrivacySettingsParams {
  /** Account the settings belong to — native prefs are stored per uid. */
  uid: string;
  /** "silent" pauses all stat sharing; individual toggles define active sharing. */
  mode: "active" | "silent";
  shareScreenTime: boolean;
  shareDataUsage: boolean;
  shareWifiStatus: boolean;
  shareMostUsedApps: boolean;
  shareLaunches: boolean;
  shareNotifications: boolean;
  shareDeviceInfo: boolean;
  shareBattery: boolean;
}

export interface VibeStatsPlugin {
  checkUsageAccess(): Promise<{ granted: boolean }>;
  requestUsageAccess(): Promise<void>;
  collectStats(): Promise<VibeStatsData>;
  startBackgroundSync(): Promise<void>;
  stopBackgroundSync(): Promise<void>;
  getManufacturer(): Promise<{ manufacturer: string }>;
  requestBatteryOptimization(): Promise<void>;
  /** True when ChatZ is exempt from battery optimization (background sync can run). */
  checkBatteryOptimization(): Promise<{ granted: boolean }>;
  openAppSettings(): Promise<void>;
  /** Push privacy toggles to native so the background worker respects them. */
  setPrivacySettings(settings: PrivacySettingsParams): Promise<void>;
  /** Open a specific Android Settings screen by action key (notifications, usage, location, camera, mic, data). */
  openSettings(options: { action: string }): Promise<void>;
  /** Request a runtime permission by action key. Returns granted status. */
  requestPermission(options: {
    action: string;
  }): Promise<{ granted: boolean; needsSettings: boolean }>;
  /** Check if a runtime permission is currently granted. */
  checkPermission(options: {
    action: string;
  }): Promise<{ granted: boolean; needsSettings: boolean }>;
  /**
   * Native Google Sign-In. Signs the *native* Firebase Auth instance in and returns
   * the ID token so the JS instance can sign in as the same account.
   */
  signInWithGoogle(): Promise<{ idToken: string }>;
  /**
   * Mirror the current WebView session into the native instance — same account, no
   * UI. Used on cold start, where the JS SDK has restored a session that the native
   * instance does not hold yet.
   *
   * The native SDK only accepts a Google-issued ID token, which a restored session
   * cannot mint, so this is a silent Google sign-in. Resolves with "" when nothing
   * could be adopted (the worker then simply skips); it does not reject for a miss.
   */
  adoptExistingSession(options: { uid: string; email: string }): Promise<{ uid: string }>;
  /** uid the native Firebase Auth instance is signed in as, or "" when signed out. */
  getNativeAuthUid(): Promise<{ uid: string }>;
  /** Sign the native Firebase Auth instance out. */
  signOutNative(): Promise<void>;
  /**
   * Post a system notification for an in-app social event (message, reaction,
   * comment, friend request). `channel` picks the Android channel: "message"
   * gets heads-up treatment, "social" lands quietly in the shade.
   */
  notify(options: {
    id: string;
    title: string;
    body: string;
    channel?: "message" | "social";
  }): Promise<{ shown: boolean; reason?: string }>;
  /**
   * FCM registration token for this device, or "" when messaging is
   * unavailable. The JS layer stores it on the user doc so the chatz-push
   * Worker can reach the device when this app's process is frozen or killed.
   */
  getFcmToken(): Promise<{ token: string }>;
}

const VibeStats = registerPlugin<VibeStatsPlugin>("VibeStats", {
  web: () => import("./vibe-stats.web").then((m) => new m.VibeStatsWeb()),
});

export { VibeStats };
