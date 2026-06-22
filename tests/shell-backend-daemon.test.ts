import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { validateConfig } from "@worktreeos/core/config";
import {
  sessionRootForWorktree,
  sessionNameForWorktree,
  sessionShellServiceLogPath,
} from "@worktreeos/core/paths";
import type { WosState } from "@worktreeos/core/state";
import { TunnelRegistry } from "@worktreeos/runtime/tunnel-registry";
import {
  selectBackendId,
  selectBackendIdForSession,
  readSessionState,
} from "@worktreeos/daemon/backend/backend-selection";
import {
  createShellBackendAdapter,
  createBackendRegistry,
} from "@worktreeos/daemon/backend/adapters";
import { createShellFollowerStarter } from "@worktreeos/daemon/backend/shell-log-follower";
import { createShellCollector } from "@worktreeos/daemon/session-monitor-runtime";
import { startDaemon, type DaemonHandle } from "@worktreeos/daemon/daemon-server";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
  withDaemonDefaults,
} from "./helpers/daemon-test-harness.ts";
import type { SessionContext } from "@worktreeos/core/session-context";

let home: string;
let prevHome: string | undefined;

beforeEach(async () => {
  prevHome = process.env.WOS_HOME;
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  home = await mkdtemp(join(tmpdir(), "wos-shell-daemon-"));
  process.env.WOS_HOME = home;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.WOS_HOME;
  else process.env.WOS_HOME = prevHome;
  const { rm } = await import("node:fs/promises");
  await rm(home, { recursive: true, force: true });
});

function shellConfig() {
  return validateConfig({
    mode: "shell",
    app: {
      services: {
        api: { script: ["run api"], ports: [{ port: 3000, healthcheck: false }] },
      },
    },
  });
}

function generatedConfig() {
  return validateConfig({ app: { services: {} } });
}

