import { test, expect, describe } from "bun:test";
import {
  DEFAULT_WAIT_TIMEOUT_MS,
  parseDuration,
  parseWaitArgs,
  runWaitViaDaemon,
} from "../apps/cli/commands/wait";
import type { UiClient } from "@worktreeos/daemon/ui-client";
import type { DeploymentStatus } from "@worktreeos/daemon/ui-protocol";
import { NotInsideWorktreeError, type GitRunner } from "@worktreeos/core/git";

const okGit: GitRunner = async (args) => {
  if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
    return "/fake-worktree\n";
  if (args[0] === "rev-parse" && args[1] === "--git-dir")
    return "/fake-worktree/.git\n";
  throw new Error(`unexpected git ${args.join(" ")}`);
};

const okBootstrap = () =>
  ({
    ensureRunning: async () => ({
      baseUrl: "http://127.0.0.1:1",
      health: { ok: true, version: "1" },
    }),
  }) as any;

function uiClientFromQueue(
  statuses: DeploymentStatus[],
  opts: { servicesAt?: number } = {},
): { client: UiClient; callCount: () => number } {
  let i = 0;
  let calls = 0;
  return {
    callCount: () => calls,
    client: {
      listProjects: async () => ({ projects: [] }),
      addProject: async () => ({ created: false, project: {} as any }),
      getWorktreeDetail: async (path: string) => {
        calls += 1;
        const idx = Math.min(i++, statuses.length - 1);
        const status = statuses[idx]!;
        const services =
          idx >= (opts.servicesAt ?? 0)
            ? [
                { service: "api", state: "running", status: "Up", ports: [] } as any,
              ]
            : [];
        return {
          worktree: {
            path,
            detached: false,
            isSource: true,
            sessionName: "session-x",
            status,
          } as any,
          projectId: "",
          projectName: "p",
          state: status === "not_started" ? null : ({} as any),
          services,
          appPortHealthchecks: [],
          tunnels: [],
        };
      },
      submitUp: async () => ({} as any),
      getOperation: async () => ({} as any),
      streamOperationEvents: async function* () {},
      streamWorktreeLogs: async function* () {},
      getStagedDiff: async () => ({ diff: "", empty: true }),
      getUnstagedDiff: async () => ({ diff: "", empty: true }),
    },
  };
}

describe("parseDuration", () => {
  test("plain integer is milliseconds", () => {
    expect(parseDuration("1500")).toBe(1500);
  });
  test("with ms suffix", () => {
    expect(parseDuration("1500ms")).toBe(1500);
  });
  test("with s suffix", () => {
    expect(parseDuration("30s")).toBe(30_000);
  });
  test("with m suffix", () => {
    expect(parseDuration("1m")).toBe(60_000);
  });
  test("fractional seconds", () => {
    expect(parseDuration("1.5s")).toBe(1500);
  });
  test("uppercase suffix accepted", () => {
    expect(parseDuration("2S")).toBe(2000);
  });
  test("rejects garbage", () => {
    expect(parseDuration("nope")).toBeNull();
  });
  test("rejects empty string", () => {
    expect(parseDuration("")).toBeNull();
  });
  test("rejects negative", () => {
    expect(parseDuration("-100")).toBeNull();
  });
  test("rejects zero", () => {
    expect(parseDuration("0")).toBeNull();
    expect(parseDuration("0s")).toBeNull();
  });
  test("rejects unknown suffix", () => {
    expect(parseDuration("10h")).toBeNull();
  });
});

describe("parseWaitArgs", () => {
  test("default timeout is 60000ms", () => {
    const out = parseWaitArgs([]);
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    expect(out.timeoutMs).toBe(DEFAULT_WAIT_TIMEOUT_MS);
    expect(DEFAULT_WAIT_TIMEOUT_MS).toBe(60_000);
  });

  test("parses --timeout 30s", () => {
    const out = parseWaitArgs(["--timeout", "30s"]);
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    expect(out.timeoutMs).toBe(30_000);
  });

  test("parses --timeout=1500ms", () => {
    const out = parseWaitArgs(["--timeout=1500ms"]);
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    expect(out.timeoutMs).toBe(1500);
  });

  test("invalid --timeout returns an error", () => {
    const out = parseWaitArgs(["--timeout", "nope"]);
    expect("error" in out).toBe(true);
  });

  test("missing --timeout value returns an error", () => {
    const out = parseWaitArgs(["--timeout"]);
    expect("error" in out).toBe(true);
  });

  test("--timeout= with empty value returns an error", () => {
    const out = parseWaitArgs(["--timeout="]);
    expect("error" in out).toBe(true);
  });

  test("unknown argument returns an error", () => {
    const out = parseWaitArgs(["--bogus"]);
    expect("error" in out).toBe(true);
  });
});

