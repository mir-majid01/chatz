# ChatZ — Architecture, explained from zero

**Audience:** whoever is new to this codebase (including a future you). No prior knowledge of Capacitor, Firestore, or FCM is assumed.
**Last verified against:** `main` @ `93eff26`, v2.0 / versionCode 12, installed and tested on an Infinix X6876 (Android 16 / XOS).
**Caveat on file paths:** `android/` is gitignored (`.gitignore:26`) because it contains the signing keystore and `google-services.json`, so native paths below exist only on the development machine. Everything under `src/`, `push-worker/`, and the config files is in git and resolvable.

---

## 1. What the thing actually is

ChatZ is a **social screen-time tracker**. It reads how the phone is really being used (screen time, top apps, mobile/Wi-Fi data, battery, Wi-Fi name), turns that into one daily snapshot per person, and lets friends compare their shared numbers — plus DMs, reactions, comments, and notifications about all of it.

There are exactly four verbs in this product:

1. **Measure** the device (only native Android code can do this).
2. **Publish** one snapshot to a shared database, filtered by what the owner agreed to share.
3. **Compare** with people who are mutually confirmed friends.
4. **Announce** when something happened — even when the app is closed.

Everything else in the repository is plumbing in service of those four.

The most important architectural fact to say out loud first:

> **There is no backend server.** The phone talks directly to Google's database, and access control lives *inside* that database. The only "server" you own is one 6 KB Cloudflare Worker whose single job is something a phone physically cannot do alone.

---

## 2. System context — the five moving parts

```
      [ Google ]                     [ Firebase: dropscope-b588a ]
      signs people in                Auth        = who you are
      and delivers pushes            Firestore   = everything you know
                                          ^
                                          | reads / writes, every one
                                          | re-checked by security rules
  +---------------------------------------+----------------------------+
  |  ChatZ.apk, on each phone                                           |
  |  ┌───────────────────────┐        ┌─────────────────────────────┐  |
  |  │  JS brain  (src/)     │bridge  │  Kotlin brain (android/)    │  |
  |  │  React 19 screens,    │<------>|  permissions, usage stats,  |  |
  |  │  all UI, all logic    │        │  push receiver, APK install |  |
  |  └───────────────────────┘        └─────────────────────────────┘  |
  +------------------------------+-------------------------------------+
                                 ^
                    POST /push   |  body is only {"notifId": "zqAb…"}
                                 v
                 [ Cloudflare Worker: chatz-push ]   ← the only server
                     signs a service-account key, reads Firestore,
                     asks Google to deliver one message
                                 |
                                 v
                 [ FCM: Google's delivery bus to phones ]
                                 |
                                 v
                 wakes ChatzPushService on the recipient's phone

  [ GitHub: mir-majid01/chatz ]  just stores the APK file. Not a backend.
```

| Part | What it is responsible for | If it dies |
|---|---|---|
| The APK (two brains) | UI, measurement, delivery of notifications | nothing works |
| Firebase Auth | identity, Google Sign-In | nobody can sign in |
| Cloud Firestore | all data + all access rules | app opens, then errors honestly |
| FCM (Google) | reaching a phone with no running process | killed-app pushes stop |
| `chatz-push` Worker | turning "a doc exists" into an FCM send | pushes stop; in-app notifications still work |
| GitHub | hosting + serving the APK binary | updates can't be downloaded |

---

## 3. Inside the app: two brains and a bridge

### Capacitor is a web browser wearing an Android app

Capacitor does **not** translate React into native widgets. It wraps a WebView.

```
chatz-v2.0.apk
├── Android code (Kotlin/Java)         ← your android/ folder
└── assets/public/                     ← literally your dist/ folder, copied by `npx cap sync`
      └── WebView loads https://localhost/
            └── React app runs, byte-identical to `npm run dev` in Chrome
```

Consequence: every screen you have written is a web page. `npm run dev` and the APK run the same code, which is why `src/lib/vibe-stats.web.ts` exists — it is the same interface with stub bodies, so nothing crashes when there is no Kotlin on the other end.

### Why two brains are necessary

