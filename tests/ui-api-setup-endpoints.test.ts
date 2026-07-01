import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "@worktreeos/daemon/daemon-server";
import type { DaemonOptions } from "@worktreeos/daemon/daemon-server";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
  withDaemonDefaults,
} from "./helpers/daemon-test-harness.ts";
import { signAuthCookie, AUTH_COOKIE_NAME } from "@worktreeos/daemon/public-auth";
import type { GlobalConfig } from "@worktreeos/core/global-config";
import type {
  SetupEnvironmentResponse,
  SetupInstallTmuxResponse,
  SetupStatusResponse,
  SetupCompleteResponse,
} from "@worktreeos/daemon/ui-protocol";

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
  } as unknown as GlobalConfig;
}

/** tmux available; docker fully present. */
function healthyEnv(): NonNullable<DaemonOptions["setupEnvironment"]> {
  return {
    probeDocker: async () => ({ dockerInstalled: true, dockerComposeV2: true }),
    detectTmux: () => ({ available: true, binary: "tmux", platform: "linux" }),
    detectPackageManager: () => null,
    runInstall: async () => true,
    platform: "linux",
  };
}

describe("setup environment probe", () => {
  let tmpHome: string;
  let daemon: DaemonHandle | null;

  beforeEach(async () => {
    tmpHome = await createDaemonTestHome("wos-ui-setup-env-");
    daemon = null;
  });
  afterEach(async () => {
    await teardownDaemonTestHome(tmpHome, daemon);
  });

  test("reports docker/compose/tmux status", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        setupEnvironment: {
          probeDocker: async () => ({ dockerInstalled: true, dockerComposeV2: false }),
          detectTmux: () => ({ available: true, binary: "tmux", platform: "linux" }),
          detectPackageManager: () => null,
          runInstall: async () => true,
          platform: "linux",
        },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/setup/environment`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SetupEnvironmentResponse;
    expect(body.docker.installed).toBe(true);
    expect(body.dockerCompose.installed).toBe(false);
    expect(body.tmux.available).toBe(true);
    expect(body.tmux.packageManager).toBeNull();
  });

  test("includes the install command hint when tmux is unavailable", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        setupEnvironment: {
          probeDocker: async () => ({ dockerInstalled: false, dockerComposeV2: false }),
          detectTmux: () => ({
            available: false,
            reason: "tmux not found",
            binary: "tmux",
            platform: "linux",
          }),
          detectPackageManager: () => ({ manager: "apt", command: "sudo apt-get install -y tmux" }),
          runInstall: async () => true,
          platform: "linux",
        },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/setup/environment`);
    const body = (await res.json()) as SetupEnvironmentResponse;
    expect(body.docker.installed).toBe(false);
    expect(body.tmux.available).toBe(false);
    expect(body.tmux.reason).toBe("tmux not found");
    expect(body.tmux.packageManager).toEqual({
      manager: "apt",
      command: "sudo apt-get install -y tmux",
      requiresElevation: true,
    });
  });

  test("public/remote access is forbidden", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        globalConfig: publicEnabledConfig(),
        setupEnvironment: healthyEnv(),
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/setup/environment`, {
      headers: { host: PUBLIC_HOST, cookie: publicCookie() },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("forbidden");
  });
});

describe("setup install-tmux", () => {
  let tmpHome: string;
  let daemon: DaemonHandle | null;

  beforeEach(async () => {
    tmpHome = await createDaemonTestHome("wos-ui-setup-tmux-");
    daemon = null;
  });
  afterEach(async () => {
    await teardownDaemonTestHome(tmpHome, daemon);
  });

  test("no-sudo manager installs, re-probes, and switches the backend to tmux", async () => {
    let installed = false;
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        setupEnvironment: {
          probeDocker: async () => ({ dockerInstalled: true, dockerComposeV2: true }),
          // Unavailable until the install runs, then available.
          detectTmux: () =>
            installed
              ? { available: true, binary: "tmux", platform: "darwin" }
              : { available: false, reason: "not found", binary: "tmux", platform: "darwin" },
          detectPackageManager: () => ({ manager: "brew", command: "brew install tmux" }),
          runInstall: async () => {
            installed = true;
            return true;
          },
          platform: "darwin",
        },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/setup/install-tmux`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SetupInstallTmuxResponse;
    expect(body.status).toBe("ok");
    expect(body.available).toBe(true);
    expect(body.terminalBackend).toBe("tmux");
    // The backend switch is persisted to config.json.
    const cfg = JSON.parse(await readFile(join(tmpHome, "config.json"), "utf8"));
    expect(cfg.terminalBackend).toBe("tmux");
  });

  test("sudo manager returns manual-required guidance without running the command", async () => {
    let ran = false;
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        setupEnvironment: {
          probeDocker: async () => ({ dockerInstalled: true, dockerComposeV2: true }),
          detectTmux: () => ({ available: false, reason: "not found", binary: "tmux", platform: "linux" }),
          detectPackageManager: () => ({ manager: "apt", command: "sudo apt-get install -y tmux" }),
          runInstall: async () => {
            ran = true;
            return true;
          },
          platform: "linux",
        },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/setup/install-tmux`, { method: "POST" });
    const body = (await res.json()) as SetupInstallTmuxResponse;
    expect(body.status).toBe("manual-required");
    expect(body.command).toBe("sudo apt-get install -y tmux");
    expect(body.terminalBackend).toBe("default");
    expect(ran).toBe(false);
  });

  test("a failed install returns a typed error and does not switch the backend", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        setupEnvironment: {
          probeDocker: async () => ({ dockerInstalled: true, dockerComposeV2: true }),
          // Stays unavailable even after the install "runs".
          detectTmux: () => ({ available: false, reason: "not found", binary: "tmux", platform: "darwin" }),
          detectPackageManager: () => ({ manager: "brew", command: "brew install tmux" }),
          runInstall: async () => false,
          platform: "darwin",
        },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/setup/install-tmux`, { method: "POST" });
    const body = (await res.json()) as SetupInstallTmuxResponse;
    expect(body.status).toBe("error");
    expect(body.available).toBe(false);
    expect(body.terminalBackend).toBe("default");
    expect(typeof body.message).toBe("string");
  });

  test("public/remote access is forbidden", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        globalConfig: publicEnabledConfig(),
        setupEnvironment: healthyEnv(),
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/setup/install-tmux`, {
      method: "POST",
      headers: { host: PUBLIC_HOST, cookie: publicCookie() },
    });
    expect(res.status).toBe(403);
  });
});

describe("setup complete", () => {
  let tmpHome: string;
  let daemon: DaemonHandle | null;

  beforeEach(async () => {
    tmpHome = await createDaemonTestHome("wos-ui-setup-complete-");
    daemon = null;
  });
  afterEach(async () => {
    await teardownDaemonTestHome(tmpHome, daemon);
  });

  test("stamps the marker so subsequent status reports setup not required", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
    // Fresh install → onboarding required.
    const before = (await (
      await fetch(`${daemon.webUrl}/ui/v1/setup/status`)
    ).json()) as SetupStatusResponse;
    expect(before.setupRequired).toBe(true);

    const done = await fetch(`${daemon.webUrl}/ui/v1/setup/complete`, { method: "POST" });
    expect(done.status).toBe(200);
    const doneBody = (await done.json()) as SetupCompleteResponse;
    expect(doneBody.ok).toBe(true);
    expect(typeof doneBody.firstRunCompleted).toBe("string");

    const after = (await (
      await fetch(`${daemon.webUrl}/ui/v1/setup/status`)
    ).json()) as SetupStatusResponse;
    expect(after.setupRequired).toBe(false);
    expect(after.firstRunCompleted).toBe(doneBody.firstRunCompleted);
  });

  test("public/remote access is forbidden", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        globalConfig: publicEnabledConfig(),
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/setup/complete`, {
      method: "POST",
      headers: { host: PUBLIC_HOST, cookie: publicCookie() },
    });
    expect(res.status).toBe(403);
  });
});
