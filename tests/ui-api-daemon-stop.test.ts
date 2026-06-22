import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { startDaemon, type DaemonHandle } from "@worktreeos/daemon/daemon-server";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
  withDaemonDefaults,
} from "./helpers/daemon-test-harness.ts";
import { signAuthCookie, AUTH_COOKIE_NAME } from "@worktreeos/daemon/public-auth";
import type { GlobalConfig } from "@worktreeos/core/global-config";
import type { UiHealthResponse } from "@worktreeos/daemon/ui-protocol";

const PUBLIC_HOST = "wos.example.com";
const SECRET = "letmein";

function publicCookie(now = Date.now()): string {
  return `${AUTH_COOKIE_NAME}=${signAuthCookie(SECRET, now)}`;
}

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

let tmpHome: string;
let daemon: DaemonHandle | null;

beforeEach(async () => {
  tmpHome = await createDaemonTestHome("wos-ui-stop-");
  daemon = null;
});

afterEach(async () => {
  await teardownDaemonTestHome(tmpHome, daemon);
});

describe("daemon stop UI API — local access", () => {
  test("local POST schedules stop and returns 202 before shutdown", async () => {
    const scheduled: number[] = [];
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        stopScheduler: () => {
          scheduled.push(Date.now());
        },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/daemon/stop`, {
      method: "POST",
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string; scheduledAt: string };
    expect(body.status).toBe("scheduled");
    expect(typeof body.scheduledAt).toBe("string");
    expect(scheduled.length).toBe(1);
    // The daemon is still serving after the response — shutdown is deferred
    // to the scheduler, so deployed services and in-flight requests survive.
    const health = await fetch(`${daemon.webUrl}/ui/v1/health`);
    expect(health.status).toBe(200);
  });

  test("returns 503 when no stop scheduler is wired", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/daemon/stop`, {
      method: "POST",
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("stop-unavailable");
  });

  test("GET on stop endpoint returns 405", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        stopScheduler: () => {},
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/daemon/stop`);
    expect(res.status).toBe(405);
  });

  test("scheduling failure returns 500 and keeps the daemon up", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        stopScheduler: () => {
          throw new Error("boom");
        },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/daemon/stop`, {
      method: "POST",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("stop-failed");
    const health = await fetch(`${daemon.webUrl}/ui/v1/health`);
    expect(health.status).toBe(200);
  });
});

describe("daemon stop UI API — public access boundary", () => {
  test("authenticated public POST returns 403 and does not schedule stop", async () => {
    let scheduledCount = 0;
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        globalConfig: publicEnabledConfig(),
        stopScheduler: () => {
          scheduledCount += 1;
        },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/daemon/stop`, {
      method: "POST",
      headers: { host: PUBLIC_HOST, cookie: publicCookie() },
    });
    expect(res.status).toBe(403);
    expect(scheduledCount).toBe(0);
  });

  test("unauthenticated public POST returns 401", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        globalConfig: publicEnabledConfig(),
        stopScheduler: () => {},
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/daemon/stop`, {
      method: "POST",
      headers: { host: PUBLIC_HOST },
    });
    expect(res.status).toBe(401);
  });
});

describe("health public boundary", () => {
  test("public health returns minimal readiness without local management details", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        globalConfig: publicEnabledConfig(),
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/health`, {
      headers: { host: PUBLIC_HOST, cookie: publicCookie() },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UiHealthResponse;
    expect(body.ok).toBe(true);
    expect(body.pid).toBeUndefined();
    expect(body.daemonId).toBeUndefined();
    expect(body.webPort).toBeUndefined();
  });
});