| Capability | JS brain | Kotlin brain |
|---|---|---|
| Render UI | yes | no |
| Read `UsageStatsManager` (real screen time) | no | yes |
| Schedule work that runs while the app is closed | no | yes (WorkManager) |
| Download, verify and install a new APK | no | yes |
| Receive an FCM push | no | yes (`ChatzPushService`) |
| Talk to Firestore, hold all business rules | yes | yes |

The **bridge** is the custom `VibeStats` Capacitor plugin. Mechanically: JS calls `VibeStats.checkUsageAccess()`, Capacitor serialises it, `VibeStatsPlugin.kt` runs the real Android API, and the JS promise resolves. The waiter analogy holds: the dining room never enters the kitchen.

- Registered once in `android/app/src/main/java/com/chatz/app/MainActivity.java`
- Typed on the JS side in `src/lib/vibe-stats.ts` (+ `.web.ts` fallback)

Those two files **are** the contract between the worlds. Change one without the other and TypeScript will not always warn you.

### The subtlest part: two separate Firebase instances

The WebView has its own Firebase SDK. So does Kotlin. They are two independent signed-in clients that do not know about each other.

Google Sign-In therefore has four steps, and the fourth is invisible in the UI:

1. Tap "Continue with Google" → **Kotlin** shows the real account picker via `GoogleSignInClient`. It must be native: Firebase's `signInWithRedirect`/popup flow loses the `sessionStorage` state parameter inside a WebView, so it cannot work here.
2. Kotlin returns a Google **ID token** across the bridge as a string.
3. JS converts it: `GoogleAuthProvider.credential(idToken)` → `signInWithCredential()` → the JS Firebase is now signed in.
4. `session.ts:49` calls `ensureNativeSession(user)`, which compares `getNativeAuthUid()` against the JS uid and, if they differ, calls `VibeStats.adoptExistingSession()` → `GoogleSignInClient.silentSignIn()`. That signs the *native* instance in with no UI.

Step 4 is what lets the background worker authenticate when nobody has opened the app in three hours. Delete it and the app still looks perfect — your stats just silently stop updating. Same lesson in reverse on sign-out: `signOutEverywhere()` must sign out JS, native, and the local cache.

---

## 4. How `src/` is organised

```
src/
├── routes/        screens, one per URL            "what the user sees"
├── components/    reusable pieces                  "what things look like"
└── lib/           everything that knows facts      "where truth comes from"
```

### routes — the filename *is* the URL

TanStack Router with dot-separated names:

| File | URL | Role |
|---|---|---|
| `__root.tsx` | (all) | Root layout, `QueryClientProvider` |
| `index.tsx` | `/` | Landing, Google button, session auto-restore |
| `onboarding.tsx` | `/onboarding` | Name, handle, avatar, private details, permissions, goal |
| `app.tsx` | `/app` | **The shell**: session gate, permission gate, privacy mirroring, presence, update check, FCM registration |
| `app.index.tsx` | `/app` | Pulse — own live stats, Active/Silent mode, friend cards |
| `app.friends.tsx` | `/app/friends` | Friends, requests, `@handle`/name search |
| `app.chats.$chatId.tsx` | `/app/chats/x` | One DM (Firestore) or a local group |
| `app.notifications.tsx` | `/app/notifications` | Feed, accept/decline, per-kind prefs |
| `app.profile.tsx` | `/app/profile` | Profile, edit, privacy toggles |
| `app.settings.$section.tsx` | `/app/settings/x` | Privacy, help, permissions, about, blocked |
| `app.stats.$friendId.tsx` | `/app/stats/x` | Detailed stats, share-flag gated |
| `app.user.$friendId.tsx` | `/app/user/x` | Friend's public profile: unfriend / block / report |

`app.tsx` earns the word "shell": everything cross-cutting lives there, and the screens beneath it assume identity and permission questions are already settled.

**Gotcha:** `src/routeTree.gen.ts` is maintained **by hand** — there is no router plugin in `vite.config.ts`. Add a route file and forget this edit, and you get a 404 that looks like a router bug.

### lib — the `*-repo.ts` convention

