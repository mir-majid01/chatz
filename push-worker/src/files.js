/**
 * User-to-user file sharing: the endpoints that move bytes into R2 and metadata
 * into Firestore, and the one that hands them back out.
 *
 * Why a Worker at all: R2 presigned URLs cannot carry a size limit (R2 has no
 * presigned POST policy, so no content-length-range), a presigned URL cannot be
 * re-authorised mid-flight, and the app must never hold storage credentials.
 * So the bytes come *through* here and every decision is made from the database
 * rather than from whatever the caller asserted:
 *
 *   - the caller names a document id, never a storage path. The key is read out
 *     of that document and must equal `files/<uid>/<fileId>`.
 *   - the cap is enforced twice: against `declaredSize` before any bytes move,
 *     and against the object R2 actually stored afterwards. A client that
 *     declares 1 KiB and streams 200 MiB is refused and its upload aborted.
 *   - `state` becomes 'ready' only here, after R2 has confirmed the object, so a
 *     recipient can never be handed a file whose bytes did not land.
 *
 * Part size is fixed at 32 MiB: R2 requires every non-final part to be the same
 * size and at least 5 MiB, Workers caps a request body at 100 MiB, and 250 MiB
 * then costs at most 8 requests. Keeping the number server-side is what makes an
 * interrupted upload resumable — the client re-reads the plan from `begin`.
 */

import { AuthError, bearerToken, verifyIdToken } from "./auth.js";
import { PROJECT_ID, fsDelete, fsGet, fsPatch, int, millis, str } from "./fs.js";

export const MAX_FILE_BYTES = 262_144_000; // 250 MiB — the same number as the rules
export const PART_BYTES = 33_554_432; // 32 MiB
const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_PARTS = 10_000; // the S3/R2 limit

const FILE_ID_RE = /^[A-Za-z0-9_]{8,40}$/;
const UID_RE = /^[A-Za-z0-9_-]{12,40}$/;
const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
const ETAG_RE = /^[A-Za-z0-9-]{8,80}$/;

const json = (extra = {}) => Response.json({ ok: true, ...extra });
const bad = (status, code) => Response.json({ ok: false, error: code }, { status });

/**
 * @returns {{count: number, lastSize: number, sizeOf: Function}} or null when
 *   the total cannot be a legal multipart plan.
 */
export function planParts(totalBytes) {
  if (!Number.isInteger(totalBytes) || totalBytes <= 0 || totalBytes > MAX_FILE_BYTES) return null;
  const count = Math.max(1, Math.ceil(totalBytes / PART_BYTES));
  if (count > MAX_PARTS) return null;
  const lastSize = totalBytes - (count - 1) * PART_BYTES;
  // Only the final part may be short, and it may never exceed a full part; if it
  // did, the ceiling above is wrong and every later byte count would be too.
  if (lastSize <= 0 || lastSize > PART_BYTES) return null;
  return { count, lastSize, sizeOf: (n) => (n < count ? PART_BYTES : lastSize) };
}

/**
 * RFC 6264/5987 filename for a forced download.
 *
 * Two forms, because a receiver that only understands `filename=` must still get
 * something safe: the ASCII fallback replaces every control character, quote,
 * backslash and angle bracket, so it cannot close its own quoted string or
 * inject a header line; the UTF-8 form percent-encodes everything outside
 * attr-char rather than trusting encodeURIComponent, which leaves ! ( ) * ' and,
 * worse, a literal `%` alone.
 */
