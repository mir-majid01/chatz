/**
 * Retention cleanup for ChatZ, run from the Worker's `scheduled` trigger.
 *
 * Why this exists here: Firestore TTL is a Blaze-plan feature and the project is
 * on Spark, so expired documents are never deleted by Google. Nothing else in
 * the system can do it either — the app is often not running, and rules cannot
 * delete their own data. This Worker already holds an admin token for push.
 *
 * Design constraints that shaped it:
 *   - Workers Free allows 10 ms CPU per invocation and Firestore Spark allows a
 *     bounded number of deletes per day, so every target is capped per tick and
 *     the job is meant to be run often rather than exhaustively.
 *   - Deleting is idempotent by construction: a document that is already gone is
 *     simply not returned by the next query, so an interrupted run needs no
 *     cursor and a doubled run does nothing.
 *   - `dryRun` defaults to ON. Deleting user data is a destructive production
 *     change, so real deletion needs CLEANUP_DRY_RUN="false" set deliberately.
 *   - Expiry is derived from the SERVER-owned `createdAt` (the rules pin it to
 *     request.time), never from a client-supplied `expiresAt`. Same rule the
 *     readers apply in src/lib/ttl.ts — keep the two in step.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BATCH = 40;
const DELETE_CHUNK = 20; // Firestore batchCommit caps writes per request.

/** Collections whose documents age out, and how their parent path is rebuilt. */
const TARGETS = [
  { label: "notifications", kind: "collection", id: "notifications" },
  { label: "comments", kind: "group", id: "comments" },
  { label: "reactions", kind: "group", id: "reactions" },
  { label: "messages", kind: "group", id: "messages" },
];

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Run one structured query and return `{ path, createdMs }` for each hit.
 * `document.fields.createdAt.timestampValue` is what the delete needs; the REST
 * response is a stream of newline-delimited JSON objects, one per document.
 */
async function queryExpired(base, token, target, cutoffMs, limit) {
  const from =
    target.kind === "collection"
      ? [{ collectionId: target.id, allDescendants: false }]
      : [{ collectionId: target.id, allDescendants: true }];

  const res = await fetch(`${base}:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from,
        where: {
          fieldFilter: {
            field: { fieldPath: "createdAt" },
            op: "LESS_THAN",
            value: { timestampValue: iso(cutoffMs) },
          },
        },
        limit,
      },
    }),
  });
  if (!res.ok) throw new Error(`runQuery ${target.id}: ${res.status}`);

  const text = await res.text();
  const out = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // trailing fragment / non-JSON status line
    }
    const doc = parsed.document;
    if (!doc?.name) continue;
    const created = doc.fields?.createdAt?.timestampValue;
    if (!created) continue; // no server stamp → leave it, reported as a gap
    out.push({ path: doc.name.split("/documents/")[1] ?? doc.name, created });
  }
  return out;
}

async function deleteDocs(base, token, paths) {
  let deleted = 0;
  for (let i = 0; i < paths.length; i += DELETE_CHUNK) {
    const writes = paths.slice(i, i + DELETE_CHUNK).map((p) => ({ delete: `${base}/${p}` }));
    const res = await fetch(`${base}:commit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ writes }),
    });
    if (!res.ok) throw new Error(`commit: ${res.status} ${(await res.text()).slice(0, 160)}`);
    deleted += writes.length;
  }
  return deleted;
}

/**
 * One bounded pass. Returns counts only — never document contents, because
 * messages and notification text are user content and must not reach logs.
 */
export async function runRetention({ base, token, now = Date.now(), dryRun = true, limit = DEFAULT_BATCH }) {
  const cutoff = now - DAY_MS;
  const report = { dryRun, cutoff: iso(cutoff), targets: [] };

  for (const target of TARGETS) {
    const entry = { label: target.label, found: 0, deleted: 0, error: null };
    try {
      const docs = await queryExpired(base, token, target, cutoff, limit);
      entry.found = docs.length;
      if (!entry.found) {
        report.targets.push(entry);
        continue;
      }
      if (dryRun) {
        entry.deleted = 0;
      } else {
        entry.deleted = await deleteDocs(
          base,
          token,
          docs.map((d) => d.path),
        );
      }
    } catch (err) {
      entry.error = String(err?.message ?? err).slice(0, 160);
    }
    report.targets.push(entry);
  }

  report.totalFound = report.targets.reduce((a, t) => a + t.found, 0);
  report.totalDeleted = report.targets.reduce((a, t) => a + t.deleted, 0);
  return report;
}

export const RETENTION_TARGETS = TARGETS.map((t) => t.label);
export const RETENTION_DEFAULT_BATCH = DEFAULT_BATCH;