async function writeShellSession(
  worktreeRoot: string,
  opts: { pid?: number } = {},
): Promise<{ sessionName: string; stdoutPath: string; stderrPath: string }> {
  const sessionRoot = sessionRootForWorktree(worktreeRoot);
  await mkdir(join(sessionRoot, "shell", "logs"), { recursive: true });
  const stdoutPath = sessionShellServiceLogPath(worktreeRoot, "api", "stdout");
  const stderrPath = sessionShellServiceLogPath(worktreeRoot, "api", "stderr");
  await writeFile(stdoutPath, "");
  await writeFile(stderrPath, "");
  const state: WosState = {
    initialized: true,
    projectName: "shell-p",
    composeFile: "",
    backend: "shell",
    mode: "shell",
    worktreeRoot,
    sourcePath: worktreeRoot,
    portAssignments: { api: { "3000": 21000 } },
    shell: {
      services: {
        api: {
          pid: opts.pid ?? process.pid,
          processGroupId: opts.pid ?? process.pid,
          command: ["sh", "-lc", "(run api)"],
          cwd: worktreeRoot,
          environmentKeys: ["PATH"],
          logFiles: { stdout: stdoutPath, stderr: stderrPath },
          startedAt: "2026-05-29T00:00:00.000Z",
          ports: { "3000": 21000 },
        },
      },
    },
  };
  await writeFile(join(sessionRoot, "state.json"), JSON.stringify(state));
  return { sessionName: sessionNameForWorktree(worktreeRoot), stdoutPath, stderrPath };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1500,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("backend selection", () => {
  test("selects shell for shell config and docker otherwise", () => {
    expect(selectBackendId({ config: shellConfig() })).toBe("shell");
    expect(selectBackendId({ config: generatedConfig() })).toBe("docker");
    expect(selectBackendId({ state: { backend: "shell" } as WosState })).toBe("shell");
    expect(
      selectBackendId({ state: { initialized: true } as WosState }),
    ).toBe("docker");
    expect(selectBackendId({})).toBe("docker");
  });

  test("reads persisted state and selects backend by session", async () => {
    const worktreeRoot = join(home, "wt");
    const { sessionName } = await writeShellSession(worktreeRoot);
    const state = readSessionState(sessionName);
    expect(state?.backend).toBe("shell");
    expect(selectBackendIdForSession(sessionName)).toBe("shell");
    expect(selectBackendIdForSession("does-not-exist")).toBe("docker");
  });
});

describe("shell adapter", () => {
  test("collectServiceSnapshot reads shell state without Docker", async () => {
    const worktreeRoot = join(home, "wt");
    const { sessionName } = await writeShellSession(worktreeRoot);
    const adapter = createShellBackendAdapter();
    const snapshot = await adapter.collectServiceSnapshot(sessionName);
    expect(snapshot?.map((s) => s.service)).toEqual(["api"]);
    expect(snapshot?.[0]!.ports[0]!.hostPort).toBe(21000);
  });

  test("resolveStreamContext enumerates managed shell services", async () => {
    const worktreeRoot = join(home, "wt");
    const { sessionName } = await writeShellSession(worktreeRoot);
    const adapter = createShellBackendAdapter();
    const ctx = await adapter.resolveStreamContext(sessionName);
    expect(ctx?.allowedServices).toEqual(["api"]);
    expect(ctx?.aggregateServices).toEqual(["api"]);
  });

  test("registry selects the shell adapter by config", () => {
    const registry = createBackendRegistry({
      docker: { dockerState: {} as any },
    });
    expect(registry.select({ config: shellConfig() }).id).toBe("shell");
    expect(registry.select({ config: generatedConfig() }).id).toBe("docker");
  });
});

describe("shell log follower", () => {
  test("delivers existing tail and streams appended output", async () => {
    const worktreeRoot = join(home, "wt");
    const { sessionName, stdoutPath, stderrPath } =
      await writeShellSession(worktreeRoot);
    await appendFile(stdoutPath, "boot line\n");

    const chunks: Array<{ stream: string; chunk: string }> = [];
    const starter = createShellFollowerStarter({ pollMs: 10 });
    const followers = starter({
      ctx: { projectName: "shell-p", composeFile: "" },
      services: ["api"],
      sink: (_svc, stream, chunk) => chunks.push({ stream, chunk }),
      sessionName,
    });
    expect(followers.length).toBe(1);

    await waitFor(() => chunks.some((c) => c.chunk.includes("boot line")));
    await appendFile(stdoutPath, "live line\n");
    await waitFor(() => chunks.some((c) => c.chunk.includes("live line")));
    await appendFile(stderrPath, "err line\n");
    await waitFor(() =>
      chunks.some((c) => c.stream === "stderr" && c.chunk.includes("err line")),
    );

    for (const f of followers) f.stop();
    await Promise.all(followers.map((f) => f.done));
  });

  test("returns no followers when the session has no shell state", () => {
    const starter = createShellFollowerStarter({ pollMs: 10 });
    const followers = starter({
      ctx: { projectName: "p", composeFile: "" },
      services: ["api"],
      sink: () => {},
      sessionName: "missing-session",
    });
    expect(followers).toEqual([]);
  });
});

describe("shell monitor collector", () => {
  test("builds a snapshot from shell state without Docker", async () => {
    const worktreeRoot = join(home, "wt");
    const { sessionName } = await writeShellSession(worktreeRoot);
    const tunnels = new TunnelRegistry();
    const collector = createShellCollector({
      sessionName,
      config: shellConfig(),
      tunnels,
    });
    const snapshot = await collector.collect();
    expect(snapshot.compose.map((c) => c.service)).toEqual(["api"]);
    expect(snapshot.compose[0]!.state).toBe("running");
    expect(snapshot.tunnels).toEqual([]);
  });
});

describe("daemon shell-mode restoration", () => {
  let daemon: DaemonHandle | null = null;
  afterEach(async () => {
    if (daemon) await daemon.stop();
    daemon = null;
  });

  test("restores a monitor for an initialized shell session on startup", async () => {
    const tmpHome = await createDaemonTestHome("wos-shell-restore-");
    try {
      const worktreeRoot = join(tmpHome, "wt");
      await mkdir(worktreeRoot, { recursive: true });
      await Bun.write(
        join(worktreeRoot, ".wos", "deploy.yaml"),
        "mode: shell\napp:\n  services:\n    api:\n      script:\n        - run api\n",
      );
      // Re-point shell session helpers at the daemon test home.
      const sessionRoot = sessionRootForWorktree(worktreeRoot);
      await mkdir(join(sessionRoot, "shell", "logs"), { recursive: true });
      const stdoutPath = sessionShellServiceLogPath(worktreeRoot, "api", "stdout");
      const stderrPath = sessionShellServiceLogPath(worktreeRoot, "api", "stderr");
      await writeFile(stdoutPath, "");
      await writeFile(stderrPath, "");
      const state: WosState = {
        initialized: true,
        projectName: "shell-p",
        composeFile: "",
        backend: "shell",
        mode: "shell",
        worktreeRoot,
        sourcePath: worktreeRoot,
        portAssignments: {},
        shell: {
          services: {
            api: {
              pid: process.pid,
              command: ["sh", "-lc", "(run api)"],
              cwd: worktreeRoot,
              environmentKeys: [],
              logFiles: { stdout: stdoutPath, stderr: stderrPath },
              startedAt: "2026-05-29T00:00:00.000Z",
              ports: {},
            },
          },
        },
      };
      await writeFile(join(sessionRoot, "state.json"), JSON.stringify(state));

      const fakeCtx: SessionContext = {
        worktreeRoot,
        source: { path: worktreeRoot, bare: false, detached: false },
        config: shellConfig(),
        projectName: "shell-p",
        sessionName: sessionNameForWorktree(worktreeRoot),
        sessionRoot,
        state,
      };
      daemon = await startDaemon(
        withDaemonDefaults(tmpHome, {
          restorePersistedState: true,
          resolveSession: async () => fakeCtx,
        }),
      );
      expect(daemon.monitors.has(sessionNameForWorktree(worktreeRoot))).toBe(true);
    } finally {
      await teardownDaemonTestHome(tmpHome, daemon);
      daemon = null;
    }
  });
});
