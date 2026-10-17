/**
 * Firestore REST, shared by the push and the file endpoints.
 *
 * The Worker already holds a service account for FCM, and that account is an
 * admin of the project, so these reads and writes bypass the security rules.
 * That is the whole reason the file endpoints can exist: `state`, `actualSize`
 * and `etag` are fields no client may write, and the only way to write them is
 * from outside the rule system.
 *
 * It also means the opposite: nothing here trusts an argument it was handed.
 * Every path is built from a value this module read out of the database, and
 * callers pass document ids that were already pattern-checked.
 */

export const PROJECT_ID = "dropscope-b588a";
export const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
export const FCM_SEND = `https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`;

/** @returns the document, or null when it does not exist. */
export async function fsGet(path, token) {
  const res = await fetch(`${FS_BASE}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fs read ${path}: ${res.status}`);
  return res.json();
}

/**
 * Patch only the fields named in `fields`. Firestore's PATCH with an updateMask
 * leaves every other field alone, which is what lets the ready-transition write
 * the seven Worker fields without rewriting the sender's declaration.
 */
export async function fsPatch(path, token, fields) {
  const q = Object.keys(fields)
    .map((k) => `updateMask.fieldPaths=${k}`)
    .join("&");
  const res = await fetch(`${FS_BASE}/${path}?${q}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`fs patch ${path}: ${res.status}`);
  return res.json();
}

export async function fsDelete(path, token) {
  const res = await fetch(`${FS_BASE}/${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  // 404 means it was already gone, which is the same end state as having
  // deleted it, so it is success here and not an error.
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`fs delete ${path}: ${res.status}`);
  return true;
}

/** Field extraction — only the value shapes ChatZ writes. */
export const str = (doc, key) => doc?.fields?.[key]?.stringValue ?? "";

/**
 * Firestore REST serialises an integer as a *string* in `integerValue`, so this
 * returns a number or NaN — never a silent 0, because a missing size that reads
 * as zero would look like a legitimately empty file.
 */
export function int(doc, key) {
  const f = doc?.fields?.[key];
  if (!f) return NaN;
  const raw = f.integerValue ?? f.doubleValue;
  if (typeof raw !== "string" && typeof raw !== "number") return NaN;
  return Number(raw);
}

/** Epoch ms for a `timestampValue`, or NaN when the field is absent. */
export function millis(doc, key) {
  const v = doc?.fields?.[key]?.timestampValue;
  if (typeof v !== "string") return NaN;
  const t = Date.parse(v);
  return Number.isNaN(t) ? NaN : t;
}

export const bool = (doc, key) => doc?.fields?.[key]?.booleanValue === true;

/** A Firestore document name as `fsGet` wants it, from a REST `name` URL. */
export const pathOf = (doc) => doc?.name?.split("/documents/")[1] ?? "";
