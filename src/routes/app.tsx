import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { applyTheme, DEFAULT_PRIVACY, readProfile, type Profile } from "@/lib/profile-store";
import { onAuthChange } from "@/lib/auth";
import { resolveSession, signOutEverywhere } from "@/lib/session";
import { syncLocalProfile } from "@/lib/profile-repo";
import { pushUsageSnapshot, setPresence } from "@/lib/usage-repo";
import { VibeStats } from "@/lib/vibe-stats";
import { allPermsGranted, checkAllPerms, type PermState } from "@/lib/app-permissions";
import { PermissionGate } from "@/components/PermissionGate";
import { ChatZMark } from "@/components/Logo";
import { Capacitor } from "@capacitor/core";
import { App as NativeApp } from "@capacitor/app";
import { Activity, RefreshCw, ShieldAlert, Users, User as UserIcon } from "lucide-react";
import { isChatUnread, useChatsOverview, useReadMarkers } from "@/lib/dm-repo";
import { useNotifs } from "@/lib/notifications-store";
import { UpdateScreen } from "@/components/UpdateScreen";
import { ConnectionStatus } from "@/components/ConnectionStatus";
import {
  checkForUpdates,
  getLastNotifiedVersion,
  listenForUpdates,
  setLastNotifiedVersion,
  type UpdateInfo,
} from "@/lib/update-repo";
import { claimStarterFrame } from "@/lib/frames-repo";
import { registerFcmToken } from "@/lib/push-repo";

export const Route = createFileRoute("/app")({
  component: AppShell,
});

/** Settings the app owns locally but still keeps on the Firestore profile. */
function syncable(p: Profile): string {
  return JSON.stringify({
    theme: p.theme,
    accent: p.accent,
    privacy: p.privacy,
    mode: p.mode ?? "active",
    socials: p.socials ?? {},
    goalHours: p.goalHours,
    color: p.color,
    avatarId: p.avatarId ?? null,
    frame: p.frame ?? null,
    frames: p.frames ?? [],
  });
}

function effectivePrivacy(p: Profile) {
  return { ...DEFAULT_PRIVACY, ...(p.privacy ?? {}) };
}

/** Keep the background worker's per-account privacy gates in step with the user. */
function pushPrivacy(p: Profile) {
  if (!Capacitor.isNativePlatform()) return;
  if (!p.uid) return;
  const privacy = effectivePrivacy(p);
  VibeStats.setPrivacySettings({
    uid: p.uid,
    mode: p.mode === "silent" ? "silent" : "active",
    shareScreenTime: privacy.showScreenTime,
    shareDataUsage: privacy.showData,
    shareWifiStatus: privacy.showWifi,
    shareMostUsedApps: privacy.showTopApp,
    shareLaunches: privacy.showLaunches,
    shareNotifications: privacy.showNotifications,
    shareDeviceInfo: privacy.showDeviceInfo,
    shareBattery: privacy.showBattery,
  }).catch(() => {});
}

const GATE_DISMISSED_KEY = "chatz.perms.gateDismissed";

