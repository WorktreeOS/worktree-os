import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildManagementSnapshot,
  globalConfigPath,
  loadGlobalConfig,
  saveGlobalConfig,
  writeNotificationsConfig,
} from "@worktreeos/core/global-config";
import {
  defaultNotificationsConfig,
  REDACTED_SECRET,
} from "@worktreeos/core/notifications";

let tmpHome: string;
let warnings: string[];
const env = () => ({ WOS_HOME: tmpHome }) as NodeJS.ProcessEnv;
const warn = (s: string) => {
  warnings.push(s);
};

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "wos-notif-cfg-"));
  warnings = [];
});

afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true });
});

describe("notifications config", () => {
  test("defaults when notifications block is absent", async () => {
    await writeFile(globalConfigPath(env()), JSON.stringify({ web: { port: 5000 } }));
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.notifications).toEqual(defaultNotificationsConfig());
    expect(cfg.notifications.rules["agent.done"]?.enabled).toBe(false);
    expect(cfg.notifications.channels.telegram.enabled).toBe(false);
    expect(warnings).toEqual([]);
  });

  test("merges a valid notifications block over defaults", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        notifications: {
          rules: {
            "agent.done": { enabled: true, channels: { telegram: true, webpush: false } },
          },
          channels: {
            telegram: { enabled: true, botToken: "secret-token", chatId: "123" },
            webpush: { enabled: true },
          },
          pushSubscriptions: [
            { endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } },
          ],
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.notifications.rules["agent.done"]).toEqual({
      enabled: true,
      channels: { telegram: true, webpush: false },
    });
    // Unspecified known kind keeps its disabled default.
    expect(cfg.notifications.rules["agent.question"]?.enabled).toBe(false);
    expect(cfg.notifications.channels.telegram).toEqual({
      enabled: true,
      botToken: "secret-token",
      chatId: "123",
      mode: "when-away",
    });
    expect(cfg.notifications.channels.webpush.enabled).toBe(true);
    expect(cfg.notifications.pushSubscriptions).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  test("falls back with a warning on an invalid value", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        notifications: { channels: { telegram: { enabled: "yes" } } },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.notifications.channels.telegram.enabled).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(globalConfigPath(env()));
    expect(warnings[0]).toContain("notifications.channels.telegram.enabled");
    expect(warnings[0]).toContain('"yes"');
  });

  test("telegram mode defaults to when-away when absent", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        notifications: { channels: { telegram: { enabled: true } } },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.notifications.channels.telegram.mode).toBe("when-away");
    expect(warnings).toEqual([]);
  });

  test("telegram mode 'always' merges over the default", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        notifications: { channels: { telegram: { mode: "always" } } },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.notifications.channels.telegram.mode).toBe("always");
    expect(warnings).toEqual([]);
  });

  test("an invalid telegram mode falls back to when-away with a warning", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        notifications: { channels: { telegram: { mode: "sometimes" } } },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.notifications.channels.telegram.mode).toBe("when-away");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(globalConfigPath(env()));
    expect(warnings[0]).toContain("notifications.channels.telegram.mode");
    expect(warnings[0]).toContain('"sometimes"');
  });

  test("telegram mode round-trips on save", async () => {
    const next = defaultNotificationsConfig();
    next.channels.telegram = {
      enabled: true,
      botToken: "tok",
      chatId: "42",
      mode: "always",
    };
    await writeNotificationsConfig(next, { env: env() });

    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.notifications.channels.telegram.mode).toBe("always");
  });

  test("preserves an unknown rule kind without failing", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        notifications: {
          rules: {
            "deploy.failed": { enabled: true, channels: { telegram: true, webpush: false } },
          },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.notifications.rules["deploy.failed"]).toEqual({
      enabled: true,
      channels: { telegram: true, webpush: false },
    });
    // Known kinds still present alongside the unknown one.
    expect(cfg.notifications.rules["agent.done"]).toBeDefined();
    expect(warnings).toEqual([]);
  });

  test("writeNotificationsConfig persists in-place and preserves other keys", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ web: { port: 5000 }, customKey: { keep: true } }),
    );
    const next = defaultNotificationsConfig();
    next.channels.telegram = { enabled: true, botToken: "tok", chatId: "42", mode: "when-away" };
    await writeNotificationsConfig(next, { env: env() });

    const raw = JSON.parse(await readFile(globalConfigPath(env()), "utf8"));
    expect(raw.web.port).toBe(5000);
    expect(raw.customKey).toEqual({ keep: true });
    expect(raw.notifications.channels.telegram.botToken).toBe("tok");

    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.web.port).toBe(5000);
    expect(cfg.notifications.channels.telegram.chatId).toBe("42");
  });

  test("generic save preserves a previously written notifications block", async () => {
    const next = defaultNotificationsConfig();
    next.channels.telegram = { enabled: true, botToken: "tok", chatId: "42", mode: "when-away" };
    await writeNotificationsConfig(next, { env: env() });

    const result = await saveGlobalConfig({ web: { port: 6000 } }, { env: env() });
    expect(result.ok).toBe(true);

    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.web.port).toBe(6000);
    expect(cfg.notifications.channels.telegram.botToken).toBe("tok");
  });

  test("management snapshot redacts the telegram token", async () => {
    const next = defaultNotificationsConfig();
    next.channels.telegram = { enabled: true, botToken: "tok", chatId: "42", mode: "when-away" };
    await writeNotificationsConfig(next, { env: env() });

    const snapshot = await buildManagementSnapshot({ env: env() });
    expect(snapshot.raw?.notifications?.channels.telegram.botToken).toBe(REDACTED_SECRET);
    expect(snapshot.raw?.notifications?.channels.telegram.chatId).toBe("42");
    // Effective config keeps the real token for the engine.
    expect(snapshot.effective.notifications.channels.telegram.botToken).toBe("tok");
  });
});
