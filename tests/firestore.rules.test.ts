import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import firebase from "firebase/compat/app";
import "firebase/compat/firestore";
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";

/**
 * Security-rule tests for ChatZ.
 *
 * There is no backend between the client and the database, so these rules ARE
 * the access-control implementation — they are the only thing standing between
 * one user and another user's messages, stats, private fields and notifications.
 *
 * Run: npm run test:rules   (needs Java + the Firestore emulator via firebase-tools)
 *
 * NOTE on the compat SDK: @firebase/rules-unit-testing v4 talks to
 * `firebase/compat/firestore`, so every handle here is a compat Firestore. The
 * app itself uses the modular API. That is fine for rules testing — the server
 * evaluates the same rules for either client — but the two object types must
 * never be mixed in one expression.
 */

// Firebase Auth uids never contain "_". These fixtures must not either: several
// rules recover a uid from a composite document id with split("_")[0], and an
// underscore inside a test uid silently breaks that (it cost a confusing
// "evaluation error at L352" on the first run of this suite).
const A = "aaaTestUid0000000000";
const B = "bbbTestUid0000000000";
const C = "cccTestUid0000000000";
/**
 * A uid that is deliberately NEVER made a friend of anyone. Tests that need a
 * stranger must use this, not C: the friendship tests legitimately create
 * A–C and B–C friendships, so "C is a stranger" stops being true half-way down
 * the file once those batches succeed.
 */
const OUTSIDER = "zzzTestUid0000000000";
// uids sort ascending, so this is the canonical pair id for A+B.
const PAIR = `${A}_${B}`;

type FS = firebase.firestore.Firestore;

let env: RulesTestEnvironment;

const db = (uid: string): FS => env.authenticatedContext(uid).firestore() as unknown as FS;
const anon = (): FS => env.unauthenticatedContext().firestore() as unknown as FS;

/** Write fixtures with the rules switched off, so assertions test rules only. */
const seed = async (fn: (d: FS) => Promise<unknown>): Promise<void> => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await fn(ctx.firestore() as unknown as FS);
  });
};

/** Seed and return one resulting document id. */
const seedReturn = async (fn: (d: FS) => Promise<{ id: string }>): Promise<string> => {
  let id = "";
  await seed(async (d) => {
    id = (await fn(d)).id;
  });
  return id;
};

const SV = () => firebase.firestore.FieldValue.serverTimestamp();
const in24h = () => firebase.firestore.Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000);
const ts = (ms: number) => firebase.firestore.Timestamp.fromMillis(ms);

const blockDoc = (blocker: string, blocked: string) => ({
  blockerUid: blocker,
  blockedUid: blocked,
  blockedName: "Blocked Person",
  blockedHandle: "blocked",
  blockedColor: "#ffffff",
  blockedAvatarId: null,
  createdAt: SV(),
});

beforeAll(async () => {
  const rules = fs.readFileSync(path.resolve(process.cwd(), "firestore.rules"), "utf8");
  env = await initializeTestEnvironment({
    projectId: "chatz-rules-test",
    firestore: { rules, host: "127.0.0.1", port: 8099 },
  });
  await env.clearFirestore();

  await seed((d) =>
    Promise.all([
      d.collection("users").doc(A).set({ name: "Ada", handleLower: "ada", profileCompleted: true }),
      d
        .collection("users")
        .doc(A)
        .collection("private")
        .doc("data")
        .set({ email: "ada@example.com", mode: "active" }),
      d.collection("usageStats").doc(A).set({ screenTimeMs: 1000, mode: "active" }),
      d.collection("presence").doc(A).set({ online: true }),
      d.collection("handles").doc("ada").set({ uid: A }),
      d.collection("users").doc(B).set({ name: "Ben", handleLower: "ben", profileCompleted: true }),
      d
        .collection("users")
        .doc(B)
        .collection("private")
        .doc("data")
        .set({ email: "ben@example.com" }),
      d.collection("usageStats").doc(B).set({ screenTimeMs: 2000, mode: "active" }),
      d.collection("handles").doc("ben").set({ uid: B }),
      d
        .collection("friendships")
        .doc(PAIR)
        .set({ members: [A, B] }),
      d.collection("appConfig").doc("updateMetadata").set({
        latestVersionCode: 12,
        latestVersionName: "2.0",
        mandatory: false,
      }),
    ]),
  );
});

