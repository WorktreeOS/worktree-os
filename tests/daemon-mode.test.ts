import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { resolve } from "node:path";
import {
  runDownViaDaemon,
  runStatusViaDaemon,
  runUpViaDaemon,
  runWorktreeRemoveViaDaemon,
} from "../apps/cli/commands/daemon-mode";
import { UiSessionBusyError } from "@worktreeos/daemon/ui-client";
import { startDaemon, type DaemonHandle } from "@worktreeos/daemon/daemon-server";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
  withDaemonDefaults,
} from "./helpers/daemon-test-harness.ts";
import type { UiClient } from "@worktreeos/daemon/ui-client";
import type { Renderer } from "@worktreeos/ui/renderer";
import type { SessionContext } from "@worktreeos/core/session-context";
import { NotInsideWorktreeError, type GitRunner } from "@worktreeos/core/git";

function fakeContext(over: Partial<SessionContext> = {}): SessionContext {
  return {
    worktreeRoot: "/fake",
    source: { path: "/fake", bare: false, detached: false },
    config: {
      cloneVolumes: [],
      hostPorts: { start: 20000, end: 29999 },
      app: { initScript: [] },
      cache: [],
    } as any,
    projectName: "p",
    sessionName: "fake-session",
    sessionRoot: "/tmp/fake-session",
    state: null,
    ...over,
  };
}

const okGit: GitRunner = async (args) => {
  if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/fake\n";
  if (args[0] === "rev-parse" && args[1] === "--git-dir") return "/fake/.git\n";
  if (args[0] === "worktree" && args[1] === "list") return "worktree /fake\n";
  throw new Error(`unexpected git ${args.join(" ")}`);
};

const nonWorktreeGit: GitRunner = async () => {
  throw new (class extends Error {
    constructor() {
      super("fatal: not a git repository");
    }
  })();
};

let home: string;
let daemon: DaemonHandle | null;

beforeEach(async () => {
  home = await createDaemonTestHome("wos-daemon-mode-");
  daemon = null;
});

afterEach(async () => {
  await teardownDaemonTestHome(home, daemon);
});

const okFakeBootstrap = () =>
  ({
    ensureRunning: async () => ({
      baseUrl: "http://127.0.0.1:1",
      health: { ok: true, version: "1" },
    }),
  }) as any;

interface FakeUiCounters {
  getWorktreeCalls: number;
  getWorktreePaths: string[];
  submitUpCalls: number;
  streamEventCalls: number;
  streamLogCalls: number;
  submitUpForce: boolean[];
}

function makeFakeUiClient(opts: {
  services?: any[];
  appPortHealthchecks?: any[];
  tunnels?: any[];
  terminalStatus?: "succeeded" | "failed";
  terminalFailureMessage?: string;
  status?: "not-started" | "running" | "deploying";
  detailKind?: "not-started" | "ok";
  streamEvents?: Array<any>;
  counters?: FakeUiCounters;
}): UiClient {
  const services = opts.services ?? [];
  const appPortHealthchecks = opts.appPortHealthchecks ?? [];
  const tunnels = opts.tunnels ?? [];
  const terminal = opts.terminalStatus ?? "succeeded";
  const counters = opts.counters;
  return {
    listProjects: async () => ({ projects: [] }),
    addProject: async () => ({ created: false, project: {} as any }),
    getWorktreeDetail: async (path: string) => {
      counters && (counters.getWorktreeCalls += 1);
      counters?.getWorktreePaths.push(path);
      return {
        worktree: {
          path,
          detached: false,
          isSource: true,
          sessionName: "session-x",
          status: opts.status ?? (opts.detailKind === "not-started" ? "not-started" : "running"),
        } as any,
        projectId: "",
        projectName: "p",
        state: opts.detailKind === "not-started" ? null : ({} as any),
        services,
        appPortHealthchecks,
        tunnels,
      };
    },
    submitUp: async (input: { path: string; force?: boolean }) => {
      counters && (counters.submitUpCalls += 1);
      counters && counters.submitUpForce.push(Boolean(input.force));
      return {
        operationId: "op",
        sessionName: "session-x",
        kind: "up" as const,
        startedAt: new Date().toISOString(),
      };
    },
    getOperation: async () => ({} as any),
    streamOperationEvents: async function* () {
      counters && (counters.streamEventCalls += 1);
      for (const ev of opts.streamEvents ?? []) {
        yield ev;
      }
      yield {
        operationId: "op",
        sessionName: "session-x",
        sequence: 999,
        timestamp: "t",
        terminal: {
          status: terminal,
          ...(opts.terminalFailureMessage
            ? { failureMessage: opts.terminalFailureMessage }
            : {}),
        },
      } as any;
    },
    streamWorktreeLogs: async function* () {
      counters && (counters.streamLogCalls += 1);
    },
    getStagedDiff: async () => ({ diff: "", empty: true }),
    getUnstagedDiff: async () => ({ diff: "", empty: true }),
  };
}

