import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { startDaemon, type DaemonHandle } from "@worktreeos/daemon/daemon-server";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
  withDaemonDefaults,
} from "./helpers/daemon-test-harness.ts";
import type { GlobalConfig } from "@worktreeos/core/global-config";
import { createUiApi, UiUnauthorizedError } from "../apps/web/src/lib/ui-api";
import {
  applyUnauthorized,
  gateDecision,
  readyFromSession,
  type PublicAuthState,
} from "../apps/web/src/lib/public-auth-state";

describe("public-auth-state", () => {
  test("gateDecision maps loading/login/app/error", () => {
    expect(gateDecision({ kind: "loading" })).toBe("loading");
    expect(gateDecision({ kind: "error", message: "x" })).toBe("error");
    expect(
      gateDecision({
        kind: "ready",
        authenticated: false,
        requiresAuth: true,
      }),
    ).toBe("login");
    expect(
      gateDecision({
        kind: "ready",
        authenticated: true,
        requiresAuth: true,
      }),
    ).toBe("app");
    expect(
      gateDecision({
        kind: "ready",
        authenticated: false,
        requiresAuth: false,
      }),
    ).toBe("app");
  });

  test("applyUnauthorized only drops to login when requiresAuth is true", () => {
    const local: PublicAuthState = {
      kind: "ready",
      authenticated: false,
      requiresAuth: false,
    };
    expect(applyUnauthorized(local)).toEqual(local);

    const publicReady: PublicAuthState = {
      kind: "ready",
      authenticated: true,
      requiresAuth: true,
    };
    expect(applyUnauthorized(publicReady)).toEqual({
      kind: "ready",
      authenticated: false,
      requiresAuth: true,
    });
  });

  test("readyFromSession coerces booleans", () => {
    expect(
      readyFromSession({
        authenticated: true,
        requiresAuth: true,
      }),
    ).toEqual({ kind: "ready", authenticated: true, requiresAuth: true });
  });
});

describe("web UI auth client against live daemon", () => {
  const SECRET = "letmein";
  const PUBLIC_HOST = "wos.example.com";

  let tmpHome: string;
  let daemon: DaemonHandle;

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

  beforeEach(async () => {
    tmpHome = await createDaemonTestHome("wos-web-pub-auth-");
  });

  afterEach(async () => {
    await teardownDaemonTestHome(tmpHome, daemon);
  });

  test("direct main-port public hostname produces a login gate decision", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        globalConfig: publicConfig(),
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/auth/session`, {
      headers: { host: PUBLIC_HOST },
    });
    expect(res.status).toBe(200);
    const session = (await res.json()) as {
      authenticated: boolean;
      requiresAuth: boolean;
    };
    expect(gateDecision(readyFromSession(session))).toBe("login");
  });

  test("local loopback reports requiresAuth=false", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        globalConfig: publicConfig(),
      }),
    );
    const api = createUiApi(daemon.webUrl!);
    const session = await api.getAuthSession();
    expect(session.authenticated).toBe(false);
    expect(session.requiresAuth).toBe(false);
  });

  test("login with bad secret throws UiUnauthorizedError", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        globalConfig: publicConfig(),
      }),
    );
    const api = createUiApi(daemon.webUrl!);
    let caught: unknown;
    try {
      await api.login("nope");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UiUnauthorizedError);
  });

  test("login with correct secret resolves without throwing", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        globalConfig: publicConfig(),
      }),
    );
    const api = createUiApi(daemon.webUrl!);
    await api.login(SECRET);
  });

  test("onUnauthorized fires when a non-auth request returns 401", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        globalConfig: publicConfig(),
      }),
    );
    let fired = 0;
    // We need the request to be classified as public-host so the gate returns
    // 401. The fetch path strips the Host header in cross-platform ways via
    // the standard `fetch` — instead, drive the request directly with a manual
    // Host header and verify the hook independently.
    const onUnauthorized = () => {
      fired += 1;
    };
    const api = createUiApi(daemon.webUrl!, { onUnauthorized });

    // Verify the hook is wired via a fetch interceptor: shadow `fetch` to
    // return a 401 once.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    try {
      try {
        await api.listProjects();
      } catch {
        /* expected */
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(fired).toBe(1);
  });

  test("auth endpoints do NOT trigger onUnauthorized on 401", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        globalConfig: publicConfig(),
      }),
    );
    let fired = 0;
    const api = createUiApi(daemon.webUrl!, {
      onUnauthorized: () => {
        fired += 1;
      },
    });
    try {
      await api.login("nope");
    } catch {
      /* expected */
    }
    expect(fired).toBe(0);
  });
});
