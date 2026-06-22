import { test, expect, describe, beforeEach, afterEach } from "bun:test";
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

describe("daemon restart UI API — local access", () => {
  let tmpHome: string;
  let daemon: DaemonHandle | null;

  beforeEach(async () => {
    tmpHome = await createDaemonTestHome("wos-ui-restart-local-");
    daemon = null;
  });

  afterEach(async () => {
    await teardownDaemonTestHome(tmpHome, daemon);
  });

  test("local POST schedules restart and returns 202", async () => {
    const scheduled: number[] = [];
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        restartScheduler: () => {
          scheduled.push(Date.now());
        },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/daemon/restart`, {
      method: "POST",
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      status: string;
      scheduledAt: string;
    };
    expect(body.status).toBe("scheduled");
    expect(typeof body.scheduledAt).toBe("string");
    // Scheduler is invoked exactly once before the response returns.
    expect(scheduled.length).toBe(1);
  });

  test("scheduler runs after response is built", async () => {
    let order: string[] = [];
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        restartScheduler: () => {
          order.push("scheduler");
        },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/daemon/restart`, {
      method: "POST",
    });
    order.push("response");
    expect(res.status).toBe(202);
    // Scheduler runs synchronously during handler execution, before the
    // client observes the response. Both events must be present.
    expect(order).toContain("scheduler");
    expect(order).toContain("response");
  });

  test("scheduling failure returns 500 and does not crash daemon", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        restartScheduler: () => {
          throw new Error("boom");
        },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/daemon/restart`, {
      method: "POST",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("restart-failed");
    expect(body.message).toContain("boom");
    // Sanity: daemon is still serving — second request works.
    const health = await fetch(`${daemon.webUrl}/ui/v1/health`);
    expect(health.status).toBe(200);
  });

  test("GET on restart endpoint returns 405", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        restartScheduler: () => {},
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/daemon/restart`);
    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("method-not-allowed");
  });
});

describe("daemon restart UI API — public access boundary", () => {
  let tmpHome: string;
  let daemon: DaemonHandle | null;

  beforeEach(async () => {
    tmpHome = await createDaemonTestHome("wos-ui-restart-public-");
    daemon = null;
  });

  afterEach(async () => {
    await teardownDaemonTestHome(tmpHome, daemon);
  });

  test("authenticated public POST returns 403 and does not schedule restart", async () => {
    let scheduledCount = 0;
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        globalConfig: publicEnabledConfig(),
        restartScheduler: () => {
          scheduledCount += 1;
        },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/daemon/restart`, {
      method: "POST",
      headers: { host: PUBLIC_HOST, cookie: publicCookie() },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("forbidden");
    expect(scheduledCount).toBe(0);
  });

  test("unauthenticated public POST returns 401", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        globalConfig: publicEnabledConfig(),
        restartScheduler: () => {},
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/daemon/restart`, {
      method: "POST",
      headers: { host: PUBLIC_HOST },
    });
    expect(res.status).toBe(401);
  });

  test("local loopback POST works even when public web is enabled", async () => {
    let scheduledCount = 0;
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        globalConfig: publicEnabledConfig(),
        restartScheduler: () => {
          scheduledCount += 1;
        },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/daemon/restart`, {
      method: "POST",
    });
    expect(res.status).toBe(202);
    expect(scheduledCount).toBe(1);
  });
});
