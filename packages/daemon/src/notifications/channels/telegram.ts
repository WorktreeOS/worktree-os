import type {
  Notification,
  NotificationsConfig,
  TelegramChannelConfig,
} from "@worktreeos/core/notifications";
import type {
  ChannelDeliveryResult,
  ChannelValidationResult,
  NotificationChannel,
} from "./types";

const TELEGRAM_API_BASE = "https://api.telegram.org";

/** Render the plain-text Telegram message body from a notification. */
export function renderTelegramMessage(notification: Notification): string {
  return `${notification.title}\n${notification.body}`;
}

export interface TelegramChannelDeps {
  /** Override fetch (tests). */
  fetch?: typeof fetch;
  /** Override the Telegram API base URL (tests). */
  apiBase?: string;
}

/**
 * Telegram channel. Delivers a notification by calling the Telegram Bot API
 * `sendMessage`. Deliverable only when both a non-empty bot token and chat id
 * are configured.
 */
export class TelegramChannel implements NotificationChannel {
  readonly id = "telegram";
  private config: TelegramChannelConfig = {
    enabled: false,
    botToken: "",
    chatId: "",
    mode: "when-away",
  };
  private readonly doFetch: typeof fetch;
  private readonly apiBase: string;

  constructor(deps: TelegramChannelDeps = {}) {
    this.doFetch = deps.fetch ?? fetch;
    this.apiBase = deps.apiBase ?? TELEGRAM_API_BASE;
  }

  updateConfig(config: NotificationsConfig): void {
    this.config = config.channels.telegram;
  }

  validateConfig(): ChannelValidationResult {
    if (!this.config.botToken) {
      return { ok: false, error: "Telegram bot token is required" };
    }
    if (!this.config.chatId) {
      return { ok: false, error: "Telegram chat id is required" };
    }
    return { ok: true };
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  async deliver(notification: Notification): Promise<void> {
    await this.send(notification);
  }

  async send(notification: Notification): Promise<ChannelDeliveryResult> {
    const valid = this.validateConfig();
    if (!valid.ok) return { ok: false, error: valid.error };
    const url = `${this.apiBase}/bot${this.config.botToken}/sendMessage`;
    try {
      const res = await this.doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: this.config.chatId,
          text: renderTelegramMessage(notification),
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        return { ok: false, error: `Telegram API returned ${res.status}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
