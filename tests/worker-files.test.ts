import { describe, expect, it } from "vitest";
import worker from "../push-worker/src/index.js";
import {
  MAX_FILE_BYTES,
  PART_BYTES,
  contentDisposition,
  handleFiles,
  planParts,
} from "../push-worker/src/files.js";
import { objectKeyFor } from "../push-worker/src/retention.js";

/**
 * The file endpoints, minus the parts that need a live bucket.
 *
 * What is verified here is the arithmetic and the refusals — the two things that
 * decide whether a byte is stored at all. `planParts` is why a wrong size cannot
 * be smuggled through, `contentDisposition` is why a filename cannot inject a
 * header, `objectKeyFor` is why the sweep cannot delete someone else's object.
 * The happy path against real R2 is M3e's smoke test: a stubbed bucket would
 * only prove the code agrees with its own assumptions.
 */

describe("multipart plan", () => {
  it("covers the file end to end with no gap and no overlap", () => {
    for (const total of [
      1,
      1024,
      5 * 1024 * 1024,
      PART_BYTES,
      PART_BYTES + 1,
      2 * PART_BYTES,
      123_456_789,
      MAX_FILE_BYTES,
    ]) {
      const plan = planParts(total);
      expect(plan, `${total} bytes`).not.toBeNull();
      let sum = 0;
      for (let n = 1; n <= plan!.count; n++) sum += plan!.sizeOf(n);
      expect(sum).toBe(total);
      // R2 rejects a multipart upload whose non-final parts differ in size.
      for (let n = 1; n < plan!.count; n++) expect(plan!.sizeOf(n)).toBe(PART_BYTES);
      expect(plan!.lastSize).toBeGreaterThan(0);
      expect(plan!.lastSize).toBeLessThanOrEqual(PART_BYTES);
    }
  });

  it("refuses anything that is not a whole number of bytes within the cap", () => {
    expect(planParts(0)).toBeNull();
    expect(planParts(-1)).toBeNull();
    expect(planParts(1.5)).toBeNull();
    expect(planParts(NaN)).toBeNull();
    expect(planParts(Infinity)).toBeNull();
    expect(planParts(MAX_FILE_BYTES + 1)).toBeNull();
    // The cap is the same 250 MiB the Firestore create rule enforces, and at
    // 32 MiB a part it costs 8 requests — not 8,000.
    expect(planParts(MAX_FILE_BYTES)!.count).toBe(8);
  });
});

describe("download filename", () => {
  it("forces a download and repeats the name in both forms", () => {
    const header = contentDisposition("report.pdf");
    expect(header).toContain("attachment;");
    expect(header).toContain('filename="report.pdf"');
    expect(header).toContain("filename*=UTF-8''report.pdf");
  });

  it("cannot be quoted out of, and cannot inject a header line", () => {
    const attacks = [
      'a"; x="b',
      "a\\b",
      "a\r\nSet-Cookie: leak=1",
      'a"b"c',
      "a`b",
      "a|b",
      "a<b>",
      "a\tb",
      "../../etc/passwd",
    ];
    for (const name of attacks) {
      const header = contentDisposition(name);
      expect(header).not.toContain("\r");
      expect(header).not.toContain("\n");
      const fallback = /filename="([^"]*)"/.exec(header)?.[1] ?? null;
      expect(fallback).not.toBeNull();
      expect(fallback).not.toContain('"');
      expect(fallback).not.toContain("\\");
      expect(fallback).not.toContain("\t");
      expect(fallback).not.toContain("/");
    }
  });

  it("percent-encodes what the ASCII fallback had to give up", () => {
    const header = contentDisposition("réport (final).pdf");
    // attr-char excludes ( ) and a space, so the extended form is the only one
    // that can carry the real name; the fallback keeps something typable.
    expect(header).toContain("filename*=UTF-8''r%C3%A9port%20%28final%29.pdf");
    expect(header).toContain('filename="r_port _final_.pdf"');
  });

  it("never hands back an empty filename", () => {
    for (const name of ["", "   ", "///", "??"]) {
      expect(contentDisposition(name)).toMatch(/filename="[^"]+"/);
    }
    expect(contentDisposition("")).toContain('filename="download"');
  });

  it("is bounded, whatever the document claims", () => {
    const header = contentDisposition("x".repeat(5000));
    expect(header.length).toBeLessThan(600);
  });
});

