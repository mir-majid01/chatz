/**
 * ChatZ push worker — the one bridge between "a notification doc was created"
 * and FCM HTTP v1, without a Blaze plan.
 *
 * Flow: the sender's app POSTs { notifId } after the doc lands in Firestore.
 * The worker then treats the DATABASE as the payload authority — it reads the
 * notification doc itself (so a caller can forge nothing), reads the
 * recipient's device token from their owner-only private doc, sends one
 * data-only FCM message, and stamps pushedAt back onto the doc. That stamp is
 * also the dedupe marker: a second ping for the same doc is a no-op, and the
 * recipient's in-app listener skips any doc that carries it.
 *
 * Secrets (wrangler secret put):
 *   SA_JSON  — the chatz-push service-account key JSON, verbatim.
 *
 * Vars (wrangler.jsonc): CLEANUP_DRY_RUN ("false" to actually delete),
 * RETENTION_BATCH. The `scheduled` handler runs the 24-hour retention sweep.
 */

import { runRetention, RETENTION_DEFAULT_BATCH } from "./retention.js";

const PROJECT_ID = "dropscope-b588a";
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const FCM_SEND = `https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

let cachedToken = null; // { value, expiresAt }

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const pemToDer = (pem) => {
  const b64 = pem.split("\n").filter((l) => !l.startsWith("-----")).join("");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

async function getAccessToken(env) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const sa = JSON.parse(env.SA_JSON);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = b64url(
    new TextEncoder().encode(
      JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, exp: now + 3600, iat: now }),
    ),
  );
  const sig = b64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`)));
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${header}.${claims}.${sig}`,
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  const tok = await res.json();
  cachedToken = { value: tok.access_token, expiresAt: Date.now() + (tok.expires_in - 120) * 1000 };
  return cachedToken.value;
}

async function fsGet(path, token) {
  const res = await fetch(`${FS_BASE}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fs read ${path}: ${res.status}`);
  return res.json();
}

async function fsPatch(path, token, fields) {
  const q = Object.keys(fields).map((k) => `updateMask.fieldPaths=${k}`).join("&");
  const res = await fetch(`${FS_BASE}/${path}?${q}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`fs patch ${path}: ${res.status}`);
  return res.json();
}

/** Firestore REST value extraction — only the field shapes ChatZ writes. */
const str = (doc, key) => doc?.fields?.[key]?.stringValue ?? "";
const boolFalse = (doc, key) => doc?.fields?.[key]?.booleanValue === false;

async function handlePush(request, env) {
  let notifId;
  try {
    ({ notifId } = await request.json());
  } catch {
    return Response.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  if (typeof notifId !== "string" || !/^[A-Za-z0-9_]{8,40}$/.test(notifId)) {
    return Response.json({ ok: false, error: "bad id" }, { status: 400 });
  }

  // The doc's own pushedAt stamp is the dedupe marker. Two pings racing before
  // the first stamp lands would post twice, and both posts hash the same
  // notification id to the same Android notification id — so the second
  // replaces the first in the shade rather than stacking.
  const token = await getAccessToken(env);
  const notif = await fsGet(`notifications/${notifId}`, token);
  if (!notif) return Response.json({ ok: false, error: "no such doc" }, { status: 404 });
  if (notif.fields?.pushedAt?.timestampValue) {
    return Response.json({ ok: true, skipped: "already" });
  }
  if (notif.fields?.expiresAt?.timestampValue && new Date(notif.fields.expiresAt.timestampValue) < new Date()) {
    return Response.json({ ok: true, skipped: "expired" });
  }

  const toUid = str(notif, "toUid");
  if (!/^[A-Za-z0-9_-]{12,40}$/.test(toUid)) return Response.json({ ok: false, error: "bad toUid" }, { status: 400 });

  const priv = await fsGet(`users/${toUid}/private/data`, token);
  const fcmToken = str(priv, "fcmToken");
  if (!fcmToken) {
    // Recipient is on a pre-push app version or never registered a token:
    // their client-side listener + catch-up watermark still cover them.
    return Response.json({ ok: true, skipped: "no token" });
  }

  const kind = str(notif, "kind");
  const send = await fetch(FCM_SEND, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        token: fcmToken,
        // Data-only on purpose, and strictly data-only: putting anything under
        // android.notification (even just channel_id) makes FCM classify this as
        // a notification message, and then a backgrounded app gets the OS's own
        // tray entry — blank, because there is no title/body to render — while
        // onMessageReceived never runs. The service creates its channel and
        // decides presentation, so a foregrounded ChatZ can stay silent and let
        // the in-app badge speak.
        data: {
          notifId,
          kind,
          title: str(notif, "fromName") || "ChatZ",
          body: str(notif, "text"),
          link: str(notif, "link"),
        },
        android: { priority: "high" },
      },
    }),
  });
  const sendBody = await send.text();
  if (!send.ok) {
    if (send.status === 400 && /UNREGISTERED/.test(sendBody)) {
      // Stale token: clear it so future pushes skip fast; the app re-registers.
      await fsPatch(`users/${toUid}/private/data`, token, { fcmToken: { stringValue: "" } }).catch(() => {});
      return Response.json({ ok: true, skipped: "unregistered" });
    }
    console.error("fcm send failed", send.status, sendBody.slice(0, 300));
    return Response.json({ ok: false, error: "fcm failed" }, { status: 502 });
  }

  // Stamp the doc: it records the delivery, and it is what makes the recipient's
  // in-app listener and any replayed ping leave this event alone.
  await fsPatch(`notifications/${notifId}`, token, {
    pushedAt: { timestampValue: new Date().toISOString() },
  }).catch(() => {});
  return Response.json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
    if (request.method === "POST" && url.pathname === "/push") {
      try {
        return await handlePush(request, env);
      } catch (err) {
        console.error("push worker error", err?.message);
        return Response.json({ ok: false, error: "internal" }, { status: 500 });
      }
    }
    return Response.json({ ok: true, service: "chatz-push" });
  },

  /**
   * 24-hour retention sweep. Counts only, never contents: message text and
   * notification bodies are user data and must not reach the logs.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          const token = await getAccessToken(env);
          const report = await runRetention({
            base: FS_BASE,
            token,
            dryRun: env.CLEANUP_DRY_RUN !== "false",
            limit: Number(env.RETENTION_BATCH) || RETENTION_DEFAULT_BATCH,
          });
          console.log(
            `retention dryRun=${report.dryRun} found=${report.totalFound} deleted=${report.totalDeleted} ` +
              report.targets.map((t) => `${t.label}:${t.found}/${t.deleted}${t.error ? "!err" : ""}`).join(" "),
          );
        } catch (err) {
          console.error("retention failed", String(err?.message ?? err).slice(0, 200));
        }
      })(),
    );
  },
};
