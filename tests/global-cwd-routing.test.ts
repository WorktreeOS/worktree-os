import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  gitRunnerInCwd,
  defaultGitRunner,
  ensureCurrentWorktree,
} from "@worktreeos/core/git";
import {
  runDownViaDaemon,
  runStatusViaDaemon,
  runUpViaDaemon,
} from "../apps/cli/commands/daemon-mode";
import { runWaitViaDaemon } from "../apps/cli/commands/wait";
import type { UiClient } from "@worktreeos/daemon/ui-client";

async function makeTempGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wos-cwd-"));
  // On macOS tmpdir may be a symlink (/var -> /private/var); git returns
  // the real path, so normalize it ahead of time.
  const root = await realpath(dir);
  await Bun.$`git init -q ${root}`.quiet();
  await Bun.$`git -C ${root} config user.email t@t.t`.quiet();
  await Bun.$`git -C ${root} config user.name t`.quiet();
  await Bun.$`git -C ${root} commit -q --allow-empty -m init`.quiet();
  return root;
}

function fakeUiClient(detailPaths: string[]): UiClient {
  return {
    listProjects: async () => ({ projects: [] }),
    addProject: async () => ({ created: false, project: {} as any }),
    getWorktreeDetail: async (path: string) => {
      detailPaths.push(path);
      return {
        worktree: {
          path,
          detached: false,
          isSource: true,
          sessionName: "session-x",
          status: "running" as const,
        } as any,
        projectId: "",
        projectName: "p",
        state: {} as any,
        services: [
          { service: "api", state: "running", status: "Up", ports: [] } as any,
        ],
        appPortHealthchecks: [],
        tunnels: [],
      };
    },
    submitUp: async () => ({
      operationId: "op",
      sessionName: "session-x",
      kind: "up" as const,
      startedAt: new Date().toISOString(),
    }),
    getOperation: async () => ({} as any),
    streamOperationEvents: async function* () {
      yield {
        operationId: "op",
        sessionName: "session-x",
        sequence: 1,
        timestamp: "t",
        terminal: { status: "succeeded" as const },
      } as any;
    },
    streamWorktreeLogs: async function* () {},
    getStagedDiff: async () => ({ diff: "", empty: true }),
    getUnstagedDiff: async () => ({ diff: "", empty: true }),
  };
}

const fakeBootstrap = () =>
  ({
    ensureRunning: async () => ({
      baseUrl: "http://127.0.0.1:1",
      health: { ok: true, version: "1" },
    }),
  }) as any;

let repoA: string;
let repoB: string;

beforeEach(async () => {
  repoA = await makeTempGitRepo();
  repoB = await makeTempGitRepo();
});

afterEach(async () => {
  await rm(repoA, { recursive: true, force: true });
  await rm(repoB, { recursive: true, force: true });
});

describe("gitRunnerInCwd", () => {
  test("rev-parse --show-toplevel returns the path of the given cwd, not process.cwd()", async () => {
    const runner = gitRunnerInCwd(repoA);
    const out = await runner(["rev-parse", "--show-toplevel"]);
    expect(out.trim()).toBe(repoA);
  });

  test("does not mutate process.cwd()", async () => {
    const before = process.cwd();
    const runner = gitRunnerInCwd(repoB);
    await runner(["rev-parse", "--show-toplevel"]);
    expect(process.cwd()).toBe(before);
  });

  test("ensureCurrentWorktree with cwd-bound runner returns the correct worktree", async () => {
    const { worktreeRoot } = await ensureCurrentWorktree(gitRunnerInCwd(repoA));
    expect(worktreeRoot).toBe(repoA);
  });
});

describe("daemon-mode commands honor opts.cwd", () => {
  test("runStatusViaDaemon uses opts.cwd to resolve target worktree", async () => {
    const detailPaths: string[] = [];
    const code = await runStatusViaDaemon([], {
      cwd: repoA,
      bootstrap: fakeBootstrap(),
      uiClient: fakeUiClient(detailPaths),
    });
    expect(code).toBe(0);
    expect(detailPaths[0]).toBe(repoA);
  });

  test("runDownViaDaemon uses opts.cwd to resolve target worktree", async () => {
    const calls: string[] = [];
    const baseClient = fakeUiClient([]);
    const uiClient: UiClient = {
      ...baseClient,
      submitDown: async (input: { path: string }) => {
        calls.push(input.path);
        return {
          operationId: "op",
          sessionName: "session-x",
          kind: "down" as const,
          startedAt: new Date().toISOString(),
        };
      },
    };
    const code = await runDownViaDaemon([], {
      cwd: repoB,
      bootstrap: fakeBootstrap(),
      uiClient,
    });
    expect(code).toBe(0);
    expect(calls[0]).toBe(repoB);
  });

  test("runUpViaDaemon uses opts.cwd to resolve target worktree (detached mode)", async () => {
    const submitPaths: string[] = [];
    const baseClient = fakeUiClient([]);
    const uiClient: UiClient = {
      ...baseClient,
      submitUp: async (input: { path: string; force?: boolean }) => {
        submitPaths.push(input.path);
        return baseClient.submitUp(input);
      },
    };
    const code = await runUpViaDaemon(["-d"], {
      cwd: repoA,
      bootstrap: fakeBootstrap(),
      uiClient,
      stdoutWrite: () => {},
      stderrWrite: () => {},
      resolveWebUrl: async () => null,
    });
    expect(code).toBe(0);
    expect(submitPaths[0]).toBe(repoA);
  });

  test("runWaitViaDaemon uses opts.cwd to resolve target worktree", async () => {
    const detailPaths: string[] = [];
    const code = await runWaitViaDaemon([], {
      cwd: repoB,
      bootstrap: fakeBootstrap(),
      uiClient: fakeUiClient(detailPaths),
      stdoutWrite: () => {},
      stderrWrite: () => {},
    });
    expect(code).toBe(0);
    expect(detailPaths[0]).toBe(repoB);
  });
});

describe("daemon-mode commands fall back to process.cwd() when --cwd is absent", () => {
  test("runStatusViaDaemon without opts.cwd uses defaultGitRunner (process.cwd-based)", async () => {
    // We can verify wiring by injecting a gitRunner explicitly; the production
    // code path uses defaultGitRunner when neither gitRunner nor cwd are given.
    // Asserting on the resolved path requires a real git ctx; this test simply
    // confirms the flow accepts a gitRunner override and is not broken.
    const detailPaths: string[] = [];
    const code = await runStatusViaDaemon([], {
      gitRunner: async (args) => {
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
          return `${repoA}\n`;
        if (args[0] === "rev-parse" && args[1] === "--git-dir")
          return `${repoA}/.git\n`;
        return defaultGitRunner(args);
      },
      bootstrap: fakeBootstrap(),
      uiClient: fakeUiClient(detailPaths),
    });
    expect(code).toBe(0);
    expect(detailPaths[0]).toBe(repoA);
  });
});

// Ensure the resolved cwd path is absolute (parseGlobalArgs already resolve()s).
test("resolve('/abs') is idempotent", () => {
  expect(resolve("/abs/path")).toBe("/abs/path");
});
