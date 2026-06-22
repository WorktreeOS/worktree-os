// Web Push subscription helpers. The pure parts (key decoding + subscription
// shaping) are unit-tested; `enableWebPush` is the thin browser-binding layer.

import type { StoredPushSubscription } from "./ui-api";

/** Decode a base64url VAPID key into the `Uint8Array` `pushManager` expects. */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** Shape a browser `PushSubscriptionJSON` into the daemon's stored form. */
export function toStoredSubscription(
  json: PushSubscriptionJSON,
): StoredPushSubscription | null {
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return null;
  const sub: StoredPushSubscription = {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  };
  if (typeof json.expirationTime === "number") {
    sub.expirationTime = json.expirationTime;
  }
  return sub;
}

export interface WebPushApi {
  getNotifications(): Promise<{ vapidPublicKey: string }>;
  registerPushSubscription(
    sub: StoredPushSubscription,
  ): Promise<{ ok: boolean }>;
}

export type EnableWebPushResult =
  | { ok: true }
  | {
      ok: false;
      reason: "unsupported" | "permission-denied" | "error";
      message?: string;
    };

/** Whether this browser can do Web Push at all. */
export function isWebPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * Request permission, subscribe the browser to the daemon's VAPID key, and POST
 * the subscription. Returns a structured result so the UI can report failures.
 */
export async function enableWebPush(
  api: WebPushApi,
): Promise<EnableWebPushResult> {
  if (!isWebPushSupported()) return { ok: false, reason: "unsupported" };
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, reason: "permission-denied" };
  try {
    const { vapidPublicKey } = await api.getNotifications();
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });
    const stored = toStoredSubscription(
      subscription.toJSON() as PushSubscriptionJSON,
    );
    if (!stored) {
      return { ok: false, reason: "error", message: "subscription is missing keys" };
    }
    const res = await api.registerPushSubscription(stored);
    return res.ok
      ? { ok: true }
      : { ok: false, reason: "error", message: "daemon rejected the subscription" };
  } catch (err) {
    return { ok: false, reason: "error", message: (err as Error).message };
  }
}
