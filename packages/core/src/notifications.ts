/**
 * Channel-agnostic notification contract shared between the daemon
 * notification engine, the delivery channels (Telegram / Web Push / Sound),
 * the global config, and the web client.
 *
 * The taxonomy is intentionally open: new `NotificationKind`s and new channels
 * fold in without breaking existing config. Config loading tolerates unknown
 * rule kinds so a newer config keeps working against an older build.
 */

/** Known notification kinds in v1. The taxonomy is open for new kinds. */
export const NOTIFICATION_KINDS = ["agent.done", "agent.question"] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Whether a string names a kind the running build recognizes. */
export function isKnownNotificationKind(
  value: unknown,
): value is NotificationKind {
  return (
    typeof value === "string" &&
    (NOTIFICATION_KINDS as readonly string[]).includes(value)
  );
}

/** Coarse severity carried by every notification, mirroring agent activity. */
export type NotificationSeverity = "info" | "needs-attention";

/**
 * A rendered, channel-agnostic notification. Self-contained so any channel can
 * deliver it without further daemon lookups. `kind` is typed as `string` (not
 * `NotificationKind`) so a forward-compatible kind still renders.
 */
export interface Notification {
  kind: string;
  title: string;
  body: string;
  severity: NotificationSeverity;
  /** Click-through target (web route) for the notification. */
  link: string;
  /** Stable key used to suppress duplicate deliveries within a window. */
  dedupeKey: string;
  worktreePath?: string;
  terminalSessionId?: string;
}

/** Stable identifiers for the v1 channels. Sound is delivered by the web tab. */
export type NotificationChannelId = "telegram" | "webpush" | "sound";

/**
 * Which daemon-delivered channels a kind routes to. Sound is per-device and
 * client-only, so it is not part of the daemon routing.
 */
export interface NotificationChannelRouting {
  telegram: boolean;
  webpush: boolean;
}

/** Per-kind rule: whether to notify at all and which channels to fan out to. */
export interface NotificationRule {
  enabled: boolean;
  channels: NotificationChannelRouting;
}

/**
 * Telegram delivery mode. `when-away` (the default) gates delivery on presence —
 * a message is sent only when no browser client is focused. `always` bypasses
 * the gate and delivers on every matching event, because Telegram reaches a
 * separate device.
 */
export type TelegramDeliveryMode = "always" | "when-away";

/** Telegram channel credentials and enable flag. `botToken` is a secret. */
export interface TelegramChannelConfig {
  enabled: boolean;
  botToken: string;
  chatId: string;
  /** Whether presence gates delivery; defaults to `when-away`. */
  mode: TelegramDeliveryMode;
}

/** Web Push channel enable flag. The VAPID keypair lives in the state dir. */
export interface WebPushChannelConfig {
  enabled: boolean;
}

/** Encryption keys carried by a browser Web Push subscription. */
export interface PushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

/** A browser Web Push subscription registered by the web client. */
export interface PushSubscription {
  endpoint: string;
  keys: PushSubscriptionKeys;
  /** Browser-reported expiration (ms epoch), when present. */
  expirationTime?: number | null;
}

export interface NotificationChannelsConfig {
  telegram: TelegramChannelConfig;
  webpush: WebPushChannelConfig;
}

/**
 * The daemon-side notification config block. Per-kind rules are keyed by
 * `NotificationKind`; unknown kinds are preserved verbatim for forward
 * compatibility. Delivery is gated on focus presence: `notification.raised` and
 * Web Push fire only when no browser client is focused, and Telegram follows its
 * configured delivery mode.
 */
export interface NotificationsConfig {
  rules: Record<string, NotificationRule>;
  channels: NotificationChannelsConfig;
  /** Registered Web Push subscriptions used as delivery targets. */
  pushSubscriptions: PushSubscription[];
}

/** A disabled-by-default rule for a single kind. */
export function defaultNotificationRule(): NotificationRule {
  return { enabled: false, channels: { telegram: false, webpush: false } };
}

/**
 * Built-in notification config: every rule and channel disabled, no push
 * subscriptions. Returned whenever the `notifications` block is absent.
 */
export function defaultNotificationsConfig(): NotificationsConfig {
  const rules: Record<string, NotificationRule> = {};
  for (const kind of NOTIFICATION_KINDS) {
    rules[kind] = defaultNotificationRule();
  }
  return {
    rules,
    channels: {
      telegram: { enabled: false, botToken: "", chatId: "", mode: "when-away" },
      webpush: { enabled: false },
    },
    pushSubscriptions: [],
  };
}

/** Placeholder used wherever a secret value is surfaced to a client. */
export const REDACTED_SECRET = "__redacted__";

/**
 * Return a deep copy of the notifications config with secret values replaced by
 * `REDACTED_SECRET`, safe to return to the UI. Push subscription endpoints are
 * dropped (they are device-bound delivery targets, not user-editable settings).
 */
export function redactNotificationsConfig(
  config: NotificationsConfig,
): NotificationsConfig {
  return {
    rules: structuredClone(config.rules),
    channels: {
      telegram: {
        enabled: config.channels.telegram.enabled,
        botToken: config.channels.telegram.botToken ? REDACTED_SECRET : "",
        chatId: config.channels.telegram.chatId,
        // The delivery mode is not a secret; surface it verbatim to the UI.
        mode: config.channels.telegram.mode,
      },
      webpush: { enabled: config.channels.webpush.enabled },
    },
    // Subscription count is the only client-relevant fact; targets stay server-side.
    pushSubscriptions: [],
  };
}