**`*-repo.ts` = the only file that talks to Firestore for one domain.** `profile-repo`, `friends-repo`, `dm-repo`, `blocks-repo`, `usage-repo`, `reports-repo`, `frames-repo`, `push-repo`, `stat-social`. No screen issues a database call directly. So "what actually happens when someone accepts a friend request?" has exactly one file to read, and one matching block in `firestore.rules` to verify against.

**`*-store.ts` = local client state.** `profile-store` (localStorage cache + theme/accent), `chat-store` and `groups-store` (local-only group prototype, keyed per uid). **One deliberate exception:** `notifications-store.ts` is *not* a local store — it is the Firestore realtime listener plus the decision engine for posting to the shade. Treat it as a repo; the name is historical.

**`firebase.ts`** (21 lines) creates the single `app`, `auth`, and `db` objects that everything else imports. One connection, not forty. Its config must mirror `android/app/google-services.json` — a mismatch is the classic Google Sign-In `status 10 / DEVELOPER_ERROR`.

**`session.ts` is the traffic cop**, and it is the spine of the app:

```
resolveSession(user)                      src/lib/session.ts:41
├─ no Firebase user        → signed-out   → /
├─ Firestore: no completed profile
│                          → onboarding   → /onboarding
├─ users/{uid}.profileCompleted === true
│                          → ready        → /app
└─ Firestore unreachable AND no cache for this uid
                           → unknown      → error + retry   (never guesses)
```

The ordering is the entire design: **Firebase answers *who you are*; Firestore answers *are you set up*; localStorage never answers either.** That is why a friend who finished onboarding can reinstall the app and never see it again — the answer was never stored on the phone. And `unknown` exists because when the network is down, guessing between the two routes risks overwriting a real profile.

---

## 5. The data model

Firestore is a tree of collections of JSON documents in Google's cloud, with two properties that shape everything: **listeners push changes to you in real time**, and **access rules are evaluated inside the database, not in your app**.

```
users/{uid}                        public profile            readable by any signed-in user
users/{uid}/private/data           email, dob, education,
                                   privacy map, mode, fcmToken   owner only
users/{uid}/private/prefs          per-kind notif filters    owner only
handles/{handleLower}              { uid }                   the uniqueness lock
friendRequests/{sender}_{receiver} status: pending/accepted/rejected/cancelled
friendships/{a}_{b}                members sorted ascending
friendCounts/{uid}                 { count, updatedAt }      denormalised
chats/{pairId}                     lastMessage + members
chats/{pairId}/messages/{id}       immutable text
statPosts/{ownerUid}_{day}/reactions/{reactorUid}
statPosts/{ownerUid}_{day}/comments/{id}
notifications/{autoId}             the one place ids are random, on purpose
blocks/{blocker}_{blocked}         denormalised display fields
reports/{autoId}                   write-only; unreadable by literally everyone
usageStats/{uid}                   the single shared snapshot
presence/{uid}                     heartbeat
appConfig/updateMetadata           the version every device must be on
```

### Three rules that carry most of the design

**(a) Deterministic document IDs, not random ones.**
`friendships/{a}_{b}` sorts the two uids, so Alice+Babs is always the *same* document ID regardless of who acted. You cannot accumulate two contradictory friendship rows, and "are we friends?" is one `getDoc` instead of a query. Same for requests, chats, blocks, stat posts, and handles. Random IDs appear only where a duplicate is harmless.

**(b) Public/private split, because rules cannot hide a field.**
A Firestore rule answers "may you read this document?" — it cannot answer "may you read this document but not `.email`". So sensitive fields live in a second document with its own rule. Had they been columns on `users/{uid}`, everyone allowed to see a name would also see an email address. This is the standard NoSQL answer to column-level security.

**(c) Security rules are the referee, and your own client is a suspect.**
Every read and write is re-checked server-side against `firestore.rules`. Client-side validation is user experience; the rules are truth — the JS bundle can be edited by anyone who owns the phone. Anything that must happen *together* therefore goes in one atomic `WriteBatch`:

```
acceptRequest = batch {
  friendRequests/A_B.status  → accepted
  friendships/{sorted pair}  → create
  friendCounts/A             → +1
  friendCounts/B             → +1
}
```

