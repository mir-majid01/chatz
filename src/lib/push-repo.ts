// The push bridge, in two halves.
//
//   registerFcmToken — this device records the FCM token Firebase gave it, in
//                      the owner-only private doc, so a push has an address.
//   triggerPush      — after a notification doc is created, the sender pings the
//                      chatz-push Cloudflare Worker. The ping carries only the
//                      document id: the Worker re-reads the payload from
//                      Firestore itself, so nothing a caller sends can become
//                      notification text, and a forged request gets nothing.
//
// The Worker is needed because FCM's HTTP v1 API demands a credential an app
// cannot safely ship, and Cloud Functions would require a Blaze plan.
import { Capacitor } from "@capacitor/core";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "./firebase";
import { VibeStats } from "./vibe-stats";

// Filled in after `wrangler deploy`. Left empty until then: no ping is sent, and
// recipients keep the previous behaviour (live listener + catch-up watermark).
export const PUSH_WORKER_URL = "https://chatz-push.chatz-app.workers.dev";

/**
 * One token per user document, so a second phone signed into the same account
 * takes over delivery. ChatZ assumes one device per account.
 */
export async function registerFcmToken(uid: string): Promise<void> {
  if (!uid || !Capacitor.isNativePlatform()) return;
  const token = await VibeStats.getFcmToken()
    .then((r) => r.token)
    .catch(() => "");
  if (!token) return;

  const ref = doc(db, "users", uid, "private", "data");
  // Registration tokens are stable per install, so most launches land here and
  // write nothing.
  const current = await getDoc(ref).catch(() => null);
  if ((current?.data() as { fcmToken?: string } | undefined)?.fcmToken === token) return;
  await setDoc(ref, { fcmToken: token }, { merge: true }).catch(() => {});
}

/** Fire-and-forget: a missed ping only means the client-side path still runs. */
export function triggerPush(notifId: string): void {
  if (!PUSH_WORKER_URL) return;
  fetch(`${PUSH_WORKER_URL}/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notifId }),
  }).catch(() => {});
}