function AppShell() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [blocked, setBlocked] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(false);
  const [perms, setPerms] = useState<PermState | null>(null);
  const [gateDismissed, setGateDismissed] = useState(() => {
    try {
      return localStorage.getItem(GATE_DISMISSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [presenceUid, setPresenceUid] = useState<string | null>(null);
  const [mode, setMode] = useState<"active" | "silent">("active");
  const resolvedRef = useRef(false);
  const uidRef = useRef<string | null>(null);
  const syncedRef = useRef<string | null>(null);
  const privacySigRef = useRef<string | null>(null);

  // Update check state
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [showUpdateScreen, setShowUpdateScreen] = useState(false);
  const [updateCheckComplete, setUpdateCheckComplete] = useState(false);
  const updateCheckedRef = useRef(false);
  const framesClaimedRef = useRef(false);

  /**
   * Privacy gates change both the native worker prefs and the friend-facing
   * snapshot: a field the user just turned off must stop being readable right
   * away, not at the next background sync (which Android may defer for hours).
   */
  const applyPrivacy = useCallback((p: Profile) => {
    pushPrivacy(p);
    if (!p.uid) return;
    const sig = JSON.stringify({
      uid: p.uid,
      privacy: p.privacy ?? {},
      mode: p.mode ?? "active",
    });
    if (sig === privacySigRef.current) return;
    privacySigRef.current = sig;
    pushUsageSnapshot(p.uid, effectivePrivacy(p), p.mode === "silent" ? "silent" : "active").catch(
      () => {},
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    resolvedRef.current = false;
    setReady(false);

    // Paint the cached theme before anything async so the shell never flashes.
    // Nothing account-specific (privacy gates, pause deadline) is applied from
    // the cache here: it may belong to the previous account, and those values
    // are only ever pushed once the real session has been resolved.
    const cached = readProfile();
    if (cached) applyTheme(cached);

    const unsub = onAuthChange(async (firebaseUser) => {
      const session = await resolveSession(firebaseUser);
      if (cancelled) return;
      resolvedRef.current = true;

      switch (session.state) {
        case "signed-out":
          uidRef.current = null;
          syncedRef.current = null;
          privacySigRef.current = null;
          setPresenceUid(null);
          setReady(false);
          navigate({ to: "/" });
          return;

        case "unknown":
          // Neither routing choice is safe: showing onboarding could re-ask an
          // existing user for a profile they already have.
          setBlocked(true);
          return;

        case "onboarding":
          setBlocked(false);
          // Give the worker this account's defaults right away — it must never
          // keep uploading with the previous account's privacy gates.
          {
            const shell = readProfile();
            if (shell) {
              applyPrivacy(shell);
              setMode(shell.mode === "silent" ? "silent" : "active");
            }
          }
          navigate({ to: "/onboarding" });
          return;

        case "ready":
          setBlocked(false);
          setReady(true);
          applyTheme(session.profile);
          applyPrivacy(session.profile);
          setMode(session.profile.mode === "silent" ? "silent" : "active");
          VibeStats.startBackgroundSync().catch(() => {});
          // Firestore already holds these values, so remember them and only write
          // when the user actually changes something.
          uidRef.current = session.user.uid;
          syncedRef.current = syncable(session.profile);
          setPresenceUid(session.user.uid);

          // Check for updates once per session (with cooldown handled natively)
          if (!updateCheckedRef.current && Capacitor.isNativePlatform()) {
            updateCheckedRef.current = true;
            checkForUpdates(false)
              .then((result) => {
                if (result.hasUpdate && result.updateInfo) {
                  setLastNotifiedVersion(result.updateInfo.latestVersionCode);
                  setUpdateInfo(result.updateInfo);
                  setShowUpdateScreen(true);
                }
              })
              .catch(() => {})
              .finally(() => {
                // Mark update check complete so dashboard can render
                setUpdateCheckComplete(true);
              });
          } else {
            // Skip update check on web or already checked
            setUpdateCheckComplete(true);
          }

          // Starter avatar frame: one random frame for every completed profile.
          // claimStarterFrame reads the server first and no-ops once any frame
          // is owned, so this is safe on every launch — fresh signups claim
          // theirs, and users upgrading from a pre-frames build get theirs
          // automatically without having to do anything.
          if (!framesClaimedRef.current) {
            framesClaimedRef.current = true;
            if (session.profile.uid && !session.profile.frames?.length) {
              claimStarterFrame(session.profile.uid).catch(() => {});
            }
          }
          return;
      }
    });

    // If Firebase Auth never answers, say so instead of leaving a blank shell.
    const timer = setTimeout(() => {
      if (cancelled || resolvedRef.current) return;
      setBlocked(true);
    }, 6000);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      unsub();
    };
  }, [navigate, attempt]);

  // Real-time update listener for active users.
  // Listens to Firestore metadata changes and reacts the moment a new version
  // is published — no app restart needed. Foreground users get the update card;
  // backgrounded users get a real device notification instead (the card would
  // be invisible to them). This only fires while the process is alive — a
  // frozen/killed app converges on the next cold start's update check.
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !ready) return;

    const cleanup = listenForUpdates((metadata) => {
      const code = metadata.latestVersionCode;
      if (code <= 0) return;
      getLastNotifiedVersion()
        .then((lastNotified) => {
          if (code === lastNotified) return;
          return checkForUpdates(true).then((result) => {
            if (!result.hasUpdate || !result.updateInfo) return;
            setLastNotifiedVersion(code);
            if (document.visibilityState === "visible") {
              setUpdateInfo(result.updateInfo);
              setShowUpdateScreen(true);
            } else {
              VibeStats.notify({
                id: `update-${code}`,
                title: "A ChatZ update is waiting",
                body: `v${result.updateInfo.latestVersionName} — ${result.updateInfo.title || "open the app to update"}`,
                channel: "social",
              }).catch(() => {});
            }
          });
        })
        .catch(() => {});
    });

    return () => {
      cleanup();
    };
  }, [ready]);

  // About → "Check for updates" runs its own forced check and hands the result
  // here: the modal lives on the shell, and "Later" only hid it.
  useEffect(() => {
    const show = (e: Event) => {
      const info = (e as CustomEvent).detail as UpdateInfo | undefined;
      if (!info) return;
      setUpdateInfo(info);
      setShowUpdateScreen(true);
    };
    window.addEventListener("chatz:show-update", show);
    return () => window.removeEventListener("chatz:show-update", show);
  }, []);

  // Any writeProfile() from a settings screen lands here and is mirrored to
  // Firestore, so the local cache can never drift away from the real profile.
  useEffect(() => {
    const push = () => {
      const uid = uidRef.current;
      if (!uid) return;
      const p = readProfile();
      if (!p || p.uid !== uid) return;
      // Privacy gates and the sharing mode live on the native side, so they
      // must be pushed even when nothing else about the profile changed.
      applyPrivacy(p);
      setMode(p.mode === "silent" ? "silent" : "active");
      const next = syncable(p);
      if (next === syncedRef.current) return;
      syncedRef.current = next;
      syncLocalProfile(uid, p).catch(() => {
        // Forget the marker so the next edit retries instead of being skipped —
        // and retry once shortly after. A lost write here is how a Silent the
        // user just set could vanish: the cache said one thing, Firestore kept
        // another, and the next loadProfile resurrected the stale value.
        syncedRef.current = null;
        window.setTimeout(() => {
          if (uidRef.current !== uid) return;
          const retry = readProfile();
          if (!retry || retry.uid !== uid) return;
          syncLocalProfile(uid, retry).catch(() => {});
        }, 4000);
      });
    };
    window.addEventListener("st-social:profile", push);
    return () => window.removeEventListener("st-social:profile", push);
  }, [applyPrivacy]);

  // Presence. Foreground means online, background means offline, and a slow
  // heartbeat keeps the flag fresh while the app is actually being used. Silent
  // mode reads as offline by design: a paused account must not keep leaking
  // live activity through presence. This is deliberately separate from the
  // 15-minute usage snapshot: presence changes at human timescales, screen time
  // does not.
  //
  // Heartbeat interval: 90 seconds — frequent enough to detect genuine absence
  // within ~2 minutes, but infrequent enough to avoid unnecessary writes when
  // the user keeps the app open for long periods. Visibility/appState listeners
  // handle immediate transitions; the heartbeat is only a freshness guard.
  useEffect(() => {
    if (!presenceUid) return;
    let heartbeat: number | undefined;
    let nativeSub: { remove: () => void } | undefined;
    let cancelled = false;
    let lastPresenceWrite = 0;

    const goOffline = () => {
      if (heartbeat !== undefined) window.clearInterval(heartbeat);
      heartbeat = undefined;
      setPresence(presenceUid, false).catch(() => {});
      lastPresenceWrite = 0;
    };

    const goOnline = () => {
      if (mode === "silent") {
        goOffline();
        return;
      }
      const now = Date.now();
      // Only write if it's been >30s since the last write — prevents redundant
      // writes when visibilitychange fires rapidly (e.g., switching between apps).
      if (now - lastPresenceWrite > 30_000) {
        setPresence(presenceUid, true).catch(() => {});
        lastPresenceWrite = now;
      }
      if (heartbeat !== undefined) window.clearInterval(heartbeat);
      heartbeat = window.setInterval(() => {
        const now = Date.now();
        if (now - lastPresenceWrite > 30_000) {
          setPresence(presenceUid, true).catch(() => {});
          lastPresenceWrite = now;
        }
      }, 90_000);
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") goOnline();
      else goOffline();
    };

    document.addEventListener("visibilitychange", onVisibility);
    if (Capacitor.isNativePlatform()) {
      NativeApp.addListener("appStateChange", ({ isActive }) => {
        if (isActive) goOnline();
        else goOffline();
      })
        .then((sub) => {
          if (cancelled) sub.remove();
          else nativeSub = sub;
        })
        .catch(() => {});
    }
    if (document.visibilityState === "visible") goOnline();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      nativeSub?.remove();
      goOffline();
    };
  }, [presenceUid, mode]);

  // The three core permissions gate the whole app: checked on entry and after
  // every return from Android settings, so a revocation locks dependent
  // functionality instead of silently showing stale or fake data.
  const recheckPerms = useCallback(() => {
    checkAllPerms()
      .then(setPerms)
      .catch(() => {});
  }, []);

  // A full grant is the only state that clears the skip: revoking later brings
  // the gate back, where the user can skip again in one tap if they want to.
  useEffect(() => {
    if (!perms || !allPermsGranted(perms)) return;
    try {
      localStorage.removeItem(GATE_DISMISSED_KEY);
    } catch {
      /* private mode */
    }
    setGateDismissed(false);
  }, [perms]);

  const skipGate = useCallback(() => {
    try {
      localStorage.setItem(GATE_DISMISSED_KEY, "1");
    } catch {
      /* private mode */
    }
    setGateDismissed(true);
  }, []);

  useEffect(() => {
    if (!ready || !Capacitor.isNativePlatform()) return;
    let alive = true;
    const refresh = () => {
      checkAllPerms()
        .then((s) => {
          if (alive) setPerms(s);
        })
        .catch(() => {});
    };
    refresh();
    const sub = NativeApp.addListener("appStateChange", ({ isActive }) => {
      if (isActive) refresh();
    });
    return () => {
      alive = false;
      sub.then((h) => h.remove()).catch(() => {});
    };
  }, [ready]);

  // The push address. Firestore needs this device's FCM token before the
  // chatz-push Worker can reach a user whose app is frozen or killed — without
  // it they only ever get the in-app listener and the catch-up summary.
  // Re-checked on resume, which is also how a rotated token gets published.
  useEffect(() => {
    if (!ready || !presenceUid || !Capacitor.isNativePlatform()) return;
    registerFcmToken(presenceUid).catch(() => {});
    let alive = true;
    const sub = NativeApp.addListener("appStateChange", ({ isActive }) => {
      if (isActive && alive) registerFcmToken(presenceUid).catch(() => {});
    });
    return () => {
      alive = false;
      sub.then((h) => h.remove()).catch(() => {});
    };
  }, [ready, presenceUid]);

  // The Friends tab carries one dot for either signal: an unread DM or a
  // pending friend request.
  const dmOverview = useChatsOverview(presenceUid);
  const dmMarkers = useReadMarkers(presenceUid);
  const notifList = useNotifs();
  const friendsDot =
    Array.from(dmOverview.values()).some((c) => isChatUnread(c, dmMarkers)) ||
    notifList.some((n) => !n.read && n.kind === "friend_request");

  if (blocked) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center px-8 text-center">
        <div className="w-14 h-14 rounded-2xl bg-secondary grid place-items-center">
          <RefreshCw size={22} className="text-muted-foreground" />
        </div>
        <h1 className="mt-5 text-xl font-semibold tracking-tight">
          We couldn't load your profile
        </h1>
        <p className="mt-2 text-[14px] text-muted-foreground leading-relaxed max-w-sm">
          You're signed in, but ChatZ couldn't reach the server. Check your connection and try
          again — we won't ask you to redo your profile.
        </p>
        <button
          onClick={() => {
            setBlocked(false);
            setAttempt((n) => n + 1);
          }}
          className="mt-6 h-11 px-6 rounded-full bg-primary text-primary-foreground font-medium text-[15px] active:scale-[0.98]"
        >
          Try again
        </button>
        <button
          onClick={() => {
            signOutEverywhere().catch(() => {});
          }}
          className="mt-3 text-[13px] text-muted-foreground underline"
        >
          Sign out instead
        </button>
      </div>
    );
  }

  // Until the session is resolved the cached profile may belong to the previous
  // account, so no app screen — and no Firestore read keyed off that uid — may
  // mount yet.
  if (!ready) {
    return (
      <div className="min-h-screen bg-[#000000] grid place-items-center">
        <ChatZMark size={288} glyphOnly fg="#FFFFFF" />
      </div>
    );
  }

  // CRITICAL: Block dashboard rendering until update check completes.
  // This prevents Splash → Dashboard → Update popup flow.
  // The update check must resolve BEFORE any dashboard content mounts.
  if (Capacitor.isNativePlatform() && !updateCheckComplete) {
    return (
      <div className="min-h-screen bg-[#000000] grid place-items-center">
        <ChatZMark size={288} glyphOnly fg="#FFFFFF" />
      </div>
    );
  }

  // Native builds must not enter the app while a core permission is missing —
  // unless the user explicitly chose limited access, in which case a banner
  // marks the degraded state instead of re-blocking.
  // `perms === null` means the first check is still running.
  if (Capacitor.isNativePlatform() && (!perms || !allPermsGranted(perms))) {
    if (!perms) {
      return (
        <div className="min-h-screen bg-[#000000] grid place-items-center">
          <ChatZMark size={288} glyphOnly fg="#FFFFFF" />
        </div>
      );
    }
    if (!gateDismissed) {
      return (
        <PermissionGate
          state={perms}
          recheck={recheckPerms}
          onSignOut={() => signOutEverywhere().catch(() => {})}
          onSkip={skipGate}
        />
      );
    }
  }

  const hideTabs =
    /^\/app\/chats\/[^/]+$/.test(pathname) ||
    /^\/app\/settings(\/.*)?$/.test(pathname) ||
    /^\/app\/notifications$/.test(pathname);

  const missingCount = perms ? Object.values(perms).filter((v) => !v).length : 0;
  const showLimitedBanner =
    Capacitor.isNativePlatform() &&
    !!perms &&
    !allPermsGranted(perms) &&
    pathname !== "/app/settings/permissions";

  return (
    <>
      <ConnectionStatus />
      <div className="min-h-screen bg-background flex flex-col">
        {showLimitedBanner && (
          <Link
            to="/app/settings/permissions"
            className="sticky top-0 z-20 flex items-center gap-2 bg-amber-500/10 border-b border-amber-500/30 px-4 py-2.5 text-[12px] font-medium"
          >
            <ShieldAlert size={14} className="text-amber-500 shrink-0" />
            <span className="flex-1 text-foreground">
              Limited access — {missingCount} of 3 permissions off
            </span>
            <span className="text-primary font-semibold shrink-0">Fix</span>
          </Link>
        )}
        <div className={`flex-1 flex flex-col ${hideTabs ? "" : "pb-28"}`}>
          <Outlet />
        </div>
        {!hideTabs && <DynamicIslandNav pathname={pathname} friendsDot={friendsDot} />}
      </div>

      {/* Update screen modal */}
      {updateInfo && (
        <UpdateScreen
          open={showUpdateScreen}
          updateInfo={updateInfo}
          onLater={() => setShowUpdateScreen(false)}
          onUpdate={async () => {
            // This will be handled by the UpdateScreen component itself
          }}
        />
      )}
    </>
  );
}

