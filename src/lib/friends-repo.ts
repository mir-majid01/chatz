// The friends graph on Firestore.
//
//   friendRequests/{senderUid}_{receiverUid}   { senderId, receiverId, status, createdAt, updatedAt }
//   friendships/{memberA}_{memberB}            { members: [memberA, memberB], createdAt }
//   friendCounts/{uid}                         { count, updatedAt }
//
// The document ID is always derived from the two uids, so exactly one document can
// exist per pair in each collection — no duplicates, no random IDs, no contradictory
// state spread across many documents. A pending request is never a friendship.
//
// Profiles are only ever resolved from users/{uid} by UID (see profile-repo.ts),
// never by email or handle. The Firebase Auth UID is the only identity key.
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type WriteBatch,
} from "firebase/firestore";
import { auth, db } from "./firebase";
import { colorForHandle } from "./profile-store";
import { getPublicProfiles, type PublicProfile } from "./profile-repo";
import { notifPayload } from "./notifications-store";
import { triggerPush } from "./push-repo";

export type FriendRequestStatus = "pending" | "accepted" | "rejected" | "cancelled";

export type FriendRequest = {
  id: string;
  fromUid: string;
  toUid: string;
  status: FriendRequestStatus;
  createdAt: string;
  /** Sender profile, resolved live from users/{uid}. */
  fromName: string;
  fromHandle: string;
  fromColor: string;
  fromAvatarId?: string;
};

const FRIEND_REQUESTS = "friendRequests";
const FRIENDSHIPS = "friendships";
const FRIEND_COUNTS = "friendCounts";

// Client-side rate limiting for friend requests: track last sent request timestamp.
// This is a UI-level guard only; a modified APK could bypass it. True protection
// requires Cloud Functions or Firestore rules with time-based validation.
const LAST_REQUEST_KEY = "chatz:friend-request:last-sent";
const MIN_REQUEST_INTERVAL = 5000; // 5 seconds between distinct requests

function getLastRequestSent(): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.localStorage.getItem(LAST_REQUEST_KEY);
    return raw ? parseInt(raw, 10) : 0;
  } catch {
    return 0;
  }
}

function setLastRequestSent(timestamp: number) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LAST_REQUEST_KEY, String(timestamp));
}

const requestsCol = collection(db, FRIEND_REQUESTS);
const friendshipsCol = collection(db, FRIENDSHIPS);

/** The actor details every relationship notification carries. */
export type ActorInfo = { name: string; handle?: string; color: string; avatarId?: string };

function requestRef(senderUid: string, receiverUid: string) {
  return doc(db, FRIEND_REQUESTS, requestId(senderUid, receiverUid));
}

/** One request per direction per pair. */
export function requestId(senderUid: string, receiverUid: string): string {
  return `${senderUid}_${receiverUid}`;
}

/** One friendship per pair: members are sorted so a_b and b_a name the same doc. */
export function friendshipId(a: string, b: string): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Firestore Timestamp → ISO string. */
function asIso(v: unknown): string {
  const t = v as { toDate?: () => Date } | null;
  if (t && typeof t.toDate === "function") return t.toDate().toISOString();
  return typeof v === "string" ? v : "";
}

// ----------------------------------------------------------- friend counts

/**
 * The next values for both sides' friendCounts documents, read fresh. The caller
 * must place the returned writes in the SAME batch as the friendship change:
 * security rules only accept a count change that is provably coupled to a
 * friendship being created or removed in that batch.
 *
 * A missing document has never been counted (accounts that predate counts): a
 * gain seeds it at 1, a loss leaves it alone rather than writing a negative.
 */
export async function friendCountOps(
  a: string,
  b: string,
  delta: 1 | -1,
): Promise<Array<{ uid: string; count: number }>> {
  const pairs: Array<[string, ReturnType<typeof doc>]> = [a, b].map((uid) => [
    uid,
    doc(db, FRIEND_COUNTS, uid),
  ]);
  const snaps = await Promise.all(pairs.map(([, ref]) => getDoc(ref)));
  const ops: Array<{ uid: string; count: number }> = [];
  snaps.forEach((snap, i) => {
    const uid = pairs[i][0];
    if (!snap.exists()) {
      if (delta === 1) ops.push({ uid, count: 1 });
      return;
    }
    const raw = snap.data().count;
    const old = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
    ops.push({ uid, count: Math.max(0, old + delta) });
  });
  return ops;
}

/** Add the count writes produced by friendCountOps() to a batch. */
export function addFriendCountWrites(
  batch: WriteBatch,
  ops: Array<{ uid: string; count: number }>,
): void {
  for (const op of ops) {
    batch.set(
      doc(db, FRIEND_COUNTS, op.uid),
      { count: op.count, updatedAt: serverTimestamp() },
      { merge: true },
    );
  }
}

