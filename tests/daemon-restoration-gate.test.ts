import { test, expect, describe } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startDaemon, type DaemonHandle } from "@worktreeos/daemon/daemon-server";
import {
  createDaemonTestHarness,
  withDaemonDefaults,
} from "./helpers/daemon-test-harness.ts";

describe("daemon restoration gate", () => {
  test("restorePersistedState false skips monitor restoration", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "wos-restore-gate-"));
    const prevHome = process.env.WOS_HOME;
    process.env.WOS_HOME = tmpHome;
    const worktreeRoot = join(tmpHome, "wt");
    await mkdir(worktreeRoot, { recursive: true });
    await Bun.write(join(worktreeRoot, ".wos", "deploy.yaml"), "app:\n  services: {}\n");
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
        projectName: "p",
        composeFile,
        lastUp: "2026-05-18T00:00:00.000Z",
        worktreeRoot,
        sourcePath: worktreeRoot,
      }),
    );

    let daemon: DaemonHandle | null = null;
    try {
      daemon = await startDaemon(
        withDaemonDefaults(tmpHome, {
          restorePersistedState: false,
          resolveSession: async () => ({}) as any,
        }),
      );
      expect(daemon.monitors.has(sessionNameForWorktree(worktreeRoot))).toBe(false);
    } finally {
      if (daemon) await daemon.stop();
      if (prevHome === undefined) delete process.env.WOS_HOME;
      else process.env.WOS_HOME = prevHome;
      await rm(tmpHome, { recursive: true, force: true });
    }
  });

  test("restorePersistedState true restores from the test wos home", async () => {
    const harness = await createDaemonTestHarness({
      restorePersistedState: true,
      resolveSession: async () => ({}) as any,
      dockerRunner: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });
    const worktreeRoot = join(harness.wosHome, "wt");
    await mkdir(worktreeRoot, { recursive: true });
    await Bun.write(join(worktreeRoot, ".wos", "deploy.yaml"), "app:\n  services: {}\n");
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
        projectName: "p",
        composeFile,
        lastUp: "2026-05-18T00:00:00.000Z",
        worktreeRoot,
        sourcePath: worktreeRoot,
      }),
    );

    await harness.daemon.stop();
    const restored = await createDaemonTestHarness({
      wosHome: harness.wosHome,
      restorePersistedState: true,
      resolveSession: async () => ({}) as any,
      dockerRunner: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });
    try {
      expect(
        restored.daemon.monitors.has(sessionNameForWorktree(worktreeRoot)),
      ).toBe(true);
    } finally {
      await restored.stop();
    }
  });
});
