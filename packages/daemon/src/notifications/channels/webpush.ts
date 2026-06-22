import type {
  Notification,
  NotificationsConfig,
  PushSubscription,
} from "@worktreeos/core/notifications";
import type {
  ChannelDeliveryResult,
  ChannelValidationResult,
  NotificationChannel,
} from "./types";
import {
  encryptPayload,
  signVapidJwt,
  type VapidKeys,
} from "./webpush-crypto";

/** TTL in seconds the push service should retain an undelivered message. */
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 28; // 28 days
/** VAPID JWTs must expire within 24h; use a comfortable 12h. */
const VAPID_JWT_LIFETIME_SECONDS = 60 * 60 * 12;

export interface PushRequest {
  endpoint: string;
  headers: Record<string, string>;
  body: Buffer;
}

export interface PushResponse {
  status: number;
}

export type PushSender = (req: PushRequest) => Promise<PushResponse>;

const defaultSender: PushSender = async (req) => {
  const res = await fetch(req.endpoint, {
    method: "POST",
    headers: req.headers,
    body: req.body,
  });
  return { status: res.status };
};

export interface WebPushChannelDeps {
  vapid: VapidKeys;
  /** VAPID `sub` claim: a `mailto:` or `https:` contact. */
  subject: string;
  /** Override the HTTP sender (tests). */
  sender?: PushSender;
  /** Called when the push service reports a subscription as gone (404/410). */
  onSubscriptionGone?: (endpoint: string) => void;
  /** Injectable clock in ms (tests). */
  now?: () => number;
  ttlSeconds?: number;
}

/**
 * Web Push channel. Encrypts a notification per subscription (RFC 8291) and
 * POSTs it with a VAPID Authorization header. A subscription the push service
 * reports as gone (404/410) is pruned via `onSubscriptionGone`.
 */
export class WebPushChannel implements NotificationChannel {
  readonly id = "webpush";
  private enabled = false;
  private subscriptions: PushSubscription[] = [];
  private readonly vapid: VapidKeys;
  private readonly subject: string;
  private readonly sender: PushSender;
  private readonly onSubscriptionGone?: (endpoint: string) => void;
  private readonly now: () => number;
  private readonly ttlSeconds: number;

  constructor(deps: WebPushChannelDeps) {
    this.vapid = deps.vapid;
    this.subject = deps.subject;
    this.sender = deps.sender ?? defaultSender;
    this.onSubscriptionGone = deps.onSubscriptionGone;
    this.now = deps.now ?? (() => Date.now());
    this.ttlSeconds = deps.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  }

  updateConfig(config: NotificationsConfig): void {
    this.enabled = config.channels.webpush.enabled;
    this.subscriptions = config.pushSubscriptions;
  }

  validateConfig(): ChannelValidationResult {
    if (this.subscriptions.length === 0) {
      return { ok: false, error: "no Web Push subscriptions registered" };
    }
    return { ok: true };
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async deliver(notification: Notification): Promise<void> {
    await this.fanOut(notification);
  }

  async send(notification: Notification): Promise<ChannelDeliveryResult> {
    return this.fanOut(notification);
  }

  private async fanOut(
    notification: Notification,
  ): Promise<ChannelDeliveryResult> {
    const subs = this.subscriptions;
    if (subs.length === 0) {
      return { ok: false, error: "no Web Push subscriptions registered" };
    }
    const payload = JSON.stringify({
      title: notification.title,
      body: notification.body,
      kind: notification.kind,
      data: { path: notification.link },
    });
    let anyOk = false;
    let lastError: string | undefined;
    for (const sub of subs) {
      const outcome = await this.sendOne(sub, payload);
      if (outcome.ok) anyOk = true;
      else lastError = outcome.error;
    }
    return anyOk ? { ok: true } : { ok: false, error: lastError ?? "delivery failed" };
  }

  private async sendOne(
    sub: PushSubscription,
    payload: string,
  ): Promise<ChannelDeliveryResult> {
    try {
      const aud = new URL(sub.endpoint).origin;
      const exp = Math.floor(this.now() / 1000) + VAPID_JWT_LIFETIME_SECONDS;
      const jwt = signVapidJwt(this.vapid.privateJwk, {
        aud,
        sub: this.subject,
        exp,
      });
      const body = encryptPayload({
        payload,
        uaPublicKey: sub.keys.p256dh,
        authSecret: sub.keys.auth,
      });
      const res = await this.sender({
        endpoint: sub.endpoint,
        headers: {
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          ttl: String(this.ttlSeconds),
          authorization: `vapid t=${jwt}, k=${this.vapid.publicKey}`,
        },
        body,
      });
      if (res.status === 404 || res.status === 410) {
        this.onSubscriptionGone?.(sub.endpoint);
        return { ok: false, error: `subscription gone (${res.status})` };
      }
      if (res.status >= 200 && res.status < 300) return { ok: true };
      return { ok: false, error: `push service returned ${res.status}` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