afterAll(async () => {
  await env?.cleanup();
});

describe("identity and profile ownership", () => {
  it("denies an anonymous caller everything except update metadata", async () => {
    const d = anon();
    await assertFails(d.collection("users").doc(A).get());
    await assertFails(d.collection("usageStats").doc(A).get());
    await assertFails(d.collection("friendships").doc(PAIR).get());
    await assertFails(d.collection("users").doc(A).collection("private").doc("data").get());
    // Deliberately public: the native update listener runs before any session.
    await assertSucceeds(d.collection("appConfig").doc("updateMetadata").get());
  });

  it("keeps users/{uid}/private/* owner-only", async () => {
    const priv = (uid: string) =>
      db(uid).collection("users").doc(A).collection("private").doc("data").get();
    await assertSucceeds(priv(A));
    await assertFails(priv(B));
    await assertFails(priv(C));
  });

  it("lets a caller write only their own profile, and never delete one", async () => {
    await assertSucceeds(db(A).collection("users").doc(A).update({ name: "Ada L." }));
    await assertFails(db(B).collection("users").doc(A).update({ name: "hijacked" }));
    await assertFails(db(A).collection("users").doc(A).delete());
  });

  it("refuses to publish a handle the caller has not reserved", async () => {
    const d = db(C);
    await assertFails(d.collection("users").doc(C).set({ name: "Cy", handleLower: "cy" }));
    // "ben" is reserved by B, so C cannot publish it either.
    await assertFails(d.collection("users").doc(C).set({ name: "Cy", handleLower: "ben" }));
  });

  it("only lets a handle reservation be made for yourself", async () => {
    await assertFails(db(A).collection("handles").doc("dana").set({ uid: C }));
    await assertSucceeds(db(C).collection("handles").doc("dana").set({ uid: C }));
    await assertSucceeds(
      db(C)
        .collection("users")
        .doc(C)
        .set({ name: "Dana", handleLower: "dana", profileCompleted: true }),
    );
  });
});

