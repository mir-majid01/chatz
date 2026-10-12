// Blocking, stored on Firestore.
//
//   blocks/{blockerUid}_{blockedUid}   { blockerUid, blockedUid, blockedName,
//                                        blockedHandle, blockedColor,
//                                        blockedAvatarId, createdAt }
//
// The document ID is derived from the pair, so blocking twice is the same
// document. Display fields for the blocked person are denormalized so the
// blocker's "Blocked accounts" list never needs to read the blocked person's
// profile (which the rules deny once a block exists).
//
// A block is enforced by the security rules: the blocked person cannot read the
// blocker's profile, stats, presence or chats. Deleting a block never restores
// the friendship — that requires the normal request/accept flow again.
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  where,
  writeBatch,
} from "firebase/firestore";
import { db } from "./firebase";
import {
  addFriendCountWrites,
  areFriends,
  friendCountOps,
  friendshipId,
  requestId,
  type ActorInfo,
} from "./friends-repo";
import { notifPayload } from "./notifications-store";
import { triggerPush } from "./push-repo";

const BLOCKS = "blocks";

export type BlockState = {
  /** I blocked the other person. */
  blockedByMe: boolean;
  /** The other person blocked me. */
  blockedByThem: boolean;
};

export type BlockedUser = {
  uid: string;
  name: string;
  handle: string;
  color: string;
  avatarId?: string;
  /** ISO timestamp of when the block was created. */
  at: string;
};

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asIso(v: unknown): string {
  const t = v as { toDate?: () => Date } | null;
  if (t && typeof t.toDate === "function") return t.toDate().toISOString();
  return typeof v === "string" ? v : "";
}

function blockRef(blockerUid: string, blockedUid: string) {
  return doc(db, BLOCKS, `${blockerUid}_${blockedUid}`);
}

/**
 * Whether a block exists in either direction. Two single-document reads, so the
 * rules can verify each side separately (the blocked person is allowed to learn
 * that the blocker blocked them; that is how the UI explains the lost access).
 */
export async function fetchBlockState(meUid: string, otherUid: string): Promise<BlockState> {
  if (!meUid || !otherUid || meUid === otherUid) {
    return { blockedByMe: false, blockedByThem: false };
  }
  const [mine, theirs] = await Promise.all([
    getDoc(blockRef(meUid, otherUid)),
    getDoc(blockRef(otherUid, meUid)),
  ]);
  return { blockedByMe: mine.exists(), blockedByThem: theirs.exists() };
}

/** Uids I have blocked. */
export async function blockedUids(meUid: string): Promise<Set<string>> {
  const snap = await getDocs(query(collection(db, BLOCKS), where("blockerUid", "==", meUid)));
  return new Set(snap.docs.map((d) => asString(d.data().blockedUid)));
}

/** My blocked accounts, newest first, resolved from the denormalized fields. */
export async function listBlocked(meUid: string): Promise<BlockedUser[]> {
  const snap = await getDocs(query(collection(db, BLOCKS), where("blockerUid", "==", meUid)));
  return snap.docs
    .map((d) => {
      const data = d.data() as Record<string, unknown>;
      return {
        uid: asString(data.blockedUid),
        name: asString(data.blockedName) || "Someone",
        handle: asString(data.blockedHandle),
        color: asString(data.blockedColor) || "#5E72E4",
        avatarId: (data.blockedAvatarId as string) ?? undefined,
        at: asIso(data.createdAt),
      };
    })
    .filter((b) => b.uid)
    .sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * Block someone. One batch:
 *   1. the block document itself,
 *   2. the friendship, if one exists (with both friend counts decremented),
 *   3. any pending friend request between the two, in either direction,
 *   4. a "blocked you" notification for the target.
 *
 * Unblocking never re-creates any of this; the relationship must be rebuilt
 * through a fresh request and acceptance.
 */
export async function blockUser(
  meUid: string,
  targetUid: string,
  target: { name: string; handle?: string; color?: string; avatarId?: string },
  actor: ActorInfo,
): Promise<void> {
  if (!meUid || !targetUid || meUid === targetUid) return;

  const [wasFriend, outgoing, incoming] = await Promise.all([
    areFriends(meUid, targetUid),
    getDoc(doc(db, "friendRequests", requestId(meUid, targetUid))),
    getDoc(doc(db, "friendRequests", requestId(targetUid, meUid))),
  ]);
  const countOps = wasFriend ? await friendCountOps(meUid, targetUid, -1) : [];

  const batch = writeBatch(db);
  batch.set(blockRef(meUid, targetUid), {
    blockerUid: meUid,
    blockedUid: targetUid,
    blockedName: target.name,
    blockedHandle: target.handle ?? "",
    blockedColor: target.color ?? "",
    blockedAvatarId: target.avatarId ?? null,
    createdAt: serverTimestamp(),
  });
  if (wasFriend) batch.delete(doc(db, "friendships", friendshipId(meUid, targetUid)));
  addFriendCountWrites(batch, countOps);

  if (outgoing.exists() && asString(outgoing.data().status) === "pending") {
    batch.update(doc(db, "friendRequests", requestId(meUid, targetUid)), {
      status: "cancelled",
      updatedAt: serverTimestamp(),
    });
  }
  if (incoming.exists() && asString(incoming.data().status) === "pending") {
    batch.update(doc(db, "friendRequests", requestId(targetUid, meUid)), {
      status: "rejected",
      updatedAt: serverTimestamp(),
    });
  }

  const notifRef = doc(collection(db, "notifications"));
  batch.set(
    notifRef,
    notifPayload(
      {
        toUid: targetUid,
        kind: "block",
        fromName: actor.name,
        fromColor: actor.color,
        fromHandle: actor.handle,
        fromAvatarId: actor.avatarId,
        text: `${actor.name} blocked you. You can no longer view this profile or interact with them.`,
        link: "/app",
      },
      meUid,
    ),
  );
  await batch.commit();
  triggerPush(notifRef.id);
}

/**
 * Unblock someone. Removes only the block document; the friendship is NOT
 * restored and no notification is sent — the two users must go through the
 * normal friend-request flow again.
 */
export async function unblockUser(meUid: string, targetUid: string): Promise<void> {
  if (!meUid || !targetUid || meUid === targetUid) return;
  await deleteDoc(blockRef(meUid, targetUid));
}

/** Batch-compatible block write, for callers that need it inside a larger batch. */
export function blockWrite(
  batch: ReturnType<typeof writeBatch>,
  meUid: string,
  targetUid: string,
  target: { name: string; handle?: string; color?: string; avatarId?: string },
): void {
  batch.set(blockRef(meUid, targetUid), {
    blockerUid: meUid,
    blockedUid: targetUid,
    blockedName: target.name,
    blockedHandle: target.handle ?? "",
    blockedColor: target.color ?? "",
    blockedAvatarId: target.avatarId ?? null,
    createdAt: serverTimestamp(),
  });
}
