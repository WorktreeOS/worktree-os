import type { PushSubscription } from "@worktreeos/core/notifications";

/** Add a subscription, replacing any existing entry with the same endpoint. */
export function upsertSubscription(
  list: PushSubscription[],
  sub: PushSubscription,
): PushSubscription[] {
  return [...list.filter((s) => s.endpoint !== sub.endpoint), sub];
}

/** Remove the subscription with the given endpoint. */
export function removeSubscription(
  list: PushSubscription[],
  endpoint: string,
): PushSubscription[] {
  return list.filter((s) => s.endpoint !== endpoint);
}

/** Validate the minimally-required shape of an incoming push subscription. */
export function parsePushSubscriptionInput(
  input: unknown,
): PushSubscription | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.endpoint !== "string" || obj.endpoint.length === 0) return null;
  const keys = obj.keys;
  if (!keys || typeof keys !== "object") return null;
  const k = keys as Record<string, unknown>;
  if (typeof k.p256dh !== "string" || typeof k.auth !== "string") return null;
  const sub: PushSubscription = {
    endpoint: obj.endpoint,
    keys: { p256dh: k.p256dh, auth: k.auth },
  };
  if (typeof obj.expirationTime === "number") {
    sub.expirationTime = obj.expirationTime;
  }
  return sub;
}