and the rule for `friendCounts` only accepts a ±1 change when a friendship document was created or destroyed **in the same batch** (using `getAfter`). That is how a database with no foreign keys keeps a counter honest. Blocking goes one step further: the block document is only legal if the friendship is *already gone after the batch* (`existsAfter`), which is what makes "blocked ⇒ never friends" true across every other rule instead of a race condition.

Also worth knowing: `rules_version = '2'` means a `match` block applies **only to its own path** — nested subcollections need their own block. And there is no `allow read, write: if true` anywhere in the file.

**Deploy note (a real incident):** `firebase.json` once referenced only `firestore.indexes.json`, so `firebase deploy --only firestore` shipped the indexes and silently left the live rules untouched. Rules in git are only the truth once something deploys them. `firebase deploy --only firestore` now publishes both.

### Two supporting conventions

- **24h expiry on temporary activity.** Reactions, comments, and notifications carry `expiresAt`, minted from the **client clock** (`ttl.ts:14`, rules tolerate ±1 h skew). Two things must be said plainly: expired documents are hidden **only client-side** — `firestore.rules` performs no read-time expiry check — and **there is no Firestore TTL policy**, and on the Spark plan there cannot be one (TTL is a Blaze feature; verified 2026-10-15). So an expired document stays in the database indefinitely; nothing physically deletes it. See `docs/CHATZ_PRODUCTION_AUDIT.md` §4.3 for the proposed two-mechanism fix.
- **Avatars are drawn, not stored.** `avatars.ts` renders parametric SVG from an id + colours; only the id is saved. That is why the Storage bucket is declared and unused — there are no image uploads anywhere.

---

## 6. Where the numbers come from: the stats pipeline

```
[ Android OS records usage for every app, continuously, whether or not ChatZ exists ]
                    |  reads
                    v
   VibeDataCollector.kt      UsageStatsManager (screen time, top apps, launches),
                    |         TelephonyManager (mobile data), TrafficStats (Wi-Fi data),
                    v         BatteryManager, WifiManager
   VibeModels.kt             typed snapshot objects
                    |
                    v
   UsageStatsSyncWorker.kt   ← WorkManager, every 15 min, RUNS WHILE CHATZ IS CLOSED
        ├─ reads per-uid privacy flags from SharedPreferences (set via the bridge)
        ├─ masks disallowed categories BEFORE anything leaves the device
        ├─ fingerprint compare: unchanged snapshot → skip the write
        ├─ no Usage access / no native session → exit quietly, do not fabricate
        └─ set(usageStats/{uid}, …, SetOptions.merge())
                    |
                    v
              Firestore  →  friends' listeners update
```

Design decisions, and their reasons:

- **Native measures.** A WebView cannot see other apps, so `VibeDataCollector` owns all measurement; `collectStats()` exists only for when a screen wants numbers immediately.
- **WorkManager, not a foreground service.** Periodic, inexact by design, survives reboots, polite to battery. `ExistingPeriodicWorkPolicy.UPDATE` so opening the app never resets the 15-minute window; `CONNECTED` network constraint; exponential backoff; `Result.failure()` on `PERMISSION_DENIED` (retrying cannot help), `Result.retry()` up to 3 attempts otherwise.
- **The battery-not-low constraint was deliberately removed.** Android 12–15 and OEM panels (OnePlus, Transsion/XOS) mark devices "low" aggressively, which stretched a 15-minute job into hours.
- **Idempotence hides the drift.** The payload is a *snapshot of today*, not an increment, so a late run overwrites with correct data rather than double-counting.
- **Presence is a separate document on purpose.** `presence/{uid}` changes every couple of minutes; keeping it out of the profile and out of the daily snapshot stops a heartbeat from churning permanent data. It is treated as stale after 2 minutes — a heartbeat, not a socket.
- **A privacy or mode change pushes an immediate snapshot** (`pushUsageSnapshot`), so friends see the change at once instead of up to 15 minutes later.

### The two invariants that make this trustworthy