describe("friendship-gated data", () => {
  it("lets a friend read usageStats and presence and locks everyone else out", async () => {
    await assertSucceeds(db(B).collection("usageStats").doc(A).get());
    await assertSucceeds(db(B).collection("presence").doc(A).get());
    await assertFails(db(C).collection("usageStats").doc(A).get());
    await assertFails(db(C).collection("presence").doc(A).get());
  });

  it("never lets anyone but the owner write their stats or presence", async () => {
    await assertFails(db(B).collection("usageStats").doc(A).set({ screenTimeMs: 0 }));
    await assertFails(db(B).collection("presence").doc(A).set({ online: false }));
    await assertSucceeds(db(A).collection("usageStats").doc(A).set({ screenTimeMs: 5 }));
  });

  it("creates a friendship only for the receiver of an accepted request, in one batch", async () => {
    const AC = `${A}_${C}`;
    // Seeded pending, exactly as a real request arrives: the receiver's batch is
    // what flips it to accepted, and only that batch may create the friendship.
    await seed((d) =>
      d
        .collection("friendRequests")
        .doc(AC)
        .set({ senderId: A, receiverId: C, status: "pending", createdAt: SV(), updatedAt: SV() }),
    );

    // A is the sender, so A cannot declare the friendship.
    // One context per batch: authenticatedContext() mints a fresh Firestore per
    // call, and a batch refuses references from another instance.
    const sa = db(A);
    const sender = sa.batch();
    sender.set(sa.collection("friendships").doc(AC), { members: [A, C] });
    await assertFails(sender.commit());

    // C is the receiver: request flip + friendship + both counts commit together.
    const d = db(C);
    const batch = d.batch();
    batch.update(d.collection("friendRequests").doc(AC), { status: "accepted" });
    batch.set(d.collection("friendships").doc(AC), { members: [A, C] });
    batch.set(d.collection("friendCounts").doc(C), { count: 1, updatedAt: SV() });
    batch.set(d.collection("friendCounts").doc(A), { count: 1, updatedAt: SV() });
    await assertSucceeds(batch.commit());
  });

  it("rejects a friendship whose id or member order does not match", async () => {
    const d = db(B);
    await assertFails(
      d
        .collection("friendships")
        .doc(`${B}_${A}`)
        .set({ members: [B, A] }),
    );
    await assertFails(
      d
        .collection("friendships")
        .doc(PAIR)
        .set({ members: [A] }),
    );
    await assertFails(
      d
        .collection("friendships")
        .doc("random_id")
        .set({ members: [A, B] }),
    );
  });

  it("only lets the two members read or delete the friendship, and never edit it", async () => {
    await assertSucceeds(db(B).collection("friendships").doc(PAIR).get());
    await assertFails(db(C).collection("friendships").doc(PAIR).get());
    await assertFails(db(C).collection("friendships").doc(PAIR).delete());
    await assertFails(
      db(B)
        .collection("friendships")
        .doc(PAIR)
        .update({ members: [A] }),
    );
  });

  it("does not let a friend count move without a friendship change in the same batch", async () => {
    await seed((d) => d.collection("friendCounts").doc(C).set({ count: 1, updatedAt: SV() }));

    const self = db(C);
    const jump = self.batch();
    jump.update(self.collection("friendCounts").doc(C), { count: 50, updatedAt: SV() });
    await assertFails(jump.commit()); // even self-writes are limited to ±1

    const other = db(B);
    const lonely = other.batch();
    lonely.update(other.collection("friendCounts").doc(C), { count: 2, updatedAt: SV() });
    await assertFails(lonely.commit()); // +1 with no friendship gained or lost

    const BC = `${B}_${C}`;
    await seed((d) =>
      d
        .collection("friendRequests")
        .doc(BC)
        .set({ senderId: B, receiverId: C, status: "pending", createdAt: SV(), updatedAt: SV() }),
    );
    // A friendship document can never be created on its own: the accepted request
    // transition has to be in the same batch (the rule reads it with getAfter).
    const dc = db(C);
    const orphan = dc.batch();
    orphan.set(dc.collection("friendships").doc(BC), { members: [B, C] });
    await assertFails(orphan.commit());

    const legit = dc.batch();
    legit.update(dc.collection("friendRequests").doc(BC), { status: "accepted" });
    legit.set(dc.collection("friendships").doc(BC), { members: [B, C] });
    legit.update(dc.collection("friendCounts").doc(C), { count: 2, updatedAt: SV() });
    await assertSucceeds(legit.commit());
  });
});