describe("runWaitViaDaemon behavior", () => {
  function setup(statuses: DeploymentStatus[], opts: { servicesAt?: number } = {}) {
    const { client: uiClient, callCount } = uiClientFromQueue(statuses, opts);
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
      uiClient,
      callCount,
      stdout,
      stderr,
      run: async (args: string[] = [], extra: { timeoutMs?: number } = {}) =>
        runWaitViaDaemon(args, {
          gitRunner: okGit,
          bootstrap: okBootstrap(),
          uiClient,
          stdoutWrite: (t) => stdout.push(t),
          stderrWrite: (t) => stderr.push(t),
          pollIntervalMs: 1,
          sleep: () => Promise.resolve(),
          now: extra.timeoutMs ? mockClock(extra.timeoutMs) : undefined,
        }),
    };
  }

  test("succeeds immediately when status is running", async () => {
    const ctx = setup(["running"]);
    const code = await ctx.run();
    expect(code).toBe(0);
    expect(ctx.callCount()).toBe(1);
    expect(ctx.stdout.join("")).toContain("api");
    expect(ctx.stdout.join("")).toContain("running");
  });

  test("polls through pending and checking until running", async () => {
    const ctx = setup(["pending", "checking", "running"], { servicesAt: 2 });
    const code = await ctx.run();
    expect(code).toBe(0);
    expect(ctx.callCount()).toBe(3);
  });

  test("polls through running_partial until running", async () => {
    const ctx = setup(["running_partial", "running"], { servicesAt: 1 });
    const code = await ctx.run();
    expect(code).toBe(0);
    expect(ctx.callCount()).toBe(2);
  });

  test("polls through unknown until running", async () => {
    const ctx = setup(["unknown", "running"], { servicesAt: 1 });
    const code = await ctx.run();
    expect(code).toBe(0);
    expect(ctx.callCount()).toBe(2);
  });

  test("fails fast when status is not_started", async () => {
    const ctx = setup(["not_started"]);
    const code = await ctx.run();
    expect(code).toBe(1);
    expect(ctx.stderr.join("")).toContain(
      "no wos deployment has been initialized",
    );
  });

  test("fails fast when status is failed", async () => {
    const ctx = setup(["failed"]);
    const code = await ctx.run();
    expect(code).toBe(1);
    expect(ctx.stderr.join("")).toContain("failed");
  });

  test("fails fast when status is stopped", async () => {
    const ctx = setup(["stopped"]);
    const code = await ctx.run();
    expect(code).toBe(1);
    expect(ctx.stderr.join("")).toContain("stopped");
  });

  test("times out and exits non-zero when status never becomes running", async () => {
    const ctx = setup(["pending"]);
    // Mock clock so deadline expires after the first poll.
    let t = 0;
    const code = await runWaitViaDaemon(["--timeout", "10ms"], {
      gitRunner: okGit,
      bootstrap: okBootstrap(),
      uiClient: ctx.uiClient,
      stdoutWrite: (t) => ctx.stdout.push(t),
      stderrWrite: (t) => ctx.stderr.push(t),
      pollIntervalMs: 1,
      sleep: () => Promise.resolve(),
      now: () => (t += 5),
    });
    expect(code).toBe(1);
    expect(ctx.stderr.join("")).toContain("timed out");
    expect(ctx.stderr.join("")).toContain("last status: pending");
  });
});

describe("runWaitViaDaemon worktree guard", () => {
  test("reports the worktree guard when not inside a git worktree and does not contact daemon for status", async () => {
    let ensured = 0;
    let detailCalls = 0;
    const guardGit: GitRunner = async () => {
      throw new NotInsideWorktreeError();
    };
    const uiClient: UiClient = {
      listProjects: async () => ({ projects: [] }),
      addProject: async () => ({ created: false, project: {} as any }),
      getWorktreeDetail: async () => {
        detailCalls += 1;
        return {} as any;
      },
      submitUp: async () => ({} as any),
      getOperation: async () => ({} as any),
      streamOperationEvents: async function* () {},
      streamWorktreeLogs: async function* () {},
      getStagedDiff: async () => ({ diff: "", empty: true }),
      getUnstagedDiff: async () => ({ diff: "", empty: true }),
    };
    const bootstrap = {
      ensureRunning: async () => {
        ensured += 1;
        return { baseUrl: "http://127.0.0.1:1", health: { ok: true } };
      },
    } as any;
    const stderr: string[] = [];
    const code = await runWaitViaDaemon([], {
      gitRunner: guardGit,
      bootstrap,
      uiClient,
      stdoutWrite: () => {},
      stderrWrite: (t) => stderr.push(t),
      pollIntervalMs: 1,
      sleep: () => Promise.resolve(),
    });
    expect(code).toBe(1);
    expect(stderr.join("")).toContain(
      "wos must be run from inside a Git worktree",
    );
    expect(detailCalls).toBe(0);
    expect(ensured).toBe(0);
  });
});

function mockClock(advancePerCall: number): () => number {
  let t = 0;
  return () => {
    const out = t;
    t += advancePerCall;
    return out;
  };
}