- **Fail closed.** No privacy record for a uid → the worker skips the account. A missing preference is never read as "share everything".
- **Never invent data.** Without Usage Access the collector returns zeros, and displaying "0h 0m" is a lie. Both Pulse and the stats page check `checkUsageAccess()` first and render an honest "Screen-time access is off" state with a Grant CTA. This is enforced in code and stated as an invariant in `AGENTS.md`.

### Android's permission reality

| Permission | Why | Note |
|---|---|---|
| `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE` | Firebase, connectivity type | install-time |
| `POST_NOTIFICATIONS` | Android 13+ notifications | runtime dialog, optional |
| `PACKAGE_USAGE_STATS` | real screen time | **AppOps** — granted by the user in Settings, never at install. Without the declaration Android does not even list ChatZ in Usage access |
| `RECEIVE_BOOT_COMPLETED` | let WorkManager re-arm after reboot | |
| `READ_PHONE_STATE` (`maxSdkVersion 25`) | mobile-data stats on Android 6–7 | legacy |

Camera, mic, location, contacts, media, and foreground-service permissions were removed on purpose — no feature needs them.

Android 13+ adds one genuine obstacle: **sideloaded APKs are subject to "restricted settings"**, which can grey out the Usage Access row. The honest path is the only path this app takes: tell the user to tap the row and enable it, report the real state via `checkUsageAccess()`, and never try to grant it through AppOps, root, Shizuku, or accessibility tricks.

---

## 7. Notifications: three paths, one event

```
                    notifications/{id} created in Firestore
                                 |
       ┌─────────────────────────┼──────────────────────────┐
       ▼                         ▼                          ▼
 PATH A "live"            PATH B "catch-up"          PATH C "push"
 recipient's onSnapshot   recipient wakes later      process is dead
 listener is running      → persistent watermark     → Worker → FCM →
 → notifications-store      turns missed events        ChatzPushService
 → VibeStats.notify         into ONE summary         → notify()
   (bridge → Kotlin)
 needs a live process      needs a live process     needs nothing running
```

- **A** is a Firestore subscription: the instant a doc appears, `useNotifs` sees the array change, and posts to the shade only when the event is **unread**, **fresh** (`DEVICE_FRESH_MS = 90_000`, `createdAt` within 90 s), and the app **is not visible**. Three guards: without the freshness check, every listener re-attach replays the entire unread history into the shade.
- **B** is a per-uid watermark in localStorage (`chatz.notifWm.<uid>`), which exists because XOS freezes ChatZ roughly six seconds after backgrounding, and those events would otherwise vanish silently.
- **C** is the only path that can reach a phone with no ChatZ process. This is what v2.0 added.

### How the paths avoid double-notifying

Both A and C can be true simultaneously. Three mechanisms:

1. `pushedAt` on the document, written by the Worker, is the exactly-once marker; the client skips any doc carrying it.
2. The client delays its own post by `PUSH_GRACE_MS = 1500` and re-checks the doc, so push wins the race.
3. Both paths use `notifId.hashCode()` as the **Android notification ID**. Same ID = the same row in the shade, so losing the race *replaces* rather than stacks.

### The rule that cost a full debugging pass

> **The FCM message must be strictly data-only.**

In FCM, who renders the notification is decided by the shape of the message:

| Payload | Who renders | Your code runs? |
|---|---|---|
| `data` only | your `onMessageReceived` | yes |
| anything under `android.notification` (even only `channel_id`) | the operating system, for a backgrounded app | **no** |

Sending `channel_id` made FCM a *notification* message, so backgrounded devices got the OS tray entry with `title=null` on `fcm_fallback_notification_channel`, and `ChatzPushService` never executed. Fixed in `93eff26` by removing the block; the service creates its own channels. **No APK change was needed** — that is the value of keeping the presentation decision in the client.

### What delivery was actually verified (2026-10-12, Infinix X6876)

- FCM token registration: two accounts on one device share the same token, because FCM tokens are **device+app scoped, not user scoped**.
- A frozen, not-foregrounded ChatZ is woken by `com.google.android.c2dm.intent.RECEIVE` (XOS logs `transition from Frozen to Running`) and the notification posts on `chatz_messages` at importance 4 within ~60 ms.
- **Settings → Force stop does block delivery.** Android sets `FLAG_STOPPED`, which suppresses FCM until the user next opens the app. No app-side workaround exists or should exist. Swipe-away and OEM freezing are both fine.