function makeCounters(): FakeUiCounters {
  return {
    getWorktreeCalls: 0,
    getWorktreePaths: [],
    submitUpCalls: 0,
    streamEventCalls: 0,
    streamLogCalls: 0,
    submitUpForce: [],
  };
}

function captureRenderer(): {
  emitted: Array<any>;
  factory: () => Renderer;
  startCalls: number;
  stopCalls: number;
} {
  const emitted: Array<any> = [];
  const state = { startCalls: 0, stopCalls: 0 };
  const factory = (): Renderer => ({
    observer: { emit: (ev) => emitted.push(ev) },
    stdout: () => {},
    start() {
      state.startCalls += 1;
    },
    stop() {
      state.stopCalls += 1;
    },
  });
  return {
    emitted,
    factory,
    get startCalls() {
      return state.startCalls;
    },
    get stopCalls() {
      return state.stopCalls;
    },
  };
}

describe("runUpViaDaemon worktree guard", () => {
  test("returns 1 and writes the worktree guard message when not in a worktree", async () => {
    const guardGit: GitRunner = async () => {
      throw new NotInsideWorktreeError();
    };
    const code = await runUpViaDaemon([], { gitRunner: guardGit });
    expect(code).toBe(1);
  });
});

describe("runStatusViaDaemon", () => {
  test("prints no-deployment message when worktree is not-started", async () => {
    const counters = makeCounters();
    const code = await runStatusViaDaemon([], {
      gitRunner: okGit,
      bootstrap: okFakeBootstrap(),
      uiClient: makeFakeUiClient({ status: "not-started", detailKind: "not-started", counters }),
    });
    expect(code).toBe(0);
    expect(counters.getWorktreeCalls).toBe(1);
  });
});

describe("runUpViaDaemon busy session via daemon", () => {
  test("reports busy session and active operation id", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(home, {
        resolveSession: async () => fakeContext(),
      }),
    );
    daemon.registry.begin("fake-session", "up");
    const { createUiClient } = await import("@worktreeos/daemon/ui-client");
    const uiClient = createUiClient({ baseUrl: daemon.webUrl });
    const cap = captureRenderer();
    const code = await runUpViaDaemon([], {
      gitRunner: okGit,
      bootstrap: okFakeBootstrap(),
      uiClient,
      rendererFactory: cap.factory,
      resolveWebUrl: async () => null,
    });
    expect(code).toBe(1);
  });
});

describe("runDownViaDaemon", () => {
  test("succeeds when no deployment is initialized", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(home, {
        resolveSession: async () => fakeContext({ state: null }),
      }),
    );
    const { createUiClient } = await import("@worktreeos/daemon/ui-client");
    const uiClient = createUiClient({ baseUrl: daemon.webUrl });
    const code = await runDownViaDaemon([], {
      gitRunner: okGit,
      bootstrap: okFakeBootstrap(),
      uiClient,
    });
    expect(code).toBe(0);
  });
});

describe("guard precedes daemon contact", () => {
  test("up reports guard without touching the daemon client", async () => {
    let touched = 0;
    const fakeBootstrap = {
      ensureRunning: async () => {
        touched += 1;
        return { baseUrl: "http://127.0.0.1:1", health: { ok: true } };
      },
    } as any;
    const code = await runUpViaDaemon([], {
      gitRunner: nonWorktreeGit,
      bootstrap: fakeBootstrap,
      uiClient: makeFakeUiClient({}),
    });
    expect(code).toBe(1);
    expect(touched).toBe(0);
  });
});

