import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "@worktreeos/daemon/daemon-server";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
  withDaemonDefaults,
} from "./helpers/daemon-test-harness.ts";
import { signAuthCookie, AUTH_COOKIE_NAME } from "@worktreeos/daemon/public-auth";
import type { GlobalConfig } from "@worktreeos/core/global-config";

const PUBLIC_HOST = "wos.example.com";
const SECRET = "letmein";

function publicCookie(now = Date.now()): string {
  return `${AUTH_COOKIE_NAME}=${signAuthCookie(SECRET, now)}`;
}

function publicEnabledConfig(terminalEnabled = false): GlobalConfig {
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
        terminalEnabled,
        whitelistIps: [],
      },
      serviceTunnels: { enabled: false, whitelistIps: [] },
    },
    healthcheck: {},
    terminalBackend: "default",
    aiProviders: [],
  };
}

async function configJson(home: string): Promise<unknown> {
  const text = await readFile(join(home, "config.json"), "utf8");
  return JSON.parse(text);
}

describe("settings UI API — local access", () => {
  let tmpHome: string;
  let daemon: DaemonHandle;

  beforeEach(async () => {
    tmpHome = await createDaemonTestHome("wos-ui-settings-local-");
  });

  afterEach(async () => {
    await teardownDaemonTestHome(tmpHome, daemon);
  });

  test("GET returns snapshot with effective defaults when file absent", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: { exists: boolean; effective: { web: { port: number } } } };
    expect(body.config.exists).toBe(false);
    expect(body.config.effective.web.port).toBe(4949);
  });

  test("PUT persists config and reports restartRequired", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        web: { port: 5050 },
        tunnel: { enabled: false },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      restartRequired: boolean;
      config: { effective: { web: { port: number } }; exists: boolean };
    };
    expect(body.restartRequired).toBe(true);
    expect(body.config.exists).toBe(true);
    expect(body.config.effective.web.port).toBe(5050);
    const persisted = await configJson(tmpHome);
    expect(persisted).toEqual({
      web: { port: 5050 },
      tunnel: { enabled: false },
    });
  });

  test("PUT persists web.host and serviceBind", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        web: { port: 4949, host: "192.168.1.18" },
        serviceBind: "10.0.0.5",
        tunnel: { enabled: false },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      config: { effective: { web: { host: string }; serviceBind?: string } };
    };
    expect(body.config.effective.web.host).toBe("192.168.1.18");
    expect(body.config.effective.serviceBind).toBe("10.0.0.5");
    const persisted = (await configJson(tmpHome)) as {
      web: { host: string };
      serviceBind: string;
    };
    expect(persisted.web.host).toBe("192.168.1.18");
    expect(persisted.serviceBind).toBe("10.0.0.5");
  });

  test("PUT rejects a non-string web.host with a field-aware error", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ web: { host: 123 } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: { field: string }[] };
    expect(body.errors[0]?.field).toBe("web.host");
  });

  test("GET snapshot includes effective SSL defaults", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      config: {
        effective: {
          web: { ssl: { enabled: boolean } };
          tunnel: { ssl: { enabled: boolean } };
        };
      };
    };
    expect(body.config.effective.web.ssl.enabled).toBe(false);
    expect(body.config.effective.tunnel.ssl.enabled).toBe(false);
  });

  test("GET includes effective SSL source and certificate status fields", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      config: {
        effectiveSsl: {
          web: { source: string };
          tunnel: { source: string };
        };
      };
      certificateStatus: Record<string, unknown>;
    };
    expect(body.config.effectiveSsl.web.source).toBe("disabled");
    expect(body.config.effectiveSsl.tunnel.source).toBe("disabled");
    expect(body.certificateStatus).toBeDefined();
  });

  test("PUT persists SSL settings and marks restartRequired", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        web: {
          ssl: { enabled: true, cert: "/etc/ssl/web.crt", key: "/etc/ssl/web.key" },
        },
        tunnel: { enabled: false, ssl: { enabled: true } },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      restartRequired: boolean;
      config: { raw: { web?: { ssl?: { enabled: boolean } } } };
    };
    expect(body.restartRequired).toBe(true);
    expect(body.config.raw.web?.ssl?.enabled).toBe(true);
    const persisted = (await configJson(tmpHome)) as {
      web: { ssl: { enabled: boolean; cert: string; key: string } };
      tunnel: { ssl: { enabled: boolean } };
    };
    expect(persisted.web.ssl).toEqual({
      enabled: true,
      cert: "/etc/ssl/web.crt",
      key: "/etc/ssl/web.key",
    });
    expect(persisted.tunnel.ssl).toEqual({ enabled: true });
  });

  test("PUT persists tunnel Let's Encrypt settings", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          ssl: {
            enabled: true,
            source: "letsencrypt",
            letsencrypt: {
              email: "me@example.com",
              acceptTerms: true,
              directory: "production",
              challenge: {
                type: "dns-01",
                provider: "hook",
                createCommand: "/bin/true",
                deleteCommand: "/bin/true",
                propagationSeconds: 30,
              },
            },
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const persisted = (await configJson(tmpHome)) as {
      tunnel: { ssl: { source: string; letsencrypt: { email: string; directory: string } } };
    };
    expect(persisted.tunnel.ssl.source).toBe("letsencrypt");
    expect(persisted.tunnel.ssl.letsencrypt.email).toBe("me@example.com");
    expect(persisted.tunnel.ssl.letsencrypt.directory).toBe("production");
  });

  test("PUT persists Cloudflare Let's Encrypt challenge", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          ssl: {
            enabled: true,
            source: "letsencrypt",
            letsencrypt: {
              email: "me@example.com",
              acceptTerms: true,
              directory: "staging",
              challenge: {
                type: "dns-01",
                provider: "cloudflare",
                apiTokenEnv: "CF_API_TOKEN",
                zoneId: "zone-abc",
                propagationSeconds: 30,
              },
            },
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const persisted = (await configJson(tmpHome)) as {
      tunnel: {
        ssl: {
          letsencrypt: {
            challenge: {
              provider: string;
              apiTokenEnv?: string;
              apiToken?: string;
              zoneId?: string;
            };
          };
        };
      };
    };
    const ch = persisted.tunnel.ssl.letsencrypt.challenge;
    expect(ch.provider).toBe("cloudflare");
    expect(ch.apiTokenEnv).toBe("CF_API_TOKEN");
    expect(ch.zoneId).toBe("zone-abc");
    // No hook fields written for Cloudflare provider.
    expect(JSON.stringify(persisted)).not.toContain("createCommand");
  });

  test("PUT rejects Cloudflare without token source", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          ssl: {
            enabled: true,
            source: "letsencrypt",
            letsencrypt: {
              email: "me@example.com",
              acceptTerms: true,
              challenge: { type: "dns-01", provider: "cloudflare" },
            },
          },
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: { field: string }[] };
    expect(
      body.errors.some(
        (e) => e.field === "tunnel.ssl.letsencrypt.challenge.apiTokenEnv",
      ),
    ).toBe(true);
  });

  test("PUT rejects Let's Encrypt without acceptTerms", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          ssl: {
            enabled: true,
            source: "letsencrypt",
            letsencrypt: {
              email: "me@example.com",
              acceptTerms: false,
              challenge: {
                type: "dns-01",
                provider: "hook",
                createCommand: "/bin/true",
                deleteCommand: "/bin/true",
              },
            },
          },
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: { field: string }[] };
    expect(
      body.errors.some(
        (e) => e.field === "tunnel.ssl.letsencrypt.acceptTerms",
      ),
    ).toBe(true);
  });

  test("PUT rejects invalid SSL settings with field error", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        web: { ssl: { enabled: true, cert: "/c.pem" } },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      errors: { field: string }[];
    };
    expect(body.error).toBe("validation");
    expect(body.errors.some((e) => e.field === "web.ssl.key")).toBe(true);
  });

  test("GET snapshot includes effective terminalBackend default", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      config: {
        effective: { terminalBackend: string };
        raw: { terminalBackend?: string } | null;
      };
    };
    expect(body.config.effective.terminalBackend).toBe("default");
    expect(body.config.raw).toBeNull();
  });

  test("PUT persists terminalBackend=\"tmux\" and snapshot reports it", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ terminalBackend: "tmux" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      restartRequired: boolean;
      config: {
        effective: { terminalBackend: string };
        raw: { terminalBackend?: string } | null;
      };
    };
    expect(body.restartRequired).toBe(true);
    expect(body.config.effective.terminalBackend).toBe("tmux");
    expect(body.config.raw?.terminalBackend).toBe("tmux");
    const persisted = (await configJson(tmpHome)) as { terminalBackend: string };
    expect(persisted.terminalBackend).toBe("tmux");
  });

  test("PUT rejects invalid terminalBackend with field error", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ terminalBackend: "screen" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      errors: { field: string }[];
    };
    expect(body.error).toBe("validation");
    expect(body.errors.some((e) => e.field === "terminalBackend")).toBe(true);
  });

  test("GET returns raw and effective aiProviders for a local client", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
    await writeFile(
      join(tmpHome, "config.json"),
      JSON.stringify({
        aiProviders: [
          { type: "openai", apiKey: "sk-local", models: ["gpt-4.1"] },
        ],
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      config: {
        raw: { aiProviders?: unknown };
        effective: { aiProviders: unknown };
      };
    };
    expect(body.config.raw.aiProviders).toEqual([
      { type: "openai", apiKey: "sk-local", models: ["gpt-4.1"] },
    ]);
    expect(body.config.effective.aiProviders).toEqual([
      { type: "openai", apiKey: "sk-local", models: ["gpt-4.1"] },
    ]);
  });

  test("PUT persists valid aiProviders without requiring restart", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tunnel: { enabled: false },
        aiProviders: [
          { type: "anthropic", apiKey: "sk-ant", name: "Prod" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      restartRequired: boolean;
      config: { effective: { aiProviders: unknown } };
    };
    // aiProviders is re-read fresh per request, so a change applies live.
    expect(body.restartRequired).toBe(false);
    expect(body.config.effective.aiProviders).toEqual([
      { type: "anthropic", apiKey: "sk-ant", name: "Prod" },
    ]);
    const persisted = (await configJson(tmpHome)) as {
      aiProviders: unknown;
    };
    expect(persisted.aiProviders).toEqual([
      { type: "anthropic", apiKey: "sk-ant", name: "Prod" },
    ]);
  });

  test("PUT rejects invalid aiProviders with provider-specific field paths and does not modify config", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
    await writeFile(
      join(tmpHome, "config.json"),
      JSON.stringify({ web: { port: 4949 } }),
    );
    const before = await readFile(join(tmpHome, "config.json"), "utf8");
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        aiProviders: [{ type: "openai", apiKey: "" }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      errors: { field: string; message: string }[];
    };
    expect(body.error).toBe("validation");
    expect(body.errors.map((e) => e.field)).toContain("aiProviders.0.apiKey");
    const after = await readFile(join(tmpHome, "config.json"), "utf8");
    expect(after).toBe(before);
  });

  test("PUT with invalid setting returns 400 and does not modify config", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
    await writeFile(
      join(tmpHome, "config.json"),
      JSON.stringify({ web: { port: 4949 } }),
    );
    const before = await readFile(join(tmpHome, "config.json"), "utf8");
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ web: { port: 0 } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      errors: { field: string; message: string }[];
    };
    expect(body.error).toBe("validation");
    expect(body.errors[0]?.field).toBe("web.port");
    const after = await readFile(join(tmpHome, "config.json"), "utf8");
    expect(after).toBe(before);
  });
});