type Tab = {
  to: string;
  label: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  exact?: boolean;
};

function DynamicIslandNav({ pathname, friendsDot }: { pathname: string; friendsDot: boolean }) {
  const tabs: Tab[] = [
    { to: "/app", label: "Pulse", icon: Activity, exact: true },
    { to: "/app/friends", label: "Friends", icon: Users },
    { to: "/app/profile", label: "Me", icon: UserIcon },
  ];

  return (
    <nav className="fixed bottom-0 inset-x-0 z-30 pointer-events-none pb-[max(env(safe-area-inset-bottom),12px)] px-4">
      <div className="pointer-events-auto mx-auto max-w-md bg-foreground/95 backdrop-blur-xl rounded-full shadow-[0_12px_40px_-12px_rgba(0,0,0,0.45)] px-2 py-1.5 flex items-center justify-between gap-1">
        {tabs.map((t) => {
          // Friend-context pages (profile, full stats) keep the Friends tab lit.
          const active = t.exact
            ? pathname === t.to
            : t.to === "/app/friends"
              ? /^\/app\/(friends|user|stats)(\/|$)/.test(pathname)
              : pathname.startsWith(t.to);
          const Icon = t.icon;
          return (
            <Link
              key={t.to}
              to={t.to as "/app"}
              className={`relative flex items-center gap-1.5 h-11 rounded-full transition-all duration-300 ease-out ${
                active
                  ? "bg-background text-foreground px-4 flex-1 justify-center"
                  : "text-background/70 hover:text-background w-11 justify-center"
              }`}
            >
              <Icon size={20} strokeWidth={active ? 2.4 : 2} />
              {active && (
                <span className="text-[13px] font-semibold tracking-tight">{t.label}</span>
              )}
              {t.to === "/app/friends" && friendsDot && (
                <span
                  className={`absolute top-1 right-1 w-2 h-2 rounded-full bg-primary ring-2 ${
                    active ? "ring-background" : "ring-foreground"
                  }`}
                />
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