/** The stored friend count, or null when the account has never had one counted. */
export async function fetchFriendCount(uid: string): Promise<number | null> {
  if (!uid) return null;
  const snap = await getDoc(doc(db, FRIEND_COUNTS, uid));
  if (!snap.exists()) {
    // Accounts that predate the counts collection have no document, and the
    // rules (correctly) forbid inventing one. Counting the viewer's OWN
    // friendships is exact and needs no stored value; anyone else's count is
    // simply unknown until the next accepted friendship seeds the document.
    if (uid === auth.currentUser?.uid) return (await friendUids(uid)).size;
    return null;
  }
  const raw = snap.data().count;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

// -------------------------------------------------------------- requests

/**
 * Send a friend request. Re-requesting reuses the same document (a status flip),
 * including a stale 'accepted' one left behind when the friendship was severed
 * (unfriend, or block → unblock): it is only ever flipped back to pending while
 * no friendship exists, which the security rules also enforce. Sending again
 * while a request is already pending, or while you're already friends, is a
 * no-op rather than an error.
 *
 * Returns true only when a request was actually created or re-activated — callers
 * use that to notify the receiver exactly once, never for a no-op.
 */
export async function sendFriendRequest(meUid: string, targetUid: string): Promise<boolean> {
  if (!meUid) throw new Error("You must be signed in.");
  if (meUid === targetUid) throw new Error("You can't add yourself.");
  if (await areFriends(meUid, targetUid)) return false;

  // Client-side rate limiting: prevent rapid-fire requests to different users.
  // This is a UI-level guard only; a modified APK could bypass it. True protection
  // requires Cloud Functions or Firestore rules with time-based validation.
  const now = Date.now();
  const lastSent = getLastRequestSent();
  if (now - lastSent < MIN_REQUEST_INTERVAL) {
    console.warn("sendFriendRequest: rate limited — wait before sending another request");
    return false;
  }

  const ref = requestRef(meUid, targetUid);
  const snap = await getDoc(ref);

  if (snap.exists()) {
    const status = asString(snap.data().status);
    if (status === "pending") return false;
    await updateDoc(ref, { status: "pending", updatedAt: serverTimestamp() });
    setLastRequestSent(now);
    return true;
  }

  await setDoc(ref, {
    senderId: meUid,
    receiverId: targetUid,
    status: "pending",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  setLastRequestSent(now);
  return true;
}

/**
 * Pending requests I have received, newest first. Sorted in the client because an
 * orderBy on a third field would require a composite index in the console.
 */
export async function incomingRequests(myUid: string): Promise<FriendRequest[]> {
  const snap = await getDocs(
    query(requestsCol, where("receiverId", "==", myUid), where("status", "==", "pending")),
  );
  if (snap.empty) return [];

  const rows = snap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }));
  const profiles = await getPublicProfiles(rows.map((r) => asString(r.data.senderId)));

  return rows
    .map(({ id, data }) => {
      const fromUid = asString(data.senderId);
      const p: PublicProfile | undefined = profiles.get(fromUid);
      const handle = p?.handle ?? "";
      return {
        id,
        fromUid,
        toUid: asString(data.receiverId),
        status: "pending" as const,
        createdAt: asIso(data.createdAt),
        fromName: p?.name || handle || "Someone",
        fromHandle: handle,
        fromColor: p?.color || colorForHandle(fromUid),
        fromAvatarId: p?.avatarId,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Uids I have a still-pending outgoing request to. */
export async function outgoingRequestUids(myUid: string): Promise<Set<string>> {
  const snap = await getDocs(
    query(requestsCol, where("senderId", "==", myUid), where("status", "==", "pending")),
  );
  return new Set(snap.docs.map((d) => asString(d.data().receiverId)));
}

/**
 * Accept a request: flip the status, create the friendship and bump both friend
 * counts in one batch. The rules let the friendship exist only because the same
 * batch sets the request to 'accepted' (checked with getAfter), and the count
 * bumps are only valid alongside the friendship creation itself.
 *
 * A pending request that lands while the two are already friends (crossed
 * requests) must not stay 'pending', or it lingers as a phantom "Requests (1)"
 * that comes back on every load; a crossed request of mine to the same person
 * is cancelled in the same batch. The friendship and count writes are skipped
 * when already friends — nothing needs creating, and the count rules would
 * reject an uncoupled write anyway.
 *
 * Idempotent: an already-handled request (repeat tap, crossed accept) returns
 * quietly — the rules only allow pending → accepted, so re-flipping would be
 * denied and throw at a tap where nothing is left to do.
 */
export async function acceptRequest(req: FriendRequest, myUid: string): Promise<void> {
  if (req.toUid !== myUid) throw new Error("Only the person who received a request can accept it.");

  const incomingRef = doc(db, FRIEND_REQUESTS, req.id);
  const reciprocalRef = requestRef(myUid, req.fromUid);
  const [incoming, reciprocal, alreadyFriends] = await Promise.all([
    getDoc(incomingRef),
    getDoc(reciprocalRef),
    areFriends(myUid, req.fromUid),
  ]);

  const status = incoming.exists() ? asString(incoming.data().status) : "";
  if (status !== "pending") return;

  const batch = writeBatch(db);
  batch.update(incomingRef, {
    status: "accepted",
    updatedAt: serverTimestamp(),
  });
  // My own crossed request to them is moot once theirs is accepted.
  if (reciprocal.exists() && asString(reciprocal.data().status) === "pending") {
    batch.update(reciprocalRef, { status: "cancelled", updatedAt: serverTimestamp() });
  }
  if (!alreadyFriends) {
    const countOps = await friendCountOps(myUid, req.fromUid, 1);
    const members = [myUid, req.fromUid].sort() as [string, string];
    batch.set(doc(db, FRIENDSHIPS, `${members[0]}_${members[1]}`), {
      members,
      createdAt: serverTimestamp(),
    });
    addFriendCountWrites(batch, countOps);
  }
  await batch.commit();
}

/**
 * Remove a friendship. Deletes the friendship document and decrements both
 * counts in one batch, and records an "unfriended you" notification for the
 * other person.
 *
 * No-op when the two are already not friends, so a stale screen cannot cause a
 * spurious count change (or a notification for something that did not happen).
 */
export async function unfriend(meUid: string, otherUid: string, actor: ActorInfo): Promise<void> {
  if (!meUid || !otherUid || meUid === otherUid) return;
  if (!(await areFriends(meUid, otherUid))) return;

  const countOps = await friendCountOps(meUid, otherUid, -1);
  const batch = writeBatch(db);
  const notifRef = doc(collection(db, "notifications"));
  batch.delete(doc(db, FRIENDSHIPS, friendshipId(meUid, otherUid)));
  addFriendCountWrites(batch, countOps);
  batch.set(
    notifRef,
    notifPayload(
      {
        toUid: otherUid,
        kind: "unfriend",
        fromName: actor.name,
        fromColor: actor.color,
        fromHandle: actor.handle,
        fromAvatarId: actor.avatarId,
        text: `${actor.name} unfriended you.`,
        link: "/app/friends",
      },
      meUid,
    ),
  );
  await batch.commit();
  triggerPush(notifRef.id);
}

/**
 * Reject ("decline") an incoming request. A crossed request of mine to the same
 * person is cancelled in the same batch — declining means no connection is
 * wanted, and leaving my own outgoing alive would let them accept it and form
 * the friendship I just declined.
 */
export async function declineRequest(req: FriendRequest): Promise<void> {
  const incomingRef = doc(db, FRIEND_REQUESTS, req.id);
  const reciprocalRef = requestRef(req.toUid, req.fromUid);
  const [incoming, reciprocal] = await Promise.all([getDoc(incomingRef), getDoc(reciprocalRef)]);

  // Same idempotency as acceptRequest: only a pending request can be rejected.
  if (!incoming.exists() || asString(incoming.data().status) !== "pending") return;

  const batch = writeBatch(db);
  batch.update(incomingRef, {
    status: "rejected",
    updatedAt: serverTimestamp(),
  });
  if (reciprocal.exists() && asString(reciprocal.data().status) === "pending") {
    batch.update(reciprocalRef, { status: "cancelled", updatedAt: serverTimestamp() });
  }
  await batch.commit();
}

// ------------------------------------------------------------ friendships

/** True when the friendship document exists. One read, no index. */
export async function areFriends(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false;
  const snap = await getDoc(doc(db, FRIENDSHIPS, friendshipId(a, b)));
  return snap.exists();
}

/** Uids of my confirmed friends. */
export async function friendUids(myUid: string): Promise<Set<string>> {
  const snap = await getDocs(query(friendshipsCol, where("members", "array-contains", myUid)));
  const ids = new Set<string>();
  for (const d of snap.docs) {
    const members = (d.data().members ?? []) as unknown[];
    for (const m of members) if (typeof m === "string" && m !== myUid) ids.add(m);
  }
  return ids;
}

/** My friends with their current public profiles, sorted by name. */
export async function listFriends(myUid: string): Promise<PublicProfile[]> {
  const ids = await friendUids(myUid);
  if (ids.size === 0) return [];
  const profiles = await getPublicProfiles(Array.from(ids));
  return Array.from(ids)
    .map((uid) => profiles.get(uid))
    .filter((p): p is PublicProfile => p !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
}
