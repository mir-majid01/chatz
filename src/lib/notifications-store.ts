// Notifications live in Firestore: notifications/{autoId} = { toUid, fromUid, ... }.
// The recipient subscribes to their own slice with a single-field query
// (where toUid == uid) so no composite index is needed; sorting happens client-side.
// Writes are only ever performed by the actor (fromUid == their own auth uid).
import { useEffect, useRef, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { Capacitor } from "@capacitor/core";
import {
  addDoc,
  collection,
  doc,
  getDocs,
  limit as firestoreLimit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAfter,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { auth, db } from "./firebase";
import { expiresAt24h, isExpired } from "./ttl";
import { VibeStats } from "./vibe-stats";

export type NotifKind =
  | "reaction"
  | "comment"
  | "message"
  | "friend_request"
  | "group_invite"
  | "mention"
  | "unfriend"
  | "block";

export type Notif = {
  id: string;
  kind: NotifKind;
  /** uid of the actor — lets the UI correlate (e.g. clear friend-request rows). */
  fromUid?: string;
  fromName: string;
  fromColor: string;
  fromHandle?: string;
  fromAvatarId?: string;
  text: string;
  ago: string;
  read: boolean;
  link?: string; // route to navigate to
  createdAt?: number; // epoch ms, for grouping/sorting
};

/** What a sender provides when pushing a notification. */
export type NewNotif = {
  toUid: string;
  kind: NotifKind;
  fromName: string;
  fromColor: string;
  fromHandle?: string;
  fromAvatarId?: string;
  text: string;
  link?: string;
};

export type NotifPrefs = { reaction: boolean; comment: boolean };
const DEFAULT_PREFS: NotifPrefs = { reaction: true, comment: true };

/** Latest snapshot, so markAllRead() can run from a no-arg click handler. */
let latest: Notif[] = [];
let latestUid: string | null = null;

function agoFrom(ms: number): string {
  if (!ms) return "now";
  const d = Date.now() - ms;
  if (d < 60_000) return "now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
  return `${Math.floor(d / 86_400_000)}d`;
}

function toNotif(id: string, raw: Record<string, unknown>): Notif {
  const ts = raw.createdAt as { toMillis?: () => number } | null | undefined;
  const createdAt = ts && typeof ts.toMillis === "function" ? ts.toMillis() : 0;
  return {
    id,
    kind: (raw.kind as NotifKind) ?? "message",
    fromUid: typeof raw.fromUid === "string" ? raw.fromUid : undefined,
    fromName: typeof raw.fromName === "string" ? raw.fromName : "Someone",
    fromColor: typeof raw.fromColor === "string" ? raw.fromColor : "#5E72E4",
    fromHandle: typeof raw.fromHandle === "string" ? raw.fromHandle : undefined,
    fromAvatarId: typeof raw.fromAvatarId === "string" ? raw.fromAvatarId : undefined,
    text: typeof raw.text === "string" ? raw.text : "",
    ago: agoFrom(createdAt),
    read: raw.read === true,
    link: typeof raw.link === "string" ? raw.link : undefined,
    createdAt,
  };
}

// --------------------------------------------------- device notifications
//
// Social events mirror into the Android notification shade like Instagram or
// WhatsApp: "Majid sent you a message: hii". Guards keep this honest and quiet:
//   1. FRESH  — events stamped within the last 90s post individually while the
//               app is hidden (the classic live case).
//   2. NEW    — session-scoped seen-set, so the same Firestore doc never pops
//               twice even across snapshot re-emissions.
//   3. GONE   — only while the app is NOT visible for the individual post.
//   4. CATCH-UP — a persistent per-account watermark records the newest event
//               this device has already seen. OEM freezer (XOS and friends)
//               kills the listener within seconds of backgrounding, so events
//               that land while frozen would otherwise be discarded by the
//               90s rule forever. On the next listener attach everything after
//               the watermark that missed the live window is posted as ONE
//               summary notification instead of vanishing silently.
// (A killed process still cannot post: real push for that needs FCM + a server.)

const DEVICE_FRESH_MS = 90_000;
const seenOnDevice = new Set<string>();

function appVisible(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "visible";
}

function readWatermark(uid: string): number {
  try {
    return Number(localStorage.getItem(`chatz.notifWm.${uid}`) || 0) || 0;
  } catch {
    return 0;
  }
}

function writeWatermark(uid: string, ts: number) {
  try {
    localStorage.setItem(`chatz.notifWm.${uid}`, String(ts));
  } catch {
    /* private mode: catch-up degrades to per-session only */
  }
}

function postDeviceNotification(n: Notif) {
  if (!Capacitor.isNativePlatform()) return;
  const channel = n.kind === "message" ? "message" : "social";
  VibeStats.notify({
    id: n.id,
    title: n.fromName,
    body: n.text,
    channel,
  }).catch(() => {});
}

/** One consolidated notification for events that arrived while frozen. */
function postCatchup(missed: Notif[]) {
  if (!Capacitor.isNativePlatform() || missed.length === 0) return;
  const newest = missed[missed.length - 1]; // caller passes oldest-first
  const body =
    missed.length === 1
      ? `${newest.fromName} ${newest.text}`
      : `${missed.length} new since you last checked — latest: ${newest.fromName} ${newest.text}`;
  VibeStats.notify({
    id: `catchup-${newest.createdAt}`,
    title: "ChatZ",
    body,
    channel: newest.kind === "message" ? "message" : "social",
  }).catch(() => {});
}

/**
 * Runs on every listener emission. `items` is oldest-first (the hook reverses
 * the desc query), so the newest event is last.
 */
function deviceNotify(items: Notif[], uid: string) {
  const now = Date.now();
  const wm = readWatermark(uid);

  // Live pass: brand-new events while the app is hidden.
  for (const n of items) {
    if (seenOnDevice.has(n.id)) continue;
    seenOnDevice.add(n.id);
    if (n.read) continue;
    if (!n.createdAt || now - n.createdAt > DEVICE_FRESH_MS) continue;
    if (appVisible()) continue;
    postDeviceNotification(n);
  }

  // Catch-up pass: unread events after the watermark that already missed the
  // live window (frozen listener). Only on the first emission of this session,
  // because the watermark advance below makes later ones empty by construction.
  const missed = items.filter((n) => {
    const t = n.createdAt ?? 0;
    return !n.read && t > wm && now - t > DEVICE_FRESH_MS;
  });
  if (missed.length > 0) postCatchup(missed);

  const maxTs = items.reduce((m, n) => Math.max(m, n.createdAt || 0), wm);
  if (maxTs !== wm) writeWatermark(uid, maxTs);
}

export function useNotifs() {
  const [list, setList] = useState<Notif[]>(
    latestUid && latestUid === auth.currentUser?.uid ? latest : [],
  );
  useEffect(() => {
    let unsubSnap: (() => void) | undefined;
    const unsubAuth = onAuthStateChanged(auth, (u) => {
      unsubSnap?.();
      unsubSnap = undefined;
      if (!u) {
        latest = [];
        latestUid = null;
        setList([]);
        return;
      }
      if (latestUid !== u.uid) {
        latest = [];
        setList([]);
      }
      latestUid = u.uid;
      // Paginated query: only fetch the 50 most recent notifications, ordered by creation time.
      // This prevents loading the user's entire notification history on every app start.
      const q = query(
        collection(db, "notifications"),
        where("toUid", "==", u.uid),
        orderBy("createdAt", "desc"),
        firestoreLimit(50),
      );
      unsubSnap = onSnapshot(
        q,
        (snap) => {
          const items = snap.docs
            .filter((d) => !isExpired(d.data().expiresAt))
            .map((d) => toNotif(d.id, d.data()));
          // Already sorted by createdAt desc from the query — reversed to
          // oldest-first so the newest event is last.
          items.reverse();

          // Device shade: live posts, frozen-gap catch-up, watermark advance.
          deviceNotify(items, u.uid);

          latest = items;
          setList(items);
        },
        (err) => {
          // Most common here: the notifications rules have not been published yet.
          console.warn("notifications: listen failed", (err as { code?: string })?.code);
          latest = [];
          setList([]);
        },
      );
    });
    return () => {
      unsubSnap?.();
      unsubAuth();
    };
  }, []);
  return list;
}

/** Load the next page of older notifications. Call when user scrolls to bottom. */
export async function loadOlderNotifs(cursorCreatedAt: number, cursorId: string, count = 50): Promise<Notif[]> {
  const uid = auth.currentUser?.uid;
  if (!uid) return [];
  const q = query(
    collection(db, "notifications"),
    where("toUid", "==", uid),
    orderBy("createdAt", "desc"),
    startAfter(cursorCreatedAt, cursorId),
    firestoreLimit(count),
  );
  const snap = await getDocs(q);
  const items = snap.docs
    .filter((d) => !isExpired(d.data().expiresAt))
    .map((d) => toNotif(d.id, d.data()));
  return items.reverse(); // Return oldest-first for appending
}

export function unreadCount(list: Notif[]) {
  return list.filter((n) => !n.read).length;
}

export function filterByPrefs(list: Notif[], prefs: NotifPrefs): Notif[] {
  return list.filter((n) => {
    if (n.kind === "reaction") return prefs.reaction;
    if (n.kind === "comment") return prefs.comment;
    return true;
  });
}

export function markAllRead() {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  const unread = latest.filter((n) => !n.read);
  if (unread.length === 0) return;
  const batch = writeBatch(db);
  for (const n of unread) batch.update(doc(db, "notifications", n.id), { read: true });
  batch.commit().catch((err) => console.warn("notifications: mark-all failed", err));
}

export function markRead(id: string) {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  updateDoc(doc(db, "notifications", id), { read: true }).catch(() => {});
}

/**
 * Delete every notification matching `pred` in one batch. Used when a friend
 * request is accepted/declined from anywhere: the row (and its action buttons)
 * must leave every open surface at once, and the live listener makes the
 * deletion propagate instantly. The rules let the recipient delete own rows.
 */
export function dismissNotifs(pred: (n: Notif) => boolean) {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  const targets = latest.filter(pred);
  if (targets.length === 0) return;
  const batch = writeBatch(db);
  for (const n of targets) batch.delete(doc(db, "notifications", n.id));
  batch.commit().catch((err) => console.warn("notifications: dismiss failed", err));
}

/**
 * The exact document a notification write produces. Exported so relationship
 * changes (unfriend, block) can place the same payload inside the same atomic
 * batch as the change itself — the rules only accept those kinds alongside the
 * relationship write they describe.
 */
export function notifPayload(n: NewNotif, fromUid: string): Record<string, unknown> {
  return {
    toUid: n.toUid,
    fromUid,
    fromName: n.fromName,
    fromColor: n.fromColor,
    ...(n.fromHandle ? { fromHandle: n.fromHandle } : {}),
    ...(n.fromAvatarId ? { fromAvatarId: n.fromAvatarId } : {}),
    kind: n.kind,
    text: n.text,
    link: n.link ?? "/app",
    read: false,
    createdAt: serverTimestamp(),
    expiresAt: expiresAt24h(),
  };
}

/** Fire-and-forget by design: callers don't await, failures stay silent. */
export function pushNotif(n: NewNotif) {
  const fromUid = auth.currentUser?.uid;
  if (!fromUid || !n.toUid || n.toUid === fromUid) return;
  addDoc(collection(db, "notifications"), notifPayload(n, fromUid)).catch((err) =>
    console.warn("notifications: push failed", err),
  );
}

export function useNotifPrefs(): [NotifPrefs, (p: Partial<NotifPrefs>) => void] {
  const [prefs, setPrefs] = useState<NotifPrefs>(DEFAULT_PREFS);
  const ref = useRef(prefs);
  ref.current = prefs;
  useEffect(() => {
    let unsubSnap: (() => void) | undefined;
    const unsubAuth = onAuthStateChanged(auth, (u) => {
      unsubSnap?.();
      unsubSnap = undefined;
      if (!u) {
        setPrefs(DEFAULT_PREFS);
        return;
      }
      unsubSnap = onSnapshot(
        doc(db, "users", u.uid, "private", "prefs"),
        (snap) => {
          const stored = (snap.data()?.notifPrefs ?? {}) as Partial<NotifPrefs>;
          setPrefs({ ...DEFAULT_PREFS, ...stored });
        },
        () => setPrefs(DEFAULT_PREFS),
      );
    });
    return () => {
      unsubSnap?.();
      unsubAuth();
    };
  }, []);
  const update = (p: Partial<NotifPrefs>) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const next = { ...ref.current, ...p };
    setPrefs(next);
    setDoc(doc(db, "users", uid, "private", "prefs"), { notifPrefs: next }, { merge: true }).catch(
      (err) => console.warn("notifications: prefs save failed", err),
    );
  };
  return [prefs, update];
}
