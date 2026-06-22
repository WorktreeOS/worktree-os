import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "@worktreeos/daemon/daemon-server";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
  withDaemonDefaults,
} from "./helpers/daemon-test-harness.ts";
import { signAuthCookie, AUTH_COOKIE_NAME } from "@worktreeos/daemon/public-auth";
import { startTunnelServer } from "@worktreeos/runtime/tunnel";
import { createFakeTerminalRuntime } from "@worktreeos/daemon/terminal-layer/testing";
import type { GlobalConfig } from "@worktreeos/core/global-config";

const PUBLIC_HOST = "wos.example.com";
const SECRET = "letmein";

function publicEnabledConfig(): GlobalConfig {
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

function publicCookie(now = Date.now()): string {
  return `${AUTH_COOKIE_NAME}=${signAuthCookie(SECRET, now)}`;
}

describe("public request authorization", () => {
  let tmpHome: string;
  let daemon: DaemonHandle;
  let assetRoot: string;

  beforeEach(async () => {
    tmpHome = await createDaemonTestHome("wos-public-auth-gate-");
    assetRoot = join(tmpHome, "dist");
    await mkdir(assetRoot, { recursive: true });
    await writeFile(
      join(assetRoot, "index.html"),
      "<!doctype html><h1>shell</h1>",
    );
  });

  afterEach(async () => {
    await teardownDaemonTestHome(tmpHome, daemon);
  });

  async function startEnabled() {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0, assetRoot },
        globalConfig: publicEnabledConfig(),
      }),
    );
  }

  test("public-host UI API request without cookie → 401", async () => {
    await startEnabled();
    const res = await fetch(`${daemon.webUrl}/ui/v1/health`, {
      headers: { host: PUBLIC_HOST },
    });
    expect(res.status).toBe(401);
  });

  test("public-host UI API request with valid cookie → 200", async () => {
    await startEnabled();
    const res = await fetch(`${daemon.webUrl}/ui/v1/health`, {
      headers: { host: PUBLIC_HOST, cookie: publicCookie() },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("local loopback UI API works without cookie", async () => {
    await startEnabled();
    const res = await fetch(`${daemon.webUrl}/ui/v1/health`);
    expect(res.status).toBe(200);
  });

  test("public web shell loads before login (no auth gate on static assets)", async () => {
    await startEnabled();
    const res = await fetch(`${daemon.webUrl}/`, {
      headers: { host: PUBLIC_HOST },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
  });

  test("public-host SSE stream without cookie → 401, no subscription created", async () => {
    await startEnabled();
    const res = await fetch(`${daemon.webUrl}/ui/v1/events`, {
      headers: { host: PUBLIC_HOST },
    });
    expect(res.status).toBe(401);
    // Body, if any, is JSON error, not an SSE stream.
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
  });

  test("public-host log stream without cookie → 401", async () => {
    await startEnabled();
    const res = await fetch(
      `${daemon.webUrl}/ui/v1/worktrees/logs?session=any`,
      { headers: { host: PUBLIC_HOST } },
    );
    expect(res.status).toBe(401);
  });

  test("public-host terminal attach without cookie → 401, no WebSocket upgrade", async () => {
    await startEnabled();
    // Create a real terminal via local loopback so an id exists.
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const create = await fetch(`${daemon.webUrl}/ui/v1/terminals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worktreePath: wt }),
    });
    if (create.status !== 201) {
      // Terminals may be unavailable in this environment (no PTY backend).
      return;
    }
    const { session } = (await create.json()) as { session: { id: string } };

    const res = await fetch(
      `${daemon.webUrl}/ui/v1/terminals/${session.id}/attach`,
      { headers: { host: PUBLIC_HOST } },
    );
    expect(res.status).toBe(401);
  });

  test("local /ui/v1/auth/session reports authenticated=false when no cookie", async () => {
    await startEnabled();
    const res = await fetch(`${daemon.webUrl}/ui/v1/auth/session`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authenticated: boolean };
    expect(body.authenticated).toBe(false);
  });

  test("public-host /ui/v1/auth/session is reachable without a cookie", async () => {
    await startEnabled();
    const res = await fetch(`${daemon.webUrl}/ui/v1/auth/session`, {
      headers: { host: PUBLIC_HOST },
    });
    expect(res.status).toBe(200);
  });

  test("direct main-port /ui/v1/auth/session via public hostname reports requiresAuth=true", async () => {
    await startEnabled();
    const res = await fetch(`${daemon.webUrl}/ui/v1/auth/session`, {
      headers: { host: PUBLIC_HOST },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      authenticated: boolean;
      requiresAuth: boolean;
    };
    expect(body.requiresAuth).toBe(true);
    expect(body.authenticated).toBe(false);
  });

  test("direct main-port /ui/v1/auth/session via public hostname with valid cookie reports authenticated=true", async () => {
    await startEnabled();
    const res = await fetch(`${daemon.webUrl}/ui/v1/auth/session`, {
      headers: { host: PUBLIC_HOST, cookie: publicCookie() },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      authenticated: boolean;
      requiresAuth: boolean;
    };
    expect(body.requiresAuth).toBe(true);
    expect(body.authenticated).toBe(true);
  });

  test("local loopback /ui/v1/auth/session reports requiresAuth=false", async () => {
    await startEnabled();
    const res = await fetch(`${daemon.webUrl}/ui/v1/auth/session`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { requiresAuth: boolean };
    expect(body.requiresAuth).toBe(false);
  });

  test("legacy /v1/* daemon API routes return 404 on the web listener", async () => {
    await startEnabled();
    const res = await fetch(`${daemon.webUrl}/v1/health`, {
      headers: { host: PUBLIC_HOST, cookie: publicCookie() },
    });
    expect(res.status).toBe(404);
  });

  test("public-host /ui/v1/auth/login is reachable without a cookie", async () => {
    await startEnabled();
    const res = await fetch(`${daemon.webUrl}/ui/v1/auth/login`, {
      method: "POST",
      headers: { host: PUBLIC_HOST, "content-type": "application/json" },
      body: JSON.stringify({ secret: SECRET }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").toContain(AUTH_COOKIE_NAME);
  });

  test("real tunnel proxy: request via tunnel hits the public auth gate", async () => {
    // Start a real tunnel server on an OS-assigned port, then start the daemon
    // with publicWeb enabled and inject the tunnel via tunnelServerStarter so
    // the daemon registers the public route on it.
    const tunnel = await startTunnelServer({
      port: 0,
      domain: "example.com",
      hostname: "127.0.0.1",
    });
    try {
      daemon = await startDaemon(
        withDaemonDefaults(tmpHome, {
          resolveSession: async () => ({}) as any,
          web: { port: 0, assetRoot },
          globalConfig: {
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
          },
          tunnelServerStarter: async () => tunnel,
        }),
      );
      // Verify the public route is actually registered on the tunnel server.
      expect(tunnel.hasRoute(PUBLIC_HOST)).toBe(true);

      const tunnelUrl = `http://127.0.0.1:${tunnel.port}`;

      // Unauthenticated request through the proxy → 401.
      const unauth = await fetch(`${tunnelUrl}/ui/v1/health`, {
        headers: { host: PUBLIC_HOST },
      });
      expect(unauth.status).toBe(401);

      // Authenticated request through the proxy → 200.
      const auth = await fetch(`${tunnelUrl}/ui/v1/health`, {
        headers: {
          host: PUBLIC_HOST,
          cookie: `${AUTH_COOKIE_NAME}=${signAuthCookie(SECRET, Date.now())}`,
        },
      });
      expect(auth.status).toBe(200);

      // Login flow through the proxy works end to end.
      const login = await fetch(`${tunnelUrl}/ui/v1/auth/login`, {
        method: "POST",
        headers: { host: PUBLIC_HOST, "content-type": "application/json" },
        body: JSON.stringify({ secret: SECRET }),
      });
      expect(login.status).toBe(200);
      expect(login.headers.get("set-cookie") ?? "").toContain(AUTH_COOKIE_NAME);
    } finally {
      await tunnel.stop();
    }
  });
});

describe("public terminal access policy", () => {
  let tmpHome: string;
  let daemon: DaemonHandle;

  beforeEach(async () => {
    tmpHome = await createDaemonTestHome("wos-public-terminal-");
  });

  afterEach(async () => {
    await teardownDaemonTestHome(tmpHome, daemon);
  });

  async function startWithTerminalAccess(terminalEnabled: boolean) {
    const runtime = createFakeTerminalRuntime();
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        terminalRuntime: runtime.runtime,
        globalConfig: {
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
        },
      }),
    );
    return runtime;
  }

  test("public terminal list without cookie → 401 before runtime probe", async () => {
    await startWithTerminalAccess(true);
    const res = await fetch(`${daemon.webUrl}/ui/v1/terminal-layer/sessions`, {
      headers: { host: PUBLIC_HOST },
    });
    expect(res.status).toBe(401);
  });

  test("authenticated public terminal list with terminalEnabled=false → 403 forbidden", async () => {
    await startWithTerminalAccess(false);
    const res = await fetch(`${daemon.webUrl}/ui/v1/terminal-layer/sessions`, {
      headers: { host: PUBLIC_HOST, cookie: publicCookie() },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("forbidden");
  });

  test("authenticated public terminal list with terminalEnabled=true → 200", async () => {
    await startWithTerminalAccess(true);
    const res = await fetch(`${daemon.webUrl}/ui/v1/terminal-layer/sessions`, {
      headers: { host: PUBLIC_HOST, cookie: publicCookie() },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[] };
    expect(Array.isArray(body.sessions)).toBe(true);
  });

  test("authenticated public terminal create with terminalEnabled=true → 201", async () => {
    await startWithTerminalAccess(true);
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const res = await fetch(`${daemon.webUrl}/ui/v1/terminal-layer/sessions`, {
      method: "POST",
      headers: {
        host: PUBLIC_HOST,
        cookie: publicCookie(),
        "content-type": "application/json",
      },
      body: JSON.stringify({ worktreePath: wt }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { session: { id: string } };
    expect(body.session.id).toBeDefined();
  });

  test("authenticated public terminal create with terminalEnabled=false → 403", async () => {
    await startWithTerminalAccess(false);
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const res = await fetch(`${daemon.webUrl}/ui/v1/terminal-layer/sessions`, {
      method: "POST",
      headers: {
        host: PUBLIC_HOST,
        cookie: publicCookie(),
        "content-type": "application/json",
      },
      body: JSON.stringify({ worktreePath: wt }),
    });
    expect(res.status).toBe(403);
  });

  test("local loopback terminal create works even when terminalEnabled=false", async () => {
    await startWithTerminalAccess(false);
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const res = await fetch(`${daemon.webUrl}/ui/v1/terminal-layer/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worktreePath: wt }),
    });
    expect(res.status).toBe(201);
  });

  test("public terminal WS attach without cookie → 401, no upgrade", async () => {
    await startWithTerminalAccess(true);
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const create = await fetch(`${daemon.webUrl}/ui/v1/terminal-layer/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worktreePath: wt }),
    });
    expect(create.status).toBe(201);
    const { session } = (await create.json()) as { session: { id: string } };

    const res = await fetch(
      `${daemon.webUrl}/ui/v1/terminal-layer/sessions/${session.id}/attach`,
      { headers: { host: PUBLIC_HOST } },
    );
    expect(res.status).toBe(401);
  });

  test("authenticated public terminal WS attach with terminalEnabled=false → 403", async () => {
    await startWithTerminalAccess(false);
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const create = await fetch(`${daemon.webUrl}/ui/v1/terminal-layer/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worktreePath: wt }),
    });
    expect(create.status).toBe(201);
    const { session } = (await create.json()) as { session: { id: string } };

    const res = await fetch(
      `${daemon.webUrl}/ui/v1/terminal-layer/sessions/${session.id}/attach`,
      { headers: { host: PUBLIC_HOST, cookie: publicCookie() } },
    );
    expect(res.status).toBe(403);
  });

  test("authenticated public terminal WS attach with terminalEnabled=true upgrades", async () => {
    const runtime = await startWithTerminalAccess(true);
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const create = await fetch(`${daemon.webUrl}/ui/v1/terminal-layer/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worktreePath: wt }),
    });
    expect(create.status).toBe(201);
    const { session } = (await create.json()) as { session: { id: string } };

    const wsUrl =
      daemon.webUrl!.replace(/^http/, "ws") +
      `/ui/v1/terminal-layer/sessions/${session.id}/attach`;
    const ws = new WebSocket(wsUrl, {
      headers: {
        host: PUBLIC_HOST,
        cookie: publicCookie(),
      },
    } as any);
    try {
      await new Promise<void>((resolveOpen, reject) => {
        const timer = setTimeout(() => reject(new Error("ws open timeout")), 2000);
        ws.addEventListener("open", () => {
          clearTimeout(timer);
          resolveOpen();
        });
        ws.addEventListener("error", (e) => {
          clearTimeout(timer);
          reject(new Error(`ws error: ${(e as ErrorEvent).message ?? "unknown"}`));
        });
      });
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      ws.close();
    }
    // The fake runtime is exercised via the session create above; ensure it
    // is referenced so static analysis sees the binding is intentional.
    expect(runtime.spawned.length).toBeGreaterThanOrEqual(1);
  });
});