describe("retention object key", () => {
  const sender = { stringValue: "aaaTestUid0000000000" };

  it("rebuilds the key from the path the database actually holds", () => {
    expect(objectKeyFor("files/fileA0001", { senderUid: sender })).toBe(
      "files/aaaTestUid0000000000/fileA0001",
    );
  });

  it("ignores a stored key that disagrees, rather than deleting what it names", () => {
    const fields = {
      senderUid: sender,
      key: { stringValue: "files/zzzOtherUid0000000/fileA0001" },
    };
    expect(objectKeyFor("files/fileA0001", fields)).toBe("files/aaaTestUid0000000000/fileA0001");
  });

  it("refuses to name an object for anything it cannot fully derive", () => {
    expect(objectKeyFor("chats/x/messages/y", { senderUid: sender })).toBeNull();
    expect(objectKeyFor("files/fileA0001", {})).toBeNull();
    expect(objectKeyFor("files/fileA0001", { senderUid: { stringValue: "short" } })).toBeNull();
    expect(
      objectKeyFor("files/fileA0001", { senderUid: { stringValue: "a".repeat(41) } }),
    ).toBeNull();
    expect(objectKeyFor("files/../../etc", { senderUid: sender })).toBeNull();
  });
});

describe("routing and refusal before any storage call", () => {
  const req = (method: string, path: string, body?: unknown) =>
    new Request(`https://chatz-push.test${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });

  it("leaves a path that is not a file route for the push handler", async () => {
    expect(await handleFiles(req("POST", "/push"), {}, "token")).toBeNull();
    expect(await handleFiles(req("GET", "/"), {}, "token")).toBeNull();
  });

  it("refuses an unknown file route instead of falling through to 200", async () => {
    const res = await handleFiles(req("POST", "/files/nope"), {}, "token");
    expect(res!.status).toBe(404);
    expect(await res!.json()).toEqual({ ok: false, error: "no-route" });
  });

  it("refuses a malformed id before reading auth or the database", async () => {
    for (const bad of ["x", "a".repeat(41), "has/slash", "has space", "%20"]) {
      const res = await handleFiles(req("POST", "/files/begin", { fileId: bad }), {}, "token");
      expect(res!.status, bad).toBe(400);
      expect(await res!.json()).toEqual({ ok: false, error: "bad-id" });
    }
  });

  it("refuses a malformed part number before anything else", async () => {
    for (const q of ["part=0", "part=1.5", "part=abc", "part=", "part=-2"]) {
      const res = await handleFiles(req("PUT", `/files/part?fileId=fileA0001&${q}`), {}, "token");
      expect(res!.status, q).toBe(400);
    }
    // A legal part number instead gets to the auth check and stops there: the
    // shape tests above prove the refusal order, this one proves it is not
    // everything falling through to 401 regardless of input.
    const next = await handleFiles(req("PUT", "/files/part?fileId=fileA0001&part=1"), {}, "token");
    expect(next!.status).toBe(401);
  });

  it("refuses an absent bearer token with 401, not a crash", async () => {
    const res = await handleFiles(
      req("POST", "/files/begin", { fileId: "fileA0001" }),
      {},
      "token",
    );
    expect(res!.status).toBe(401);
    expect(await res!.json()).toEqual({ ok: false, error: "no-token" });
  });

  it("says storage is unconfigured rather than throwing inside the first bucket call", async () => {
    // env without FILES: the binding is configuration, and the operator needs to
    // be told that in as many words.
    const res = await worker.fetch(req("POST", "/files/begin", { fileId: "fileA0001" }), {});
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "storage-unconfigured" });
  });

  it("answers JSON when the service account cannot be used at all", async () => {
    // A missing SA_JSON used to escape as a Workers 1102 HTML error page: the
    // token exchange sat outside every handler's try, and the app's upload UI
    // cannot read HTML.
    const res = await worker.fetch(req("POST", "/files/begin", { fileId: "fileA0001" }), {
      FILES: {},
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "worker-misconfigured" });
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("still answers the health check", async () => {
    const res = await worker.fetch(req("GET", "/"), {});
    expect(await res.json()).toEqual({ ok: true, service: "chatz-push" });
  });
});
