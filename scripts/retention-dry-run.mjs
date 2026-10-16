/**
 * Retention dry-run: measures what a 24-hour expiry policy would actually do to
 * the live database. Read-only — it never writes or deletes.
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=<service-account.json> node scripts/retention-dry-run.mjs
 *
 * It reports per-collection age buckets, documents that would be expired, ones
 * missing the timestamps the policy depends on, and the delete volume that a
 * cleanup job would face — because Cloud Firestore on the Spark plan caps
 * deletes per day, so an unbounded sweep is not an option.
 */
import { readFileSync, existsSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const KEY = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!KEY || !existsSync(KEY)) {
  console.error("Set GOOGLE_APPLICATION_CREDENTIALS to the service-account key path.");
  console.error("Example (PowerShell): $env:GOOGLE_APPLICATION_CREDENTIALS='C:\\path\\to\\key.json'");
  process.exit(1);
}
initializeApp({ credential: cert(JSON.parse(readFileSync(KEY, "utf8"))) });
const db = getFirestore();

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

/** Age buckets are in whole days since the document's own creation stamp. */
const bucket = (ageMs) => {
  if (ageMs < 0) return "future (clock skew)";
  if (ageMs < DAY) return "< 1 day";
  if (ageMs < 2 * DAY) return "1-2 days";
  if (ageMs < 7 * DAY) return "2-7 days";
  if (ageMs < 30 * DAY) return "7-30 days";
  return "> 30 days";
};
const BUCKETS = ["future (clock skew)", "< 1 day", "1-2 days", "2-7 days", "7-30 days", "> 30 days"];

const rows = [];
async function survey(label, ref, { subjectTo24h, idHint, nestedOf = null }) {
  const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  let total = 0;
  let noCreatedAt = 0;
  let noExpiry = 0;
  let expiryNot24h = 0;
  let expiredButPresent = 0;

  const docs = await ref.get();
  for (const d of docs.docs) {
    total++;
    const data = d.data();
    const created = data.createdAt?.toMillis?.() ?? null;
    const expires = data.expiresAt?.toMillis?.() ?? null;
    if (created == null) noCreatedAt++;
    else counts[bucket(now - created)]++;
    if (expires == null) noExpiry++;
    else if (created != null && Math.abs(expires - created - DAY) > 3600_000) expiryNot24h++;
    if (expires != null && expires < now) expiredButPresent++;
  }

  rows.push({
    label,
    subjectTo24h,
    idHint,
    nestedOf,
    total,
    expiredButPresent,
    noCreatedAt,
    noExpiry,
    expiryNot24h,
    buckets: counts,
  });
  return { total, docs };
}

// Top-level collections.
await survey("notifications", db.collection("notifications"), { subjectTo24h: true });
await survey("statPosts/*/comments", db.collectionGroup("comments"), { subjectTo24h: true });
await survey("statPosts/*/reactions", db.collectionGroup("reactions"), { subjectTo24h: true });
await survey("presence", db.collection("presence"), { subjectTo24h: false });
await survey("usageStats", db.collection("usageStats"), { subjectTo24h: false });
await survey("reports", db.collection("reports"), { subjectTo24h: false });
await survey("blocks", db.collection("blocks"), { subjectTo24h: false });
await survey("friendRequests", db.collection("friendRequests"), { subjectTo24h: false });
await survey("users", db.collection("users"), { subjectTo24h: false });

// DMs are the decision point: chats/{pair}/messages with no expiry field at all.
const chats = await db.collection("chats").get();
const msgCounts = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
let msgTotal = 0;
let msgMissingCreate = 0;
let oldestMsg = null;
for (const chat of chats.docs) {
  const msgs = await chat.ref.collection("messages").get();
  for (const m of msgs.docs) {
    msgTotal++;
    const created = m.data().createdAt?.toMillis?.() ?? null;
    if (created == null) msgMissingCreate++;
    else {
      msgCounts[bucket(now - created)]++;
      if (oldestMsg == null || created < oldestMsg) oldestMsg = created;
    }
  }
}

const pad = (s, n) => String(s).padEnd(n);
console.log("\n=== retention survey (read-only, no writes) ===\n");
console.log(
  pad("collection", 26) + pad("docs", 7) + pad("expired", 9) + pad("no exp. field", 15) + pad("no createdAt", 14) + "expiry != 24h",
);
for (const r of rows) {
  console.log(
    pad(r.label, 26) +
      pad(r.total, 7) +
      pad(r.expiredButPresent, 9) +
      pad(r.noExpiry, 15) +
      pad(r.noCreatedAt, 14) +
      r.expiryNot24h,
  );
}

console.log("\n=== age buckets ===\n");
for (const r of rows) {
  const line = BUCKETS.filter((b) => r.buckets[b] > 0).map((b) => `${b}: ${r.buckets[b]}`);
  if (line.length) console.log(`${pad(r.label, 26)} ${line.join(" | ")}`);
}

console.log("\n=== chats/{pairId}/messages (the 24h DM decision) ===\n");
console.log(`chat documents          : ${chats.size}`);
console.log(`message documents       : ${msgTotal}`);
console.log(`missing createdAt       : ${msgMissingCreate}`);
console.log(
  `oldest message        : ${oldestMsg ? `${Math.floor((now - oldestMsg) / DAY)} days ago` : "n/a"}`,
);
console.log(`age buckets             :`);
for (const b of BUCKETS) if (msgCounts[b]) console.log(`  ${pad(b, 20)} ${msgCounts[b]}`);
const wouldExpire = Object.entries(msgCounts)
  .filter(([b]) => b !== "< 1 day" && b !== "future (clock skew)")
  .reduce((a, [, n]) => a + n, 0);
console.log(`deleted by a 24h policy : ${wouldExpire} of ${msgTotal}`);

const allExpired = rows.reduce((a, r) => a + r.expiredButPresent, 0);
console.log("\n=== cleanup budget ===\n");
console.log(`already-expired docs still present : ${allExpired}`);
console.log(`plus messages to delete            : ${wouldExpire}`);
console.log(`total delete ops (first sweep)     : ${allExpired + wouldExpire}`);
console.log(`Spark plan delete allowance        : ~20,000/day (verify live console figure)`);
console.log(
  allExpired + wouldExpire > 20_000
    ? "VERDICT: exceeds one day's quota — cleanup MUST be batched and spread."
    : "VERDICT: fits inside a single day, but batching is still required for the 10 ms Worker CPU cap.",
);
