// Direct messages on Firestore.
//
//   chats/{pairId}               { members: [a, b] sorted, updatedAt, lastMessage: { fromUid, text, at, clientAt } }
//   chats/{pairId}/messages/{id} { fromUid, text, createdAt, clientAt }
//
// pairId reuses the friendships scheme: both uids sorted ascending joined with "_",
// so exactly one conversation document can exist per pair. `createdAt` is the
// authoritative server timestamp (validated in rules); `clientAt` (epoch ms) exists
// so a just-sent message — whose serverTimestamp is still pending locally — sorts at
// the correct position in the sender's own view instead of jumping to the end.
import { useEffect, useRef, useState } from "react";
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";
import { db } from "./firebase";
import { readProfile } from "./profile-store";
import { pushNotif } from "./notifications-store";
import { isExpiredDoc, TTL_MS } from "./ttl";

export function dmConversationId(a: string, b: string): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

export type DmMessage = {
  id: string;
  fromUid: string;
  text: string;
  /** epoch ms (from clientAt — always present, even while createdAt is pending). */
  createdAt: number;
};

/** One row per conversation, for unread badges and last-message previews. */
export type ChatOverview = {
  peerUid: string;
  lastFromUid: string;
  lastText: string;
  at: number;
};

const MAX_MESSAGE = 2000;
const PREVIEW = 120;
const PAGE = 300;

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asMs(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const t = v as { toMillis?: () => number } | null;
  if (t && typeof t.toMillis === "function") return t.toMillis();
  return 0;
}

// ------------------------------------------------------------------ messages

/**
 * Live messages for one conversation, oldest-first, with the count of messages
 * that have aged past the 24-hour window.
 *
 * Ordering uses `clientAt` (a pending serverTimestamp sorts as null locally and
 * would land at the wrong end), but VISIBILITY is decided by the server-owned
 * `createdAt` — a client clock cannot keep a message alive past the deadline,
 * which is the same rule the security rules enforce on write.
 */
export type DmThread = { messages: DmMessage[]; expiredCount: number };

export function useDmMessages(
  peerUid: string | null,
  meUid: string | null,
  onError?: (err: Error) => void,
): DmThread {
  const [thread, setThread] = useState<DmThread>({ messages: [], expiredCount: 0 });
  const errRef = useRef(onError);
  errRef.current = onError;
  useEffect(() => {
    if (!peerUid || !meUid || peerUid === meUid) {
      setThread({ messages: [], expiredCount: 0 });
      return;
    }
    const q = query(
      collection(db, "chats", dmConversationId(meUid, peerUid), "messages"),
      orderBy("clientAt", "desc"),
      limit(PAGE),
    );
    return onSnapshot(
      q,
      (snap) => {
        let expiredCount = 0;
        const rows: DmMessage[] = [];
        for (const d of snap.docs) {
          const data = d.data();
          if (isExpiredDoc(data)) {
            expiredCount++;
            continue;
          }
          rows.push({
            id: d.id,
            fromUid: asString(data.fromUid),
            text: asString(data.text),
            createdAt: asMs(data.clientAt),
          });
        }
        rows.reverse();
        setThread({ messages: rows, expiredCount });
      },
      (err) => {
        setThread({ messages: [], expiredCount: 0 });
        errRef.current?.(err);
      },
    );
  }, [peerUid, meUid]);
  return thread;
}

/**
 * Send a DM. The message document is written first (better failure mode: a lost
 * parent update costs a preview, a lost message costs the message), then the
 * conversation summary, then the recipient's notification.
 */
export async function sendDm(meUid: string, peerUid: string, rawText: string): Promise<void> {
  const text = rawText.trim().slice(0, MAX_MESSAGE);
  if (!meUid || !peerUid || !text) return;
  const pairId = dmConversationId(meUid, peerUid);

  // Client-generated id so the pending local write surfaces in the listener
  // immediately, at its final position.
  await setDoc(doc(collection(db, "chats", pairId, "messages")), {
    fromUid: meUid,
    text,
    createdAt: serverTimestamp(),
    clientAt: Date.now(),
  });

  await setDoc(
    doc(db, "chats", pairId),
    {
      members: [meUid, peerUid].sort(),
      updatedAt: serverTimestamp(),
      lastMessage: {
        fromUid: meUid,
        text: text.slice(0, PREVIEW),
        at: serverTimestamp(),
        clientAt: Date.now(),
      },
    },
    { merge: true },
  );

  const me = readProfile();
  pushNotif({
    toUid: peerUid,
    kind: "message",
    fromName: me?.name ?? "Someone",
    fromColor: me?.color ?? "#5E72E4",
    fromHandle: me?.handle,
    fromAvatarId: me?.avatarId,
    text: `sent you a message: "${text.length > 60 ? `${text.slice(0, 60)}…` : text}"`,
    link: `/app/chats/${meUid}`,
  });
}

