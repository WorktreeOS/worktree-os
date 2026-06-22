import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startDaemon, type DaemonHandle } from "@worktreeos/daemon/daemon-server";
import type { SessionContext } from "@worktreeos/core/session-context";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
  withDaemonDefaults,
} from "./helpers/daemon-test-harness.ts";
import { createUiApi, UiWorktreeDirtyError } from "../apps/web/src/lib/ui-api";

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
  tmpHome = await createDaemonTestHome("wos-web-ui-");
  daemon = null;
});

afterEach(async () => {
  await teardownDaemonTestHome(tmpHome, daemon);
});

async function startWithHome() {
  return startDaemon(
    withDaemonDefaults(tmpHome, {
      resolveSession: async () => fakeContext(),
      web: { host: "127.0.0.1", port: 0, assetRoot: undefined },
    }),
  );
}

describe("web ui-api client against live daemon", () => {
  test("listProjects returns empty list", async () => {
    daemon = await startWithHome();
    const api = createUiApi(daemon.webUrl!);
    const res = await api.listProjects();
    expect(res.projects).toEqual([]);
  });

  test("addProject reports validation error for missing path", async () => {
    daemon = await startWithHome();
    const api = createUiApi(daemon.webUrl!);
    try {
      await api.addProject({ path: join(tmpHome, "nope") });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as Error).message).toContain("path not found");
    }
  });

  test("submitDown returns an operation id even without initialized deployment", async () => {
    daemon = await startWithHome();
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const api = createUiApi(daemon.webUrl!);
    const res = await api.submitDown(wt);
    expect(res.kind).toBe("down");
    expect(typeof res.operationId).toBe("string");
  });

  test("listDirectories returns children for a given directory", async () => {
    daemon = await startWithHome();
    const root = join(tmpHome, "browse-root");
    await mkdir(join(root, "alpha"), { recursive: true });
    await mkdir(join(root, "beta"), { recursive: true });
    const api = createUiApi(daemon.webUrl!);
    const res = await api.listDirectories(root);
    const names = res.entries.map((e) => e.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
    // All entries are flagged as not-git when the system git binary cannot
    // resolve them as worktrees — this is the local fallback path.
    expect(res.entries.every((e) => e.isGitWorktree === false)).toBe(true);
  });

  test("validateProjectPath reports invalid for a non-git directory", async () => {
    daemon = await startWithHome();
    const dir = join(tmpHome, "plain");
    await mkdir(dir, { recursive: true });
    const api = createUiApi(daemon.webUrl!);
    const res = await api.validateProjectPath(dir);
    expect(res.valid).toBe(false);
    expect(typeof res.message).toBe("string");
  });

  test("submitUp rejects mixed services/target selection", async () => {
    daemon = await startWithHome();
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const api = createUiApi(daemon.webUrl!);
    let caught: unknown;
    try {
      await api.submitUp(wt, false, { services: ["app"], target: "all" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
  });

  test("submitUp forwards arguments payload via daemon", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async (cwd) =>
          fakeContext({
            worktreeRoot: cwd,
            config: {
              cloneVolumes: [],
              hostPorts: { start: 20000, end: 29999 },
              app: { image: null, initScript: [], services: {} },
              deps: {},
              cache: [],
              arguments: ["API_URL"],
            } as any,
          }),
        web: { host: "127.0.0.1", port: 0, assetRoot: undefined },
      }),
    );
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const api = createUiApi(daemon.webUrl!);
    const res = await api.submitUp(wt, false, {
      arguments: { API_URL: "https://empl-stage.test-wa.ru" },
    });
    expect(res.kind).toBe("up");
    expect(typeof res.operationId).toBe("string");
  });

  test("submitUp rejects undeclared runtime argument", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async (cwd) =>
          fakeContext({
            worktreeRoot: cwd,
            config: {
              cloneVolumes: [],
              hostPorts: { start: 20000, end: 29999 },
              app: { image: null, initScript: [], services: {} },
              deps: {},
              cache: [],
              arguments: ["API_URL"],
            } as any,
          }),
        web: { host: "127.0.0.1", port: 0, assetRoot: undefined },
      }),
    );
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const api = createUiApi(daemon.webUrl!);
    let caught: unknown;
    try {
      await api.submitUp(wt, false, { arguments: { OTHER: "x" } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).message).toMatch(/not declared/);
  });

  test("submitUp rejects empty services list", async () => {
    daemon = await startWithHome();
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const api = createUiApi(daemon.webUrl!);
    let caught: unknown;
    try {
      await api.submitUp(wt, false, { services: [] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
  });

  test("submitServiceStop validates missing service name", async () => {
    daemon = await startWithHome();
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const api = createUiApi(daemon.webUrl!);
    let caught: unknown;
    try {
      await api.submitServiceStop(wt, "");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).message).toContain("service");
  });

  test("submitServiceRestart rejects without initialized deployment", async () => {
    daemon = await startWithHome();
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const api = createUiApi(daemon.webUrl!);
    let caught: unknown;
    try {
      await api.submitServiceRestart(wt, "api");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).message).toContain("no wos deployment");
  });

  test("getWorktreeDetail returns not-started for a fresh worktree dir", async () => {
    daemon = await startWithHome();
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    // Without a git worktree, listWorktrees fails — detail still returns
    // with empty branch/projectId but status is not-started.
    const api = createUiApi(daemon.webUrl!);
    const detail = await api.getWorktreeDetail(wt);
    expect(detail.worktree.status).toBe("not_started");
    expect(detail.state).toBeNull();
  });

  test("getWorktreeDetail returns pending when an active up exists before init", async () => {
    daemon = await startWithHome();
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const { sessionNameForWorktree } = await import("@worktreeos/core/paths");
    const sessionName = sessionNameForWorktree(wt);
    const begin = daemon.registry.begin(sessionName, "up");
    if (!begin.ok) throw new Error("begin failed");
    const api = createUiApi(daemon.webUrl!);
    const detail = await api.getWorktreeDetail(wt);
    expect(detail.worktree.status).toBe("pending");
    expect(detail.state).toBeNull();
    expect(detail.activeOperation?.kind).toBe("up");
    expect(detail.activeOperation?.operationId).toBe(begin.record.operationId);
  });

  test("submitWorktreeRemove rejects source worktree with validation error", async () => {
    daemon = await startWithHome();
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    // Default fakeContext source is "/fake" (different from wt). Override
    // resolveSession to mark the target itself as the source worktree.
    await daemon.stop();
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async (cwd) =>
          fakeContext({
            worktreeRoot: cwd,
            source: { path: cwd, bare: false, detached: false },
          }),
        web: { host: "127.0.0.1", port: 0, assetRoot: undefined },
      }),
    );
    const api = createUiApi(daemon.webUrl!);
    let caught: unknown;
    try {
      await api.submitWorktreeRemove(wt);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).message).toContain("primary/source worktree");
  });

  test("submitWorktreeRemove succeeds for a clean worktree without confirmation", async () => {
    daemon = await startWithHome();
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    await daemon.stop();
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async (cwd) =>
          fakeContext({
            worktreeRoot: cwd,
            source: {
              path: resolve(tmpHome, "source"),
              bare: false,
              detached: false,
            },
          }),
        gitRunner: async (_cwd, _args) => "",
        web: { host: "127.0.0.1", port: 0, assetRoot: undefined },
      }),
    );
    const api = createUiApi(daemon.webUrl!);
    const res = await api.submitWorktreeRemove(wt);
    expect(res.kind).toBe("worktree-remove");
    expect(typeof res.operationId).toBe("string");
    expect(res.sessionName).toBeDefined();
  });

  test("submitWorktreeRemove throws UiWorktreeDirtyError for dirty worktrees", async () => {
    daemon = await startWithHome();
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    await daemon.stop();
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async (cwd) =>
          fakeContext({
            worktreeRoot: cwd,
            source: {
              path: resolve(tmpHome, "source"),
              bare: false,
              detached: false,
            },
          }),
        gitRunner: async (_cwd, args) => {
          if (args[0] === "status" && args[1] === "--porcelain=v1") {
            return " M edited.ts\n?? new.ts\n";
          }
          return "";
        },
        web: { host: "127.0.0.1", port: 0, assetRoot: undefined },
      }),
    );
    const api = createUiApi(daemon.webUrl!);
    let caught: unknown;
    try {
      await api.submitWorktreeRemove(wt);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UiWorktreeDirtyError);
    const dirty = caught as UiWorktreeDirtyError;
    expect(dirty.changes.total).toBe(2);
    expect(dirty.changes.unstaged).toBe(1);
    expect(dirty.changes.untracked).toBe(1);
    expect(dirty.worktreePath).toBe(wt);
  });

  test("submitWorktreeRemove with discardChanges accepts dirty worktrees", async () => {
    daemon = await startWithHome();
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    await daemon.stop();
    const gitCalls: Array<{ cwd: string; args: string[] }> = [];
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async (cwd) =>
          fakeContext({
            worktreeRoot: cwd,
            source: {
              path: resolve(tmpHome, "source"),
              bare: false,
              detached: false,
            },
          }),
        gitRunner: async (cwd, args) => {
          gitCalls.push({ cwd, args });
          if (args[0] === "status" && args[1] === "--porcelain=v1") {
            return " M edited.ts\n";
          }
          return "";
        },
        web: { host: "127.0.0.1", port: 0, assetRoot: undefined },
      }),
    );
    const api = createUiApi(daemon.webUrl!);
    const res = await api.submitWorktreeRemove(wt, true);
    expect(res.kind).toBe("worktree-remove");
    // Preflight is skipped when discardChanges is true.
    const statusCalls = gitCalls.filter(
      (c) => c.args[0] === "status" && c.args[1] === "--porcelain=v1",
    );
    expect(statusCalls.length).toBe(0);
  });

  test("streamUnifiedEvents delivers pending status events to subscribers", async () => {
    daemon = await startWithHome();
    const api = createUiApi(daemon.webUrl!);
    const abort = new AbortController();
    const collected: { type: string; status?: string }[] = [];
    const runner = (async () => {
      try {
        for await (const env of api.streamUnifiedEvents({
          signal: abort.signal,
        })) {
          collected.push({
            type: env.type,
            status: (env.event as { status?: string }).status,
          });
          if (collected.length >= 1) break;
        }
      } catch {
        /* aborted */
      }
    })();
    // Give the SSE handler a moment to subscribe before publishing.
    await new Promise((r) => setTimeout(r, 50));
    const { publishWorktreeStatusChanged } = await import(
      "@worktreeos/daemon/unified-publishers"
    );
    publishWorktreeStatusChanged(daemon.events, "first-launch", "pending", {
      operationId: "op-1",
      worktreePath: "/w/first-launch",
    });
    await runner;
    abort.abort();
    expect(collected[0]?.type).toBe("worktree.deployment-status.changed");
    expect(collected[0]?.status).toBe("pending");
  });
});
