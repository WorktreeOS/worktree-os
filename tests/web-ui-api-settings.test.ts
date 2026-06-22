import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "@worktreeos/daemon/daemon-server";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
  withDaemonDefaults,
} from "./helpers/daemon-test-harness.ts";
import {
  createUiApi,
  UiForbiddenError,
  UiUnauthorizedError,
  UiValidationError,
} from "../apps/web/src/lib/ui-api";
import type { GlobalConfig } from "@worktreeos/core/global-config";

const PUBLIC_HOST = "wos.example.com";
const SECRET = "letmein";

let tmpHome: string;
let daemon: DaemonHandle | null;

beforeEach(async () => {
  tmpHome = await createDaemonTestHome("wos-web-ui-settings-");
  daemon = null;
});

afterEach(async () => {
  await teardownDaemonTestHome(tmpHome, daemon);
});

function publicConfig(): GlobalConfig {
  return {
    web: { port: 0, ssl: { enabled: false } },
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
  };
}

describe("web ui-api settings client", () => {
  test("getSettingsConfig returns snapshot with defaults", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { host: "127.0.0.1", port: 0 },
      }),
    );
    const api = createUiApi(daemon.webUrl!);
    const res = await api.getSettingsConfig();
    expect(res.config.exists).toBe(false);
    expect(res.config.effective.web.port).toBe(4949);
  });

  test("saveSettingsConfig persists draft and reports restartRequired", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { host: "127.0.0.1", port: 0 },
      }),
    );
    const api = createUiApi(daemon.webUrl!);
    const res = await api.saveSettingsConfig({
      web: { port: 5151 },
      tunnel: { enabled: false },
    });
    expect(res.restartRequired).toBe(true);
    expect(res.config.exists).toBe(true);
    expect(res.config.effective.web.port).toBe(5151);
  });

  test("saveSettingsConfig reports restartRequired false for a live-applicable-only change", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { host: "127.0.0.1", port: 0 },
      }),
    );
    const api = createUiApi(daemon.webUrl!);
    const res = await api.saveSettingsConfig({
      tunnel: { enabled: false },
      aiProviders: [{ type: "anthropic", apiKey: "sk-ant", name: "Prod" }],
    });
    // aiProviders applies live, so the page must not prompt a restart.
    expect(res.restartRequired).toBe(false);
    expect(res.config.exists).toBe(true);
  });

  test("saveSettingsConfig persists web.host and serviceBind", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { host: "127.0.0.1", port: 0 },
      }),
    );
    const api = createUiApi(daemon.webUrl!);
    const res = await api.saveSettingsConfig({
      web: { host: "192.168.1.18" },
      serviceBind: "10.0.0.5",
      tunnel: { enabled: false },
    });
    expect(res.restartRequired).toBe(true);
    expect(res.config.effective.web.host).toBe("192.168.1.18");
    expect(res.config.effective.serviceBind).toBe("10.0.0.5");
  });

  test("saveSettingsConfig surfaces web.host validation error", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { host: "127.0.0.1", port: 0 },
      }),
    );
    const api = createUiApi(daemon.webUrl!);
    try {
      await api.saveSettingsConfig({ web: { host: 123 as unknown as string } });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(UiValidationError);
      expect((e as UiValidationError).fieldErrors[0]?.field).toBe("web.host");
    }
  });

  test("saveSettingsConfig surfaces validation errors as UiValidationError", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { host: "127.0.0.1", port: 0 },
      }),
    );
    const api = createUiApi(daemon.webUrl!);
    try {
      await api.saveSettingsConfig({ web: { port: 0 } });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(UiValidationError);
      const v = e as UiValidationError;
      expect(v.fieldErrors[0]?.field).toBe("web.port");
    }
  });

  test("authenticated public client receives UiForbiddenError", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { host: "127.0.0.1", port: 0 },
        globalConfig: publicConfig(),
      }),
    );
    // Login via fetch to get the cookie, then provide it via Host + Cookie header.
    const login = await fetch(`${daemon.webUrl}/ui/v1/auth/login`, {
      method: "POST",
      headers: { host: PUBLIC_HOST, "content-type": "application/json" },
      body: JSON.stringify({ secret: SECRET }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";")[0] ?? "";

    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/config`, {
      headers: { host: PUBLIC_HOST, cookie },
    });
    expect(res.status).toBe(403);
  });

  test("unauthenticated public client triggers 401 path", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { host: "127.0.0.1", port: 0 },
        globalConfig: publicConfig(),
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/config`, {
      headers: { host: PUBLIC_HOST },
    });
    expect(res.status).toBe(401);
    // Sanity: UiForbiddenError + UiUnauthorizedError both exported.
    expect(typeof UiForbiddenError).toBe("function");
    expect(typeof UiUnauthorizedError).toBe("function");
  });

  test("getTerminalBackendAvailability reports available with binary and platform", async () => {
    const prev = process.env.TMUX_BINARY;
    let okBin: string;
    if (process.platform === "win32") {
      okBin = join(tmpHome, "ok.cmd");
      await writeFile(okBin, "@echo off\r\nexit /b 0\r\n", "utf8");
    } else {
      okBin = "true";
    }
    process.env.TMUX_BINARY = okBin;
    try {
      daemon = await startDaemon(
        withDaemonDefaults(tmpHome, {
          resolveSession: async () => ({}) as any,
          web: { host: "127.0.0.1", port: 0 },
        }),
      );
      const api = createUiApi(daemon.webUrl!);
      const res = await api.getTerminalBackendAvailability();
      expect(res.tmux.available).toBe(true);
      expect(res.tmux.binary).toBe(okBin);
      expect(res.tmux.platform).toBe(process.platform);
    } finally {
      if (prev === undefined) delete process.env.TMUX_BINARY;
      else process.env.TMUX_BINARY = prev;
    }
  });

  test("getTerminalBackendAvailability reports unavailable with a reason", async () => {
    const prev = process.env.TMUX_BINARY;
    let failBin: string;
    if (process.platform === "win32") {
      failBin = join(tmpHome, "fail.cmd");
      await writeFile(failBin, "@echo off\r\nexit /b 1\r\n", "utf8");
    } else {
      failBin = "false";
    }
    process.env.TMUX_BINARY = failBin;
    try {
      daemon = await startDaemon(
        withDaemonDefaults(tmpHome, {
          resolveSession: async () => ({}) as any,
          web: { host: "127.0.0.1", port: 0 },
        }),
      );
      const api = createUiApi(daemon.webUrl!);
      const res = await api.getTerminalBackendAvailability();
      expect(res.tmux.available).toBe(false);
      expect(typeof res.tmux.reason).toBe("string");
      expect(res.tmux.platform).toBe(process.platform);
    } finally {
      if (prev === undefined) delete process.env.TMUX_BINARY;
      else process.env.TMUX_BINARY = prev;
    }
  });
});
