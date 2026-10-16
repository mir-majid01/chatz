// Temporary activity (reactions, comments, notifications, DM messages) lives for
// 24 hours.
//
//   - The authoritative clock is `createdAt`, which the rules pin to server time
//     (`createdAt == request.time`). A client cannot stretch a document's life
//     whatever its own clock says.
//   - `expiresAt` is still written for readability and for the push Worker's
//     skip check, and is treated as a fallback only when `createdAt` is absent.
//   - There is no Firestore TTL policy — TTL is a Blaze-plan feature and this
//     project is on Spark — so expiry is enforced in exactly two places: readers
//     filter with isExpiredDoc (below), and the `chatz-push` Worker's scheduled
//     cleanup deletes the documents physically.
//   - A document with neither stamp stays visible. Hiding a friend's message
//     because a write lost its timestamp is worse than showing it a day late;
//     the cleanup job reports those documents instead of guessing.
import { Timestamp } from "firebase/firestore";

export const TTL_MS = 24 * 60 * 60 * 1000;

/** Client-side timestamp for `expiresAt` fields. */
export function expiresAt24h(): Timestamp {
  return Timestamp.fromMillis(Date.now() + TTL_MS);
}

/** Milliseconds a Firestore Timestamp / Date / raw ms value represents, or null. */
function toMs(v: unknown): number | null {
  if (!v) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const ms = (v as { toMillis?: () => number }).toMillis?.();
  return typeof ms === "number" && Number.isFinite(ms) ? ms : null;
}

/** True only when `v` is a valid timestamp that lies in the past. */
export function isExpired(v: unknown, nowMs: number = Date.now()): boolean {
  const ms = toMs(v);
  return ms !== null && ms <= nowMs;
}

/**
 * Has this document outlived its 24 hours? Deadlines come from server-owned
 * `createdAt`; a document with no server stamp falls back to its written
 * `expiresAt`, and one with neither is kept.
 */
export function isExpiredDoc(
  data: { createdAt?: unknown; expiresAt?: unknown } | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!data) return false;
  const created = toMs(data.createdAt);
  if (created !== null) return nowMs >= created + TTL_MS;
  return isExpired(data.expiresAt, nowMs);
}

/** When a document becomes unreadable, derived the same way as isExpiredDoc. */
export function retentionDeadlineMs(data: {
  createdAt?: unknown;
  expiresAt?: unknown;
}): number | null {
  const created = toMs(data.createdAt);
  if (created !== null) return created + TTL_MS;
  return toMs(data.expiresAt);
}
