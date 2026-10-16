import { describe, expect, it } from "vitest";
import { TTL_MS, isExpired, isExpiredDoc, retentionDeadlineMs } from "../src/lib/ttl";

/**
 * Unit tests for the 24-hour reader rule.
 *
 * These matter because the rules apply NO read-time expiry: isExpiredDoc is the
 * only thing that decides whether an expired document is shown. The tests below
 * are all about which clock wins when the two stamps disagree.
 *
 * Run: npm test
 */

const NOW = 1_800_000_000_000; // a fixed "now" — no sleeping, no flaky clock
const ts = (ms: number) => ({ toMillis: () => ms });
const H = 60 * 60 * 1000;

describe("isExpiredDoc", () => {
  it("hides a document older than 24 hours by its server stamp", () => {
    expect(isExpiredDoc({ createdAt: ts(NOW - 25 * H) }, NOW)).toBe(true);
    expect(isExpiredDoc({ createdAt: ts(NOW - 23 * H) }, NOW)).toBe(false);
    // The boundary is inclusive: exactly createdAt + 24h is expired.
    expect(isExpiredDoc({ createdAt: ts(NOW - TTL_MS) }, NOW)).toBe(true);
  });

  it("trusts the server stamp and ignores a client-written expiresAt", () => {
    // A skewed device cannot stretch a document's life by writing a far expiry...
    expect(isExpiredDoc({ createdAt: ts(NOW - 30 * H), expiresAt: ts(NOW + 90 * H) }, NOW)).toBe(
      true,
    );
    // ...nor hide a fresh one by writing a past expiry.
    expect(isExpiredDoc({ createdAt: ts(NOW - 1 * H), expiresAt: ts(NOW - 1 * H) }, NOW)).toBe(
      false,
    );
  });

  it("falls back to expiresAt only when there is no server stamp", () => {
    expect(isExpiredDoc({ expiresAt: ts(NOW + 1 * H) }, NOW)).toBe(false);
    expect(isExpiredDoc({ expiresAt: ts(NOW - 1 * H) }, NOW)).toBe(true);
    // A malformed createdAt must not be read as "expired" — it falls back.
    expect(isExpiredDoc({ createdAt: "not-a-timestamp", expiresAt: ts(NOW + 1 * H) }, NOW)).toBe(
      false,
    );
  });

  it("keeps a document that carries neither stamp", () => {
    // Deliberate: hiding a friend's message because a write lost its timestamps is
    // worse than showing it a day late. The cleanup job reports these instead.
    expect(isExpiredDoc({}, NOW)).toBe(false);
    expect(isExpiredDoc({ createdAt: null, expiresAt: null }, NOW)).toBe(false);
    expect(isExpiredDoc(undefined, NOW)).toBe(false);
    expect(isExpiredDoc(null, NOW)).toBe(false);
  });
});

describe("retentionDeadlineMs", () => {
  it("derives the deadline from the same clock as isExpiredDoc", () => {
    expect(retentionDeadlineMs({ createdAt: ts(NOW) })).toBe(NOW + TTL_MS);
    expect(retentionDeadlineMs({ expiresAt: ts(NOW + 5 * H) })).toBe(NOW + 5 * H);
    expect(retentionDeadlineMs({})).toBeNull();
    for (const data of [{ createdAt: ts(NOW - 2 * H) }, { expiresAt: ts(NOW + 22 * H) }]) {
      const deadline = retentionDeadlineMs(data);
      expect(deadline).not.toBeNull();
      expect(isExpiredDoc(data, deadline! - 1)).toBe(false);
      expect(isExpiredDoc(data, deadline!)).toBe(true);
    }
  });
});

describe("isExpired", () => {
  it("is true only for a valid timestamp in the past", () => {
    expect(isExpired(ts(NOW - 1), NOW)).toBe(true);
    expect(isExpired(ts(NOW), NOW)).toBe(true);
    expect(isExpired(ts(NOW + 1), NOW)).toBe(false);
    expect(isExpired(undefined, NOW)).toBe(false);
    expect(isExpired(null, NOW)).toBe(false);
    expect(isExpired("2026-10-15", NOW)).toBe(false);
    expect(isExpired({ toMillis: () => Number.NaN }, NOW)).toBe(false);
  });
});