export function contentDisposition(fileName) {
  const raw = typeof fileName === "string" ? fileName.slice(0, 200) : "";
  const fallback =
    raw
      // Control characters (they could start a header line), the characters that
      // could close the quoted string, and the two that mean "path" to a client
      // that writes the name straight to disk.

      .replace(/[\x00-\x1f\x7f"'\\/<>()|]/g, "_")
      .replace(/[^\x20-\x7e]/g, "_")
      .trim() || "download";
  const ATTR_CHAR = /[A-Za-z0-9!#$&+\-.^_`|~]/;
  const bytes = new TextEncoder().encode(raw);
  let ext = "";
  for (const byte of bytes) {
    const c = String.fromCharCode(byte);
    ext += ATTR_CHAR.test(c) ? c : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return `attachment; filename="${fallback}"; filename*=UTF-8''${ext}`;
}

/**
 * Pass bytes through untouched while counting them, so the caller can compare
 * the stream against the plan after R2 accepted the part. Buffering a part to
 * check it first would put 32 MiB inside a 128 MB isolate.
 */
function countingStream(body, counter) {
  const reader = body.getReader();
  return new ReadableStream({
    async pull(ctrl) {
      const { done, value } = await reader.read();
      if (done) {
        ctrl.close();
        return;
      }
      if (value?.byteLength) counter.bytes += value.byteLength;
      ctrl.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** The authenticated uid, or the response the caller should return. */
async function caller(request) {
  const token = bearerToken(request);
  if (!token) return { res: bad(401, "no-token") };
  try {
    const { uid } = await verifyIdToken(token, PROJECT_ID);
    if (!UID_RE.test(uid)) return { res: bad(401, "bad-uid") };
    return { uid };
  } catch (err) {
    return { res: bad(401, err instanceof AuthError ? err.reason : "verify-failed") };
  }
}

/** Firestore stores a pair under one ordering only, and which one is not ours to know. */
async function friendshipLive(adminToken, a, b) {
  if (await fsGet(`friendships/${a}_${b}`, adminToken)) return true;
  return !!(await fsGet(`friendships/${b}_${a}`, adminToken));
}

/**
 * The document plus what every endpoint needs before it touches storage.
 *
 * `need: 'upload'` re-checks the friendship and the size because the rules only
 * proved them at create time, and an upload can start hours later — after an
 * unfriend, or on a document that predates these rules entirely.
 */
async function loadFile(adminToken, fileId, uid, need) {
  const doc = await fsGet(`files/${fileId}`, adminToken);
  if (!doc) return { res: bad(404, "no-such-file") };
  const senderUid = str(doc, "senderUid");
  const recipientUid = str(doc, "recipientUid");
  const state = str(doc, "state");
  const key = str(doc, "key");
  const declaredSize = int(doc, "declaredSize");
  const createdAt = millis(doc, "createdAt");

  if (!UID_RE.test(senderUid) || !UID_RE.test(recipientUid)) return { res: bad(400, "bad-owner") };
  if (key !== `files/${senderUid}/${fileId}`) return { res: bad(400, "bad-key") };
  if (!Number.isFinite(createdAt)) return { res: bad(400, "bad-createdAt") };
  if (Date.now() - createdAt > RETENTION_MS) return { res: bad(410, "expired") };

  if (need === "upload") {
    if (senderUid !== uid) return { res: bad(403, "not-yours") };
    if (state !== "pending" && state !== "uploading") return { res: bad(409, `state-${state}`) };
    if (!(declaredSize > 0 && declaredSize <= MAX_FILE_BYTES)) return { res: bad(400, "bad-size") };
    if (!(await friendshipLive(adminToken, senderUid, recipientUid)))
      return { res: bad(403, "not-friends") };
  } else {
    const shared =
      recipientUid === uid &&
      state === "ready" &&
      (await friendshipLive(adminToken, senderUid, recipientUid));
    if (senderUid !== uid && !shared) return { res: bad(403, "forbidden") };
  }
  return { doc, senderUid, recipientUid, state, key, declaredSize, createdAt };
}

/** POST /files/begin { fileId } — start, or resume, the upload the document declares. */
async function handleBegin(request, env, adminToken) {
  let fileId;
  try {
    ({ fileId } = await request.json());
  } catch {
    return bad(400, "bad-json");
  }
  if (typeof fileId !== "string" || !FILE_ID_RE.test(fileId)) return bad(400, "bad-id");

  const who = await caller(request);
  if (who.res) return who.res;
  const f = await loadFile(adminToken, fileId, who.uid, "upload");
  if (f.res) return f.res;
  const plan = planParts(f.declaredSize);
  if (!plan) return bad(400, "bad-size");

  // Resume: a document that already carries an uploadId is not restarted. A
  // second createMultipartUpload would strand the first one's parts until the
  // bucket lifecycle swept them, and the client would have two answers to choose
  // between — which is how a "successful" upload ends up half-written.
  const existing = str(f.doc, "uploadId");
  if (f.state === "uploading" && UPLOAD_ID_RE.test(existing)) {
    if (int(f.doc, "partsTotal") === plan.count) {
      return json({
        resumed: true,
        uploadId: existing,
        partBytes: PART_BYTES,
        partsTotal: plan.count,
      });
    }
    await env.FILES.resumeMultipartUpload(f.key, existing)
      .abort()
      .catch(() => {});
  }

  const upload = await env.FILES.createMultipartUpload(f.key, {
    httpMetadata: { contentType: str(f.doc, "mimeType") || "application/octet-stream" },
  });
  await fsPatch(`files/${fileId}`, adminToken, {
    state: { stringValue: "uploading" },
    uploadId: { stringValue: upload.uploadId },
    partsTotal: { integerValue: String(plan.count) },
    uploadStartedAt: { timestampValue: new Date().toISOString() },
  });
  // An event kind and a size, never a filename: the name is user data.
  console.log(`files begin uid=${who.uid} parts=${plan.count} bytes=${f.declaredSize}`);
  return json({ uploadId: upload.uploadId, partBytes: PART_BYTES, partsTotal: plan.count });
}

/**
 * PUT /files/part?fileId=..&part=..  (raw body)
 *
 * One part per invocation and nothing else: no Firestore read after the bytes
 * start moving, no body to buffer. Streaming is I/O, so the 10 ms free-plan CPU
 * budget never sees the file.
 */
async function handlePart(url, request, env, adminToken) {
  const fileId = url.searchParams.get("fileId") ?? "";
  const partNo = Number(url.searchParams.get("part") ?? "");
  if (!FILE_ID_RE.test(fileId) || !Number.isInteger(partNo) || partNo < 1)
    return bad(400, "bad-id");

  const who = await caller(request);
  if (who.res) return who.res;
  if (!request.body) return bad(400, "no-body");

  const f = await loadFile(adminToken, fileId, who.uid, "upload");
  if (f.res) return f.res;
  const uploadId = str(f.doc, "uploadId");
  const partsTotal = int(f.doc, "partsTotal");
  if (!UPLOAD_ID_RE.test(uploadId) || !Number.isInteger(partsTotal) || partsTotal < 1)
    return bad(409, "no-upload");
  if (partNo > partsTotal) return bad(400, "bad-part");

  const plan = planParts(f.declaredSize);
  if (!plan || plan.count !== partsTotal) return bad(409, "plan-mismatch");
  const expected = plan.sizeOf(partNo);

  const counter = { bytes: 0 };
  const upload = env.FILES.resumeMultipartUpload(f.key, uploadId);
  let part;
  try {
    part = await upload.uploadPart(partNo, countingStream(request.body, counter));
  } catch {
    // Either the upload was completed or aborted elsewhere, or R2 refused the
    // part. The client's next `begin` re-reads the truth from the document.
    console.error(`files part failed uid=${who.uid} part=${partNo}`);
    return bad(502, "part-failed");
  }

  if (counter.bytes !== expected) {
    // Wrong length for this slot. A non-uniform multipart upload cannot be
    // repaired, so the whole thing goes away and the client starts from `begin`.
    await upload.abort().catch(() => {});
    await markFailed(`files/${fileId}`, adminToken);
    console.warn(`files part size mismatch uid=${who.uid} got=${counter.bytes} want=${expected}`);
    return bad(413, "part-size");
  }
  return json({ part: partNo, etag: part.etag, bytes: counter.bytes });
}

/** POST /files/complete { fileId, parts: [{ part, etag }] } */
async function handleComplete(request, env, adminToken) {
  let body;
  try {
    body = await request.json();
  } catch {
    return bad(400, "bad-json");
  }
  const fileId = typeof body?.fileId === "string" ? body.fileId : "";
  if (!FILE_ID_RE.test(fileId)) return bad(400, "bad-id");
  const claimed = Array.isArray(body?.parts) ? body.parts : [];
  if (claimed.length === 0 || claimed.length > MAX_PARTS) return bad(400, "bad-parts");

  const who = await caller(request);
  if (who.res) return who.res;
  const f = await loadFile(adminToken, fileId, who.uid, "upload");
  if (f.res) return f.res;
  const uploadId = str(f.doc, "uploadId");
  const partsTotal = int(f.doc, "partsTotal");
  if (!UPLOAD_ID_RE.test(uploadId) || !Number.isInteger(partsTotal)) return bad(409, "no-upload");
  if (partsTotal !== claimed.length) return bad(409, "part-count");

  // Exactly the part numbers 1..n, each once, each with an etag shaped like one
  // this endpoint issued. Anything else is a client that lost track of its own
  // upload, and completing it would build a truncated object.
  const seen = new Set();
  const parts = [];
  for (const p of claimed) {
    const n = Number(p?.part);
    const etag = typeof p?.etag === "string" ? p.etag : "";
    if (!Number.isInteger(n) || n < 1 || n > partsTotal || seen.has(n))
      return bad(400, "bad-parts");
    if (!ETAG_RE.test(etag)) return bad(400, "bad-etag");
    seen.add(n);
    parts.push({ partNumber: n, etag });
  }

  parts.sort((a, b) => a.partNumber - b.partNumber);
  const upload = env.FILES.resumeMultipartUpload(f.key, uploadId);
  let object;
  try {
    object = await upload.complete(parts);
  } catch {
    console.error(`files complete failed uid=${who.uid}`);
    return bad(502, "complete-failed");
  }

  // The invariant: what R2 stored equals what was declared and what the rules
  // allowed. `actualSize` is therefore never the client's number.
  if (!object || object.size !== f.declaredSize) {
    if (object) await env.FILES.delete(f.key).catch(() => {});
    await markFailed(`files/${fileId}`, adminToken);
    console.warn(`files size drift uid=${who.uid} declared=${f.declaredSize}`);
    return bad(422, "size-drift");
  }

  // Freshness re-read: the sender may have deleted the document while the bytes
  // were streaming. Patching a deleted document would resurrect it as a stub, so
  // the object goes away instead.
  const still = await fsGet(`files/${fileId}`, adminToken);
  if (!still || str(still, "state") !== "uploading" || str(still, "uploadId") !== uploadId) {
    await env.FILES.delete(f.key).catch(() => {});
    return bad(410, "gone");
  }

  const fields = {
    state: { stringValue: "ready" },
    actualSize: { integerValue: String(object.size) },
    etag: { stringValue: String(object.httpEtag ?? object.etag ?? "") },
    readyAt: { timestampValue: new Date().toISOString() },
    senderUid: { stringValue: f.senderUid },
    recipientUid: { stringValue: f.recipientUid },
    key: { stringValue: f.key },
  };
  // Carried over verbatim from the read above, so a ready document can never end
  // up without the server timestamp that retention ages it from.
  if (still.fields?.createdAt) fields.createdAt = still.fields.createdAt;
  await fsPatch(`files/${fileId}`, adminToken, fields);
  console.log(`files ready uid=${who.uid} bytes=${object.size}`);
  return json({ bytes: object.size });
}

/** POST /files/abort { fileId } — the sender gives up, or retracts a finished file. */
async function handleAbort(request, env, adminToken) {
  let fileId;
  try {
    ({ fileId } = await request.json());
  } catch {
    return bad(400, "bad-json");
  }
  if (typeof fileId !== "string" || !FILE_ID_RE.test(fileId)) return bad(400, "bad-id");

  const who = await caller(request);
  if (who.res) return who.res;
  const doc = await fsGet(`files/${fileId}`, adminToken);
  if (!doc) return json({ alreadyGone: true });
  if (str(doc, "senderUid") !== who.uid) return bad(403, "not-yours");
  const key = str(doc, "key");
  if (key !== `files/${who.uid}/${fileId}`) return bad(400, "bad-key");

  const uploadId = str(doc, "uploadId");
  if (UPLOAD_ID_RE.test(uploadId)) {
    // An upload that already completed has no multipart to abort and abort()
    // simply rejects — either way the delete below is what matters.
    await env.FILES.resumeMultipartUpload(key, uploadId)
      .abort()
      .catch(() => {});
  }
  await env.FILES.delete(key).catch(() => {});
  await fsDelete(`files/${fileId}`, adminToken);
  console.log(`files aborted uid=${who.uid}`);
  return json();
}

/**
 * GET /files/download?fileId=.. — the only way bytes leave the bucket, so this
 * is where the presentation rules live.
 *
 * `attachment` and `nosniff` are not decoration: the content type came from the
 * uploader and nothing here can verify it, so a `.pdf` that is really HTML must
 * still not render inside the app's WebView with its Firebase tokens attached.
 */
async function handleDownload(url, request, env, adminToken) {
  const fileId = url.searchParams.get("fileId") ?? "";
  if (!FILE_ID_RE.test(fileId)) return bad(400, "bad-id");
  const who = await caller(request);
  if (who.res) return who.res;

  const f = await loadFile(adminToken, fileId, who.uid, "read");
  if (f.res) return f.res;

  const range = request.headers.get("range") ?? "";
  let getOptions;
  if (/^bytes=\d+-\d+$/.test(range)) {
    const [start, end] = range.slice(6).split("-").map(Number);
    if (end < start) return bad(400, "bad-range");
    getOptions = { range: { offset: start, length: end - start + 1 } };
  } else if (/^bytes=\d+-$/.test(range)) {
    getOptions = { range: { offset: Number(range.slice(6, -1)) } };
  }

  let object;
  try {
    object = await env.FILES.get(f.key, getOptions);
  } catch {
    // An unsatisfiable range reaches us here as an R2 error, not as an empty
    // body, and the client can do nothing with the detail.
    return bad(416, "bad-range");
  }
  if (!object) return bad(404, "no-bytes"); // retraction raced us

  const served = object.range ? object.range.length : object.size;
  const headers = new Headers();
  headers.set("Content-Type", str(f.doc, "mimeType") || "application/octet-stream");
  headers.set("Content-Disposition", contentDisposition(str(f.doc, "fileName")));
  headers.set("X-Content-Type-Options", "nosniff");
  // Private and no-store: two people in one chat must not be able to read each
  // other's file through a shared cache, and a device cache would outlive the 24 h.
  headers.set("Cache-Control", "private, no-store");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Length", String(served));
  headers.set("ETag", `"${String(object.httpEtag ?? "").replace(/"/g, "")}"`);
  if (object.range) {
    headers.set(
      "Content-Range",
      `bytes ${object.range.start}-${object.range.start + served - 1}/${object.size}`,
    );
  }
  return new Response(object.body, { status: object.range ? 206 : 200, headers });
}

/** A file that will never be ready: kept for the audit trail, swept by retention. */
async function markFailed(path, adminToken) {
  await fsPatch(path, adminToken, {
    state: { stringValue: "failed" },
    uploadId: { stringValue: "" },
    failedAt: { timestampValue: new Date().toISOString() },
  }).catch(() => {});
}

const ROUTES = {
  "POST /files/begin": (url, req, env, tok) => handleBegin(req, env, tok),
  "PUT /files/part": (url, req, env, tok) => handlePart(url, req, env, tok),
  "POST /files/complete": (url, req, env, tok) => handleComplete(req, env, tok),
  "POST /files/abort": (url, req, env, tok) => handleAbort(req, env, tok),
  "GET /files/download": (url, req, env, tok) => handleDownload(url, req, env, tok),
};

/**
 * @returns a Response, or null when the path is not ours so index.js can fall
 *   through to the push route. `adminToken` is the service-account access token
 *   the caller already obtained — one token exchange per request, not per hop.
 */
export async function handleFiles(request, env, adminToken) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/files/")) return null;
  const handler = ROUTES[`${request.method} ${url.pathname}`];
  if (!handler) return bad(404, "no-route");
  try {
    return await handler(url, request, env, adminToken);
  } catch {
    // No message: a thrown Firestore or R2 error can echo a document path, and a
    // path echoes a uid. The kind and the route are enough to act on.
    console.error(`files error ${request.method} ${url.pathname}`);
    return bad(500, "internal");
  }
}

export const FILES_ROUTES = Object.keys(ROUTES);
