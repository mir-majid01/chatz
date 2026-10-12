import type { PrivacySettingsParams, VibeStatsData, VibeStatsPlugin } from "./vibe-stats";

export class VibeStatsWeb implements VibeStatsPlugin {
  async checkUsageAccess(): Promise<{ granted: boolean }> {
    return { granted: false };
  }

  async requestUsageAccess(): Promise<void> {
    console.warn("[VibeStats] Usage Access not available on web");
  }

  async collectStats(): Promise<VibeStatsData> {
    return {
      uid: "",
      screenTimeTodayMs: 0,
      screenTimeFormatted: "0m",
      topApps: [],
      launchCount: 0,
      notificationCount: 0,
      deviceModel: "",
      androidVersion: "",
      wifiDataUsedBytes: 0,
      wifiDataFormatted: "0 MB",
      mobileDataUsedBytes: 0,
      mobileDataFormatted: "0 MB",
      isOnWifi: false,
      isOnMobile: false,
      maskedSsid: "",
      batteryPercent: 0,
      isCharging: false,
    };
  }

  async startBackgroundSync(): Promise<void> {
    console.warn("[VibeStats] Background sync not available on web");
  }

  async stopBackgroundSync(): Promise<void> {
    console.warn("[VibeStats] Background sync not available on web");
  }

  async getManufacturer(): Promise<{ manufacturer: string }> {
    return { manufacturer: "web" };
  }

  async requestBatteryOptimization(): Promise<void> {
    console.warn("[VibeStats] Battery optimization not available on web");
  }

  async checkBatteryOptimization(): Promise<{ granted: boolean }> {
    // No battery optimizer on web — report as exempt so the checklist is not stuck.
    return { granted: true };
  }

  async openAppSettings(): Promise<void> {
    console.warn("[VibeStats] Open App Settings not available on web");
  }

  async setPrivacySettings(settings: PrivacySettingsParams): Promise<void> {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(`chatZ:privacy:${settings.uid}`, JSON.stringify(settings));
    }
  }

  async openSettings({ action }: { action: string }): Promise<void> {
    console.warn("[VibeStats] openSettings not available on web", action);
  }

  async requestPermission({
    action,
  }: {
    action: string;
  }): Promise<{ granted: boolean; needsSettings: boolean }> {
    console.warn("[VibeStats] requestPermission not available on web", action);
    return { granted: false, needsSettings: true };
  }

  async checkPermission({
    action,
  }: {
    action: string;
  }): Promise<{ granted: boolean; needsSettings: boolean }> {
    console.warn("[VibeStats] checkPermission not available on web", action);
    return { granted: false, needsSettings: false };
  }

  async signInWithGoogle(): Promise<{ idToken: string }> {
    throw new Error("Native Google Sign-In not available on web");
  }

  // There is no second Firebase instance on web, so nothing to mirror.
  async adoptExistingSession(): Promise<{ uid: string }> {
    return { uid: "" };
  }

  async getNativeAuthUid(): Promise<{ uid: string }> {
    return { uid: "" };
  }

  async signOutNative(): Promise<void> {
    // No native Firebase instance on web.
  }

  async notify(): Promise<{ shown: boolean; reason?: string }> {
    // Browsers have their own Notification API; the web build intentionally
    // stays silent so previews never pop OS notifications.
    return { shown: false, reason: "unsupported" };
  }

  async getFcmToken(): Promise<{ token: string }> {
    return { token: "" };
  }
}