---

## 8. One event end to end: Majid types `hii`

```
 1. Majid taps Send                    dm-repo.sendDm()
 2. Firestore batch writes             chats/{pairId}/messages/{id} + chats/{pairId}.lastMessage
    └ rules: friendship exists? text 1–2000? createdAt == request.time? exact field whitelist?
 3. notifications-store.pushNotif()    adds notifications/{id}  { kind:"message", toUid, text }
    └ addDoc() resolves with a DocumentReference → triggerPush(ref.id)   (fire and forget)
 4. HTTPS POST                         https://chatz-push.chatz-app.workers.dev/push
    body: {"notifId":"zqAb…"}          nothing else travels. No text. No token. No key.
 5. Worker: sign RS256 JWT from SA_JSON → exchange at oauth2 → admin access token
 6. Worker: GET notifications/zqAb…    ← the DATABASE is the payload authority
    └ pushedAt already set → skip "already";  expiresAt past → skip "expired";  404 → "no such doc"
 7. Worker: GET users/{you}/private/data → fcmToken    (empty → skip, client paths still cover)
 8. Worker: POST fcm…/v1/projects/dropscope-b588a/messages:send
    data: { notifId, kind:"message", title:"Majid", body:"hii", link:"/app/dm" }
    android: { priority: "high" }      ← nothing under android.notification
 9. Google holds the persistent connection to the phone. No ChatZ code is running.
10. OS unfreezes/starts the process → ChatzPushService.onMessageReceived(message)
11. service: is ChatZ foregrounded? → return silently (the in-app badge already covers it)
             else → ensureChannel("chatz_messages") → notify(notifId.hashCode(), …)
12. Worker PATCHes notifications/zqAb… { pushedAt: now }
13. You hear the heads-up. Your own listener also fires around the same moment, sees
    pushedAt, and correctly does nothing.
```

Two things to notice. **Step 4–6 is the security boundary**: because the Worker re-reads the text from Firestore rather than trusting the ping, a hostile sender cannot push arbitrary content — they can only point at a document the rules already permitted them to create. **Step 8–9 is why Google is in the loop at all**: nothing else on this architecture can reach a phone with no running process.

---

## 9. How code becomes an APK on someone's phone

No Play Store, so the app has its own update channel:

```
1. bump android/app/build.gradle       versionCode 12, versionName "2.0"
2. npm run build && npx cap sync android
   cd android && ./gradlew assembleRelease
3. copy the APK → hosting/apk/chatz-v2.0.apk          committed to git
4. git push main                                        GitHub stores the file
5. create GitHub release + upload asset                 canonical: mir-majid01/chatz
   (Spark-plan Firebase Hosting refuses .apk files, hence GitHub raw)
6. PATCH appConfig/updateMetadata in Firestore:
   latestVersionCode, latestVersionName, downloadUrl, sha256, changes[],
   mandatory, title, description, releaseDate, minimumSupportedVersionCode
   (the native reader names the flag `mandatory`; update-repo.ts surfaces it to
   JS as `isMandatory`, which is a rename, not the stored field name)
   — authorised with an access token minted locally from the service-account key
7. every running app is LISTENING on that one document → popup, no restart
8. user taps Update → UpdateManager.kt downloads from raw.githubusercontent.com →
   verifies SHA-256 → hands the file over as a FileProvider content:// URI →
   Android prompts to install
9. delete the superseded release (keep-only-latest)
```

Why this behaves like a real product rather than a hack: the phone does not poll for updates, it holds a realtime subscription to one small document, so publishing propagates immediately and costs nothing per device. The SHA-256 check is what prevents a truncated or swapped APK from installing silently. `mandatory: false` (Firestore field name) is the only knob for "everyone should move now, but they may defer" — and it is only consulted together with `minimumSupportedVersionCode`, which defaults to 0 when absent (`UpdateManager.kt:92,:102`).

Startup gating matters here too: the dashboard must not render before the update check completes, otherwise users see content they may be about to be blocked from.

