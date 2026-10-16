import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the Worker's authentication layer (`push-worker/src/auth.js`).
 *
 * The Worker has no session of its own: it trusts a Firebase ID token, so
 * `verifyIdToken` is the only thing between a random HTTP caller and "I am uid X,
 * send me X's file downloads". Every rejection branch is an attack that has to be
 * closed, so the negative cases ARE the feature.
 *
 * No emulator: the keypair is generated locally, the JWKS endpoint is stubbed, and
 * WebCrypto does the real RSA work.
 *
 * Run: npm test
 */

const PROJECT = "dropscope-b588a";
const JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const UID = "7Yz2kA9bQrT3xLm8Np5VcE1sZgH4";

type AuthMod = {
  verifyIdToken: (t: string, p: string) => Promise<{ uid: string; email: string; name: string }>;
  bearerToken: (r: Request) => string;
};

const b64 = (obj: unknown) =>
  btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64bytes = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const nowSec = () => Math.floor(Date.now() / 1000);

// TS's JsonWebKey has no kid/use, but the JWKS entries Firebase serves do have them.
type RsaJwk = JsonWebKey & { kid: string; use: string; alg: string };
type Keys = { private: CryptoKey; jwk: RsaJwk; kid: string };

async function makeKeys(kid: string): Promise<Keys> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 65, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  // The Web Crypto pair is {publicKey, privateKey}; `public` is a reserved word and
  // does not exist. Passing the wrong member fails exportKey with "not of type CryptoKey".
  const kp = pair as unknown as { publicKey: CryptoKey; privateKey: CryptoKey };
  const raw = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
  return { private: kp.privateKey, jwk: { ...raw, kid, use: "sig", alg: "RS256" }, kid };
}

/** A token in exactly the shape Firebase Auth mints. */
async function signToken(keys: Keys, claims: Record<string, unknown> = {}, kid?: string) {
  const h = b64({ alg: "RS256", typ: "JWT", kid: kid ?? keys.kid });
  const p = b64({
    iss: `https://securetoken.google.com/${PROJECT}`,
    aud: PROJECT,
    sub: UID,
    user_id: UID,
    iat: nowSec(),
    exp: nowSec() + 3600,
    auth_time: nowSec(),
    firebase: {
      identities: { "google.com": [{ provider_id: "google.com" }] },
      sign_in_provider: "google.com",
    },
    ...claims,
  });
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keys.private,
    new TextEncoder().encode(`${h}.${p}`),
  );
  return `${h}.${p}.${b64bytes(sig)}`;
}

/** Serves `keys` at the JWKS URL and counts the Worker's fetches. */
function stubJwks(keys: Keys[], maxAge = 3600) {
  const fetches: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      fetches.push(url);
      if (url !== JWKS_URL) throw new Error(`unexpected fetch: ${url}`);
      return new Response(JSON.stringify({ keys: keys.map((k) => k.jwk) }), {
        status: 200,
        headers: { "cache-control": `public, max-age=${maxAge}` },
      });
    }),
  );
  return fetches;
}

/** The AuthError reason a call rejects with, or "RESOLVED". */
async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "RESOLVED";
  } catch (e) {
    const err = e as { name?: string; reason?: string; message?: string };
    return err?.name === "AuthError" ? String(err.reason) : `THREW:${err?.message ?? e}`;
  }
}

let mod: AuthMod;
let keys: Keys;
let other: Keys;

beforeEach(async () => {
  keys ??= await makeKeys("chatz-test-key");
  other ??= await makeKeys("chatz-forged-key");
  vi.unstubAllGlobals();
  // The module caches the JWKS per isolate, so each test must import a fresh
  // instance: otherwise a key set cached by an earlier test would let a rejection
  // case pass for the wrong reason.
  vi.resetModules();
  stubJwks([keys]);
  mod = (await import("../push-worker/src/auth.js")) as unknown as AuthMod;
});

describe("verifyIdToken accepts a real Firebase session", () => {
  it("returns the uid the endpoints authorise against", async () => {
    const fetched = stubJwks([keys]);
    const token = await signToken(keys, { email: "a@example.com", name: "Ada" });
    const out = await mod.verifyIdToken(token, PROJECT);
    expect(out.uid).toBe(UID);
    expect(out.email).toBe("a@example.com");
    expect(out.name).toBe("Ada");
    expect(fetched).toEqual([JWKS_URL]);
  });

  it("reuses the cached key set instead of refetching per request", async () => {
    const fetched = stubJwks([keys]);
    const token = await signToken(keys);
    await mod.verifyIdToken(token, PROJECT);
    await mod.verifyIdToken(token, PROJECT);
    await mod.verifyIdToken(token, PROJECT);
    expect(fetched).toHaveLength(1);
  });
});