// ----------------------------------------------------------------- overviews

/** Every conversation I am part of, keyed by the other member's uid. */
export function useChatsOverview(
  meUid: string | null,
  onError?: (err: Error) => void,
): Map<string, ChatOverview> {
  const [chats, setChats] = useState<Map<string, ChatOverview>>(new Map());
  const errRef = useRef(onError);
  errRef.current = onError;
  useEffect(() => {
    if (!meUid) {
      setChats(new Map());
      return;
    }
    const q = query(collection(db, "chats"), where("members", "array-contains", meUid));
    return onSnapshot(
      q,
      (snap) => {
        const next = new Map<string, ChatOverview>();
        for (const d of snap.docs) {
          const data = d.data();
          const members = (data.members ?? []) as unknown[];
          const peerUid = members.find((m) => typeof m === "string" && m !== meUid);
          if (typeof peerUid !== "string") continue;
          const lm = (data.lastMessage ?? {}) as Record<string, unknown>;
          // lastMessage.text is a COPY of a message, and the parent chat document
          // survives retention on purpose. Without this the preview would keep the
          // message content readable forever and the 24-hour rule would mean
          // nothing. `lm.at` is server-owned (rules require at == request.time),
          // so it — not clientAt — decides visibility.
          const serverAt = asMs(lm.at);
          const previewExpired = serverAt > 0 && Date.now() >= serverAt + TTL_MS;
          next.set(peerUid, {
            peerUid,
            lastFromUid: previewExpired ? "" : asString(lm.fromUid),
            lastText: previewExpired ? "" : asString(lm.text),
            // clientAt keeps unread comparisons in the same clock domain as the
            // local read markers; `at` stays the server-truth fallback.
            at: asMs(lm.clientAt) || serverAt,
          });
        }
        setChats(next);
      },
      (err) => {
        setChats(new Map());
        errRef.current?.(err);
      },
    );
  }, [meUid]);
  return chats;
}

// -------------------------------------------------------------- read markers

/** Per-account read markers: { peerUid: epoch ms read up to }. */
const MARKERS_KEY = "chatz:dm-read:v1";
const MARKERS_EVENT = "chatz:dm-read";

function markersKey(uid: string): string {
  return `${MARKERS_KEY}:${uid}`;
}

function readMarkers(uid: string | null): Record<string, number> {
  if (!uid || typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(markersKey(uid));
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeMarkers(uid: string, markers: Record<string, number>) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(markersKey(uid), JSON.stringify(markers));
  window.dispatchEvent(new Event(MARKERS_EVENT));
}

/** Record that I have seen this peer's messages up to `upTo`. Monotonic. */
export function markChatRead(meUid: string, peerUid: string, upTo: number) {
  if (!meUid || !peerUid) return;
  const markers = readMarkers(meUid);
  if ((markers[peerUid] ?? 0) >= upTo) return;
  markers[peerUid] = upTo;
  writeMarkers(meUid, markers);
}

export function useReadMarkers(meUid: string | null): Record<string, number> {
  const [markers, setMarkers] = useState<Record<string, number>>(() => readMarkers(meUid));
  useEffect(() => {
    const refresh = () => setMarkers(readMarkers(meUid));
    refresh();
    window.addEventListener(MARKERS_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(MARKERS_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [meUid]);
  return markers;
}

/** Unread = the peer sent the latest message and I have not seen it. */
export function isChatUnread(c: ChatOverview | undefined, markers: Record<string, number>): boolean {
  if (!c || !c.lastFromUid || c.lastFromUid !== c.peerUid) return false;
  return c.at > (markers[c.peerUid] ?? 0);
}
