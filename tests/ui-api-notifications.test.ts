import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "@worktreeos/daemon/daemon-server";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
  withDaemonDefaults,
} from "./helpers/daemon-test-harness.ts";
import { signAuthCookie, AUTH_COOKIE_NAME } from "@worktreeos/daemon/public-auth";
import { REDACTED_SECRET } from "@worktreeos/core/notifications";
import type { GlobalConfig } from "@worktreeos/core/global-config";

const PUBLIC_HOST = "wos.example.com";
const SECRET = "letmein";

function publicCookie(now = Date.now()): string {
  return `${AUTH_COOKIE_NAME}=${signAuthCookie(SECRET, now)}`;
}

function publicEnabledConfig(): GlobalConfig {
  return {
    web: { port: 0, host: "127.0.0.1", ssl: { enabled: false } },
    tunnel: {
      enabled: true,
      port: 5858,
      domain: "example.com",
      ssl: { enabled: false },
      webUi: {
        enabled: true,
        hostname: PUBLIC_HOST,
        secret: SECRET,
        terminalEnabled: false,
        whitelistIps: [],
      },
      serviceTunnels: { enabled: false, whitelistIps: [] },
    },
    healthcheck: {},
    terminalBackend: "default",
    aiProviders: [],
  } as unknown as GlobalConfig;
}

async function configJson(home: string): Promise<any> {
  const text = await readFile(join(home, "config.json"), "utf8");
  return JSON.parse(text);
}

describe("notifications UI API — local access", () => {
  let tmpHome: string;
  let daemon: DaemonHandle;

  beforeEach(async () => {
    tmpHome = await createDaemonTestHome("wos-ui-notif-");
  });

  afterEach(async () => {
    await teardownDaemonTestHome(tmpHome, daemon);
  });

  async function start() {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
  }

  test("GET returns disabled defaults and a VAPID public key", async () => {
    await start();
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/notifications`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      config: { rules: Record<string, { enabled: boolean }> };
      vapidPublicKey: string;
    };
    expect(body.config.rules["agent.done"]?.enabled).toBe(false);
    expect(typeof body.vapidPublicKey).toBe("string");
    expect(body.vapidPublicKey.length).toBeGreaterThan(0);
  });

  test("PUT persists rules + telegram config, redacting the token in responses", async () => {
    await start();
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/notifications`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rules: {
          "agent.done": { enabled: true, channels: { telegram: true, webpush: false } },
        },
        channels: {
          telegram: { enabled: true, botToken: "BOT:secret", chatId: "42" },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      config: {
        rules: Record<string, { enabled: boolean }>;
        channels: { telegram: { botToken: string; chatId: string } };
      };
    };
    expect(body.config.rules["agent.done"]?.enabled).toBe(true);
    // Secret is redacted in the response.
    expect(body.config.channels.telegram.botToken).toBe(REDACTED_SECRET);
    expect(body.config.channels.telegram.chatId).toBe("42");

    // Real token is persisted to disk.
    const persisted = await configJson(tmpHome);
    expect(persisted.notifications.channels.telegram.botToken).toBe("BOT:secret");

    // A subsequent GET keeps the secret redacted.
    const get = await fetch(`${daemon.webUrl}/ui/v1/settings/notifications`);
    const getBody = (await get.json()) as {
      config: { channels: { telegram: { botToken: string } } };
    };
    expect(getBody.config.channels.telegram.botToken).toBe(REDACTED_SECRET);
  });

  test("PUT with the redaction placeholder keeps the stored token", async () => {
    await start();
    await fetch(`${daemon.webUrl}/ui/v1/settings/notifications`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channels: { telegram: { enabled: true, botToken: "BOT:secret", chatId: "42" } },
      }),
    });
    // Re-save with the placeholder (as the UI would, having only the redacted value).
    await fetch(`${daemon.webUrl}/ui/v1/settings/notifications`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channels: { telegram: { enabled: true, botToken: REDACTED_SECRET, chatId: "99" } },
      }),
    });
    const persisted = await configJson(tmpHome);
    expect(persisted.notifications.channels.telegram.botToken).toBe("BOT:secret");
    expect(persisted.notifications.channels.telegram.chatId).toBe("99");
  });

  test("subscribe stores a push subscription, rejects malformed input", async () => {
    await start();
    const ok = await fetch(`${daemon.webUrl}/ui/v1/settings/notifications/subscribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: "https://push.example/sub-1",
        keys: { p256dh: "pkey", auth: "akey" },
      }),
    });
    expect(ok.status).toBe(200);
    const persisted = await configJson(tmpHome);
    expect(persisted.notifications.pushSubscriptions).toHaveLength(1);
    expect(persisted.notifications.pushSubscriptions[0].endpoint).toBe(
      "https://push.example/sub-1",
    );

    const bad = await fetch(`${daemon.webUrl}/ui/v1/settings/notifications/subscribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "x" }),
    });
    expect(bad.status).toBe(400);
  });

  test("test-send reports a failure for an unconfigured channel", async () => {
    await start();
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/notifications/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "telegram" }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBeDefined();
  });

  test("test-send requires a channel name", async () => {
    await start();
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/notifications/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("presence accepts focused and away, rejects malformed bodies", async () => {
    await start();
    const focused = await fetch(`${daemon.webUrl}/ui/v1/presence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: "c1", state: "focused" }),
    });
    expect(focused.status).toBe(204);

    const away = await fetch(`${daemon.webUrl}/ui/v1/presence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: "c1", state: "away" }),
    });
    expect(away.status).toBe(204);

    const missingClient = await fetch(`${daemon.webUrl}/ui/v1/presence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "focused" }),
    });
    expect(missingClient.status).toBe(400);

    const badState = await fetch(`${daemon.webUrl}/ui/v1/presence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: "c1", state: "elsewhere" }),
    });
    expect(badState.status).toBe(400);
  });
});

describe("notifications UI API — public access", () => {
  let tmpHome: string;
  let daemon: DaemonHandle;

  beforeEach(async () => {
    tmpHome = await createDaemonTestHome("wos-ui-notif-public-");
  });

  afterEach(async () => {
    await teardownDaemonTestHome(tmpHome, daemon);
  });

  test("authenticated public-host GET returns 403 forbidden", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        globalConfig: publicEnabledConfig(),
        web: { port: 0 },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/notifications`, {
      headers: { host: PUBLIC_HOST, cookie: publicCookie() },
    });
    expect(res.status).toBe(403);
  });
});
