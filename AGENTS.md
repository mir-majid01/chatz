<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

# ChatZ — Full Project Context for AI Agents

## Project Overview

ChatZ is a **Capacitor 7 Android app** (React + TypeScript + Vite + TanStack Router) built around a **social screen-time tracker**: it reads real device usage (screen time, top apps, data usage, battery, Wi-Fi SSID) from Android's `UsageStatsManager`, aggregates it natively on a 15-minute WorkManager schedule, uploads one snapshot per user to Cloud Firestore, and lets friends compare their shared stats.

Search a person by `@handle` or name, send a friend request, accept it, and both sides can see each other's daily screen time and online/last-seen state.

There is exactly **one identity source** (Firebase Auth, Google Sign-In only) and **one data backend** (Cloud Firestore). Supabase, the news feed, the AI/Nuxo tab, ephemeral Instants, and chat attachments have all been removed.

`docs/ARCHITECTURE.md` is the beginner-facing walkthrough of this whole system (two-brain layout, data model reasoning, notification paths, release chain, reading order). This file is the dense reference; that one is the explanation.

### Stack

| Layer | Technology |
|-------|-----------|
| Framework | React 19, TypeScript 5.8, Vite 8 (Rolldown) |
| Routing | @tanstack/react-router v1 — `src/routeTree.gen.ts` is maintained **manually** |
| Styling | Tailwind CSS v4, Radix UI primitives, class-variance-authority |
| Mobile | Capacitor 7 (Android only) |
| Auth | Firebase Auth — **Google Sign-In only** |
| Data | Cloud Firestore (profiles, handles, friends, usage snapshots, presence) |
| Native plugin | Custom `VibeStats` Capacitor plugin (Kotlin) |
| Data fetching | @tanstack/react-query v5 |
| Forms | react-hook-form + zod |
| Charts | recharts |
| Icons | lucide-react |
| Font | @fontsource/inter |
| Notifications | sonner |
| Avatars | Parametric SVG drawn at runtime (`src/lib/avatars.ts`) — no image files, no Storage bucket |

### Project Structure

```
├── android/                        # Android native project (Capacitor)
│   └── app/
│       ├── build.gradle            # Firebase Auth + Firestore, WorkManager, Play Services Auth
│       ├── google-services.json    # Firebase Android config
│       └── src/main/
│           ├── AndroidManifest.xml # 7 permissions, single MainActivity (singleTask)
│           └── java/com/chatz/app/
│               ├── MainActivity.java           # Registers VibeStatsPlugin
│               ├── plugin/VibeStatsPlugin.kt   # Capacitor plugin: Google Sign-In, permissions, stats, native session
│               └── data/
│                   ├── collector/VibeDataCollector.kt    # UsageStatsManager, network stats, battery, Wi-Fi
│                   ├── models/VibeModels.kt              # data classes: VibeData, AppUsageStat, etc.
│                   ├── permissions/PermissionHelper.kt   # Intent builders for settings screens
│                   └── sync/
│                       ├── UsageStatsSyncWorker.kt       # WorkManager: aggregates + uploads to Firestore
│                       └── WorkScheduler.kt              # Schedules the periodic 15-min sync
├── src/
│   ├── lib/
│   │   ├── firebase.ts          # Firebase app + Auth + Firestore singletons
│   │   ├── auth.ts              # Google Sign-In (native + web), sign-out, native session mirroring
│   │   ├── session.ts           # THE routing decision: signed-out / onboarding / ready / unknown
│   │   ├── profile-repo.ts      # Firestore profile + handle transactions (users/{uid}, handles/{handle})
│   │   ├── friends-repo.ts      # Firestore friend requests, friendships, friend counts
│   │   ├── dm-repo.ts           # Firestore DMs: chats/{pairId}/messages + read markers + overview hooks
│   │   ├── blocks-repo.ts       # Firestore blocks (severs friendship atomically)
│   │   ├── reports-repo.ts      # Firestore write-only abuse reports
│   │   ├── stat-social.ts       # Firestore reactions + threaded comments on stat cards (statPosts/{ownerUid}_{day})
│   │   ├── notifications-store.ts # Firestore notifications listener + DEVICE notification posting (VibeStats.notify)
│   │   ├── usage-repo.ts        # Reads/writes usageStats/{uid} + presence/{uid}; pushUsageSnapshot
│   │   ├── app-permissions.ts   # The 3 core permissions (usage / notifs / background): check + open settings
│   │   ├── handle.ts            # Handle validation + normalization (lowercase)
│   │   ├── text.ts              # Unicode-safe name/bio rules (grapheme counting, invisible-char stripping)
│   │   ├── ttl.ts               # 24h expiry stamps + client-side expiry checks (reactions/comments/notifications)
│   │   ├── use-handle-availability.ts # Debounced handle-availability probe (advisory UI only)
│   │   ├── profile-store.ts     # localStorage profile CACHE + theme/accent + privacy prefs
│   │   ├── avatars.ts           # Avatar catalogue: 16 SVG archetypes × colourways, id-only storage
│   │   ├── vibe-stats.ts        # Capacitor plugin TypeScript interface
│   │   ├── vibe-stats.web.ts    # Web fallback for the plugin
│   │   ├── chat-store.ts        # Local group-chat messages (localStorage, prototype)
│   │   ├── groups-store.ts      # Friend groups (localStorage, prototype — per-account keys)
│   │   └── utils.ts
│   ├── routes/
│   │   ├── __root.tsx           # Root layout with QueryClientProvider
│   │   ├── index.tsx            # Landing / welcome page (Google Sign-In entry + session auto-restore)
│   │   ├── onboarding.tsx       # Profile setup: name/handle, avatar, private details, permissions, goal
│   │   ├── app.tsx              # App shell: session gate, permission gate, privacy mirroring, presence
│   │   ├── app.index.tsx        # Pulse (home) — own live stats, Active/Silent mode, friend cards
│   │   ├── app.friends.tsx      # Friends list + requests + handle/name search
│   │   ├── app.chats.$chatId.tsx # DM (Firestore) or local group chat
│   │   ├── app.notifications.tsx # Notifications feed + accept/decline requests + prefs
│   │   ├── app.profile.tsx      # Profile / edit profile / privacy toggles / blocked accounts link
│   │   ├── app.settings.$section.tsx # Settings: privacy, help, permissions (live status), about, blocked
│   │   ├── app.settings.theme.tsx # Theme + accent
│   │   ├── app.stats.$friendId.tsx # Detailed stats (own or friend's) with share-flag gating
│   │   └── app.user.$friendId.tsx  # Public profile: actions (unfriend/block/report), today snapshot
│   ├── components/
│   │   ├── Avatar.tsx           # Renders an avatar recipe (SVG) or initials
│   │   ├── AvatarPicker.tsx     # Avatar grid picker
│   │   ├── PermissionGate.tsx   # Full-screen gate when core permissions are missing (with skip)
│   │   ├── RestrictedSettingsNote.tsx # Android 13+ "restricted settings" walkthrough for Usage access
│   │   ├── StatSocial.tsx       # Reaction chips + comment sheet on stat cards
│   │   ├── stat-ui.tsx          # Shared stat building blocks (formatters, CollapsibleCard)
│   │   ├── Logo.tsx / Socials.tsx
│   │   └── ui/                  # Radix UI shadcn-style primitives
│   ├── hooks/
│   ├── router.tsx               # TanStack Router setup with QueryClient
│   ├── routeTree.gen.ts         # Manual route tree (no router plugin in vite.config.ts)
│   └── main.tsx                 # App entry point
├── firestore.rules              # Security rules (referenced by firebase.json — CLI-deployable)
├── firestore.indexes.json       # Composite indexes for search (discoverable + handleLower/nameLower)
├── firebase.json                # Firestore rules + indexes config (CLI deploy wired)
├── capacitor.config.ts          # Capacitor configuration
└── package.json                 # Dependencies and scripts
```

