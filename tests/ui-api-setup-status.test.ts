import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startDaemon, type DaemonHandle } from "@worktreeos/daemon/daemon-server";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
  withDaemonDefaults,
} from "./helpers/daemon-test-harness.ts";
import { signAuthCookie, AUTH_COOKIE_NAME } from "@worktreeos/daemon/public-auth";
import type { GlobalConfig } from "@worktreeos/core/global-config";
import type { SetupStatusResponse } from "@worktreeos/daemon/ui-protocol";

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

describe("setup status UI API — local access", () => {
  let tmpHome: string;
  let daemon: DaemonHandle | null;

  beforeEach(async () => {
    tmpHome = await createDaemonTestHome("wos-ui-setup-local-");
    daemon = null;
  });

  afterEach(async () => {
    await teardownDaemonTestHome(tmpHome, daemon);
  });

  test("setupRequired=true when no config and no projects", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/setup/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SetupStatusResponse;
    expect(body.setupRequired).toBe(true);
    expect(body.projectCount).toBe(0);
    expect(body.globalConfig.exists).toBe(false);
    expect(body.globalConfig.effective.web.port).toBe(4949);
    expect(body.firstRunCompleted).toBeNull();
  });

  test("setupRequired=false when the completion marker is present", async () => {
    await writeFile(
      join(tmpHome, "config.json"),
      JSON.stringify({ firstRunCompleted: "2026-06-01T00:00:00.000Z" }),
    );
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/setup/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SetupStatusResponse;
    expect(body.setupRequired).toBe(false);
    expect(body.firstRunCompleted).toBe("2026-06-01T00:00:00.000Z");
  });

  test("setupRequired=false when config.json exists", async () => {
    await writeFile(
      join(tmpHome, "config.json"),
      JSON.stringify({ web: { port: 5050 } }),
    );
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/setup/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SetupStatusResponse;
    expect(body.setupRequired).toBe(false);
    expect(body.globalConfig.exists).toBe(true);
  });

  test("setupRequired=false when a project is registered", async () => {
    await writeFile(
      join(tmpHome, "projects.json"),
      JSON.stringify({
        version: 1,
        projects: [
          {
            id: "p1",
            displayName: "demo",
            sourcePath: tmpHome,
            createdAt: new Date(0).toISOString(),
            lastSeenAt: new Date(0).toISOString(),
          },
        ],
      }),
    );
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/setup/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SetupStatusResponse;
    expect(body.setupRequired).toBe(false);
    expect(body.projectCount).toBe(1);
  });
});

describe("setup status UI API — public access boundary", () => {
  let tmpHome: string;
  let daemon: DaemonHandle | null;

  beforeEach(async () => {
    tmpHome = await createDaemonTestHome("wos-ui-setup-public-");
    daemon = null;
  });

  afterEach(async () => {
    await teardownDaemonTestHome(tmpHome, daemon);
  });

  test("unauthenticated public-host GET returns 401", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        globalConfig: publicEnabledConfig(),
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/setup/status`, {
      headers: { host: PUBLIC_HOST },
    });
    expect(res.status).toBe(401);
  });

  test("authenticated public-host GET returns 403 forbidden", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        globalConfig: publicEnabledConfig(),
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/setup/status`, {
      headers: { host: PUBLIC_HOST, cookie: publicCookie() },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("forbidden");
  });

  test("local loopback GET still works when public web is enabled", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        globalConfig: publicEnabledConfig(),
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/setup/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SetupStatusResponse;
    expect(body.setupRequired).toBe(true);
  });
});