The manual "Check for updates" in Settings → About passes `forceCheck = true`, which bypasses the cooldown cache (`COOLDOWN_HOURS = 2L`, `UpdateManager.kt:34`) — that is how you verify a release without waiting two hours. Note the KDoc a few lines above still says "6-hour cooldown"; the constant is the truth.

---

## 10. The Worker, in detail

`push-worker/src/index.js` (~190 lines), deployed with `cd push-worker && npx wrangler deploy`.

Responsibilities, in order: validate the id shape (`/^[A-Za-z0-9_]{8,40}$/`), mint an admin token (RS256 JWT → OAuth exchange, cached in module scope until ~2 min before expiry), read the notification doc, apply dedupe/expiry skips, read the recipient's token, send one data-only FCM message, stamp `pushedAt`. It also handles `OPTIONS` for CORS, and clears a stored token when FCM reports `UNREGISTERED`.

What it deliberately is **not**:

- Not a message queue, not a store, not a cache. A **KV namespace was removed** once `pushedAt` could serve as the dedupe marker — one fewer deploy step and no free-tier write ceiling.
- Not trusted with content. It never accepts notification text from the caller.

Credentials: the service-account JSON exists **only** as a Cloudflare Worker secret named `SA_JSON` (`wrangler secret put SA_JSON < keyfile`). Not in the repo, not in `push-worker/`, not in the APK, not in Firestore. `wrangler.jsonc` holds only the Worker name and compatibility date.

Constraints learned the hard way:

- Cloud Functions require a Blaze plan; the Firebase project is on Spark. That is the entire reason this Worker exists.
- The workers.dev subdomain is account-global and claimable **only from the dashboard** — the API rejects OAuth tokens with code 10405. Current: `chatz-app`.
- Both `wrangler.toml` and `wrangler.jsonc` in one directory breaks wrangler.
- The Firebase CLI's OAuth token stopped authorising the Firestore admin path (403 even after a successful refresh); minting an access token directly from the service-account key is what works for publishing metadata.

---

## 11. Trust boundaries — what is public on purpose

| Item | Where | Public? Why |
|---|---|---|
| Firebase API key, app id, sender id | `src/lib/firebase.ts`, compiled into the APK | **Yes, by design.** It identifies the project; it authorises nothing. Access control is Auth + rules only. |
| Google OAuth **web client ID** | hardcoded in `VibeStatsPlugin.kt` | Yes — client IDs are not secrets. A client *secret* would be, and there is none in the app. |
| `firestore.rules` | git, then deployed | Effectively public. Assume an attacker reads it — which is exactly why the batch-coupling checks exist. |
| In-app Firestore reads/writes | the JS bundle | Treat every client call as forgeable. Rules decide. |
| Signing keystore, `google-services.json`, signing passwords | `android/` — gitignored | **Private.** Do not add `android/` to git without first moving these out. |
| Service-account admin key | developer machine + `SA_JSON` Worker secret | **Highest-value secret in the project.** Bypasses every security rule. Never commit, never log, never write to Firestore. |
| Device FCM token | `users/{uid}/private/data` + SharedPreferences | Semi-private delivery address. Owner-only rules; Worker reads it with admin rights. |
| Access/OAuth tokens of any kind | memory only | Never logged, never persisted, never written to Firestore. |

The rule these examples generalise to: **anything a phone can expose is public; anything that can bypass the rules must live on a machine you control.** Here that machine is a 6 KB Worker.

---

## 12. Known constraints — decisions, not oversights

| Constraint | Reason | What it costs |
|---|---|---|
| Groups are localStorage-only | prototype; never migrated to Firestore | no cross-device sync, lost on reinstall |
| Search is prefix-only | Firestore has no substring search; `>= q` / `<= q+'\uf8ff'` | `ma` finds Majid, `aji` finds nothing |
| Presence is approximate | 2-minute heartbeat, not a socket | "online" means "recently checked in" |
| Background sync is best-effort 15 min | WorkManager is inexact; OEM panels interfere | snapshots arrive late; idempotence makes it harmless |
| One ~940 KB JS chunk (~280 KB gzipped) | Firebase + React + router are not splittable by config | slow first paint; dynamic imports are the obvious fix |
| Force-stop blocks push | Android `FLAG_STOPPED` | until the user next opens the app |
| `android/` is not in git | keystore + Firebase config live there | a fresh clone builds an APK with no push service |
| Handles are case-insensitive by design | `normalizeHandle()` lowercases everywhere | `@JohnDoe` and `@johndoe` can never be two accounts (a feature, listed for completeness) |