describe("friend requests", () => {
  const pending = (sender: string, receiver: string) => ({
    senderId: sender,
    receiverId: receiver,
    status: "pending",
    createdAt: SV(),
    updatedAt: SV(),
  });

  it("cannot be forged, given a random id, pre-accepted, or carrying extra fields", async () => {
    const d = db(A);
    await assertFails(d.collection("friendRequests").doc(`${C}_${B}`).set(pending(C, B)));
    await assertFails(d.collection("friendRequests").doc("arbitrary-id").set(pending(A, B)));
    await assertFails(
      d
        .collection("friendRequests")
        .doc(`${A}_${C}`)
        .set({ ...pending(A, C), status: "accepted" }),
    );
    await assertFails(
      d
        .collection("friendRequests")
        .doc(PAIR)
        .set({ ...pending(A, B), isAdmin: true }),
    );
  });

  it("allows a legitimate request and blocks the pending -> pending re-spam loop", async () => {
    // Fresh participants: the two tests above already moved A->C and B->C requests
    // through accepted, and an accepted document cannot go back to pending while
    // its friendship still exists.
    const D = "dddTestUid0000000000";
    const E = "eeeTestUid0000000000";
    const DE = `${D}_${E}`;
    const senderDb = db(D);
    const recvDb = db(E);

    await assertSucceeds(senderDb.collection("friendRequests").doc(DE).set(pending(D, E)));
    await assertFails(senderDb.collection("friendRequests").doc(DE).update({ status: "pending" }));
    // A stranger can neither accept nor cancel it.
    await assertFails(db(C).collection("friendRequests").doc(DE).update({ status: "cancelled" }));
    // The receiver may reject, then the sender may re-request.
    await assertSucceeds(
      recvDb.collection("friendRequests").doc(DE).update({ status: "rejected" }),
    );
    await assertSucceeds(
      senderDb.collection("friendRequests").doc(DE).update({ status: "pending" }),
    );
  });
});

describe("direct messages", () => {
  const messages = (uid: string) => db(uid).collection("chats").doc(PAIR).collection("messages");
  const msg = (uid: string, text: string, extra: Record<string, unknown> = {}) =>
    messages(uid).add({ fromUid: uid, text, createdAt: SV(), clientAt: Date.now(), ...extra });

  it("friends can send, and the stored message is immutable", async () => {
    const ref = await assertSucceeds(msg(A, "hii"));
    await assertSucceeds(msg(B, "back"));
    await assertFails(messages(A).doc(ref.id).update({ text: "edited" }));
    await assertFails(messages(A).doc(ref.id).delete());
  });

  it("rejects empty, oversize, forged-sender and unknown-field messages", async () => {
    await assertFails(msg(A, ""));
    await assertFails(msg(A, "x".repeat(2001)));
    await assertFails(
      messages(A).add({
        fromUid: B,
        text: "put words in Ben's mouth",
        createdAt: SV(),
        clientAt: Date.now(),
      }),
    );
    await assertFails(msg(A, "ok", { editedAt: SV() }));
  });

  it("keeps a third user out of the conversation entirely", async () => {
    await assertFails(msg(C, "injected"));
    await assertFails(
      db(C).collection("chats").doc(PAIR).collection("messages").doc("whatever").get(),
    );
    await assertFails(db(C).collection("chats").doc(PAIR).get());
  });

  it("refuses to create a conversation without a live friendship", async () => {
    const AO = `${A}_${OUTSIDER}`;
    await assertFails(
      db(A)
        .collection("chats")
        .doc(AO)
        .set({
          members: [A, OUTSIDER],
          updatedAt: SV(),
          lastMessage: { fromUid: A, text: "hi", at: SV(), clientAt: Date.now() },
        }),
    );
    await assertSucceeds(
      db(A)
        .collection("chats")
        .doc(PAIR)
        .set({
          members: [A, B],
          updatedAt: SV(),
          lastMessage: { fromUid: A, text: "hi", at: SV(), clientAt: Date.now() },
        }),
    );
    // The member list is frozen; only the summary may change.
    await assertFails(
      db(A)
        .collection("chats")
        .doc(PAIR)
        .update({ members: [A] }),
    );
  });
});

