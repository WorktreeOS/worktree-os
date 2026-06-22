import { test, expect, describe } from "bun:test";
import {
  TelegramChannel,
  renderTelegramMessage,
} from "@worktreeos/daemon/notifications/channels/telegram";
import {
  defaultNotificationsConfig,
  type Notification,
} from "@worktreeos/core/notifications";

const notification: Notification = {
  kind: "agent.done",
  title: "Agent finished · feature-x",
  body: "The agent finished its turn.",
  severity: "info",
  link: "/worktree?path=%2Fwt%2Ffeature-x",
  dedupeKey: "agent.done:sess-1:t",
};

function configWith(telegram: {
  enabled: boolean;
  botToken: string;
  chatId: string;
  mode?: "always" | "when-away";
}) {
  const cfg = defaultNotificationsConfig();
  cfg.channels.telegram = { mode: "when-away", ...telegram };
  return cfg;
}

describe("TelegramChannel", () => {
  test("renders title + body", () => {
    expect(renderTelegramMessage(notification)).toBe(
      "Agent finished · feature-x\nThe agent finished its turn.",
    );
  });

  test("validateConfig requires token and chat id", () => {
    const channel = new TelegramChannel();
    channel.updateConfig(configWith({ enabled: true, botToken: "", chatId: "" }));
    expect(channel.validateConfig().ok).toBe(false);
    channel.updateConfig(configWith({ enabled: true, botToken: "t", chatId: "" }));
    expect(channel.validateConfig().ok).toBe(false);
    channel.updateConfig(configWith({ enabled: true, botToken: "t", chatId: "c" }));
    expect(channel.validateConfig().ok).toBe(true);
  });

  test("isEnabled reflects the channel toggle", () => {
    const channel = new TelegramChannel();
    channel.updateConfig(configWith({ enabled: false, botToken: "t", chatId: "c" }));
    expect(channel.isEnabled()).toBe(false);
    channel.updateConfig(configWith({ enabled: true, botToken: "t", chatId: "c" }));
    expect(channel.isEnabled()).toBe(true);
  });

  test("send posts to the bot sendMessage endpoint", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const channel = new TelegramChannel({ fetch: fakeFetch });
    channel.updateConfig(
      configWith({ enabled: true, botToken: "BOT:123", chatId: "42" }),
    );
    const result = await channel.send(notification);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/botBOT:123/sendMessage");
    expect((calls[0]?.body as { chat_id: string }).chat_id).toBe("42");
    expect((calls[0]?.body as { text: string }).text).toContain("Agent finished");
  });

  test("send reports a non-2xx response as a failure", async () => {
    const fakeFetch = (async () =>
      new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const channel = new TelegramChannel({ fetch: fakeFetch });
    channel.updateConfig(
      configWith({ enabled: true, botToken: "t", chatId: "c" }),
    );
    const result = await channel.send(notification);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("401");
  });

  test("deliver never throws on a network error", async () => {
    const fakeFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const channel = new TelegramChannel({ fetch: fakeFetch });
    channel.updateConfig(
      configWith({ enabled: true, botToken: "t", chatId: "c" }),
    );
    await channel.deliver(notification); // must resolve, not reject
    expect(true).toBe(true);
  });
});
