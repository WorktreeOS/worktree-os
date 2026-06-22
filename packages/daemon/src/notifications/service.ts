import { writeNotificationsConfig } from "@worktreeos/core/global-config";
import {
  redactNotificationsConfig,
  REDACTED_SECRET,
  type Notification,
  type NotificationKind,
  type NotificationRule,
  type NotificationsConfig,
  type TelegramDeliveryMode,
} from "@worktreeos/core/notifications";
import { PresenceRegistry, type PresenceState } from "./presence";
import type { DaemonEventBus } from "../event-bus";
import { TelegramChannel } from "./channels/telegram";
import type { NotificationChannel } from "./channels/types";
import { WebPushChannel } from "./channels/webpush";
import type { VapidKeys } from "./channels/webpush-crypto";
import { NotificationEngine } from "./engine";
import { parsePushSubscriptionInput, upsertSubscription } from "./subscriptions";

const VAPID_SUBJECT = "mailto:notifications@worktreeos.local";

/** A partial update to the daemon-backed notification settings. */
export interface NotificationsUpdate {
  /** Per-kind rules to replace (merged by kind over the current set). */
  rules?: Record<string, NotificationRule>;
  channels?: {
    telegram?: {
      enabled?: boolean;
      botToken?: string;
      chatId?: string;
      mode?: TelegramDeliveryMode;
    };
    webpush?: { enabled?: boolean };
  };
}

/**
 * Merge a settings update over the current config. The Telegram bot token is
 * preserved when the incoming value is the redaction placeholder (the UI never
 * sees the real token), replaced when a new value is supplied, and cleared on an
 * empty string. Push subscriptions are untouched (managed via their endpoint).
 */
export function applyNotificationsUpdate(
  current: NotificationsConfig,
  update: NotificationsUpdate,
): NotificationsConfig {
  const next: NotificationsConfig = {
    rules: { ...current.rules },
    channels: {
      telegram: { ...current.channels.telegram },
      webpush: { ...current.channels.webpush },
    },
    pushSubscriptions: current.pushSubscriptions,
  };

  if (update.rules) {
    for (const [kind, rule] of Object.entries(update.rules)) {
      next.rules[kind] = {
        enabled: rule.enabled,
        channels: {
          telegram: rule.channels?.telegram ?? false,
          webpush: rule.channels?.webpush ?? false,
        },
      };
    }
  }
  const tg = update.channels?.telegram;
  if (tg) {
    if (typeof tg.enabled === "boolean") next.channels.telegram.enabled = tg.enabled;
    if (typeof tg.chatId === "string") next.channels.telegram.chatId = tg.chatId;
    if (typeof tg.botToken === "string" && tg.botToken !== REDACTED_SECRET) {
      next.channels.telegram.botToken = tg.botToken;
    }
    if (tg.mode === "always" || tg.mode === "when-away") {
      next.channels.telegram.mode = tg.mode;
    }
  }
  const wp = update.channels?.webpush;
  if (wp && typeof wp.enabled === "boolean") {
    next.channels.webpush.enabled = wp.enabled;
  }
  return next;
}

/** A synthetic notification used by the test-send endpoint. */
export function buildTestNotification(kind: NotificationKind): Notification {
  const isQuestion = kind === "agent.question";
  return {
    kind,
    title: "WorktreeOS test notification",
    body: isQuestion
      ? "This is a test of the agent-question alert."
      : "This is a test of the agent-done alert.",
    severity: isQuestion ? "needs-attention" : "info",
    link: "/",
    dedupeKey: `test:${kind}`,
  };
}

export interface NotificationServiceDeps {
  bus: DaemonEventBus;
  config: NotificationsConfig;
  vapid: VapidKeys;
  /** Environment for config persistence (tests). */
  env?: NodeJS.ProcessEnv;
  /** Override the Telegram channel (tests). */
  telegram?: NotificationChannel;
  /** Override the Web Push channel (tests). */
  webpush?: NotificationChannel;
  /** Injectable clock for presence expiry (tests). */
  now?: () => number;
}

/**
 * Owns the notification engine, channels, VAPID keys, and config persistence.
 * Constructed once during daemon bootstrap and handed to the UI API so config
 * changes apply to the live engine without a restart.
 */
export class NotificationService {
  private config: NotificationsConfig;
  private readonly bus: DaemonEventBus;
  private readonly vapid: VapidKeys;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly channels: NotificationChannel[];
  private readonly engine: NotificationEngine;
  /** Focused browser clients; gates engine delivery on real user presence. */
  private readonly presence = new PresenceRegistry();
  private readonly now: () => number;

  constructor(deps: NotificationServiceDeps) {
    this.bus = deps.bus;
    this.config = deps.config;
    this.vapid = deps.vapid;
    this.env = deps.env;
    this.now = deps.now ?? (() => Date.now());

    const telegram = deps.telegram ?? new TelegramChannel();
    const webpush =
      deps.webpush ??
      new WebPushChannel({
        vapid: deps.vapid,
        subject: VAPID_SUBJECT,
        onSubscriptionGone: (endpoint) => {
          void this.pruneSubscription(endpoint);
        },
      });
    this.channels = [telegram, webpush];
    this.engine = new NotificationEngine({
      bus: deps.bus,
      channels: this.channels,
      config: this.config,
      hasFocusedClient: () => this.presence.hasFocusedClient(this.now()),
    });
  }

  /** Record a browser client's reported focus state. */
  touchPresence(clientId: string, state: PresenceState): void {
    this.presence.touch(clientId, state, this.now());
  }

  start(): void {
    this.engine.start();
  }

  stop(): void {
    this.engine.stop();
  }

  vapidPublicKey(): string {
    return this.vapid.publicKey;
  }

  /** Redacted config snapshot for the UI. */
  getRedactedConfig(): NotificationsConfig {
    return redactNotificationsConfig(this.config);
  }

  /** Apply + persist a settings update; returns the redacted result. */
  async updateSettings(update: NotificationsUpdate): Promise<NotificationsConfig> {
    this.config = applyNotificationsUpdate(this.config, update);
    await this.persist();
    this.engine.updateConfig(this.config);
    return redactNotificationsConfig(this.config);
  }

  /** Register a browser push subscription. */
  async registerSubscription(
    input: unknown,
  ): Promise<{ ok: boolean; error?: string }> {
    const sub = parsePushSubscriptionInput(input);
    if (!sub) return { ok: false, error: "invalid push subscription" };
    this.config = {
      ...this.config,
      pushSubscriptions: upsertSubscription(this.config.pushSubscriptions, sub),
    };
    await this.persist();
    this.engine.updateConfig(this.config);
    return { ok: true };
  }

  /** Send a test notification through a single channel. */
  async sendTest(
    channelId: string,
    kind: NotificationKind = "agent.question",
  ): Promise<{ ok: boolean; error?: string }> {
    const channel = this.channels.find((c) => c.id === channelId);
    if (!channel) return { ok: false, error: `unknown channel: ${channelId}` };
    const valid = channel.validateConfig();
    if (!valid.ok) return { ok: false, error: valid.error };
    return channel.send(buildTestNotification(kind));
  }

  private async pruneSubscription(endpoint: string): Promise<void> {
    this.config = {
      ...this.config,
      pushSubscriptions: this.config.pushSubscriptions.filter(
        (s) => s.endpoint !== endpoint,
      ),
    };
    try {
      await this.persist();
    } catch {
      // Best-effort prune: a persistence error must not break delivery.
    }
    this.engine.updateConfig(this.config);
  }

  private async persist(): Promise<void> {
    await writeNotificationsConfig(this.config, this.env ? { env: this.env } : {});
  }
}