describe("runUpViaDaemon foreground mode (default)", () => {
  test("submits up, drains progress, prints final summary and web URL on success", async () => {
    const counters = makeCounters();
    const cap = captureRenderer();
    const out: string[] = [];
    const err: string[] = [];
    const code = await runUpViaDaemon([], {
      gitRunner: okGit,
      bootstrap: okFakeBootstrap(),
      uiClient: makeFakeUiClient({
        services: [
          {
            service: "api",
            state: "running",
            status: "Up 1s",
            ports: [
              { hostIp: "0.0.0.0", hostPort: 20100, containerPort: 3000, protocol: "tcp" },
            ],
          },
        ],
        streamEvents: [
          {
            operationId: "op",
            sessionName: "session-x",
            sequence: 1,
            timestamp: "t",
            event: { type: "step", id: "prepare", state: "running" },
          },
          {
            operationId: "op",
            sessionName: "session-x",
            sequence: 2,
            timestamp: "t",
            event: { type: "step", id: "prepare", state: "done" },
          },
        ],
        counters,
      }),
      rendererFactory: cap.factory,
      stdoutWrite: (t) => out.push(t),
      stderrWrite: (t) => err.push(t),
      resolveWebUrl: async () => "http://127.0.0.1:4949/worktree?path=%2Ffake",
    });
    expect(code).toBe(0);
    expect(counters.submitUpCalls).toBe(1);
    expect(counters.streamEventCalls).toBe(1);
    expect(counters.submitUpForce).toEqual([false]);
    // Renderer received progress events through observer.emit.
    expect(cap.emitted.length).toBeGreaterThan(0);
    expect(cap.startCalls).toBe(1);
    expect(cap.stopCalls).toBe(1);
    const text = out.join("");
    expect(text).toContain("api");
    expect(text).toContain("running");
    expect(text).toContain("http://127.0.0.1:4949/worktree?path=%2Ffake");
    // Foreground mode no longer streams session logs — it exits after the
    // operation reaches terminal.
    expect(counters.streamLogCalls).toBe(0);
  });

  test("returns 1 and reports failure when operation fails", async () => {
    const cap = captureRenderer();
    const out: string[] = [];
    const err: string[] = [];
    const code = await runUpViaDaemon([], {
      gitRunner: okGit,
      bootstrap: okFakeBootstrap(),
      uiClient: makeFakeUiClient({
        terminalStatus: "failed",
        terminalFailureMessage: "compose failed",
        services: [],
      }),
      rendererFactory: cap.factory,
      stdoutWrite: (t) => out.push(t),
      stderrWrite: (t) => err.push(t),
      resolveWebUrl: async () => "http://127.0.0.1:4949/worktree?path=%2Ffake",
    });
    expect(code).toBe(1);
    // No final summary or web URL printed on failure.
    expect(out.join("")).toBe("");
    expect(err.join("")).toContain("wos up failed");
    expect(err.join("")).toContain("compose failed");
    // Renderer started + stopped properly.
    expect(cap.startCalls).toBe(1);
    expect(cap.stopCalls).toBe(1);
  });

  test("reports web URL unavailable when daemon metadata has no webUrl", async () => {
    const cap = captureRenderer();
    const out: string[] = [];
    const code = await runUpViaDaemon([], {
      gitRunner: okGit,
      bootstrap: okFakeBootstrap(),
      uiClient: makeFakeUiClient({ services: [] }),
      rendererFactory: cap.factory,
      stdoutWrite: (t) => out.push(t),
      stderrWrite: () => {},
      resolveWebUrl: async () => null,
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("Web UI unavailable");
  });

  test("forwards --force to the daemon submit call", async () => {
    const counters = makeCounters();
    const cap = captureRenderer();
    const code = await runUpViaDaemon(["--force"], {
      gitRunner: okGit,
      bootstrap: okFakeBootstrap(),
      uiClient: makeFakeUiClient({ services: [], counters }),
      rendererFactory: cap.factory,
      stdoutWrite: () => {},
      stderrWrite: () => {},
      resolveWebUrl: async () => null,
    });
    expect(code).toBe(0);
    expect(counters.submitUpForce).toEqual([true]);
  });
});

describe("runUpViaDaemon detached mode (-d)", () => {
  test("submits and exits immediately with accepted-start message and URL", async () => {
    const counters = makeCounters();
    const out: string[] = [];
    const err: string[] = [];
    const code = await runUpViaDaemon(["-d"], {
      gitRunner: okGit,
      bootstrap: okFakeBootstrap(),
      uiClient: makeFakeUiClient({ services: [], counters }),
      stdoutWrite: (t) => out.push(t),
      stderrWrite: (t) => err.push(t),
      resolveWebUrl: async () => "http://127.0.0.1:4949/worktree?path=%2Ffake",
    });
    expect(code).toBe(0);
    expect(counters.submitUpCalls).toBe(1);
    // Detached mode must NOT drain the operation stream.
    expect(counters.streamEventCalls).toBe(0);
    // It also must NOT query the final service summary.
    expect(counters.getWorktreeCalls).toBe(0);
    const text = out.join("");
    expect(text).toContain("deployment started in the background");
    expect(text).toContain("http://127.0.0.1:4949/worktree?path=%2Ffake");
  });

  test("preserves --force in detached mode", async () => {
    const counters = makeCounters();
    const code = await runUpViaDaemon(["-d", "--force"], {
      gitRunner: okGit,
      bootstrap: okFakeBootstrap(),
      uiClient: makeFakeUiClient({ services: [], counters }),
      stdoutWrite: () => {},
      stderrWrite: () => {},
      resolveWebUrl: async () => null,
    });
    expect(code).toBe(0);
    expect(counters.submitUpCalls).toBe(1);
    expect(counters.submitUpForce).toEqual([true]);
    expect(counters.streamEventCalls).toBe(0);
  });

  test("reports web URL unavailable when daemon metadata lacks webUrl", async () => {
    const counters = makeCounters();
    const out: string[] = [];
    const code = await runUpViaDaemon(["-d"], {
      gitRunner: okGit,
      bootstrap: okFakeBootstrap(),
      uiClient: makeFakeUiClient({ services: [], counters }),
      stdoutWrite: (t) => out.push(t),
      stderrWrite: () => {},
      resolveWebUrl: async () => null,
    });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("deployment started in the background");
    expect(text).toContain("Web UI unavailable");
  });
});

interface FakeRemoveCounters {
  submitCalls: number;
  submitDiscardChanges: boolean[];
  submittedPaths: string[];
  streamEventCalls: number;
}

function makeRemoveCounters(): FakeRemoveCounters {
  return {
    submitCalls: 0,
    submitDiscardChanges: [],
    submittedPaths: [],
    streamEventCalls: 0,
  };
}

function makeRemoveUiClient(opts: {
  terminalStatus?: "succeeded" | "failed";
  terminalFailureMessage?: string;
  events?: Array<any>;
  busy?: { sessionName: string; activeOperationId: string };
  counters?: FakeRemoveCounters;
}): UiClient {
  const counters = opts.counters;
  return {
    listProjects: async () => ({ projects: [] }),
    addProject: async () => ({ created: false, project: {} as any }),
    getWorktreeDetail: async () => ({} as any),
    submitUp: async () => ({} as any),
    submitWorktreeRemove: async (req: {
      path: string;
      discardChanges?: boolean;
    }) => {
      counters && (counters.submitCalls += 1);
      counters && counters.submitDiscardChanges.push(Boolean(req.discardChanges));
      counters && counters.submittedPaths.push(req.path);
      if (opts.busy) {
        throw new UiSessionBusyError("session is busy", 409, {
          error: "session-busy",
          sessionName: opts.busy.sessionName,
          active: {
            operationId: opts.busy.activeOperationId,
            kind: "up",
            sessionName: opts.busy.sessionName,
            status: "running",
            startedAt: new Date().toISOString(),
          },
        } as any);
      }
      return {
        operationId: "rm-op",
        sessionName: "session-x",
        kind: "worktree-remove" as const,
        startedAt: new Date().toISOString(),
      };
    },
    getOperation: async () => ({} as any),
    streamOperationEvents: async function* () {
      counters && (counters.streamEventCalls += 1);
      for (const ev of opts.events ?? []) yield ev;
      yield {
        operationId: "rm-op",
        sessionName: "session-x",
        sequence: 999,
        timestamp: "t",
        terminal: {
          status: opts.terminalStatus ?? "succeeded",
          ...(opts.terminalFailureMessage
            ? { failureMessage: opts.terminalFailureMessage }
            : {}),
        },
      } as any;
    },
    streamWorktreeLogs: async function* () {},
    getStagedDiff: async () => ({ diff: "", empty: true }),
    getUnstagedDiff: async () => ({ diff: "", empty: true }),
  } as unknown as UiClient;
}

describe("runWorktreeRemoveViaDaemon", () => {
  test("worktree guard precedes daemon contact", async () => {
    const counters = makeRemoveCounters();
    let ensureCalls = 0;
    const fakeBootstrap = {
      ensureRunning: async () => {
        ensureCalls += 1;
        return { baseUrl: "http://127.0.0.1:1", health: { ok: true } };
      },
    } as any;
    const code = await runWorktreeRemoveViaDaemon(
      { force: false },
      {
        gitRunner: nonWorktreeGit,
        bootstrap: fakeBootstrap,
        uiClient: makeRemoveUiClient({ counters }),
      },
    );
    expect(code).toBe(1);
    expect(ensureCalls).toBe(0);
    expect(counters.submitCalls).toBe(0);
  });

  test("submits removal and exits 0 on success", async () => {
    const counters = makeRemoveCounters();
    const out: string[] = [];
    const err: string[] = [];
    const code = await runWorktreeRemoveViaDaemon(
      { force: false },
      {
        gitRunner: okGit,
        bootstrap: okFakeBootstrap(),
        uiClient: makeRemoveUiClient({ counters }),
        stdoutWrite: (t) => out.push(t),
        stderrWrite: (t) => err.push(t),
      },
    );
    expect(code).toBe(0);
    expect(counters.submitCalls).toBe(1);
    expect(counters.submitDiscardChanges).toEqual([false]);
    expect(counters.submittedPaths[0]).toBe("/fake");
    expect(counters.streamEventCalls).toBe(1);
  });

  test("forwards --force as discardChanges to the daemon submit call", async () => {
    const counters = makeRemoveCounters();
    const code = await runWorktreeRemoveViaDaemon(
      { force: true },
      {
        gitRunner: okGit,
        bootstrap: okFakeBootstrap(),
        uiClient: makeRemoveUiClient({ counters }),
        stdoutWrite: () => {},
        stderrWrite: () => {},
      },
    );
    expect(code).toBe(0);
    expect(counters.submitDiscardChanges).toEqual([true]);
  });

  test("reports failure and exits 1 when daemon reports failed terminal", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runWorktreeRemoveViaDaemon(
      { force: false },
      {
        gitRunner: okGit,
        bootstrap: okFakeBootstrap(),
        uiClient: makeRemoveUiClient({
          terminalStatus: "failed",
          terminalFailureMessage: "fatal: dirty",
        }),
        stdoutWrite: (t) => out.push(t),
        stderrWrite: (t) => err.push(t),
      },
    );
    expect(code).toBe(1);
    expect(err.join("")).toContain("wos worktree remove failed");
    expect(err.join("")).toContain("fatal: dirty");
  });

  test("reports session-busy without streaming events", async () => {
    const counters = makeRemoveCounters();
    const err: string[] = [];
    const code = await runWorktreeRemoveViaDaemon(
      { force: false },
      {
        gitRunner: okGit,
        bootstrap: okFakeBootstrap(),
        uiClient: makeRemoveUiClient({
          counters,
          busy: { sessionName: "fake-session", activeOperationId: "active-op" },
        }),
        stdoutWrite: () => {},
        stderrWrite: (t) => err.push(t),
      },
    );
    expect(code).toBe(1);
    expect(counters.submitCalls).toBe(1);
    expect(counters.streamEventCalls).toBe(0);
    expect(err.join("")).toContain("session fake-session is busy");
    expect(err.join("")).toContain("active op active-op");
  });
});
