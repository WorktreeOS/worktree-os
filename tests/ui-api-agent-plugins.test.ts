import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { startDaemon, type DaemonHandle } from "@worktreeos/daemon/daemon-server";
import {
  claudePluginRegistryPath,
  resetAgentPluginInstallCache,
} from "@worktreeos/daemon/agent-plugin-install";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
  withDaemonDefaults,
} from "./helpers/daemon-test-harness.ts";

describe("agent plugins UI API", () => {
  let tmpHome: string;
  let daemon: DaemonHandle;
  let prevConfigDir: string | undefined;

  beforeEach(async () => {
    tmpHome = await createDaemonTestHome("wos-ui-agent-plugins-");
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(tmpHome, ".claude");
    resetAgentPluginInstallCache();
  });

  afterEach(async () => {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    resetAgentPluginInstallCache();
    await teardownDaemonTestHome(tmpHome, daemon);
  });

  test("GET reports installed + outdated from the plugin registry", async () => {
    const registry = claudePluginRegistryPath();
    mkdirSync(dirname(registry), { recursive: true });
    writeFileSync(
      registry,
      JSON.stringify({
        version: 2,
        plugins: {
          "wos@worktreeos": [
            { scope: "user", version: "0.0.1", installPath: "/cache/wos" },
          ],
        },
      }),
    );
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/agent-plugins`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      claude: { installed: boolean; outdated: boolean };
      opencode: { installed: boolean };
    };
    expect(body.claude.installed).toBe(true);
    expect(body.claude.outdated).toBe(true);
    expect(typeof body.opencode.installed).toBe("boolean");
  });

  test("GET reports missing plugin on a clean home", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/agent-plugins`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      claude: { installed: boolean; outdated: boolean };
    };
    expect(body.claude.installed).toBe(false);
    expect(body.claude.outdated).toBe(false);
  });
});