describe("terminal backend availability UI API — local access", () => {
  let tmpHome: string;
  let daemon: DaemonHandle;
  let prevTmuxBinary: string | undefined;
  let okBin: string;
  let failBin: string;

  beforeEach(async () => {
    tmpHome = await createDaemonTestHome("wos-ui-term-avail-");
    prevTmuxBinary = process.env.TMUX_BINARY;
    // Cross-platform stand-ins for always-exit-0 / always-exit-1 binaries: the
    // endpoint probes whatever `TMUX_BINARY` resolves to. POSIX has `true` /
    // `false`; native Windows does not, so synthesize `.cmd` shims.
    if (process.platform === "win32") {
      okBin = join(tmpHome, "ok.cmd");
      failBin = join(tmpHome, "fail.cmd");
      await writeFile(okBin, "@echo off\r\nexit /b 0\r\n", "utf8");
      await writeFile(failBin, "@echo off\r\nexit /b 1\r\n", "utf8");
    } else {
      okBin = "true";
      failBin = "false";
    }
  });

  afterEach(async () => {
    if (prevTmuxBinary === undefined) delete process.env.TMUX_BINARY;
    else process.env.TMUX_BINARY = prevTmuxBinary;
    await teardownDaemonTestHome(tmpHome, daemon);
  });

  test("local GET reports available with the resolved binary and platform", async () => {
    process.env.TMUX_BINARY = okBin;
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
    const res = await fetch(
      `${daemon.webUrl}/ui/v1/settings/terminal-backend/availability`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tmux: { available: boolean; binary: string; platform: string; reason?: string };
    };
    expect(body.tmux.available).toBe(true);
    expect(body.tmux.binary).toBe(okBin);
    expect(body.tmux.platform).toBe(process.platform);
    expect(body.tmux.reason).toBeUndefined();
  });

  test("local GET reports unavailable with a reason and platform", async () => {
    process.env.TMUX_BINARY = failBin;
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
    const res = await fetch(
      `${daemon.webUrl}/ui/v1/settings/terminal-backend/availability`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tmux: { available: boolean; binary: string; platform: string; reason?: string };
    };
    expect(body.tmux.available).toBe(false);
    expect(typeof body.tmux.reason).toBe("string");
    expect(body.tmux.binary).toBe(failBin);
    expect(body.tmux.platform).toBe(process.platform);
  });

  test("probe runs fresh across two requests", async () => {
    process.env.TMUX_BINARY = failBin;
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
    const first = (await (
      await fetch(`${daemon.webUrl}/ui/v1/settings/terminal-backend/availability`)
    ).json()) as { tmux: { available: boolean } };
    expect(first.tmux.available).toBe(false);
    process.env.TMUX_BINARY = okBin;
    const second = (await (
      await fetch(`${daemon.webUrl}/ui/v1/settings/terminal-backend/availability`)
    ).json()) as { tmux: { available: boolean } };
    expect(second.tmux.available).toBe(true);
  });

  test("non-GET method is rejected", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
    const res = await fetch(
      `${daemon.webUrl}/ui/v1/settings/terminal-backend/availability`,
      { method: "PUT" },
    );
    expect(res.status).toBe(405);
  });
});

