// Firebase ID-token verification inside the Worker.
//
// The file endpoints need to know who is calling: only a signed-in user, and only
// about files they own or are allowed to receive. The app's Firebase session hands
// us an ID token, and an ID token is only proof if THIS code checks it — so this
// module is the entire authentication layer for upload and download authorisation.
// It is deliberately strict: a caller must present a real Firebase session, not a
// self-asserted uid in a JSON body.
//
// What is verified, and why each one matters:
//   - header.alg === "RS256"        → blocks the classic "alg:none" and HS256-forge
//   - signature over the exact bytes → the token was minted by Google, not by us
//   - kid resolves to a current JWKS entry → keys rotate; unknown kid is refused
//   - iss === https://securetoken.google.com/<projectId> → not a token for another
//     Firebase project (every validly-signed Google token would otherwise pass)
//   - aud === <projectId>           → same reason, from the other direction
//   - exp / iat                     → expired and clock-skewed tokens are refused
//   - sub non-empty, <=128 chars    → sub IS the uid we authorise against
//
// The JWKS is fetched with Google's own max-age and cached per isolate, and each
// key is imported once per key-set generation, so a verified request costs one
// WebCrypto verify — and a retired key set cannot keep authorising old keys.

const JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const MAX_KEY_AGE_MS = 60 * 60 * 1000; // Google serves max-age=3600; never trust more
const CLOCK_SKEW_MS = 60 * 1000; // tokens arriving up to a minute early are still refused...

let jwks = { keys: [], expiresAt: 0 };
/** @type {Map<string, CryptoKey>} */
const imported = new Map();

class AuthError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "AuthError";
    this.reason = reason;
  }
}

const b64urlToBytes = (s) => {
  let bin;
  try {
    bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    // base64 of the wrong shape or length. Reported as a malformed token rather
    // than a 500, because every one of these strings comes off the network.
    throw new AuthError("malformed-token");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const b64urlToJson = (s) => {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
  } catch {
    throw new AuthError("malformed-token");
  }
};

async function signingKeys(forceRefresh = false) {
  if (!forceRefresh && jwks.expiresAt > Date.now() + 30_000) return jwks.keys;
  const res = await fetch(JWKS_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new AuthError(`jwks-unavailable-${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body?.keys) || body.keys.length === 0) throw new AuthError("jwks-empty");
  // An explicit max-age=0 means "do not cache" and must not be mistaken for a
  // missing header, which is the only case that falls back to the default.
  const declared = /max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1];
  const ttl =
    declared === undefined ? MAX_KEY_AGE_MS : Math.min(Number(declared) * 1000, MAX_KEY_AGE_MS);
  jwks = { keys: body.keys, expiresAt: Date.now() + ttl };
  imported.clear();
  return jwks.keys;
}

async function keyForKid(kid) {
  // Always consult the key set first: the imported-CryptoKey cache is keyed by the
  // generation of the set it came from, so refetching the JWKS retires old keys
  // instead of trusting a revoked one until an unknown kid happens to arrive.
  const keys = await signingKeys();
  const jwk = keys.find((k) => k.kid === kid);
  if (!jwk) throw new AuthError("unknown-kid");
  if (jwk.use !== "sig" || jwk.kty !== "RSA" || jwk.alg !== "RS256")
    throw new AuthError("bad-key-shape");
  const cacheKey = `${jwks.expiresAt}:${kid}`;
  const cached = imported.get(cacheKey);
  if (cached) return cached;
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  if (imported.size > 16) imported.clear();
  imported.set(cacheKey, key);
  return key;
}

/**
 * @returns {Promise<{uid: string, email: string, name: string, picture: string}>}
 * @throws {AuthError} for any token that is not a live session of `projectId`
 */
export async function verifyIdToken(token, projectId) {
  if (typeof token !== "string") throw new AuthError("missing-token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError("missing-token");
  const [h, p, s] = parts;

  const header = b64urlToJson(h);
  if (header?.alg !== "RS256" || typeof header.kid !== "string") throw new AuthError("bad-alg");

  const sig = b64urlToBytes(s);
  const payload = b64urlToJson(p);
  const now = Date.now();

  const verifyWith = async (kid) => {
    const key = await keyForKid(kid);
    return crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      sig,
      new TextEncoder().encode(`${h}.${p}`),
    );
  };

  let ok;
  try {
    ok = await verifyWith(header.kid);
  } catch (err) {
    if (!(err instanceof AuthError) || err.reason !== "unknown-kid") throw err;
    // Google publishes a new key before every issuer starts using it, so a kid we
    // have not seen can be legitimate. Exactly one forced refresh, then no.
    // (A wrong signature returns false and must NOT reach this branch — retrying
    // it would just fetch the keys again on every forged token.)
    await signingKeys(true);
    ok = await verifyWith(header.kid);
  }
  if (!ok) throw new AuthError("bad-signature");

  if (payload?.iss !== `https://securetoken.google.com/${projectId}`)
    throw new AuthError("bad-issuer");
  if (payload?.aud !== projectId) throw new AuthError("bad-audience");
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) throw new AuthError("expired");
  if (typeof payload.iat !== "number" || payload.iat * 1000 > now + CLOCK_SKEW_MS)
    throw new AuthError("not-yet-valid");
  if (typeof payload.sub !== "string" || payload.sub.length < 8 || payload.sub.length > 128) {
    throw new AuthError("bad-subject");
  }
  if (payload.sub !== payload.user_id) throw new AuthError("subject-mismatch");
  if (payload.firebase?.sign_in_provider !== "google.com") {
    // ChatZ has exactly one sign-in method, so a token from any other provider is
    // not a ChatZ session even though Google signed it.
    throw new AuthError("bad-provider");
  }

  return {
    uid: payload.sub,
    email: typeof payload.email === "string" ? payload.email : "",
    name: typeof payload.name === "string" ? payload.name : "",
    picture: typeof payload.picture === "string" ? payload.picture : "",
  };
}

/** Reads the `Authorization: Bearer <id token>` header the app always sends. */
export function bearerToken(request) {
  const h = request.headers.get("authorization") ?? "";
  return /^Bearer /i.test(h) ? h.slice(7).trim() : "";
}

export { AuthError };