describe("notifications", () => {
  const payload = (over: Record<string, unknown> = {}) => ({
    toUid: B,
    fromUid: A,
    fromName: "Ada",
    kind: "message",
    text: "Ada sent you a message",
    link: "/app/chats",
    read: false,
    createdAt: SV(),
    expiresAt: in24h(),
    ...over,
  });

  it("is readable only by its recipient", async () => {
    const id = await seedReturn((d) => d.collection("notifications").add(payload()));
    await assertSucceeds(db(B).collection("notifications").doc(id).get());
    await assertFails(db(A).collection("notifications").doc(id).get());
    await assertFails(db(C).collection("notifications").doc(id).get());
  });

  it("requires a fresh 24h expiry, an unread start, and a real recipient", async () => {
    const d = db(A);
    await assertFails(
      d.collection("notifications").add(payload({ expiresAt: ts(Date.now() + 60_000) })),
    );
    await assertFails(d.collection("notifications").add(payload({ expiresAt: null })));
    await assertFails(d.collection("notifications").add(payload({ read: true })));
    await assertFails(d.collection("notifications").add(payload({ toUid: A })));
  });

  it("will not let a stranger notify you about social activity", async () => {
    await assertFails(
      db(OUTSIDER)
        .collection("notifications")
        .add(payload({ fromUid: OUTSIDER })),
    );
    await assertSucceeds(db(A).collection("notifications").add(payload()));
  });

  it("lets the recipient flip read and change nothing else", async () => {
    const id = await seedReturn((d) => d.collection("notifications").add(payload()));
    await assertSucceeds(db(B).collection("notifications").doc(id).update({ read: true }));
    await assertFails(db(B).collection("notifications").doc(id).update({ text: "rewritten" }));
    await assertFails(db(A).collection("notifications").doc(id).update({ read: true }));
  });
});

describe("reactions and comments on stat cards", () => {
  const POST = `${A}_2026-10-15`;
  const reactions = (uid: string) =>
    db(uid).collection("statPosts").doc(POST).collection("reactions");
  const comments = (uid: string) =>
    db(uid).collection("statPosts").doc(POST).collection("comments");
  const reaction = (uid: string, emoji = "fire") => ({
    uid,
    emoji,
    createdAt: SV(),
    expiresAt: in24h(),
  });

  it("is limited to the owner and the owner's friends, and one reaction per person", async () => {
    await assertSucceeds(reactions(B).doc(B).set(reaction(B)));
    await assertSucceeds(reactions(A).doc(A).set(reaction(A)));
    await assertFails(reactions(OUTSIDER).doc(OUTSIDER).set(reaction(OUTSIDER))); // not a friend of A
    // Even a friend cannot write a reaction onto someone else's behalf.
    await assertFails(reactions(B).doc(A).set(reaction(A)));
    // The document id must match the uid field.
    await assertFails(reactions(B).doc(B).set(reaction(A)));
  });

  it("accepts only the six allowlisted emoji keys", async () => {
    await assertFails(reactions(B).doc(B).set(reaction(B, "🔥")));
    await assertFails(reactions(B).doc(B).set(reaction(B, "skull")));
    await assertSucceeds(reactions(B).doc(B).set(reaction(B, "clap")));
  });

  it("bounds comment length, requires friendship, and keeps comments immutable", async () => {
    const comment = (author: string, text: string) => ({
      authorUid: author,
      authorName: "Ben",
      authorHandle: "ben",
      authorColor: "#ffffff",
      text,
      parentId: null,
      createdAt: SV(),
      expiresAt: in24h(),
    });
    const id = await seedReturn((d) =>
      d.collection("statPosts").doc(POST).collection("comments").add(comment(B, "nice")),
    );
    await assertFails(comments(B).doc(id).update({ text: "edit" }));
    await assertFails(comments(B).add(comment(B, "x".repeat(1001))));
    await assertFails(comments(OUTSIDER).add(comment(OUTSIDER, "from a stranger")));
    await assertFails(comments(B).add({ ...comment(B, "ok"), editedAt: SV() }));
  });

  it("deletes only your own reaction", async () => {
    await assertSucceeds(reactions(B).doc(B).delete());
    await assertFails(reactions(A).doc(B).delete());
  });
});