## Firebase Configuration

Firebase provides **both authentication and all application data**. There is no other backend.

| Setting | Value |
|---------|-------|
| Project ID | `dropscope-b588a` |
| API Key | `AIzaSyCom5ZyFQbQOWDfLMky1e_f6inIzbcdD7Q` |
| Auth Domain | `dropscope-b588a.firebaseapp.com` |
| Storage Bucket | `dropscope-b588a.firebasestorage.app` (declared, **unused** — avatars are drawn, not stored) |
| App ID (Android) | `1:626880059849:android:41fa69ca5aceccc6b3b018` |
| Android Package | `com.chatz.app` |

These values are mirrored in `src/lib/firebase.ts` (JS SDK) and `android/app/google-services.json` (native SDK). They must stay in sync — a mismatch causes Google Sign-In to fail with status 10 (`DEVELOPER_ERROR`).

### Google Sign-In

- **Web client ID** (hardcoded in `VibeStatsPlugin.kt`): `626880059849-3ktfefr5tsjqmgiehfhba4rmtofkt6gt.apps.googleusercontent.com`
- **Native flow (the one that matters):** Android `GoogleSignInClient` in the plugin → Google ID token → `GoogleAuthProvider.credential(idToken)` → `signInWithCredential` in the WebView's JS Firebase instance.
- **Web flow:** `signInWithPopup` (used only when running in a browser, e.g. `npm run dev`).
- **Why native?** Firebase's `signInWithRedirect`/`signInWithPopup` don't work inside a Capacitor WebView — the redirect loses `sessionStorage` (Firebase's state parameter). Native Google Sign-In opens an in-app account picker and returns an ID token instead.
- **Native session mirroring:** the JS SDK and the native Kotlin SDK are two separate Firebase instances. `ensureNativeSession(user)` compares `getNativeAuthUid()` with the JS `user.uid` and, when they differ, calls `VibeStats.adoptExistingSession(...)` which uses `GoogleSignInClient.silentSignIn()` to sign the **native** instance in without any UI. The background worker reads `FirebaseAuth.getInstance().currentUser` — this is what keeps background uploads authenticated without reopening the app.
- **SHA-1:** the debug signing certificate's SHA-1 must be registered in Firebase Console → Project settings → Your apps → Android app. Missing it is the most common cause of status 10.

## Authentication & Routing Lifecycle

`src/lib/session.ts` is the single decision point. Order of truth: **Firebase Auth says who the user is; Firestore says whether onboarding is finished.** localStorage is only a cache and never answers either question by itself (except when Firestore is unreachable *and* the cache belongs to the same uid).

| `resolveSession()` state | Meaning | Where the app routes |
|--------------------------|---------|----------------------|
| `signed-out` | No Firebase user | `/` (landing, Google button) |
| `onboarding` | Signed in; Firestore has no completed profile for this uid | `/onboarding` |
| `ready` | Signed in; `users/{uid}` exists with `profileCompleted: true` | `/app` |
| `unknown` | Signed in but Firestore unreachable and no cache for this uid | Error screen with retry — **never onboarding** |

Rules that follow from this:

- A user who finished onboarding **never sees onboarding again** — not after restart, sign-out, process death, or reinstall — because the decision comes from `users/{uid}.profileCompleted` in Firestore, not from local state.
- The account is keyed on the **Firebase Auth UID**. Never on email, never on displayName, never on handle.
- The Google email/photo are stored as metadata only (`users/{uid}/private/data.email`); the Google photo URL is never used as the ChatZ avatar.
- Sign-out calls `signOutEverywhere()` → signs out the JS SDK, the native SDK (`VibeStats.signOutNative`), and clears the local cache.

## Firestore Data Model

| Path | Shape | Written by |
|------|-------|-----------|
| `users/{uid}` | `{ name, nameLower, handle, handleLower, color, avatarId, goalHours, theme, accent, bio, socials, discoverable, profileCompleted, createdAt, updatedAt }` | Onboarding + profile edits |
| `users/{uid}/private/data` | `{ email, dob, education, firstName, lastName, privacy, mode, fcmToken }` — private fields (owner-only); `privacy` is the sharing map, `mode` is `active`/`silent`, `fcmToken` is this device's push address (read by the Worker with admin credentials) | Owner only |
| `users/{uid}/private/prefs` | `{ notifPrefs: { reaction, comment } }` — per-kind notification feed filters | Owner only |
| `handles/{handleLower}` | `{ uid, createdAt }` — the uniqueness lock. The document ID *is* the reservation; losing the create race means the handle is taken | Handle claim transaction |
| `friendRequests/{senderUid}_{receiverUid}` | `{ senderId, receiverId, status, createdAt, updatedAt }` with status ∈ `pending / accepted / rejected / cancelled` | Sender creates; receiver accepts/rejects; sender may cancel and may re-request |
| `friendships/{memberA}_{memberB}` | `{ members: [uid1, uid2], createdAt }` with `members` sorted ascending, so exactly one deterministic ID can exist per pair | Created **only** by the receiver at accept time |
| `friendCounts/{uid}` | `{ count, updatedAt }` — denormalized friend count; rules only accept ±1 changes coupled to a friendship gained/lost **in the same batch** | Accept/unfriend/block batches |
| `chats/{pairId}` | `{ members: [a, b] sorted, updatedAt, lastMessage: { fromUid, text, at, clientAt } }` — pairId = sorted uids (same scheme as friendships); creatable/updatable only while the friendship exists | `sendDm` |
| `chats/{pairId}/messages/{id}` | `{ fromUid, text, createdAt: serverTimestamp, clientAt: epoch ms }` — `createdAt` is authoritative (rules require `== request.time`); `clientAt` only orders pending writes locally | `sendDm` |
| `statPosts/{ownerUid}_{day}/reactions/{reactorUid}` | `{ uid, emoji, createdAt, expiresAt }` — ASCII emoji keys, one reaction per person (doc id = reactor uid), 24h TTL | `setReaction` |
| `statPosts/{ownerUid}_{day}/comments/{id}` | `{ authorUid, authorName, authorHandle, authorColor, authorAvatarId?, text, parentId, createdAt, expiresAt }` — threaded via `parentId`, 24h TTL | `addComment` |
| `notifications/{autoId}` | `{ toUid, fromUid, fromName, fromColor, fromHandle?, fromAvatarId?, kind, text, link, read, createdAt, expiresAt, pushedAt? }` — kind ∈ `reaction / comment / message / friend_request / group_invite / mention / unfriend / block`; create rules tie `unfriend`/`block` kinds to the relationship change in the same batch. `pushedAt` is written by the push Worker, never by a client | `pushNotif` + relationship batches; `pushedAt` by the Worker |
| `blocks/{blockerUid}_{blockedUid}` | `{ blockerUid, blockedUid, blockedName, blockedHandle, blockedColor, blockedAvatarId, createdAt }` — denormalized display fields so the blocked list never reads the blocked profile | `blockUser` (batch: block + unfriend + cancel requests + notification) |
| `reports/{autoId}` | `{ reporterUid, reportedUid, reason, details, createdAt }` — write-only: no read/update/delete for anyone | `reportUser` |
| `usageStats/{uid}` | The latest snapshot: screen time, top apps, data, battery, Wi-Fi **plus `shared` (per-category flags) and `mode` (`active`/`silent`)**. Gated categories are zeroed at write time; `mode:"silent"` documents are fully neutral so friends show "Stats sharing is paused" | Native WorkManager worker (owner only) + `pushUsageSnapshot` on privacy/mode changes |
| `presence/{uid}` | `{ online, lastSeen, deviceActive, updatedAt }` — separate from the permanent profile; considered stale after 2 minutes; silent mode forces offline | App (foreground) |

Design notes:

- **Deterministic IDs, no random ones.** `friendRequests/{sender}_{receiver}`, `friendships/{a}_{b}` (sorted), `chats/{pairId}` and `blocks/{a}_{b}` mean there is exactly one document per pair and no contradictory duplicate state.
- **Composite indexes.** The two search queries need composite indexes (`discoverable ASC + handleLower ASC`, `discoverable ASC + nameLower ASC`) — declared in `firestore.indexes.json`. Everything else (equality pairs, `array-contains`, `documentId() in` chunks) runs on automatic single-field indexes. If search fails with `failed-precondition`, the indexes are not deployed yet: `firebase deploy --only firestore:indexes`.
- **Search is prefix-only.** Firestore has no substring search, so `searchProfiles()` runs `>= q` / `<= q + '\uf8ff'` ranges over `handleLower` and `nameLower`, both filtered server-side by `discoverable == true`. `handles/{handleLower}` exists purely to keep handles unique; it is not the search index.
- **Handles are case-insensitive.** `normalizeHandle()` lowercases before every read/write, so `@JohnDoe`, `@johndoe` and `@JOHNDoe` can never become three accounts.
- **Private vs public split.** Firestore rules cannot hide individual fields on a readable document, so private fields (email, DOB, education, the `privacy` map and sharing `mode`) live in the `users/{uid}/private/data` subdocument (owner-only). The public profile carries only the derived `discoverable` boolean that search queries filter on.
- **24h TTL for temporary activity.** Reactions, comments and notifications carry `expiresAt` (now + 24h, minted from the **client** clock, rules bound to ±1h); readers drop expired docs client-side (`isExpired`). There is **no Firestore TTL policy and cannot be one on Spark** — TTL is a Blaze feature — so nothing physically deletes expired documents, and rules apply no read-time expiry filter. Do not describe expired docs as "cleaned up" anywhere. See `docs/CHATZ_PRODUCTION_AUDIT.md` §4.3.

## Security Rules (`firestore.rules`)

`rules_version = '2'` — note that in v2 a `match` block applies only to its own path, so nested subcollections need their own block. There is **no** `allow read, write: if true` anywhere.

- `signedIn()` / `isSelf(uid)` / `areFriends(a, b)` / `ownsHandle(h)` helpers at the top.
- `users/{uid}`: read = any signed-in user; create = self **and** the handle is actually owned (checked against `handles/{handleLower}`); update = self and (handle unchanged **or** the new handle is owned); delete = never. `users/{uid}/private/{docId}`: owner only.
- `handles/{handle}`: read = signed in; create = the `uid` field must equal `request.auth.uid`; update = never; delete = only by the owner.
- `friendRequests/{requestId}`: read = sender or receiver only. Create requires `senderId == request.auth.uid` (so nobody can forge a request from someone else), a deterministic document id, `status == 'pending'`, and an exact field whitelist. Updates only allow the documented transitions: receiver `pending → accepted | rejected`, sender `pending → cancelled`, sender `rejected | cancelled → pending`. There is deliberately **no** `pending → pending`, which is what stops re-request spam.
- `friendships/{pairId}`: read = members only. Create requires two sorted members, a deterministic id, and `getAfter(friendRequests/...).data.status == 'accepted'` — only the receiver of an accepted request can create the friendship. Update = never. Delete = either member.
- `usageStats/{uid}` and `presence/{uid}`: read = self or a **mutual friend** (`areFriends()`), write = self only.
- `chats/{pairId}` + `chats/{pairId}/messages/*`: read/write only while the friendship for that pair exists; message creates require `createdAt == request.time`, `text` 1–2000 chars, exact field whitelist; messages are immutable.
- `statPosts/{postId}/reactions|comments`: read/write = post owner or a friend of the owner (owner uid is recovered from the doc id with `split("_")[0]`); reactions restricted to the six ASCII emoji keys; comments ≤ 1000 chars; both require a fresh 24h `expiresAt`.
- `notifications/{autoId}`: read/update(`read` key only)/delete = recipient; create rules tie each `kind` to the social graph (friends for reaction/comment/message, a pending request for `friend_request`, `friendshipLost`/block-create in the same batch for `unfriend`/`block`).
- `blocks/{id}`: read = either party; create = blocker only, requires the friendship to be gone **after** the batch (`existsAfter`), which is what guarantees "blocked ⇒ never friends" for every other rule; delete = blocker only.
- `reports/{id}`: create-only with `reporterUid == request.auth.uid`; no read/update/delete for anyone.

Deploy: `firebase deploy --only firestore` publishes BOTH the rules and the indexes (wired in `firebase.json`). Manual console application also still works — the source of truth is this repo's `firestore.rules` file.

## Friends System

Flow: search by `@handle` or name (`searchProfiles`) → `sendFriendRequest` writes `friendRequests/{sender}_{receiver}` → the receiver sees it via `incomingRequests` (and the sender via `outgoingRequestUids`) → `acceptRequest` commits **one batch** that flips the request to `accepted`, cancels the caller's own crossed pending request, creates the deterministic `friendships/{a}_{b}` document and bumps both `friendCounts` (the rules verify the count change is coupled to the friendship creation via `getAfter`) → both sides list each other through `friendUids()` / `listFriends()`. `unfriend` and `blockUser` use the same atomic-batch pattern (friendship delete + count decrement + notification).

Behavioural guarantees:

- Pending requests are never displayed as friendships — only `friendships/` documents count.
- One user can never create a friendship document on another user's behalf (enforced in rules via the sender/receiver + `getAfter` checks).
- Mutual-friend behaviour is preserved: `areFriends()` is symmetric, and friends can read each other's `usageStats/{uid}` and `presence/{uid}`.
- Friend profiles resolve from `users/{uid}` by **UID** — never by email or handle.

`friends-repo.ts` also pre-checks state to work with the rules: `sendFriendRequest` reads the existing request first (so a re-request only flips from `rejected`/`cancelled`), and `acceptRequest` checks `areFriends` before creating the friendship (since `friendships` updates are forbidden).

## Usage Snapshots, Presence & Background Sync

Two different channels, deliberately separated:

1. **The 15-minute snapshot (`usageStats/{uid}`)** — written by `UsageStatsSyncWorker` (Kotlin WorkManager). It runs even when ChatZ is closed and the UI is not open. It reads `UsageStatsManager` locally, aggregates, builds a payload filtered by the user's privacy toggles, skips the write when the fingerprint is unchanged, and uploads with `set(..., SetOptions.merge())`. Identity comes from `FirebaseAuth.getInstance().currentUser?.uid` (the native session mirrored by `adoptExistingSession`); if there is no session or no usage-access grant, it exits successfully without writing.
2. **Live presence (`presence/{uid}`)** — written by the app while it is running, kept in Firestore, and considered stale after 2 minutes. It is separate from the profile document so continuously changing data never churns the permanent profile.

Worker details worth keeping:

- `PeriodicWorkRequest` every 15 minutes with a `NetworkType.CONNECTED`-only constraint, exponential backoff at the minimum, `ExistingPeriodicWorkPolicy.UPDATE` (re-evaluates constraints without resetting the 15-min window), tag `vibe_sync`. There is no foreground service and no alarm hack. The battery-not-low constraint was **deliberately removed**: Android 12–15 battery saver and OEM battery panels (OnePlus, Transsion…) mark devices "low" aggressively, which silently stretched a 15-minute sync to hours.
- The app also pushes an **immediate snapshot on every privacy-toggle or mode change** (`pushUsageSnapshot` in `usage-repo.ts`), so a just-changed setting is visible to friends at once instead of at the next worker run. Active transitions **always land**: when Usage access is off or collection fails, a neutral `mode:"active"` document with all `shared` flags false is written, so a friend never sees a stale "Stats sharing is paused" after the owner switched back. Only the write itself failing returns false.
- Failures: `PERMISSION_DENIED` → `Result.failure()` (retrying cannot help); everything else → `Result.retry()` while `runAttemptCount < 3`. WorkManager owns the retry timing.
- A `Source.SERVER` read is used as a connectivity probe before writing (memory-cache reads would hide a dead network) and doubles as the dedup fingerprint read.
- Snapshot payloads are always relative to the **device-local day** so they line up with the in-app `localDay()` bucket.
- Privacy toggles (stored in SharedPreferences via `setPrivacySettings`) can mask screen time / apps / data / Wi-Fi before anything leaves the device. Raw per-app lists, screenshots, browser history, messages and credentials are never uploaded.

## Native Plugin (VibeStats)

Registered in `MainActivity.java`, implemented in `VibeStatsPlugin.kt`, typed in `src/lib/vibe-stats.ts` with a web fallback in `vibe-stats.web.ts`.

| Method | Purpose |
|--------|---------|
| `requestPermission({ action })` | For `notifs` on Android 13+: shows the **real runtime dialog** via `requestPermissionForAlias` + `@PermissionCallback` (settings only as the "don't ask again" fallback). For other actions / permanent denials: opens the matching settings screen. Returns `{ granted, needsSettings }` |
| `checkPermission({ action })` | For `notifs` uses `NotificationManagerCompat.areNotificationsEnabled()` (honest on all Android versions); otherwise checks the runtime grant |
| `checkUsageAccess()` | Whether `UsageStatsManager` access is granted |
| `requestUsageAccess()` | Opens the Usage Access settings screen |
| `checkBatteryOptimization()` | Whether ChatZ is exempt from battery optimization (background sync can run) |
| `collectStats()` | One-shot collection of all device stats (screen time, top apps, launches, notifications, Wi-Fi, data, battery, device info) |
| `startBackgroundSync()` / `stopBackgroundSync()` | Schedules / cancels the 15-minute WorkManager sync |
| `getManufacturer()` | Manufacturer name (used to tailor battery-optimisation guidance) |
| `requestBatteryOptimization()` | Opens the manufacturer-specific battery optimisation screen |
| `openAppSettings()` | Opens the app's system settings page |
| `openSettings({ action })` | Opens a specific settings screen |
| `setPrivacySettings({...})` | Persists **per-uid** privacy toggles + mode to SharedPreferences for the worker (fail-closed: the worker skips an account with no privacy record) |
| `notify({ id, title, body, channel })` | Posts a system notification (`chatz_messages` heads-up channel or `chatz_social` default channel); resolves `{ shown: false, reason: "permission" }` instead of throwing when POST_NOTIFICATIONS is off |
| `getFcmToken()` | The device's FCM registration token (`""` when messaging is unavailable), which `push-repo.ts` stores on `users/{uid}/private/data` so the push Worker has an address. `ChatzPushService` is the receiving `FirebaseMessagingService` |
| `adoptExistingSession({ uid, email })` | Mirrors the WebView's Firebase session onto the native SDK via `silentSignIn()` |
| `getNativeAuthUid()` | UID of the native Firebase session (empty when none) |
| `signOutNative()` | Signs out the native Firebase instance (called by `signOutEverywhere`) |
| `signInWithGoogle()` | Native Google Sign-In; signs the **native** Firebase instance in first, then returns `{ idToken }` for the JS instance |

Constraints worth remembering:

- **Capacitor 7 removed `handleOnRequestPermissionsResult`.** The plugin cannot intercept runtime permission results, so for any un-granted permission it opens the app/system settings screen and returns `{ granted: false, needsSettings: true }`; the JS side shows a toast and treats it as visited.
- `handleOnActivityResult` is deprecated but still invoked by the bridge — it is how the native Google Sign-In result is received.
- Never read `task.result` before checking `task.isSuccessful`; on a failed `Task`, `getResult()` throws (`RuntimeExecutionException`) and Kotlin's `?.` does not guard it. This was a real crash.

## Android Permissions

| Permission | Purpose | Required? |
|------------|---------|-----------|
| `INTERNET` | Firebase Auth + Firestore | Always |
| `ACCESS_NETWORK_STATE` | See connectivity type (Wi-Fi vs mobile data) | Always |
| `ACCESS_WIFI_STATE` | Wi-Fi state / SSID | For the Wi-Fi stat |
| `POST_NOTIFICATIONS` | Notifications (Android 13+) | Optional |
| `PACKAGE_USAGE_STATS` | Real screen time. **Without this declaration Android never lists ChatZ under Settings → Special app access → Usage access**, and the toggle appears greyed out and un-tappable. It is declared with `tools:ignore="ProtectedPermissions"` (AppOps permission, granted by the user, not at install time) | Core feature |
| `RECEIVE_BOOT_COMPLETED` | Let WorkManager re-arm after reboot | For background sync |
| `READ_PHONE_STATE` (`maxSdkVersion="25"`) | Mobile-data stats only on Android 6–7 | Legacy |

Camera, microphone, location, contacts, media and foreground-service permissions were deliberately removed — no feature needs them.

**Android 13+ note:** sideloaded APKs (`installerPackageName == null`) are subject to *restricted settings*, which can grey out the Usage Access row. Diagnostics are done with `adb shell appops get com.chatz.app GET_USAGE_STATS` and `dumpsys package com.chatz.app`, but AppOps is **never** modified as a production workaround — the honest path is: tap the row → enable in system settings; `checkUsageAccess()` always reports the real state and never fakes a grant.

## APK Build

```bash
npm run build                    # Vite production build → dist/
npx cap sync android             # Copy web assets to Android
cd android && ./gradlew assembleDebug
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`

Shell prerequisites (Git Bash on Windows):

```bash
export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"
export ANDROID_HOME="/c/Users/HP/AppData/Local/Android/Sdk"
export MSYS_NO_PATHCONV=1
```

Install over an existing build with `adb install -r <apk>` — this keeps app data (Firebase session, cache, WorkManager DB).

Build/toolchain notes:

- `src/routeTree.gen.ts` is **hand-maintained**; adding a route means editing it manually.
- Toolkit pins: Kotlin 2.0.21, JDK 21, `compileSdk`/`targetSdk` 35, `minSdk` 23, WorkManager 2.10.0.
- The Vite build must emit every font file that CSS references. If a `@fontsource` package is partially installed, `dist` keeps raw `../node_modules/...` URLs in the CSS and the WebView 404s them (`https://localhost/node_modules/...`). Verify with `grep -c "node_modules" dist/assets/*.css` → expected result is `0`.

## Commands

```bash
npm run dev              # Start Vite dev server
npm run build            # Production build
npm run build:dev        # Dev build
npm run preview          # Preview production build
npm run lint             # ESLint
npm run format           # Prettier
./node_modules/.bin/tsc --noEmit   # Type check (bare `npx tsc` can resolve the wrong package)
npx cap sync android     # Sync web build to Android
```

## Known Issues & Constraints

### 1. Usage Access on sideloaded builds
Android 13+ restricted settings can grey out the Usage Access row for sideloaded APKs. The manifest declaration is correct; the remaining gate is a user-action/system-settings one. Diagnose with `adb shell appops get com.chatz.app GET_USAGE_STATS`, but never grant it via AppOps as a product solution.

### 2. Background sync is best-effort 15 minutes
WorkManager periodic work is inexact by design: with Doze/battery saver it can drift (observed first-run delays on Transsion/XOS devices). The snapshot is idempotent (fingerprint dedup) so late runs are harmless.

### 3. Handle/name search is prefix-only
Firestore has no substring search. Typing mid-word fragments returns nothing until the full word (or a prefix of it) is entered.

### 4. Presence is approximate
`presence/{uid}` is a best-effort heartbeat with a 2-minute staleness window — not a realtime socket.

### 5. Groups are local-only (prototype)
`groups-store.ts` persists local group chats to localStorage (per-account keys, so two logins on one device never blend). Real 1:1 DMs, notifications, reactions and comments **are** Firestore-backed and sync across devices. Local groups do not sync and reinstalling loses them.

### 6. Device notifications: two delivery paths, same event
The in-app path (`notifications-store.ts` → `VibeStats.notify`) mirrors Firestore notifications into the shade while the process is alive, with a persistent watermark that turns events missed during an OEM freeze into one catch-up summary on the next listener attach. The push path (v2.0+) covers what no client-side code can: a killed process. The sender pings the `chatz-push` Cloudflare Worker, which reads the payload from Firestore itself and sends one data-only FCM message to the recipient's registered token. `pushedAt` on the doc is both the dedupe marker and the signal that stops the recipient's own listener from posting a second notification.

### 7. Large JS bundle
The single app chunk is ~940 KB (approx. 280 KB gzipped), mostly Firebase + React + router. Code-splitting via dynamic imports is the obvious next step if startup cost matters.

## Agent Change Log — Full Review History (for AI-agent context)

Two full review passes have been made over this codebase after the Firestore re-architecture. Everything below is **already fixed in the code** — this section exists so no agent re-introduces a solved bug or breaks a deliberate invariant.

### Invariants — do NOT regress these

1. **`mode` (active/silent) is owned exclusively by user actions.** The only writers are `syncLocalProfile` (shell mirror of the local cache) and the Pulse mode toggle. `migratePrivacy()` must **never** write `mode` — it runs un-awaited from `loadProfile` against a possibly-stale snapshot, and writing `mode: x ?? "active"` from it is what caused the Silent→Active flip (see CL-8). Absence of `mode` on the private doc means "never configured" and legitimately defaults to `active` at read time.
2. **`saveOnboardingProfile` seeds `discoverable: true`.** Without it, `migratePrivacy()` treats the profile as unmigrated and re-runs on every load — that re-run window is the race that clobbered fresh privacy/mode writes.
3. **Active stat transitions must always land in `usageStats/{uid}`.** `pushUsageSnapshot` never bails silently when it cannot collect (no Usage access, collector throw) — it writes a neutral `mode:"active"` + all-`shared:false` document instead. A silent bail leaves the doc `mode:"silent"` forever and friends see "Stats sharing is paused" indefinitely (see CL-8).
4. **"ChatZ never invents data."** When Usage access is missing, the UI must show an honest "No access" state — never a zero. A zero from the collector without the permission is fabricated data. Enforced in `app.index.tsx` (Pulse) and `app.stats.$friendId.tsx` (own stats): both check `VibeStats.checkUsageAccess()` before `collectStats()`.
5. **The onboarding "skip" and the app-shell permission gate share one flag**: `localStorage["chatz.perms.gateDismissed"]`. Onboarding's skip writes it; the shell clears it only on a full grant. If you add another permission surface, use the same key.
6. **`Intl.Segmenter` is feature-detected** (`src/lib/text.ts`). Older WebViews (< Chrome 87) throw a ReferenceError on bare construction and would white-screen the whole app — the code-point fallback must stay.
7. **Device notifications are deduplicated by document id + a 90s freshness stamp** (`notifications-store.ts`). Removing the freshness check makes every listener (re)attach replay the entire unread history into the notification shade.
8. **Message/Full-stats actions are gated on `isFriend`** (`app.user.$friendId.tsx`). The rules deny chats/messages to non-friends; un-gating the buttons resurrects a dead-end chat whose send fails with a misleading "check your connection".

### CL-1 · CRITICAL (deploy): `firebase.json` did not publish the security rules
`firebase.json` referenced only `firestore.indexes.json`. A `firebase deploy --only firestore` would publish indexes but never `firestore.rules`, leaving the live rules untouched — if the project was created in locked mode, **every** Firestore read/write fails. Fixed by adding `"rules": "firestore.rules"`. Verified sane defaults elsewhere: `firestore.indexes.json` contains exactly the two search composites; both search queries in `profile-repo.searchProfiles` match them.

### CL-2 · Fake "0h 0m" screen time when Usage access is off
Pulse's `fetchStats()` and the own-stats path of `app.stats.$friendId.tsx` called `collectStats()` unconditionally. Without the permission the collector returns zeros, so the hero rendered **0h 0m** — fabricated data violating invariant 4. Fixed: both now check `checkUsageAccess()` first, render an honest "No access" hero state (EyeOff + "Screen-time access is off"), offer a **"Grant screen-time access"** CTA linking to `/app/settings/permissions`, and hide the details sheet / reaction row (they are keyed on `stats`, which stays null). The stats-page refresh button re-runs the same check.

### CL-3 · "Message" / "Full stats" shown to non-friends → dead-end chat
The profile page offered both buttons for any non-blocked profile. Rules require an existing friendship for chats/messages, so tapping Message opened a transcript where every send was denied and surfaced as *"Couldn't send — check your connection"* — a lie. Fixed: the action row is gated on the already-loaded `isFriend` state; non-friends see a "Not friends yet — send a friend request from the Friends tab" panel instead.

### CL-4 · Double permission gate after onboarding skip
Onboarding's "Skip for now" only flipped local wizard state; the app shell's `PermissionGate` (reading `chatz.perms.gateDismissed`) blocked the user again on entering `/app` — a forced double-skip. Fixed: the onboarding skip writes the shell's flag (and "Grant permissions instead" clears it). See invariant 5.

### CL-5 · Permission status stale after granting the runtime dialog
Granting the Android 13 notifications dialog does **not** background the app, so the `appStateChange` re-check listeners in `PermissionGate` and Settings → Permissions never fired; rows stayed "Not granted" until "Check again". Both surfaces now call `recheck()`/`refresh()` immediately after `openPermSettings()` resolves.

### CL-6 · Misleading onboarding toast after a denied (but re-askable) dialog
When the runtime dialog was denied with `needsSettings:false`, onboarding still toasted "Opens Android notification settings for ChatZ" though nothing opened. The toast now distinguishes the three outcomes: granted / dialog-denied-but-re-askable / settings-opened.

### CL-7 · `Intl.Segmenter` crash on older WebViews
`text.ts` (`graphemes`) and `getInitials` constructed `Intl.Segmenter` bare. On WebViews older than Chrome 87 that throws a ReferenceError during render — a full white-screen from a single avatar. Fixed with a feature-detect + code-point fallback (see invariant 6).

### CL-8 · THE Silent → Active flip bug (reported on a OnePlus, Android 15) — root cause chain
Symptoms: the owner sets Silent; minutes later their own chip flips back to Active; meanwhile friends keep seeing "stats hidden/paused" indefinitely. Three defects chained:

1. **`migratePrivacy()` clobbered `mode`** (`profile-repo.ts`). It wrote `mode: priv.mode ?? "active"` with `merge:true`, un-awaited from `loadProfile`, from a snapshot that can be stale (Firestore cache-first reads). Because onboarding never seeded `discoverable` or private `privacy`, migration ran for **every** new account on every load until privacy was touched — a standing race against the user's Silent write. Firestore ended up `active` while the local cache said `silent`; the next process death + relaunch (frequent on OEM Android 15) re-read Firestore and flipped the UI. **Fix:** migration no longer writes `mode` (invariant 1) and onboarding seeds `discoverable` (invariant 2), so migration is a true one-time no-op.
2. **`pushUsageSnapshot()` bailed silently** (`usage-repo.ts`) when Usage access was revoked or `collectStats()` threw (`return false` before writing). The friend-facing doc stayed `mode:"silent"` **forever** — the viewer-side "still showing hidden" symptom. The worker could not rescue it: on aggressive OEMs the native Google silent sign-in often fails, `signOutNative()` runs, and the worker exits at "no native session" every 15 minutes. **Fix:** invariant 3 — the Active flip always lands (neutral doc when real numbers are unavailable); friends converge to the honest "not shared" state.
3. **Lost profile writes were swallowed** (`app.tsx` shell push handler): `syncLocalProfile` failures only reset a marker, with no retry — a transient network error could drop the Silent write entirely, letting the next `loadProfile` resurrect the stale value via its `?? "active"` default. **Fix:** one retry after 4s, re-reading the cache and re-checking the uid.

Net effect: profile mode, the friend-facing `usageStats.mode`, and the native worker prefs now converge in all paths — the viewer's "paused/hidden" view can no longer outlive the owner's toggle.

### CL-9 · Background sync refurbished for modern Android
`WorkScheduler.kt`: removed `setRequiresBatteryNotLow(true)` (Android 12–15 battery saver and OEM battery panels trip it constantly, stretching the 15-minute sync to hours — a direct contributor to CL-8's stale-snapshot report). Kept `ExistingPeriodicWorkPolicy.UPDATE` (never resets the 15-min window on app open), CONNECTED-only constraint, exponential backoff. The worker itself (fail-closed per-uid privacy prefs, silent-mode skip, fingerprint dedup, `Source.SERVER` connectivity probe) was audited and left as-is.

### CL-10 · Device notifications (Instagram/WhatsApp-style)
New native `VibeStats.notify({ id, title, body, channel })` in `VibeStatsPlugin.kt`:
- Two channels: `chatz_messages` (IMPORTANCE_HIGH → heads-up) and `chatz_social` (IMPORTANCE_DEFAULT), created idempotently on Android 8+.
- `BigTextStyle`, auto-cancel, `CATEGORY_MESSAGE`/`CATEGORY_SOCIAL`, content intent = the app's launch intent (singleTask → returns to the app; unread state is in the in-app feed).
- Never throws for a missing POST_NOTIFICATIONS grant — resolves `{ shown: false, reason: "permission" }`. Stable per-doc notification id via `key.hashCode()` so the same doc never stacks.

JS side (`notifications-store.ts`, inside the Firestore `useNotifs` listener) posts with three guards (see invariant 7): **unread only**, **fresh** (`createdAt` within 90s — listener re-attaches must not replay history), **app not visible** (`document.visibilityState`) — foreground users see the event in-app, like Instagram/WhatsApp. Web fallback no-ops. Wired for all kinds: messages ("Majid sent you a message: hii"), reactions, comments, friend requests, unfriend/block.

Known limit (was Known Issues #6 until v2.0): needed the process alive. Killed-process push is now the `chatz-push` Worker + FCM path described there.


### CL-11 · Friends refresh — circular animation
The Pulse friends-refresh button now shows a proper circular ring spinner (`border-2 border-primary/25 border-t-primary animate-spin`) instead of a spinning icon, and `refreshFriends` enforces a **≥650 ms** visible duration so cache-hit refreshes (near-instant `getDocFromServer`) still animate.

### CL-12 · Pre-refactor review (historical, superseded)
An earlier pass over the previous architecture (Supabase + news feed + weather + instants + Nuxo) found and fixed 12 bugs (feed `ArticleData` property mismatches, article-detail lookup always missing, sign-out not calling Firebase, invalid `max()` CSS, news-cache key mismatch, dead Instants integration, Nuxo search-param schema, weather search filter, `vite-tsconfig-paths` removal, resend-verification buttons, missing `trending` interest score, `SourcesSheet` typing). The re-architecture deleted those subsystems; the fixes are listed only so their lessons (e.g. "sign-out must sign out every auth instance") aren't relearned. That session's surviving principle: **sign-out must sign out of every auth instance** — now implemented as `signOutEverywhere()` (JS SDK + native SDK + cache).

## API Keys & Credentials

| Item | Value | Location |
|------|-------|----------|
| Firebase API Key | `AIzaSyCom5ZyFQbQOWDfLMky1e_f6inIzbcdD7Q` | `src/lib/firebase.ts` |
| Firebase Web Client ID (Google Sign-In) | `626880059849-3ktfefr5tsjqmgiehfhba4rmtofkt6gt.apps.googleusercontent.com` | `VibeStatsPlugin.kt` |
| Firebase App ID (Android) | `1:626880059849:android:41fa69ca5aceccc6b3b018` | `src/lib/firebase.ts` + `google-services.json` |

The Firebase API key is a public client identifier, not a secret — access is controlled entirely by Firestore Security Rules and Firebase Auth. Do **not** add service-account keys, Google OAuth client secrets, or any other server-side credential to this repository. Authentication tokens must never be logged or written to Firestore.

The push bridge's credential (`chatz-push` service-account JSON) lives **only** as a Cloudflare Worker secret named `SA_JSON`, set with `wrangler secret put SA_JSON < keyfile`. It is never in this repo, in `push-worker/`, in the APK, or in Firestore. `push-worker/wrangler.jsonc` holds only the Worker name and config.

### Push Worker (`push-worker/`)
Deployed to `https://chatz-push.chatz-app.workers.dev`. The app's `src/lib/push-repo.ts` holds the URL and both halves of the contract: `registerFcmToken(uid)` and `triggerPush(notifId)`. The Worker treats Firestore as the payload authority — a ping carries only a document id, so a caller can never forge notification text — and needs the Firebase Cloud Messaging Send API enabled on `dropscope-b588a`. Redeploy after editing: `cd push-worker && npx wrangler deploy`.

**The FCM message must stay strictly data-only.** Adding anything under `android.notification` — even just `channel_id` — makes FCM classify it as a *notification* message, so a backgrounded app gets the OS's own tray entry (blank, since there is no title/body to render) and `onMessageReceived` never runs. Verified on device: with the block the shade showed `fcm_fallback_notification_channel` with `title=null`; without it, `ChatzPushService` created `chatz_messages` itself and posted the real text. The service is responsible for channel creation; the manifest is not.

Delivery reaches a frozen, not-foregrounded ChatZ — XOS reported `transition from Frozen to Running, reason=broadcast` on `com.google.android.c2dm.intent.RECEIVE` and the notification posted within ~60 ms. It does **not** reach one stopped via Settings → Force stop: Android sets `FLAG_STOPPED` and suppresses FCM until the user next opens the app (confirmed — a force-stopped ChatZ never woke). Nothing in the app can or should work around that.

## Build Dependencies (Android)

- Kotlin stdlib + coroutines 1.9.0
- WorkManager 2.10.0 (`work-runtime-ktx`)
- Lifecycle ViewModel KTX 2.8.7
- Firebase BOM 33.12.0 → `firebase-auth`, `firebase-firestore`, `firebase-messaging` (the `chatz-push` Worker's delivery target)
- Google Play Services Auth 21.2.0
- Capacitor 7 (app, splash-screen, status-bar)