describe("settings UI API — public access boundary", () => {
  let tmpHome: string;
  let daemon: DaemonHandle;

  beforeEach(async () => {
    tmpHome = await createDaemonTestHome("wos-ui-settings-public-");
  });

  afterEach(async () => {
    await teardownDaemonTestHome(tmpHome, daemon);
  });

  async function startPublic(terminalEnabled = false) {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        globalConfig: publicEnabledConfig(terminalEnabled),
      }),
    );
  }

  test("unauthenticated public-host GET returns 401", async () => {
    await startPublic();
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/config`, {
      headers: { host: PUBLIC_HOST },
    });
    expect(res.status).toBe(401);
  });

  test("authenticated public-host GET returns 403 forbidden", async () => {
    await startPublic();
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/config`, {
      headers: { host: PUBLIC_HOST, cookie: publicCookie() },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("forbidden");
  });

  test("authenticated public-host PUT returns 403 and does not modify config", async () => {
    await startPublic();
    await writeFile(
      join(tmpHome, "config.json"),
      JSON.stringify({ web: { port: 4949 } }),
    );
    const before = await readFile(join(tmpHome, "config.json"), "utf8");
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/config`, {
      method: "PUT",
      headers: {
        host: PUBLIC_HOST,
        cookie: publicCookie(),
        "content-type": "application/json",
      },
      body: JSON.stringify({ web: { port: 5050 } }),
    });
    expect(res.status).toBe(403);
    const after = await readFile(join(tmpHome, "config.json"), "utf8");
    expect(after).toBe(before);
  });

  test("public terminal access does not grant settings access", async () => {
    await startPublic(true);
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/config`, {
      headers: { host: PUBLIC_HOST, cookie: publicCookie() },
    });
    expect(res.status).toBe(403);
  });

  test("local loopback GET works even when public web is enabled", async () => {
    await startPublic();
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/config`);
    expect(res.status).toBe(200);
  });

  test("authenticated public-host availability GET returns 403 and no probe details", async () => {
    await startPublic();
    const res = await fetch(
      `${daemon.webUrl}/ui/v1/settings/terminal-backend/availability`,
      { headers: { host: PUBLIC_HOST, cookie: publicCookie() } },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("forbidden");
    const text = JSON.stringify(body);
    expect(text).not.toContain("binary");
    expect(text).not.toContain("\"available\"");
  });

  test("authenticated public-host GET does not leak terminalBackend", async () => {
    await startPublic(true);
    await writeFile(
      join(tmpHome, "config.json"),
      JSON.stringify({ terminalBackend: "tmux" }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/config`, {
      headers: { host: PUBLIC_HOST, cookie: publicCookie() },
    });
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).not.toContain("terminalBackend");
  });

  test("authenticated public-host GET does not leak aiProvider API keys", async () => {
    await startPublic();
    await writeFile(
      join(tmpHome, "config.json"),
      JSON.stringify({
        aiProviders: [{ type: "openai", apiKey: "sk-super-secret" }],
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/config`, {
      headers: { host: PUBLIC_HOST, cookie: publicCookie() },
    });
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).not.toContain("sk-super-secret");
    expect(text).not.toContain("aiProviders");
  });

  test("authenticated public-host PUT with aiProviders returns 403 and does not modify config", async () => {
    await startPublic();
    await writeFile(
      join(tmpHome, "config.json"),
      JSON.stringify({ web: { port: 4949 } }),
    );
    const before = await readFile(join(tmpHome, "config.json"), "utf8");
    const res = await fetch(`${daemon.webUrl}/ui/v1/settings/config`, {
      method: "PUT",
      headers: {
        host: PUBLIC_HOST,
        cookie: publicCookie(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        aiProviders: [{ type: "openai", apiKey: "sk-injected" }],
      }),
    });
    expect(res.status).toBe(403);
    const after = await readFile(join(tmpHome, "config.json"), "utf8");
    expect(after).toBe(before);
  });
});