describe("blocks, reports and update metadata", () => {
  it("accepts a block only in the batch that severs the friendship", async () => {
    const BC = `${B}_${C}`;
    await seed((d) =>
      d
        .collection("friendships")
        .doc(BC)
        .set({ members: [B, C] }),
    );

    // Blocking while the friendship survives breaks the core invariant.
    await assertFails(db(B).collection("blocks").doc(BC).set(blockDoc(B, C)));

    const d = db(B);
    const batch = d.batch();
    batch.delete(d.collection("friendships").doc(BC));
    batch.set(d.collection("blocks").doc(BC), blockDoc(B, C));
    await assertSucceeds(batch.commit());
  });

  it("lets only the blocker remove a block, and never rewrite one", async () => {
    const BC = `${B}_${C}`;
    // The blocked person cannot delete or edit the block against them.
    await assertFails(db(C).collection("blocks").doc(BC).delete());
    await assertFails(db(C).collection("blocks").doc(BC).update({ blockedName: "rewritten" }));
    // Nor can they write a block document that claims a different blocker.
    await assertFails(db(C).collection("blocks").doc(`${B}_${C}`).set(blockDoc(B, C)));
    // Blocking back IS legal and intentional: C may sever B too.
    await assertSucceeds(db(C).collection("blocks").doc(`${C}_${B}`).set(blockDoc(C, B)));
    // Both sides can still see that a block exists — that is how the UI explains
    // the lost access instead of failing silently.
    await assertSucceeds(db(C).collection("blocks").doc(BC).get());
  });

  it("loses friend-level access once the block lands", async () => {
    await assertFails(db(C).collection("usageStats").doc(B).get());
  });

  it("makes reports write-only for everyone, including the reporter", async () => {
    const ref = await assertSucceeds(
      db(A).collection("reports").add({
        reporterUid: A,
        reportedUid: B,
        reason: "harassment",
        details: "text",
        createdAt: SV(),
      }),
    );
    await assertFails(db(A).collection("reports").doc(ref.id).get());
    await assertFails(db(A).collection("reports").doc(ref.id).delete());
    await assertFails(
      db(A).collection("reports").add({
        reporterUid: B,
        reportedUid: C,
        reason: "spam",
        details: "forged as Ben",
        createdAt: SV(),
      }),
    );
    await assertFails(
      db(A).collection("reports").add({
        reporterUid: A,
        reportedUid: B,
        reason: "not_a_real_reason",
        details: "x",
        createdAt: SV(),
      }),
    );
  });

  it("keeps update metadata publicly readable but never client-writable", async () => {
    await assertFails(
      db(A).collection("appConfig").doc("updateMetadata").set({ latestVersionCode: 99 }),
    );
    await assertFails(
      anon().collection("appConfig").doc("updateMetadata").set({ latestVersionCode: 99 }),
    );
    await assertFails(db(A).collection("appConfig").doc("updateMetadata").delete());
  });
});

describe("known gaps (documented, not accepted)", () => {
  /**
   * These pin CURRENT behaviour that M2 must change, so the change cannot be
   * made blindly. See docs/CHATZ_PRODUCTION_AUDIT.md §4.3.
   */
  it("expired documents are STILL readable, because the rules apply no read-time expiry", async () => {
    const id = await seedReturn((d) =>
      d.collection("notifications").add({
        toUid: B,
        fromUid: A,
        fromName: "Ada",
        kind: "message",
        text: "already expired",
        link: "/app/chats",
        read: false,
        createdAt: ts(Date.now() - 48 * 3600 * 1000),
        expiresAt: ts(Date.now() - 24 * 3600 * 1000),
      }),
    );
    const snap = await assertSucceeds(db(B).collection("notifications").doc(id).get());
    expect(snap.exists).toBe(true);
  });

  it("lets a client mint a 25h expiry from a fast clock, inside the allowed skew", async () => {
    await assertSucceeds(
      db(A)
        .collection("notifications")
        .add({
          toUid: B,
          fromUid: A,
          fromName: "Ada",
          kind: "message",
          text: "clock skew",
          link: "/app/chats",
          read: false,
          createdAt: SV(),
          expiresAt: ts(Date.now() + 25 * 3600 * 1000),
        }),
    );
  });
});
