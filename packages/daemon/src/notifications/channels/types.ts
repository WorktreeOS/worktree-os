import type {
  Notification,
  NotificationsConfig,
} from "@worktreeos/core/notifications";

export interface ChannelValidationResult {
  ok: boolean;
  /** Human-readable reason when `ok` is false. */
  error?: string;
}

/** Outcome of an attempted delivery, used by the test-send endpoint. */
export interface ChannelDeliveryResult {
  ok: boolean;
  error?: string;
}

/**
 * A notification delivery channel. The engine fans a rendered `Notification`
 * out to every routed, enabled, configured channel. Delivery is best-effort:
 * `deliver` MUST NOT throw or reject in a way that blocks the engine or other
 * channels — the engine isolates it regardless, but `deliver` swallows its own
 * network failures. The test-send path uses `send`, which reports the outcome
 * and ignores the channel-level enable flag (so a user can validate
 * credentials before turning the channel on).
 */
export interface NotificationChannel {
  /** Stable channel id matching a `NotificationChannelId` (e.g. "telegram"). */
  readonly id: string;
  /** Apply the latest config (credentials, enable flags, subscriptions). */
  updateConfig(config: NotificationsConfig): void;
  /** Whether the channel has the credentials/targets needed to deliver. */
  validateConfig(): ChannelValidationResult;
  /** Whether the channel-level enable toggle is on. */
  isEnabled(): boolean;
  /** Best-effort delivery used by the engine; never throws. */
  deliver(notification: Notification): Promise<void>;
  /** Attempt delivery and report the outcome; ignores the enable flag. */
  send(notification: Notification): Promise<ChannelDeliveryResult>;
}