describe("verifyIdToken refuses everything else", () => {
  it("rejects a token signed by a key Google does not publish", async () => {
    const fetched = stubJwks([keys]);
    const forged = await signToken(other);
    expect(await reasonOf(mod.verifyIdToken(forged, PROJECT))).toBe("unknown-kid");
    // An unknown kid earns exactly one forced refresh — not one per forged token.
    expect(fetched).toHaveLength(2);
  });

  it("rejects a payload edited after signing", async () => {
    stubJwks([keys]);
    const [h, , s] = (await signToken(keys)).split(".");
    const forgedBody = b64({
      iss: `https://securetoken.google.com/${PROJECT}`,
      aud: PROJECT,
      sub: UID,
      user_id: UID,
      iat: nowSec(),
      exp: nowSec() + 60 * 60 * 24 * 365,
      firebase: { sign_in_provider: "google.com" },
    });
    expect(await reasonOf(mod.verifyIdToken(`${h}.${forgedBody}.${s}`, PROJECT))).toBe(
      "bad-signature",
    );
  });

  it("rejects alg=none and alg=HS256, the two classic JWT forgeries", async () => {
    stubJwks([keys]);
    const [, p, s] = (await signToken(keys)).split(".");
    const none = `${b64({ alg: "none", kid: keys.kid })}.${p}.`;
    const hs = `${b64({ alg: "HS256", kid: keys.kid })}.${p}.${s}`;
    expect(await reasonOf(mod.verifyIdToken(none, PROJECT))).toBe("bad-alg");
    expect(await reasonOf(mod.verifyIdToken(hs, PROJECT))).toBe("bad-alg");
  });

  it("rejects an expired token", async () => {
    stubJwks([keys]);
    const token = await signToken(keys, { exp: nowSec() - 1 });
    expect(await reasonOf(mod.verifyIdToken(token, PROJECT))).toBe("expired");
  });

  it("rejects a token minted for a different Firebase project", async () => {
    stubJwks([keys]);
    const wrongAud = await signToken(keys, { aud: "someone-else" });
    const wrongIss = await signToken(keys, { iss: "https://securetoken.google.com/someone-else" });
    expect(await reasonOf(mod.verifyIdToken(wrongAud, PROJECT))).toBe("bad-audience");
    expect(await reasonOf(mod.verifyIdToken(wrongIss, PROJECT))).toBe("bad-issuer");
  });

  it("rejects a provider ChatZ does not offer", async () => {
    stubJwks([keys]);
    const token = await signToken(keys, { firebase: { sign_in_provider: "password" } });
    expect(await reasonOf(mod.verifyIdToken(token, PROJECT))).toBe("bad-provider");
  });

  it("rejects a missing or inconsistent subject, because sub is the uid we trust", async () => {
    stubJwks([keys]);
    const mismatch = await signToken(keys, { user_id: "x" });
    const empty = await signToken(keys, { sub: "" });
    const short = await signToken(keys, { sub: "short", user_id: "short" });
    expect(await reasonOf(mod.verifyIdToken(mismatch, PROJECT))).toBe("subject-mismatch");
    expect(await reasonOf(mod.verifyIdToken(empty, PROJECT))).toBe("bad-subject");
    expect(await reasonOf(mod.verifyIdToken(short, PROJECT))).toBe("bad-subject");
  });

  it("rejects structurally broken input instead of throwing a decode error", async () => {
    stubJwks([keys]);
    expect(await reasonOf(mod.verifyIdToken("a.b.c.d", PROJECT))).toBe("missing-token");
    expect(await reasonOf(mod.verifyIdToken("a.b", PROJECT))).toBe("missing-token");
    expect(await reasonOf(mod.verifyIdToken(undefined as unknown as string, PROJECT))).toBe(
      "missing-token",
    );
    const badBody = `${b64({ alg: "RS256", kid: keys.kid })}.!!!!.c`;
    expect(await reasonOf(mod.verifyIdToken(badBody, PROJECT))).toBe("malformed-token");
  });

  it("refuses when the signing keys cannot be fetched at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    const token = await signToken(keys);
    expect(await reasonOf(mod.verifyIdToken(token, PROJECT))).toBe("jwks-unavailable-500");
  });

  it("does not trust a cached key set past Google's own max-age", async () => {
    const fetched = stubJwks([keys], 0);
    const token = await signToken(keys);
    await mod.verifyIdToken(token, PROJECT);
    await mod.verifyIdToken(token, PROJECT);
    expect(fetched.length).toBeGreaterThan(1);
  });
});

describe("bearerToken", () => {
  const req = (v: string | null) =>
    ({ headers: new Headers(v === null ? {} : { authorization: v }) }) as unknown as Request;

  it("reads the header the app sends", () => {
    expect(mod.bearerToken(req("Bearer a.b.c"))).toBe("a.b.c");
    expect(mod.bearerToken(req("bearer  x.y.z "))).toBe("x.y.z");
  });

  it("returns empty for anything else", () => {
    expect(mod.bearerToken(req(null))).toBe("");
    expect(mod.bearerToken(req("Basic abc"))).toBe("");
  });
});
