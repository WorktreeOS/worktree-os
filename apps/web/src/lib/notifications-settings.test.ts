import { test, expect, describe } from "bun:test";
import {
  ruleOf,
  ruleUpdate,
  telegramConfigured,
  telegramUpdate,
} from "./notifications-settings";
import type { NotificationsConfigView } from "./ui-api";

function config(over: Partial<NotificationsConfigView> = {}): NotificationsConfigView {
  return {
    rules: {
      "agent.done": { enabled: false, channels: { telegram: false, webpush: false } },
      "agent.question": { enabled: true, channels: { telegram: true, webpush: false } },
    },
    channels: {
      telegram: { enabled: false, botToken: "", chatId: "", mode: "when-away" },
      webpush: { enabled: false },
    },
    pushSubscriptions: [],
    ...over,
  };
}

describe("ruleOf", () => {
  test("returns the rule or a disabled default", () => {
    const cfg = config();
    expect(ruleOf(cfg, "agent.question").enabled).toBe(true);
    expect(ruleOf(cfg, "unknown.kind")).toEqual({
      enabled: false,
      channels: { telegram: false, webpush: false },
    });
  });
});

describe("ruleUpdate", () => {
  test("changes one field, preserving the rest of the rule", () => {
    const cfg = config();
    const update = ruleUpdate(cfg, "agent.question", { webpush: true });
    expect(update.rules?.["agent.question"]).toEqual({
      enabled: true,
      channels: { telegram: true, webpush: true },
    });
  });

  test("toggling enabled keeps channel routing", () => {
    const cfg = config();
    const update = ruleUpdate(cfg, "agent.question", { enabled: false });
    expect(update.rules?.["agent.question"]).toEqual({
      enabled: false,
      channels: { telegram: true, webpush: false },
    });
  });
});

describe("telegram helpers", () => {
  test("telegramUpdate nests under channels", () => {
    expect(telegramUpdate({ enabled: true, chatId: "5" })).toEqual({
      channels: { telegram: { enabled: true, chatId: "5" } },
    });
  });

  test("telegramConfigured requires token and chat id", () => {
    expect(telegramConfigured(config())).toBe(false);
    expect(
      telegramConfigured(
        config({
          channels: {
            telegram: {
              enabled: true,
              botToken: "t",
              chatId: "c",
              mode: "when-away",
            },
            webpush: { enabled: false },
          },
        }),
      ),
    ).toBe(true);
  });
});
