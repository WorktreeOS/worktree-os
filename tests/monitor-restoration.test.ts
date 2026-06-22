import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startDaemon, type DaemonHandle } from "@worktreeos/daemon/daemon-server";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
  withDaemonDefaults,
} from "./helpers/daemon-test-harness.ts";
import type { SessionContext } from "@worktreeos/core/session-context";

function fakeContext(over: Partial<SessionContext> = {}): SessionContext {
  return {
    worktreeRoot: "/fake",
    source: { path: "/fake", bare: false, detached: false },
    config: {
      cloneVolumes: [],
      hostPorts: { start: 20000, end: 29999 },
      app: { image: null, initScript: [], services: {} },
      deps: {},
      cache: [],
    } as any,
    projectName: "p",
    sessionName: "fake-session",
    sessionRoot: "/tmp/fake-session",
    state: null,
    ...over,
  };
}

let tmpHome: string;
let daemon: DaemonHandle | null;

beforeEach(async () => {
  tmpHome = await createDaemonTestHome("wos-restore-");
  daemon = null;
});

afterEach(async () => {
  await teardownDaemonTestHome(tmpHome, daemon);
  daemon = null;
});

async function writeWorktreeConfig(worktreeRoot: string): Promise<void> {
  await mkdir(worktreeRoot, { recursive: true });
  await Bun.write(
    join(worktreeRoot, ".wos", "deploy.yaml"),
    "app:\n  services: {}\n",
  );
}

describe("Daemon startup monitor restoration", () => {
  test("registers monitors for initialized sessions without running up", async () => {
    // Create a fake initialized session state on disk.
    const worktreeRoot = join(tmpHome, "wt");
    await mkdir(worktreeRoot, { recursive: true });
    await writeWorktreeConfig(worktreeRoot);
    const { sessionRootForWorktree, sessionNameForWorktree } = await import(
      "@worktreeos/core/paths"
    );
    const sessionRoot = sessionRootForWorktree(worktreeRoot);
    await mkdir(sessionRoot, { recursive: true });
    const composeFile = join(sessionRoot, "compose.yaml");
    await writeFile(composeFile, "services: {}\n");
    const state = {
      initialized: true,
      projectName: "restored-p",
      composeFile,
      lastUp: "2026-05-18T00:00:00.000Z",
      worktreeRoot,
      sourcePath: worktreeRoot,
    };
    await writeFile(join(sessionRoot, "state.json"), JSON.stringify(state));

    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        restorePersistedState: true,
        resolveSession: async () => fakeContext(),
      }),
    );

    const sessionName = sessionNameForWorktree(worktreeRoot);
    expect(daemon.monitors.has(sessionName)).toBe(true);
  });

  test("does not spawn followers during daemon startup", async () => {
    const worktreeRoot = join(tmpHome, "wt");
    await mkdir(worktreeRoot, { recursive: true });
    await writeWorktreeConfig(worktreeRoot);
    const { sessionRootForWorktree, sessionNameForWorktree } = await import(
      "@worktreeos/core/paths"
    );
    const sessionRoot = sessionRootForWorktree(worktreeRoot);
    await mkdir(sessionRoot, { recursive: true });
    const composeFile = join(sessionRoot, "compose.yaml");
    await writeFile(composeFile, "services: {}\n");
    await writeFile(
      join(sessionRoot, "state.json"),
      JSON.stringify({
        initialized: true,
        projectName: "restored-p",
        composeFile,
        lastUp: "2026-05-18T00:00:00.000Z",
        worktreeRoot,
        sourcePath: worktreeRoot,
      }),
    );

    const started: string[] = [];
    const starter = ({ services }: { services: string[] }) => {
      started.push(...services);
      return services.map((s) => ({
        service: s,
        channel: `service:${s}` as const,
        stop: () => {},
        done: Promise.resolve(),
      }));
    };

    const dockerRunner = async (args: string[]) => {
      if (args.includes("ps")) {
        return {
          stdout: JSON.stringify([
            { Service: "api", State: "running" },
            { Service: "db", State: "running" },
          ]),
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        restorePersistedState: true,
        resolveSession: async () => fakeContext(),
        followerStarter: starter,
        dockerRunner,
      }),
    );

    const sessionName = sessionNameForWorktree(worktreeRoot);
    // After change `make-service-logs-on-demand`, daemon startup MUST NOT
    // spawn service log followers — they are request-scoped now.
    await new Promise((r) => setTimeout(r, 100));
    expect(started).toEqual([]);
    // Monitor still registers so service/healthcheck/tunnel events flow.
    expect(daemon.monitors.has(sessionName)).toBe(true);
    expect(daemon.sessions.get(sessionName)).toBeUndefined();
  });

  test("skips sessions with missing worktreeRoot without failing startup", async () => {
    const { sessionRootForWorktree } = await import("@worktreeos/core/paths");
    const sessionRoot = sessionRootForWorktree(join(tmpHome, "ghost"));
    await mkdir(sessionRoot, { recursive: true });
    // Initialized but no worktreeRoot field.
    await writeFile(
      join(sessionRoot, "state.json"),
      JSON.stringify({
        initialized: true,
        projectName: "x",
        composeFile: "/c.yaml",
      }),
    );

    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        restorePersistedState: true,
        resolveSession: async () => fakeContext(),
      }),
    );
    // Daemon started — that alone is the assertion. Confirm no monitor.
    expect(daemon.monitors.size()).toBe(0);
  });
});
