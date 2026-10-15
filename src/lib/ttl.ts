// Temporary activity (reactions, comments, notifications) expires after 24 hours.
//
//   - The write carries `expiresAt` = now + 24h from the CLIENT clock (rules bound
//     it to ±1h of request.time), so a skewed device can mint a longer life.
//
// There is no Firestore TTL policy — TTL is a Blaze-plan feature and this project
// is on Spark — so nothing physically deletes an expired document, and the rules
// apply no read-time expiry. Every reader MUST therefore drop documents whose
// stamp is already in the past (isExpired); that is the only enforcement here.
// A missing or malformed stamp counts as non-expiring, so a broken write leaves a
// document visible indefinitely rather than hiding user data.
import { Timestamp } from "firebase/firestore";

export const TTL_MS = 24 * 60 * 60 * 1000;

/** Client-side timestamp for `expiresAt` fields. */
export function expiresAt24h(): Timestamp {
  return Timestamp.fromMillis(Date.now() + TTL_MS);
}

/** True only when `v` is a valid timestamp that lies in the past. */
export function isExpired(v: unknown, nowMs: number = Date.now()): boolean {
  const t = v as { toMillis?: () => number } | null | undefined;
  if (!t || typeof t.toMillis !== "function") return false;
  const ms = t.toMillis();
  return typeof ms === "number" && Number.isFinite(ms) && ms <= nowMs;
}