---

## 13. Reading order for a newcomer

Build the mental model in this sequence — each step answers one question.

1. `src/main.tsx` (13 lines) → `src/router.tsx` → `src/routes/__root.tsx` — *how does anything start at all?*
2. `src/lib/firebase.ts` → `auth.ts` → `session.ts` → `routes/app.tsx` — *identity and the traffic cop.* This is the spine of the app.
3. `src/lib/profile-repo.ts` → `friends-repo.ts`, then open `firestore.rules` for the same two collections — *see both sides of the same rule.*
4. `android/.../plugin/VibeStatsPlugin.kt` next to `src/lib/vibe-stats.ts` — *the bridge, in one screen.*
5. `android/.../sync/UsageStatsSyncWorker.kt` → `collector/VibeDataCollector.kt` — *the half that runs while you're asleep.*
6. `src/lib/notifications-store.ts` → `src/lib/push-repo.ts` → `push-worker/src/index.js` → `android/.../push/ChatzPushService.kt` — *read these four as one system: the newest and most distributed path.*
7. `RELEASE-PROCEDURE.md` and `AGENTS.md` — *how it ships, and why things are shaped the way they are.* `AGENTS.md`'s "Invariants" list and CL-1…CL-11 entries are post-mortems of bugs already paid for; read them before changing anything nearby.

---

## 14. Glossary of the terms used above

- **APK** — the installable Android package. One file, contains both brains.
- **Capacitor** — the wrapper that puts a WebView in an Android app and provides the JS↔Kotlin bridge.
- **WebView** — an embedded browser component. Where the React app actually runs.
- **Plugin / bridge** — your custom callable surface between JS and Kotlin (`VibeStats`).
- **Firestore** — Google's document database with realtime listeners and server-side access rules.
- **Security rules** — JavaScript-like policy evaluated inside the database on every request.
- **WriteBatch / atomic** — several document writes that either all succeed or none do.
- **`getAfter` / `existsAfter`** — rule functions that inspect the database state *after* the whole batch, which is how cross-document invariants are enforced.
- **Realtime listener (`onSnapshot`)** — a subscription; the database pushes changed results to you.
- **FCM** — Firebase Cloud Messaging. Google's delivery bus to phones; the only thing that can wake a dead app.
- **Data message vs notification message** — data → your code handles it; notification → the OS displays it. See §7.
- **WorkManager** — Android's official periodic/deferred job scheduler. Survives reboot, inexact by design.
- **AppOps permission** — an Android permission class granted only by the user in Settings (`PACKAGE_USAGE_STATS`), not at install.
- **`FLAG_STOPPED`** — the OS state after Settings → Force stop, which suppresses background delivery until the app is reopened.
- **Cloudflare Worker** — a small function running at Google-free edge locations, billed per request, free tier sufficient here.
- **Service account** — a credential that acts as the project's admin, bypassing security rules.
- **TTL** — time-to-live; documents stamped to expire. Firestore also sells a server-side "TTL policy" feature that physically deletes them, but it is **Blaze-plan only and is not in use here** — an expiry stamp in this app is metadata, not deletion.
- **Idempotent** — running the same write twice produces the same state (the daily snapshot is; an increment would not be).

---

## Maintenance

Update this document when any of the following changes, because each is asserted above:

- a new route, `*-repo.ts`, or bridge method is added (§4)
- the Firestore schema or the rule-coupling pattern changes (§5)
- the FCM payload shape changes — **read §7 first; it is the trap**
- the release chain or the hosting target changes (§9)
- the Worker's contract, secret handling, or hosting subdomain changes (§10)
- a listed constraint is fixed and stops being a constraint (§12)

Version numbers, commit hashes, and device results in this file are dated 2026-10-12; treat them as "as of", and re-verify before repeating them as current facts.
