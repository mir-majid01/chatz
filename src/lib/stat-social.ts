// Reactions and threaded comments on a friend's daily stat card.
//
//   statPosts/{ownerUid}_{day}/reactions/{reactorUid}   { uid, emoji, createdAt }
//   statPosts/{ownerUid}_{day}/comments/{commentId}     { authorUid, ..., text, parentId, createdAt }
//
// The parent statPosts document is never written — the subcollections are the
// data. The document id embeds the owner's uid (uids never contain "_") so the
// security rules can check the friendship without reading a parent document.
//
// Reactions use ASCII keys ("heart"), not raw emoji, so the rule that validates
// the value can never be broken by an encoding difference in the rules file.
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAfter,
} from "firebase/firestore";
import { db } from "./firebase";
import { expiresAt24h, isExpiredDoc } from "./ttl";

export const REACTIONS = [
  { key: "heart", glyph: "❤️" },
  { key: "fire", glyph: "🔥" },
  { key: "thumbs", glyph: "👍" },
  { key: "wow", glyph: "😮" },
  { key: "laugh", glyph: "😂" },
  { key: "clap", glyph: "👏" },
] as const;

export type ReactionKey = (typeof REACTIONS)[number]["key"];

/** Must stay in sync with the allowed values in firestore.rules. */
export const REACTION_KEYS: string[] = REACTIONS.map((r) => r.key);

export function glyphFor(key: string): string {
  return REACTIONS.find((r) => r.key === key)?.glyph ?? "❤️";
}

export type ReactionSummary = {
  /** emoji key → number of people who picked it */
  counts: Record<string, number>;
  /** my current reaction key, or null */
  mine: string | null;
};

export type StatComment = {
  id: string;
  authorUid: string;
  authorName: string;
  authorHandle: string;
  authorColor: string;
  authorAvatarId?: string;
  text: string;
  parentId: string | null;
  createdAt: string;
};

export function statPostId(ownerUid: string, day: string): string {
  return `${ownerUid}_${day}`;
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

function reactionsCol(ownerUid: string, day: string) {
  return collection(db, "statPosts", statPostId(ownerUid, day), "reactions");
}

function commentsCol(ownerUid: string, day: string) {
  return collection(db, "statPosts", statPostId(ownerUid, day), "comments");
}

/** Minimal shape shared by one-shot snapshots and live listens. */
type DocLike = { id: string; get: (field: string) => unknown };

const expiryFields = (d: DocLike) => ({
  createdAt: d.get("createdAt"),
  expiresAt: d.get("expiresAt"),
});

function summarizeReactions(docs: ReadonlyArray<DocLike>, myUid: string): ReactionSummary {
  const counts: Record<string, number> = {};
  let mine: string | null = null;
  for (const d of docs) {
    if (isExpiredDoc(expiryFields(d))) continue;
    const emoji = asString(d.get("emoji"));
    if (!REACTION_KEYS.includes(emoji)) continue;
    counts[emoji] = (counts[emoji] ?? 0) + 1;
    if (d.id === myUid) mine = emoji;
  }
  return { counts, mine };
}

/** Live reaction summary — fires now and again whenever anyone reacts. */
export function subscribeReactions(
  ownerUid: string,
  day: string,
  myUid: string,
  cb: (summary: ReactionSummary) => void,
  onError?: (err: Error) => void,
): () => void {
  return onSnapshot(
    reactionsCol(ownerUid, day),
    (snap) => cb(summarizeReactions(snap.docs, myUid)),
    onError ? (err) => onError(err) : () => {},
  );
}

/** One reaction per person: setting a new key replaces the old one. */
export async function setReaction(
  ownerUid: string,
  day: string,
  myUid: string,
  emoji: ReactionKey | null,
): Promise<void> {
  const ref = doc(db, "statPosts", statPostId(ownerUid, day), "reactions", myUid);
  if (emoji === null) {
    await deleteDoc(ref);
    return;
  }
  await setDoc(ref, { uid: myUid, emoji, createdAt: serverTimestamp(), expiresAt: expiresAt24h() });
}

function toComments(docs: ReadonlyArray<DocLike>): StatComment[] {
  return docs
    .filter((d) => !isExpiredDoc(expiryFields(d)))
    .map((d) => ({
      id: d.id,
      authorUid: asString(d.get("authorUid")),
      authorName: asString(d.get("authorName")) || "Someone",
      authorHandle: asString(d.get("authorHandle")),
      authorColor: asString(d.get("authorColor")) || "#5E72E4",
      authorAvatarId: asString(d.get("authorAvatarId")) || undefined,
      text: asString(d.get("text")),
      parentId: asString(d.get("parentId")) || null,
      createdAt: asIso(d.get("createdAt")),
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Live comment list — new comments and replies stream in, no refetch needed. */
export function subscribeComments(
  ownerUid: string,
  day: string,
  cb: (comments: StatComment[]) => void,
  onError?: (err: Error) => void,
): () => void {
  return onSnapshot(
    commentsCol(ownerUid, day),
    (snap) => cb(toComments(snap.docs)),
    onError ? (err) => onError(err) : () => {},
  );
}

/** Paginated comment loader: fetches the first `limit` comments ordered by createdAt desc. */
export async function loadCommentsPage(
  ownerUid: string,
  day: string,
  limitCount = 10,
  cursor?: { id: string; createdAt: number },
): Promise<StatComment[]> {
  const col = commentsCol(ownerUid, day);
  let q;
  if (cursor) {
    // Fetch older comments: orderBy createdAt desc, startAfter cursor
    q = query(col, orderBy("createdAt", "desc"), startAfter(cursor.createdAt, cursor.id), limit(limitCount));
  } else {
    // Initial page: newest first
    q = query(col, orderBy("createdAt", "desc"), limit(limitCount));
  }
  const snap = await getDocs(q);
  return toComments(snap.docs).reverse(); // Return oldest-first for display
}

export type CommentAuthor = {
  uid: string;
  name: string;
  handle: string;
  color: string;
  avatarId?: string;
};

export async function addComment(
  ownerUid: string,
  day: string,
  author: CommentAuthor,
  text: string,
  parentId: string | null,
): Promise<string> {
  const payload: Record<string, unknown> = {
    authorUid: author.uid,
    authorName: author.name,
    authorHandle: author.handle,
    authorColor: author.color,
    text,
    parentId: parentId ?? null,
    createdAt: serverTimestamp(),
    expiresAt: expiresAt24h(),
  };
  if (author.avatarId) payload.authorAvatarId = author.avatarId;
  const ref = await addDoc(commentsCol(ownerUid, day), payload);
  return ref.id;
}
