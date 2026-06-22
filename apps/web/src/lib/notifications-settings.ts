// Pure view-logic for the Settings → Notifications page, extracted so the
// per-event row transforms are unit-testable without the DOM.

import type {
  NotificationKindId,
  NotificationRuleView,
  NotificationsConfigView,
  NotificationsUpdateInput,
  TelegramDeliveryMode,
} from "./ui-api";

export interface NotificationKindRow {
  kind: NotificationKindId;
  label: string;
  /** Default loop cap shown when no per-device override exists. */
  description: string;
}

export const NOTIFICATION_KIND_ROWS: readonly NotificationKindRow[] = [
  {
    kind: "agent.done",
    label: "Agent finished",
    description: "An agent completed its turn.",
  },
  {
    kind: "agent.question",
    label: "Agent needs input",
    description: "An agent is blocked awaiting your answer.",
  },
];

/** The rule for a kind, defaulting to fully-disabled. */
export function ruleOf(
  config: NotificationsConfigView,
  kind: string,
): NotificationRuleView {
  return (
    config.rules[kind] ?? {
      enabled: false,
      channels: { telegram: false, webpush: false },
    }
  );
}

export interface RulePatch {
  enabled?: boolean;
  telegram?: boolean;
  webpush?: boolean;
}

/**
 * Build a save payload that changes one kind's rule, preserving the fields the
 * patch leaves out.
 */
export function ruleUpdate(
  config: NotificationsConfigView,
  kind: string,
  patch: RulePatch,
): NotificationsUpdateInput {
  const current = ruleOf(config, kind);
  const next: NotificationRuleView = {
    enabled: patch.enabled ?? current.enabled,
    channels: {
      telegram: patch.telegram ?? current.channels.telegram,
      webpush: patch.webpush ?? current.channels.webpush,
    },
  };
  return { rules: { [kind]: next } };
}

/** Build a save payload for the Telegram connect block. */
export function telegramUpdate(patch: {
  enabled?: boolean;
  botToken?: string;
  chatId?: string;
  mode?: TelegramDeliveryMode;
}): NotificationsUpdateInput {
  return { channels: { telegram: patch } };
}

/** Whether the Telegram channel has both credentials present (token redacted). */
export function telegramConfigured(config: NotificationsConfigView): boolean {
  return (
    config.channels.telegram.botToken.length > 0 &&
    config.channels.telegram.chatId.length > 0
  );
}
