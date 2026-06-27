import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { startDaemon, type DaemonHandle } from "@worktreeos/daemon/daemon-server";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
  type CreateDaemonHarnessOptions,
  withDaemonDefaults,
} from "./helpers/daemon-test-harness.ts";
import type { SessionContext } from "@worktreeos/core/session-context";
import { existsSync } from "node:fs";
import {
  loadProjects,
  registerProjectBySourcePath,
  saveProjects,
} from "@worktreeos/core/project-registry";
import { splitSessionLogStream } from "@worktreeos/daemon/daemon-protocol";
import type { FollowerStarter } from "@worktreeos/daemon/daemon-sessions";
import type { ServiceFollower } from "@worktreeos/runtime/service-logs";
import type {
  ProjectAddResponse,
  ProjectListResponse,
  ReviewDiffResponse,
  WorktreeDetailResponse,
  WorktreeUpResponse,
  DiffResponse,
} from "@worktreeos/daemon/ui-protocol";

const TEST_PROJECT = "test-proj";

function fakeContext(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    worktreeRoot: "/fake/worktree",
    source: { path: "/fake/source", bare: false, detached: false },
    config: {
      cloneVolumes: [],
      hostPorts: { start: 20000, end: 29999 },
      app: { image: null, initScript: [], services: {} },
      deps: {},
      cache: [],
    } as any,
    projectName: TEST_PROJECT,
    sessionName: "fake-session",
    sessionRoot: "/tmp/fake-session",
    state: null,
    ...overrides,
  };
}

let tmpHome: string;
let daemon: DaemonHandle;

beforeEach(async () => {
  tmpHome = await createDaemonTestHome("wos-ui-");
});

afterEach(async () => {
  await teardownDaemonTestHome(tmpHome, daemon);
  daemon = undefined as unknown as DaemonHandle;
});

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${daemon.webUrl}${path}`, init);
}

async function startWithHome(opts: CreateDaemonHarnessOptions = {}) {
  return startDaemon(withDaemonDefaults(tmpHome, opts));
}

describe("UI API: project list", () => {
  test("returns empty list when no projects registered", async () => {
    daemon = await startWithHome({
      resolveSession: async () => fakeContext(),

    });
    const res = await fetchUi("/ui/v1/projects");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProjectListResponse;
    expect(body.projects).toEqual([]);
  });

  test("aggregates worktrees with deployment status", async () => {
    const repoRoot = join(tmpHome, "repo");
    await mkdir(repoRoot, { recursive: true });
    const featureRoot = join(tmpHome, "feature");
    await mkdir(featureRoot, { recursive: true });
    await saveProjects(
      [
        {
          id: "p1",
          displayName: "repo",
          sourcePath: repoRoot,
          createdAt: "2026-01-01T00:00:00.000Z",
          lastSeenAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      { filePath: resolve(tmpHome, "projects.json") },
    );

    const gitRunner = async (_root: string, args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return [
          `worktree ${repoRoot}`,
          "HEAD aaa",
          "branch refs/heads/main",
          "",
          `worktree ${featureRoot}`,
          "HEAD bbb",
          "branch refs/heads/feature",
          "",
        ].join("\n");
      }
      return "";
    };

    // We need to inject the gitRunner into the UI API; do that by extending
    // the daemon to accept ui-api options. As a stop-gap we use module-level
    // defaultWorktreeGitRunner — instead bypass by reading directly via fetch.
    // For this test, monkey-patch by providing a custom gitRunner through the
    // daemon options: not currently supported, so we drive the UI API by
    // calling the handler factory directly.
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");

    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({
        starter: () => [],
      }),
      tunnels: new TunnelRegistry(),
      gitRunner,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext(),
    });

    const res = await handler(new Request("http://x/ui/v1/projects"));
    expect(res).not.toBeNull();
    const body = (await res!.json()) as ProjectListResponse;
    expect(body.projects.length).toBe(1);
    expect(body.projects[0]!.worktrees.length).toBe(2);
    const main = body.projects[0]!.worktrees.find(
      (w) => w.path === resolve(repoRoot),
    );
    expect(main?.isSource).toBe(true);
    expect(main?.branch).toBe("main");
    expect(main?.status).toBe("not_started");
    expect(main?.serviceSummary).toEqual({
      total: 0,
      running: 0,
      stopped: 0,
      failed: 0,
      checking: 0,
    });
  });
});

describe("UI API: project add", () => {
  test("rejects missing path", async () => {
    daemon = await startWithHome({
      resolveSession: async () => fakeContext(),

    });
    const res = await fetchUi("/ui/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation");
  });

  test("registers project and returns summary", async () => {
    const repoRoot = join(tmpHome, "repo");
    await mkdir(repoRoot, { recursive: true });
    const featureRoot = join(tmpHome, "feature");
    await mkdir(featureRoot, { recursive: true });

    const gitRunner = async (_root: string, args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return [
          `worktree ${repoRoot}`,
          "HEAD aaa",
          "branch refs/heads/main",
          "",
          `worktree ${featureRoot}`,
          "HEAD bbb",
          "branch refs/heads/feature",
          "",
        ].join("\n");
      }
      return "";
    };

    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext(),
    });

    // Add by feature path — should register the source path instead.
    const res = await handler(
      new Request("http://x/ui/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: featureRoot }),
      }),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(201);
    const body = (await res!.json()) as ProjectAddResponse;
    expect(body.created).toBe(true);
    const { realpathSync } = await import("node:fs");
    expect(body.project.sourcePath).toBe(realpathSync(repoRoot));
  });
});

describe("UI API: worktree detail and up", () => {
  test("returns not-started detail when no state.json exists", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext(),
    });
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.worktree.status).toBe("not_started");
    expect(body.state).toBeNull();
    expect(body.services).toEqual([]);
    expect(body.serviceSummary).toEqual({
      total: 0,
      running: 0,
      stopped: 0,
      failed: 0,
      checking: 0,
    });
  });

  test("up submission publishes operation.started and pending status before monitor startup", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    await Bun.write(join(wt, ".wos", "deploy.yaml"), "{}\n");
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import(
      "@worktreeos/daemon/operation-registry"
    );
    const { DaemonSessionRegistry } = await import(
      "@worktreeos/daemon/daemon-sessions"
    );
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const { DaemonEventBus } = await import("@worktreeos/daemon/event-bus");
    const events = new DaemonEventBus();
    let upStartGate: () => void = () => {};
    const upStarted = new Promise<void>((resolve) => {
      upStartGate = resolve;
    });
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      events,
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async (cwd) =>
        fakeContext({ worktreeRoot: cwd, sessionName: "ui-up-pending" }),
      upRunner: async () => {
        upStartGate();
        // Keep the background runner alive so monitor/discovery work would
        // happen later — pending status must already be published.
        await new Promise((r) => setTimeout(r, 50));
        return {} as any;
      },
    });
    const captured: import("@worktreeos/core/unified-events").UnifiedEventEnvelope[] =
      [];
    events.subscribe((env) => captured.push(env));
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/up", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: wt }),
      }),
    );
    expect(res!.status).toBe(202);
    await upStarted;
    const types = captured.map((e) => e.type);
    // operation.started must be published, and pending status must follow.
    expect(types).toContain("operation.started");
    expect(types).toContain("worktree.deployment-status.changed");
    const startedIdx = types.indexOf("operation.started");
    const pendingIdx = types.indexOf("worktree.deployment-status.changed");
    expect(startedIdx).toBeGreaterThanOrEqual(0);
    expect(pendingIdx).toBeGreaterThan(startedIdx);
    const pending = captured[pendingIdx]!;
    expect(pending.sessionName).toBe("ui-up-pending");
    expect(pending.worktreePath).toBe(wt);
    expect(pending.operationId).toBeDefined();
    expect(
      (pending.event as { sessionName: string; status: string }).status,
    ).toBe("pending");
  });

  test("submits up and returns operation id", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    await Bun.write(join(wt, ".wos", "deploy.yaml"), "{}\n");
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const registry = new OperationRegistry();
    let upInvoked = false;
    const handler = createUiApiHandler({
      registry,
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async (cwd) =>
        fakeContext({ worktreeRoot: cwd, sessionName: "ui-up" }),
      upRunner: async () => {
        upInvoked = true;
        return {} as any;
      },
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/up", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: wt }),
      }),
    );
    expect(res!.status).toBe(202);
    const body = (await res!.json()) as WorktreeUpResponse;
    expect(body.kind).toBe("up");
    expect(typeof body.operationId).toBe("string");
    // Settle background task and confirm upRunner was called.
    await new Promise((r) => setTimeout(r, 30));
    expect(upInvoked).toBe(true);
  });

  test("keeps tunnel snapshot active when up fails after compose-up", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    await Bun.write(join(wt, ".wos", "deploy.yaml"), "{}\n");
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const registry = new OperationRegistry();
    const tunnels = new TunnelRegistry();
    const routes = new Map<string, number>();
    tunnels.setServer({
      domain: "example.com",
      port: 0,
      registerRoute: (r) => {
        routes.set(r.hostname, r.hostPort);
      },
      unregisterRoute: (h) => {
        routes.delete(h);
      },
      hasRoute: (h) => routes.has(h),
      stop: async () => {},
    });
    const handler = createUiApiHandler({
      registry,
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels,
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async (cwd) =>
        fakeContext({
          worktreeRoot: cwd,
          sessionName: "ui-up-keep",
          config: {
            cloneVolumes: [],
            hostPorts: { start: 20000, end: 29999 },
            app: {
              image: null,
              initScript: [],
              services: { api: { ports: [{ containerPort: 3000 }] } },
            },
            deps: {},
            cache: [],
          } as any,
        }),
      upRunner: async (_ctx, opts) => {
        // Simulate compose-up success followed by a required healthcheck
        // failure: open tunnel routes, flip composeStarted, then throw.
        await opts.tunnelPreparer!.prepare({ api: { "3000": 21010 } });
        opts.progress!.composeStarted = true;
        throw new Error("app-port healthcheck failed: api:3000");
      },
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/up", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: wt }),
      }),
    );
    expect(res!.status).toBe(202);
    const body = (await res!.json()) as WorktreeUpResponse;

    // Wait for the background up op to terminate.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const rec = registry.get(body.operationId);
      if (rec && rec.status !== "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(registry.get(body.operationId)!.status).toBe("failed");

    const snapshot = tunnels.snapshot("ui-up-keep");
    expect(snapshot.length).toBe(1);
    expect(snapshot[0]).toMatchObject({
      service: "api",
      containerPort: 3000,
      hostPort: 21010,
      state: "active",
    });
  });

  test("returns 409 conflict when session is busy", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    await Bun.write(join(wt, ".wos", "deploy.yaml"), "{}\n");
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const registry = new OperationRegistry();
    registry.begin("ui-up", "up");
    const handler = createUiApiHandler({
      registry,
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async (cwd) =>
        fakeContext({ worktreeRoot: cwd, sessionName: "ui-up" }),
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/up", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: wt }),
      }),
    );
    expect(res!.status).toBe(409);
  });

  test("forwards selective up with services payload", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    await Bun.write(join(wt, ".wos", "deploy.yaml"), "{}\n");
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    let observedSelection: unknown;
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async (cwd) =>
        fakeContext({ worktreeRoot: cwd, sessionName: "ui-up-sel" }),
      upRunner: async (_ctx, opts) => {
        observedSelection = opts.selection;
        return {} as any;
      },
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/up", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: wt, services: ["app", "api"] }),
      }),
    );
    expect(res!.status).toBe(202);
    await new Promise((r) => setTimeout(r, 30));
    expect(observedSelection).toEqual({ kind: "services", services: ["app", "api"] });
  });

  test("forwards selective up with target payload", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    await Bun.write(join(wt, ".wos", "deploy.yaml"), "{}\n");
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    let observedSelection: unknown;
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async (cwd) =>
        fakeContext({ worktreeRoot: cwd, sessionName: "ui-up-target" }),
      upRunner: async (_ctx, opts) => {
        observedSelection = opts.selection;
        return {} as any;
      },
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/up", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: wt, target: "app" }),
      }),
    );
    expect(res!.status).toBe(202);
    await new Promise((r) => setTimeout(r, 30));
    expect(observedSelection).toEqual({ kind: "target", target: "app" });
  });

  test("rejects up with both services and target", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async (cwd) =>
        fakeContext({ worktreeRoot: cwd }),
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/up", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: wt, services: ["a"], target: "b" }),
      }),
    );
    expect(res!.status).toBe(400);
  });

  test("rejects empty services array", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async (cwd) =>
        fakeContext({ worktreeRoot: cwd }),
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/up", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: wt, services: [] }),
      }),
    );
    expect(res!.status).toBe(400);
  });

  test("rejects selective up for compose-mode worktree", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    await Bun.write(join(wt, ".wos", "deploy.yaml"), "{}\n");
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async (cwd) =>
        fakeContext({
          worktreeRoot: cwd,
          config: {
            mode: "compose",
            cloneVolumes: [],
            hostPorts: { start: 20000, end: 29999 },
            app: { image: null, initScript: [], services: {} },
            deps: {},
            cache: [],
            compose: {
              config: "docker-compose.yaml",
              expose: [{ service: "api", port: 80 }],
              envFile: [],
              environment: {},
            },
          } as any,
        }),
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/up", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: wt, services: ["api"] }),
      }),
    );
    expect(res!.status).toBe(400);
  });

  test("forwards runtime arguments to up runner", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    await Bun.write(join(wt, ".wos", "deploy.yaml"), "{}\n");
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    let observedArgs: unknown;
    let observedSelection: unknown;
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async (cwd) =>
        fakeContext({
          worktreeRoot: cwd,
          sessionName: "ui-up-args",
          config: {
            cloneVolumes: [],
            hostPorts: { start: 20000, end: 29999 },
            app: { image: null, initScript: [], services: {} },
            deps: {},
            cache: [],
            arguments: ["API_URL"],
          } as any,
        }),
      upRunner: async (_ctx, opts) => {
        observedArgs = opts.runtimeArguments;
        observedSelection = opts.selection;
        return {} as any;
      },
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/up", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: wt,
          target: "lk-zup",
          arguments: { API_URL: "https://empl-stage.test-wa.ru" },
        }),
      }),
    );
    expect(res!.status).toBe(202);
    await new Promise((r) => setTimeout(r, 30));
    expect(observedArgs).toEqual({ API_URL: "https://empl-stage.test-wa.ru" });
    expect(observedSelection).toEqual({ kind: "target", target: "lk-zup" });
  });

  test("rejects undeclared runtime argument", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    await Bun.write(join(wt, ".wos", "deploy.yaml"), "{}\n");
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    let upInvoked = false;
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
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
      upRunner: async () => {
        upInvoked = true;
        return {} as any;
      },
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/up", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: wt,
          arguments: { OTHER: "x" },
        }),
      }),
    );
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as { message: string };
    expect(body.message).toMatch(/not declared/);
    await new Promise((r) => setTimeout(r, 10));
    expect(upInvoked).toBe(false);
  });

  test("rejects invalid runtime arguments payload shape", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async (cwd) =>
        fakeContext({ worktreeRoot: cwd }),
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/up", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: wt, arguments: ["API_URL"] }),
      }),
    );
    expect(res!.status).toBe(400);
  });
});

describe("UI API: worktree down submission", () => {
  test("submits down and returns operation id", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import(
      "@worktreeos/daemon/operation-registry"
    );
    const { DaemonSessionRegistry } = await import(
      "@worktreeos/daemon/daemon-sessions"
    );
    const { TunnelRegistry } = await import(
      "@worktreeos/runtime/tunnel-registry"
    );
    const registry = new OperationRegistry();
    let downInvoked = false;
    const handler = createUiApiHandler({
      registry,
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async (cwd) =>
        fakeContext({ worktreeRoot: cwd, sessionName: "ui-down" }),
      downRunner: async () => {
        downInvoked = true;
        return { kind: "no-deployment" };
      },
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/down", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: wt }),
      }),
    );
    expect(res!.status).toBe(202);
    const body = (await res!.json()) as {
      operationId: string;
      kind: string;
    };
    expect(body.kind).toBe("down");
    expect(typeof body.operationId).toBe("string");
    await new Promise((r) => setTimeout(r, 30));
    expect(downInvoked).toBe(true);
  });

  test("down aborts an in-flight up and then tears it down", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    await Bun.write(join(wt, ".wos", "deploy.yaml"), "{}\n");
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import(
      "@worktreeos/daemon/operation-registry"
    );
    const { DaemonSessionRegistry } = await import(
      "@worktreeos/daemon/daemon-sessions"
    );
    const { TunnelRegistry } = await import(
      "@worktreeos/runtime/tunnel-registry"
    );
    const { DeploymentCancelledError } = await import(
      "@worktreeos/runtime/operations"
    );
    const registry = new OperationRegistry();
    let aborted = false;
    let downInvoked = false;
    let upStarted: () => void = () => {};
    const upRunning = new Promise<void>((r) => {
      upStarted = r;
    });
    const handler = createUiApiHandler({
      registry,
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async (cwd) =>
        fakeContext({ worktreeRoot: cwd, sessionName: "ui-stop" }),
      // Simulate an up stuck waiting (e.g. a healthcheck for a crashed service)
      // that only resolves when the abort signal fires.
      upRunner: async (_ctx, opts) => {
        upStarted();
        await new Promise<void>((_resolve, reject) => {
          opts.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new DeploymentCancelledError());
            },
            { once: true },
          );
        });
        return {} as never;
      },
      downRunner: async () => {
        downInvoked = true;
        return { kind: "stopped" };
      },
    });
    const upRes = await handler(
      new Request("http://x/ui/v1/worktrees/up", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: wt }),
      }),
    );
    expect(upRes!.status).toBe(202);
    await upRunning;

    // Stop from the in-progress state: down must abort the up (not 409), wait
    // for it to unwind, then run the teardown.
    const downRes = await handler(
      new Request("http://x/ui/v1/worktrees/down", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: wt }),
      }),
    );
    expect(downRes!.status).toBe(202);
    expect(aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(downInvoked).toBe(true);
  });

  test("returns 409 when session is busy", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import(
      "@worktreeos/daemon/operation-registry"
    );
    const { DaemonSessionRegistry } = await import(
      "@worktreeos/daemon/daemon-sessions"
    );
    const { TunnelRegistry } = await import(
      "@worktreeos/runtime/tunnel-registry"
    );
    const registry = new OperationRegistry();
    registry.begin("ui-down", "up");
    const handler = createUiApiHandler({
      registry,
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async (cwd) =>
        fakeContext({ worktreeRoot: cwd, sessionName: "ui-down" }),
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/down", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: wt }),
      }),
    );
    expect(res!.status).toBe(409);
  });
});

describe("UI API: worktree service actions", () => {
  async function buildServiceHandler(opts: {
    wt: string;
    initialized?: boolean;
    registry?: import("@worktreeos/daemon/operation-registry").OperationRegistry;
    stopRunner?: (
      ctx: any,
      service: string,
      o?: any,
    ) => Promise<void>;
    restartRunner?: (
      ctx: any,
      service: string,
      o?: any,
    ) => Promise<void>;
  }) {
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import(
      "@worktreeos/daemon/operation-registry"
    );
    const { DaemonSessionRegistry } = await import(
      "@worktreeos/daemon/daemon-sessions"
    );
    const { TunnelRegistry } = await import(
      "@worktreeos/runtime/tunnel-registry"
    );
    const registry = opts.registry ?? new OperationRegistry();
    const ctxState = opts.initialized
      ? {
          initialized: true,
          projectName: "test-proj",
          composeFile: "/c.yaml",
        }
      : null;
    return {
      registry,
      handler: createUiApiHandler({
        registry,
        sessions: new DaemonSessionRegistry({ starter: () => [] }),
        tunnels: new TunnelRegistry(),
        gitRunner: async () => `worktree ${opts.wt}\n\n`,
        projectsFilePath: resolve(tmpHome, "projects.json"),
        resolveSession: async (cwd) =>
          fakeContext({
            worktreeRoot: cwd,
            sessionName: "ui-svc",
            state: ctxState as any,
          }),
        ...(opts.stopRunner
          ? { serviceStopRunner: opts.stopRunner as any }
          : {}),
        ...(opts.restartRunner
          ? { serviceRestartRunner: opts.restartRunner as any }
          : {}),
      }),
    };
  }

  test("submits service-stop and returns operation id", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    let stoppedFor = "";
    const { handler } = await buildServiceHandler({
      wt,
      initialized: true,
      stopRunner: async (_ctx, svc) => {
        stoppedFor = svc;
      },
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/services/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: wt, service: "api" }),
      }),
    );
    expect(res!.status).toBe(202);
    const body = (await res!.json()) as {
      kind: string;
      service: string;
    };
    expect(body.kind).toBe("service-stop");
    expect(body.service).toBe("api");
    await new Promise((r) => setTimeout(r, 30));
    expect(stoppedFor).toBe("api");
  });

  test("submits service-restart and returns operation id", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    let restartedFor = "";
    const { handler } = await buildServiceHandler({
      wt,
      initialized: true,
      restartRunner: async (_ctx, svc) => {
        restartedFor = svc;
      },
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/services/restart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: wt, service: "api" }),
      }),
    );
    expect(res!.status).toBe(202);
    const body = (await res!.json()) as {
      kind: string;
      service: string;
    };
    expect(body.kind).toBe("service-restart");
    expect(body.service).toBe("api");
    await new Promise((r) => setTimeout(r, 30));
    expect(restartedFor).toBe("api");
  });

  test("rejects empty service name with validation error", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const { handler } = await buildServiceHandler({ wt, initialized: true });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/services/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: wt, service: "  " }),
      }),
    );
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toBe("validation");
  });

  test("rejects internal init service", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const { INIT_SERVICE_NAME } = await import(
      "@worktreeos/compose/generated-compose"
    );
    const { handler } = await buildServiceHandler({ wt, initialized: true });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/services/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: wt, service: INIT_SERVICE_NAME }),
      }),
    );
    expect(res!.status).toBe(400);
  });

  test("rejects when no deployment is initialized", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const { handler } = await buildServiceHandler({ wt, initialized: false });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/services/restart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: wt, service: "api" }),
      }),
    );
    expect(res!.status).toBe(400);
  });

  test("returns 409 when session has an active mutating operation", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const { OperationRegistry } = await import(
      "@worktreeos/daemon/operation-registry"
    );
    const registry = new OperationRegistry();
    registry.begin("ui-svc", "up");
    const { handler } = await buildServiceHandler({
      wt,
      initialized: true,
      registry,
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/services/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: wt, service: "api" }),
      }),
    );
    expect(res!.status).toBe(409);
  });
});

describe("UI API: logs stream", () => {
  async function persistInitializedSession(opts: {
    services: string[];
  }): Promise<{ worktreeRoot: string; sessionName: string }> {
    const { sessionRootForWorktree, sessionNameForWorktree } = await import(
      "@worktreeos/core/paths"
    );
    const worktreeRoot = join(tmpHome, "wt");
    await mkdir(worktreeRoot, { recursive: true });
    await Bun.write(join(worktreeRoot, ".wos", "deploy.yaml"), "app:\n  services: {}\n");
    const sessionName = sessionNameForWorktree(worktreeRoot);
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
        worktreeRoot,
        sourcePath: worktreeRoot,
      }),
    );
    return { worktreeRoot, sessionName };
  }

  function fakeDockerWithServices(services: string[]) {
    return async (args: string[]) => {
      if (args.includes("ps")) {
        return {
          stdout: JSON.stringify(services.map((s) => ({ Service: s, State: "running" }))),
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
  }

  test("starts a request-scoped follower on service channel open", async () => {
    const { sessionName } = await persistInitializedSession({ services: ["api"] });
    const handles: Array<{ service: string; sink: (s: string, st: any, c: string) => void }> = [];
    const starter: FollowerStarter = ({ services, sink }) =>
      services.map((s) => {
        handles.push({ service: s, sink });
        sink(s, "stdout", `${s}-tail\n`);
        return {
          service: s,
          channel: `service:${s}` as const,
          stop: () => {},
          done: Promise.resolve(),
        } satisfies ServiceFollower;
      });
    daemon = await startWithHome({
      resolveSession: async () => fakeContext(),
      followerStarter: starter,
      dockerRunner: fakeDockerWithServices(["api"]),

    });

    expect(daemon.sessions.get(sessionName)).toBeUndefined();

    const res = await fetchUi(
      `/ui/v1/worktrees/logs?session=${encodeURIComponent(sessionName)}&channel=service:api`,
    );
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const got: ReturnType<typeof splitSessionLogStream>["envelopes"] = [];
    const deadline = Date.now() + 1500;
    while (got.length < 1 && Date.now() < deadline) {
      const r = await reader.read();
      if (r.done) break;
      buffer += decoder.decode(r.value, { stream: true });
      const { envelopes, rest } = splitSessionLogStream(buffer);
      buffer = rest;
      got.push(...envelopes);
    }
    expect(got[0]?.channel).toBe("service:api");
    expect(got[0]?.chunk).toBe("api-tail\n");
    expect(handles.map((h) => h.service)).toEqual(["api"]);
    expect(daemon.sessions.get(sessionName)?.serviceStreams.has("api")).toBe(true);
    await reader.cancel().catch(() => {});
  });

  test("delivers init history when channel=init is requested", async () => {
    daemon = await startWithHome({
      resolveSession: async () => fakeContext(),
      followerStarter: () => [],

    });
    daemon.sessions.appendInit("log-session", "stdout", "init-line\n");

    const res = await fetchUi(
      "/ui/v1/worktrees/logs?session=log-session&channel=init",
    );
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const got: ReturnType<typeof splitSessionLogStream>["envelopes"] = [];
    const deadline = Date.now() + 1000;
    while (got.length < 1 && Date.now() < deadline) {
      const r = await reader.read();
      if (r.done) break;
      buffer += decoder.decode(r.value, { stream: true });
      const { envelopes, rest } = splitSessionLogStream(buffer);
      buffer = rest;
      got.push(...envelopes);
    }
    expect(got[0]?.channel).toBe("init");
    expect(got[0]?.chunk).toBe("init-line\n");
    await reader.cancel().catch(() => {});
  });

  test("rejects an invalid channel value", async () => {
    daemon = await startWithHome({
      resolveSession: async () => fakeContext(),
      followerStarter: () => [],

    });
    const res = await fetchUi(
      "/ui/v1/worktrees/logs?session=log-session&channel=bogus",
    );
    expect(res.status).toBe(400);
  });

  test("delivers deployment history when channel=deployment is requested", async () => {
    daemon = await startWithHome({
      resolveSession: async () => fakeContext(),
      followerStarter: () => [],

    });
    daemon.sessions.appendDeployment("log-session", "stdout", "deploy-line\n");

    const res = await fetchUi(
      "/ui/v1/worktrees/logs?session=log-session&channel=deployment",
    );
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const got: ReturnType<typeof splitSessionLogStream>["envelopes"] = [];
    const deadline = Date.now() + 1000;
    while (got.length < 1 && Date.now() < deadline) {
      const r = await reader.read();
      if (r.done) break;
      buffer += decoder.decode(r.value, { stream: true });
      const { envelopes, rest } = splitSessionLogStream(buffer);
      buffer = rest;
      got.push(...envelopes);
    }
    expect(got[0]?.channel).toBe("deployment");
    expect(got[0]?.chunk).toBe("deploy-line\n");
    await reader.cancel().catch(() => {});
  });

  test("quiet channel stays open without leaking chunks from other channels", async () => {
    daemon = await startWithHome({
      resolveSession: async () => fakeContext(),
      followerStarter: () => [],
      logStreamKeepaliveMs: 50,

    });

    const res = await fetchUi(
      "/ui/v1/worktrees/logs?session=quiet-session&channel=service:nobody",
    );
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    const deadline = Date.now() + 500;
    while (raw.length < 2 && Date.now() < deadline) {
      const r = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value?: undefined }>((resolveRace) =>
          setTimeout(() => resolveRace({ done: true }), 200),
        ),
      ]);
      if (r.done) break;
      raw += decoder.decode(r.value!, { stream: true });
    }
    // Heartbeats are bare \n lines; no envelopes from other channels leak.
    expect(raw.length).toBeGreaterThan(0);
    const { envelopes } = splitSessionLogStream(raw);
    expect(envelopes).toEqual([]);
    await reader.cancel().catch(() => {});
  });

  test("no-channel aggregate stream stops followers on disconnect", async () => {
    const { sessionName } = await persistInitializedSession({ services: ["api"] });
    const handles: Array<{ service: string; sink: (s: string, st: any, c: string) => void; stopped: boolean }> = [];
    const starter: FollowerStarter = ({ services, sink }) =>
      services.map((s) => {
        const h = { service: s, sink, stopped: false };
        handles.push(h);
        sink(s, "stdout", `${s}-tail\n`);
        return {
          service: s,
          channel: `service:${s}` as const,
          stop: () => {
            h.stopped = true;
          },
          done: Promise.resolve(),
        } satisfies ServiceFollower;
      });
    daemon = await startWithHome({
      resolveSession: async () => fakeContext(),
      followerStarter: starter,
      dockerRunner: fakeDockerWithServices(["api"]),

    });
    daemon.sessions.appendInit(sessionName, "stdout", "init-noise\n");

    const abort = new AbortController();
    const res = await fetchUi(
      `/ui/v1/worktrees/logs?session=${encodeURIComponent(sessionName)}`,
      { signal: abort.signal },
    );
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const got: ReturnType<typeof splitSessionLogStream>["envelopes"] = [];
    const deadline = Date.now() + 800;
    while (got.length < 1 && Date.now() < deadline) {
      const r = await reader.read();
      if (r.done) break;
      buffer += decoder.decode(r.value, { stream: true });
      const { envelopes, rest } = splitSessionLogStream(buffer);
      buffer = rest;
      got.push(...envelopes);
    }
    expect(got.every((e) => e.channel.startsWith("service:"))).toBe(true);
    expect(got.map((e) => e.chunk)).toEqual(["api-tail\n"]);
    // Active stream exists while subscribed.
    expect(daemon.sessions.get(sessionName)?.serviceStreams.has("api")).toBe(true);
    abort.abort();
    await reader.cancel().catch(() => {});
    // Stream tears down on disconnect — best-effort polling within 500ms.
    const stopDeadline = Date.now() + 500;
    while (Date.now() < stopDeadline) {
      if (daemon.sessions.get(sessionName)?.serviceStreams.has("api") === false) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(daemon.sessions.get(sessionName)?.serviceStreams.has("api")).toBe(false);
    expect(handles[0]!.stopped).toBe(true);
  });
});

describe("UI API: diff endpoint", () => {
  test("returns staged diff and empty unstaged diff", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const gitRunner = async (_root: string, args: string[]) => {
      if (args[0] === "diff" && args[1] === "--cached") return "staged-text";
      if (args[0] === "diff") return "";
      return "";
    };
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext(),
    });
    const staged = await handler(
      new Request(
        `http://x/ui/v1/worktrees/diff/staged?path=${encodeURIComponent(wt)}`,
      ),
    );
    expect((await staged!.json()) as DiffResponse).toEqual({
      diff: "staged-text",
      empty: false,
    });
    const unstaged = await handler(
      new Request(
        `http://x/ui/v1/worktrees/diff/unstaged?path=${encodeURIComponent(wt)}`,
      ),
    );
    expect((await unstaged!.json()) as DiffResponse).toEqual({
      diff: "",
      empty: true,
    });
  });

  test("returns 400 on git error", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const gitRunner = async () => {
      const { GitError } = await import("@worktreeos/core/git");
      throw new GitError("git boom");
    };
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext(),
    });
    const res = await handler(
      new Request(
        `http://x/ui/v1/worktrees/diff/staged?path=${encodeURIComponent(wt)}`,
      ),
    );
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toBe("git-error");
  });
});

describe("UI API: structured review diff endpoint", () => {
  test("returns aggregated totals across staged and unstaged", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const stagedRaw = [
      "diff --git a/staged.txt b/staged.txt",
      "index 111..222 100644",
      "--- a/staged.txt",
      "+++ b/staged.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const unstagedRaw = [
      "diff --git a/dirty.txt b/dirty.txt",
      "index 333..444 100644",
      "--- a/dirty.txt",
      "+++ b/dirty.txt",
      "@@ -1 +1,2 @@",
      " keep",
      "+added",
      "",
    ].join("\n");
    const gitRunner = async (_root: string, args: string[]) => {
      if (args.includes("ls-files")) return "";
      const cached = args.includes("--cached");
      const numstat = args.includes("--numstat");
      const nameStatus = args.includes("--name-status");
      if (cached) {
        if (numstat) return "1\t1\tstaged.txt\n";
        if (nameStatus) return "M\tstaged.txt\n";
        return stagedRaw;
      }
      if (numstat) return "1\t0\tdirty.txt\n";
      if (nameStatus) return "M\tdirty.txt\n";
      return unstagedRaw;
    };
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext(),
    });
    const res = await handler(
      new Request(
        `http://x/ui/v1/worktrees/diff/review?path=${encodeURIComponent(wt)}`,
      ),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as ReviewDiffResponse;
    expect(body.totalAdditions).toBe(2);
    expect(body.totalDeletions).toBe(1);
    expect(body.totalChangedFiles).toBe(2);
    expect(body.staged.files).toHaveLength(1);
    expect(body.staged.files[0]!.newPath).toBe("staged.txt");
    expect(body.unstaged.files).toHaveLength(1);
    expect(body.unstaged.files[0]!.additions).toBe(1);
  });

  test("surfaces untracked new files in the unstaged set", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const untrackedRaw = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "index 0000000..80ce8d9",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+line one",
      "+line two",
      "",
    ].join("\n");
    const gitRunner = async (_root: string, args: string[]) => {
      if (args.includes("ls-files")) return "new.txt\u0000";
      if (args.includes("--no-index")) return untrackedRaw;
      // No tracked staged or unstaged changes.
      return "";
    };
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext(),
    });
    const res = await handler(
      new Request(
        `http://x/ui/v1/worktrees/diff/review?path=${encodeURIComponent(wt)}`,
      ),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as ReviewDiffResponse;
    expect(body.totalChangedFiles).toBe(1);
    expect(body.totalAdditions).toBe(2);
    expect(body.unstaged.files).toHaveLength(1);
    const file = body.unstaged.files[0]!;
    expect(file.newPath).toBe("new.txt");
    expect(file.status).toBe("added");
    expect(file.additions).toBe(2);
  });

  test("returns empty payload for clean worktree", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const gitRunner = async () => "";
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext(),
    });
    const res = await handler(
      new Request(
        `http://x/ui/v1/worktrees/diff/review?path=${encodeURIComponent(wt)}`,
      ),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as ReviewDiffResponse;
    expect(body.totalAdditions).toBe(0);
    expect(body.totalDeletions).toBe(0);
    expect(body.totalChangedFiles).toBe(0);
    expect(body.staged.files).toHaveLength(0);
    expect(body.unstaged.files).toHaveLength(0);
  });

  test("returns git-error when git fails", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const gitRunner = async () => {
      const { GitError } = await import("@worktreeos/core/git");
      throw new GitError("boom");
    };
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext(),
    });
    const res = await handler(
      new Request(
        `http://x/ui/v1/worktrees/diff/review?path=${encodeURIComponent(wt)}`,
      ),
    );
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toBe("git-error");
  });

  test("raw staged/unstaged endpoints still work", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const gitRunner = async (_root: string, args: string[]) => {
      if (args.includes("--cached")) return "staged-raw";
      return "unstaged-raw";
    };
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext(),
    });
    const staged = await handler(
      new Request(
        `http://x/ui/v1/worktrees/diff/staged?path=${encodeURIComponent(wt)}`,
      ),
    );
    expect((await staged!.json()) as DiffResponse).toEqual({
      diff: "staged-raw",
      empty: false,
    });
  });
});

describe("UI API: sidebar status reflects docker compose ps", () => {
  test("aggregated worktree status is `stopped` when docker reports no running services", async () => {
    const repoRoot = join(tmpHome, "repo");
    await mkdir(repoRoot, { recursive: true });
    const { sessionRootForWorktree } = await import("@worktreeos/core/paths");
    const sessionRoot = sessionRootForWorktree(repoRoot);
    await mkdir(sessionRoot, { recursive: true });
    const state = {
      initialized: true,
      projectName: "wos-x",
      composeFile: join(sessionRoot, "compose.yaml"),
      lastUp: "2026-05-18T00:00:00.000Z",
      worktreeRoot: repoRoot,
      sourcePath: repoRoot,
    };
    await writeFile(join(sessionRoot, "state.json"), JSON.stringify(state));
    await writeFile(state.composeFile, "services: {}");

    const { saveProjects: save } = await import("@worktreeos/core/project-registry");
    await save(
      [
        {
          id: "p1",
          displayName: "repo",
          sourcePath: repoRoot,
          createdAt: state.lastUp,
          lastSeenAt: state.lastUp,
        },
      ],
      { filePath: resolve(tmpHome, "projects.json") },
    );

    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () =>
        [`worktree ${repoRoot}`, "HEAD aaa", "branch refs/heads/main", "", ""].join("\n"),
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext(),
      // docker reports empty service list — sidebar must show stopped.
      dockerRunner: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });
    const res = await handler(new Request("http://x/ui/v1/projects"));
    const body = (await res!.json()) as ProjectListResponse;
    expect(body.projects[0]!.worktrees[0]!.status).toBe("stopped");
  });

  test("aggregated worktree status is `running` when docker reports running services", async () => {
    const repoRoot = join(tmpHome, "repo");
    await mkdir(repoRoot, { recursive: true });
    const { sessionRootForWorktree } = await import("@worktreeos/core/paths");
    const sessionRoot = sessionRootForWorktree(repoRoot);
    await mkdir(sessionRoot, { recursive: true });
    const state = {
      initialized: true,
      projectName: "wos-y",
      composeFile: join(sessionRoot, "compose.yaml"),
      lastUp: "2026-05-18T00:00:00.000Z",
      worktreeRoot: repoRoot,
      sourcePath: repoRoot,
    };
    await writeFile(join(sessionRoot, "state.json"), JSON.stringify(state));
    await writeFile(state.composeFile, "services: {}");

    const { saveProjects: save } = await import("@worktreeos/core/project-registry");
    await save(
      [
        {
          id: "p1",
          displayName: "repo",
          sourcePath: repoRoot,
          createdAt: state.lastUp,
          lastSeenAt: state.lastUp,
        },
      ],
      { filePath: resolve(tmpHome, "projects.json") },
    );

    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const psJson =
      JSON.stringify({ Name: "api", Service: "api", State: "running", Status: "Up 1m", Publishers: [] }) +
      "\n";
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () =>
        [`worktree ${repoRoot}`, "HEAD aaa", "branch refs/heads/main", "", ""].join("\n"),
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext(),
      dockerRunner: async () => ({ stdout: psJson, stderr: "", exitCode: 0 }),
    });
    const res = await handler(new Request("http://x/ui/v1/projects"));
    const body = (await res!.json()) as ProjectListResponse;
    expect(body.projects[0]!.worktrees[0]!.status).toBe("running");
  });
});

describe("UI API: worktree state from Docker cache", () => {
  async function syncedStore(
    containers: Array<{ session: string; service: string; running?: boolean }>,
  ) {
    const { DockerStateStore } = await import(
      "@worktreeos/daemon/docker/docker-state-store"
    );
    const { stableWosHomeHash } = await import(
      "@worktreeos/core/tunnel-metadata"
    );
    const homeHash = stableWosHomeHash();
    const fakeClient = {
      listContainers: async () =>
        containers.map((c, i) => ({
          Id: `c${i}`,
          Names: [`/${c.service}`],
          Image: "node:22",
          ImageID: "",
          Labels: {
            "dev.wos.managed": "true",
            "dev.wos.schema": "1",
            "dev.wos.home-hash": homeHash,
            "dev.wos.session": c.session,
            "dev.wos.project": "proj",
            "dev.wos.mode": "generated",
            "dev.wos.service": c.service,
          },
          State: c.running === false ? "exited" : "running",
          Status: c.running === false ? "Exited (0)" : "Up",
          Ports: [],
        })),
      inspectContainer: async () => {
        throw Object.assign(new Error("nf"), { status: 404 });
      },
      openEvents: () => ({
        abort() {},
        events: (async function* () {
          await new Promise<void>(() => {});
        })(),
      }),
      streamLogs: async () => ({}),
      startContainer: async () => {},
      stopContainer: async () => {},
      restartContainer: async () => {},
    };
    const store = new DockerStateStore({
      client: fakeClient as never,
      reconcileIntervalMs: 0,
    });
    await store.start(); // populates the cache and marks it synced
    return store;
  }

  const throwingDockerRunner = async () => {
    throw new Error("docker compose ps must not be called when cache is synced");
  };

  test("project summary counts come from the Docker cache, not compose ps", async () => {
    const repoRoot = join(tmpHome, "repo");
    await mkdir(repoRoot, { recursive: true });
    const { sessionRootForWorktree, sessionNameForWorktree } = await import(
      "@worktreeos/core/paths"
    );
    const sessionRoot = sessionRootForWorktree(repoRoot);
    await mkdir(sessionRoot, { recursive: true });
    const state = {
      initialized: true,
      projectName: "proj",
      composeFile: join(sessionRoot, "compose.yaml"),
      worktreeRoot: repoRoot,
      sourcePath: repoRoot,
    };
    await writeFile(join(sessionRoot, "state.json"), JSON.stringify(state));
    await writeFile(state.composeFile, "services: {}");

    const { saveProjects: save } = await import("@worktreeos/core/project-registry");
    await save(
      [
        {
          id: "p1",
          displayName: "repo",
          sourcePath: repoRoot,
          createdAt: "2026-01-01T00:00:00.000Z",
          lastSeenAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      { filePath: resolve(tmpHome, "projects.json") },
    );

    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const session = sessionNameForWorktree(repoRoot);
    const dockerState = await syncedStore([
      { session, service: "api", running: true },
    ]);
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () =>
        [`worktree ${repoRoot}`, "HEAD aaa", "branch refs/heads/main", "", ""].join("\n"),
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext(),
      dockerState,
      dockerRunner: throwingDockerRunner,
    });
    const res = await handler(new Request("http://x/ui/v1/projects"));
    const body = (await res!.json()) as ProjectListResponse;
    expect(body.projects[0]!.worktrees[0]!.status).toBe("running");
    await dockerState.stop();
  });

  test("worktree detail lists managed services from the cache, including stopped ones", async () => {
    const repoRoot = join(tmpHome, "repo");
    await mkdir(repoRoot, { recursive: true });
    const { sessionRootForWorktree, sessionNameForWorktree } = await import(
      "@worktreeos/core/paths"
    );
    const sessionRoot = sessionRootForWorktree(repoRoot);
    await mkdir(sessionRoot, { recursive: true });
    const composeFile = join(sessionRoot, "compose.yaml");
    const state = {
      initialized: true,
      projectName: "proj",
      composeFile,
      worktreeRoot: repoRoot,
      sourcePath: repoRoot,
    };
    await writeFile(join(sessionRoot, "state.json"), JSON.stringify(state));
    await writeFile(composeFile, "services: {}");

    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const session = sessionNameForWorktree(repoRoot);
    const dockerState = await syncedStore([
      { session, service: "api", running: true },
      { session, service: "db", running: false },
    ]);
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${repoRoot}\nHEAD aaa\nbranch refs/heads/main\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      // Resolved session must report initialized so the status path runs.
      resolveSession: async () =>
        fakeContext({
          worktreeRoot: repoRoot,
          state: { initialized: true, projectName: "proj", composeFile } as any,
        }),
      dockerState,
      dockerRunner: throwingDockerRunner,
    });
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(repoRoot)}`),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as WorktreeDetailResponse;
    const services = (body.services ?? []).map((s) => s.service).sort();
    expect(services).toEqual(["api", "db"]);
    const db = (body.services ?? []).find((s) => s.service === "db");
    expect(db?.state).toBe("exited");
    await dockerState.stop();
  });
});

describe("UI API: resource usage", () => {
  async function detailWith(services: any[]): Promise<WorktreeDetailResponse> {
    const wt = join(tmpHome, `wt-usage-${Math.random().toString(36).slice(2)}`);
    await mkdir(wt, { recursive: true });
    const { sessionRootForWorktree } = await import("@worktreeos/core/paths");
    const correctRoot = sessionRootForWorktree(wt);
    await mkdir(correctRoot, { recursive: true });
    const state = {
      initialized: true,
      projectName: "p",
      composeFile: "/c.yaml",
      lastUp: "2026-05-18T00:00:00.000Z",
      worktreeRoot: wt,
      sourcePath: wt,
    };
    await writeFile(join(correctRoot, "state.json"), JSON.stringify(state));

    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext({ state, worktreeRoot: wt }),
      statusRunner: async () =>
        ({ kind: "ok", services, state, appPortHealthchecks: [] }) as any,
    });
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    return (await res!.json()) as WorktreeDetailResponse;
  }

  test("detail aggregates resource usage across running services", async () => {
    const body = await detailWith([
      {
        service: "api",
        state: "running",
        status: "Up",
        ports: [],
        resourceUsage: { cpuPercent: 10, memUsedBytes: 100 },
      },
      {
        service: "db",
        state: "running",
        status: "Up",
        ports: [],
        resourceUsage: { cpuPercent: 5, memUsedBytes: 50 },
      },
      // Stopped service with usage must be excluded from the aggregate.
      {
        service: "old",
        state: "exited",
        status: "Exited",
        ports: [],
        resourceUsage: { cpuPercent: 99, memUsedBytes: 999 },
      },
    ]);
    expect(body.worktree.resourceUsage).toEqual({ cpuPercent: 15, memUsedBytes: 150 });
    const api = body.services.find((s) => s.service === "api");
    expect(api?.resourceUsage).toEqual({ cpuPercent: 10, memUsedBytes: 100 });
  });

  test("detail omits resource usage when no service reports stats", async () => {
    const body = await detailWith([
      { service: "api", state: "running", status: "Up", ports: [] },
    ]);
    expect(body.worktree.resourceUsage).toBeUndefined();
  });
});

describe("UI API: status classification", () => {
  test("reports running when state has lastUp and services are running", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const sessionRoot = resolve(tmpHome, "sessions", "wt");
    await mkdir(sessionRoot, { recursive: true });
    const state = {
      initialized: true,
      projectName: "p",
      composeFile: "/c.yaml",
      lastUp: "2026-05-18T00:00:00.000Z",
      worktreeRoot: wt,
      sourcePath: wt,
    };
    await mkdir(resolve(tmpHome, "sessions", `${tmpHome.slice(1).replace(/\//g, "-")}-wt`), {
      recursive: true,
    });
    // Use real sessionNameForWorktree to compute the dir name.
    const { sessionRootForWorktree } = await import("@worktreeos/core/paths");
    const correctRoot = sessionRootForWorktree(wt);
    await mkdir(correctRoot, { recursive: true });
    await writeFile(
      join(correctRoot, "state.json"),
      JSON.stringify(state),
    );

    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext({ state, worktreeRoot: wt }),
      statusRunner: async () =>
        ({
          kind: "ok",
          services: [
            { service: "api", state: "running", status: "Up", ports: [] },
          ],
          state,
          appPortHealthchecks: [],
        }) as any,
    });
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.worktree.status).toBe("running");
  });

  test("worktree detail exposes deploy freshness with duration and commits-since-deploy", async () => {
    const wt = join(tmpHome, "wt-fresh");
    await mkdir(wt, { recursive: true });
    const { sessionRootForWorktree, sessionNameForWorktree } = await import(
      "@worktreeos/core/paths"
    );
    const correctRoot = sessionRootForWorktree(wt);
    await mkdir(correctRoot, { recursive: true });
    const state = {
      initialized: true,
      projectName: "p",
      composeFile: "/c.yaml",
      lastUp: "2026-05-18T00:00:00.000Z",
      lastUpCommit: "deployedsha",
      worktreeRoot: wt,
      sourcePath: wt,
    };
    await writeFile(join(correctRoot, "state.json"), JSON.stringify(state));

    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");

    // Seed a completed up operation with a 23s duration via an advancing clock.
    const times = [
      "2026-05-18T00:00:00.000Z",
      "2026-05-18T00:00:23.000Z",
    ];
    let tick = 0;
    const registry = new OperationRegistry({
      now: () => new Date(times[Math.min(tick++, times.length - 1)]!),
    });
    const session = sessionNameForWorktree(wt);
    const begun = registry.begin(session, "up");
    if (begun.ok) registry.finish(begun.record, "succeeded");

    const handler = createUiApiHandler({
      registry,
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async (_root: string, args: string[]) => {
        if (args[0] === "worktree") {
          return `worktree ${wt}\nHEAD currentsha\nbranch refs/heads/main\n\n`;
        }
        if (args[0] === "rev-list") return "2\n";
        return "";
      },
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext({ state, worktreeRoot: wt }),
      statusRunner: async () =>
        ({
          kind: "ok",
          services: [
            { service: "api", state: "running", status: "Up", ports: [] },
          ],
          state,
          appPortHealthchecks: [],
        }) as any,
    });
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.deployFreshness).toBeDefined();
    expect(body.deployFreshness!.lastUpAt).toBe("2026-05-18T00:00:00.000Z");
    expect(body.deployFreshness!.deployDurationMs).toBe(23000);
    expect(body.deployFreshness!.lastUpCommit).toBe("deployedsha");
    expect(body.deployFreshness!.commitsSinceDeploy).toBe(2);
  });

  test("worktree detail reports zero commits-since-deploy when HEAD equals deployed commit", async () => {
    const wt = join(tmpHome, "wt-fresh-zero");
    await mkdir(wt, { recursive: true });
    const { sessionRootForWorktree } = await import("@worktreeos/core/paths");
    const correctRoot = sessionRootForWorktree(wt);
    await mkdir(correctRoot, { recursive: true });
    const state = {
      initialized: true,
      projectName: "p",
      composeFile: "/c.yaml",
      lastUp: "2026-05-18T00:00:00.000Z",
      lastUpCommit: "samesha",
      worktreeRoot: wt,
      sourcePath: wt,
    };
    await writeFile(join(correctRoot, "state.json"), JSON.stringify(state));

    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    let revListCalled = false;
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async (_root: string, args: string[]) => {
        if (args[0] === "worktree") {
          return `worktree ${wt}\nHEAD samesha\nbranch refs/heads/main\n\n`;
        }
        // The commits-since-deploy form is `rev-list --count <range>` without
        // `--left-right`; the ahead/behind status line uses `--left-right`.
        if (args[0] === "rev-list" && !args.includes("--left-right")) {
          revListCalled = true;
        }
        return "";
      },
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext({ state, worktreeRoot: wt }),
      statusRunner: async () =>
        ({
          kind: "ok",
          services: [{ service: "api", state: "running", status: "Up", ports: [] }],
          state,
          appPortHealthchecks: [],
        }) as any,
    });
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.deployFreshness!.commitsSinceDeploy).toBe(0);
    // No commits-since-deploy rev-list call when HEAD equals the deployed commit.
    expect(revListCalled).toBe(false);
  });

  test("worktree detail omits commits-since-deploy when git count fails but still returns", async () => {
    const wt = join(tmpHome, "wt-fresh-gitfail");
    await mkdir(wt, { recursive: true });
    const { sessionRootForWorktree } = await import("@worktreeos/core/paths");
    const correctRoot = sessionRootForWorktree(wt);
    await mkdir(correctRoot, { recursive: true });
    const state = {
      initialized: true,
      projectName: "p",
      composeFile: "/c.yaml",
      lastUp: "2026-05-18T00:00:00.000Z",
      lastUpCommit: "deployedsha",
      worktreeRoot: wt,
      sourcePath: wt,
    };
    await writeFile(join(correctRoot, "state.json"), JSON.stringify(state));

    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async (_root: string, args: string[]) => {
        if (args[0] === "worktree") {
          return `worktree ${wt}\nHEAD currentsha\nbranch refs/heads/main\n\n`;
        }
        if (args[0] === "rev-list") throw new Error("git boom");
        return "";
      },
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext({ state, worktreeRoot: wt }),
      statusRunner: async () =>
        ({
          kind: "ok",
          services: [{ service: "api", state: "running", status: "Up", ports: [] }],
          state,
          appPortHealthchecks: [],
        }) as any,
    });
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.deployFreshness).toBeDefined();
    expect(body.deployFreshness!.commitsSinceDeploy).toBeUndefined();
    // Other freshness fields still present.
    expect(body.deployFreshness!.lastUpAt).toBe("2026-05-18T00:00:00.000Z");
    expect(body.deployFreshness!.lastUpCommit).toBe("deployedsha");
  });

  test("selective generated deployment returns running with scoped healthchecks only", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const { sessionRootForWorktree } = await import("@worktreeos/core/paths");
    const correctRoot = sessionRootForWorktree(wt);
    await mkdir(correctRoot, { recursive: true });
    const state = {
      initialized: true,
      projectName: "p",
      composeFile: "/c.yaml",
      lastUp: "2026-05-18T00:00:00.000Z",
      worktreeRoot: wt,
      sourcePath: wt,
    };
    await writeFile(join(correctRoot, "state.json"), JSON.stringify(state));

    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext({ state, worktreeRoot: wt }),
      // Selective generated-compose deployment of api+web; admin is configured
      // but absent from the deployment, so statusRunner returns scoped
      // healthchecks for api+web only.
      statusRunner: async () =>
        ({
          kind: "ok",
          services: [
            { service: "api", state: "running", status: "Up", ports: [] },
            { service: "web", state: "running", status: "Up", ports: [] },
          ],
          state,
          appPortHealthchecks: [
            {
              service: "api",
              containerPort: 3000,
              state: "healthy",
              enabled: true,
              allowFailure: false,
            },
            {
              service: "web",
              containerPort: 4200,
              state: "healthy",
              enabled: true,
              allowFailure: false,
            },
          ],
        }) as any,
    });
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.worktree.status).toBe("running");
    expect(body.appPortHealthchecks.length).toBe(2);
    const hcServices = body.appPortHealthchecks.map((h) => h.service);
    expect(hcServices).toContain("api");
    expect(hcServices).toContain("web");
    expect(hcServices).not.toContain("admin");
    expect(body.serviceSummary).toEqual({
      total: 2,
      running: 2,
      stopped: 0,
      failed: 0,
      checking: 0,
    });
  });

  test("failed healthcheck on deployed selected app service still produces running_partial", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const { sessionRootForWorktree } = await import("@worktreeos/core/paths");
    const correctRoot = sessionRootForWorktree(wt);
    await mkdir(correctRoot, { recursive: true });
    const state = {
      initialized: true,
      projectName: "p",
      composeFile: "/c.yaml",
      lastUp: "2026-05-18T00:00:00.000Z",
      worktreeRoot: wt,
      sourcePath: wt,
    };
    await writeFile(join(correctRoot, "state.json"), JSON.stringify(state));

    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext({ state, worktreeRoot: wt }),
      statusRunner: async () =>
        ({
          kind: "ok",
          services: [
            { service: "api", state: "running", status: "Up", ports: [] },
            { service: "web", state: "running", status: "Up", ports: [] },
          ],
          state,
          appPortHealthchecks: [
            {
              service: "api",
              containerPort: 3000,
              state: "healthy",
              enabled: true,
              allowFailure: false,
            },
            {
              service: "web",
              containerPort: 4200,
              state: "failed",
              enabled: true,
              allowFailure: false,
              message: "expected HTTP 200, got 500",
            },
          ],
        }) as any,
    });
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.worktree.status).toBe("running_partial");
  });

  test("reports failed when most recent op for session failed", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const { sessionRootForWorktree, sessionNameForWorktree } = await import(
      "@worktreeos/core/paths"
    );
    const correctRoot = sessionRootForWorktree(wt);
    await mkdir(correctRoot, { recursive: true });
    const state = {
      initialized: true,
      projectName: "p",
      composeFile: "/c.yaml",
      worktreeRoot: wt,
      sourcePath: wt,
    };
    await writeFile(join(correctRoot, "state.json"), JSON.stringify(state));

    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const registry = new OperationRegistry();
    const sessionName = sessionNameForWorktree(wt);
    const begin = registry.begin(sessionName, "up");
    if (!begin.ok) throw new Error("begin failed");
    registry.finish(begin.record, "failed", "boom");
    const handler = createUiApiHandler({
      registry,
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext({ state, worktreeRoot: wt }),
      statusRunner: async () => ({ kind: "no-deployment" }) as any,
    });
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    const body = (await res!.json()) as WorktreeDetailResponse;
    // statusRunner returned no-deployment so services is []; but state exists.
    // Empty services with a state means stopped.
    expect(body.worktree.status).toBe("stopped");
  });

  test("reports running_partial when only some services are running", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const { sessionRootForWorktree } = await import("@worktreeos/core/paths");
    const correctRoot = sessionRootForWorktree(wt);
    await mkdir(correctRoot, { recursive: true });
    const state = {
      initialized: true,
      projectName: "p",
      composeFile: "/c.yaml",
      lastUp: "2026-05-18T00:00:00.000Z",
      worktreeRoot: wt,
      sourcePath: wt,
    };
    await writeFile(join(correctRoot, "state.json"), JSON.stringify(state));

    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext({ state, worktreeRoot: wt }),
      statusRunner: async () =>
        ({
          kind: "ok",
          services: [
            { service: "api", state: "running", status: "Up", ports: [] },
            { service: "db", state: "stopped", status: "Stopped", ports: [] },
          ],
          state,
          appPortHealthchecks: [],
        }) as any,
    });
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.worktree.status).toBe("running_partial");
    expect(body.worktree.serviceSummary?.running).toBe(1);
    expect(body.worktree.serviceSummary?.total).toBe(2);
    expect(body.serviceSummary?.total).toBe(2);
  });

  test("reports stopping when active service-stop runs against initialized state", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const { sessionRootForWorktree, sessionNameForWorktree } = await import(
      "@worktreeos/core/paths"
    );
    const correctRoot = sessionRootForWorktree(wt);
    await mkdir(correctRoot, { recursive: true });
    const state = {
      initialized: true,
      projectName: "p",
      composeFile: "/c.yaml",
      lastUp: "2026-05-18T00:00:00.000Z",
      worktreeRoot: wt,
      sourcePath: wt,
    };
    await writeFile(join(correctRoot, "state.json"), JSON.stringify(state));

    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import(
      "@worktreeos/daemon/operation-registry"
    );
    const { DaemonSessionRegistry } = await import(
      "@worktreeos/daemon/daemon-sessions"
    );
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const registry = new OperationRegistry();
    const sessionName = sessionNameForWorktree(wt);
    const begin = registry.begin(sessionName, "service-stop");
    if (!begin.ok) throw new Error("begin failed");
    const handler = createUiApiHandler({
      registry,
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext({ state, worktreeRoot: wt }),
      statusRunner: async () =>
        ({
          kind: "ok",
          services: [
            { service: "api", state: "running", status: "Up", ports: [] },
          ],
          state,
          appPortHealthchecks: [],
        }) as any,
    });
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.worktree.status).toBe("stopping");
    expect(body.activeOperation?.kind).toBe("service-stop");
  });

  test("reports stopping when active down runs against initialized state", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const { sessionRootForWorktree, sessionNameForWorktree } = await import(
      "@worktreeos/core/paths"
    );
    const correctRoot = sessionRootForWorktree(wt);
    await mkdir(correctRoot, { recursive: true });
    const state = {
      initialized: true,
      projectName: "p",
      composeFile: "/c.yaml",
      lastUp: "2026-05-18T00:00:00.000Z",
      worktreeRoot: wt,
      sourcePath: wt,
    };
    await writeFile(join(correctRoot, "state.json"), JSON.stringify(state));

    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import(
      "@worktreeos/daemon/operation-registry"
    );
    const { DaemonSessionRegistry } = await import(
      "@worktreeos/daemon/daemon-sessions"
    );
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const registry = new OperationRegistry();
    const sessionName = sessionNameForWorktree(wt);
    const begin = registry.begin(sessionName, "down");
    if (!begin.ok) throw new Error("begin failed");
    const handler = createUiApiHandler({
      registry,
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext({ state, worktreeRoot: wt }),
      statusRunner: async () =>
        ({
          kind: "ok",
          services: [
            { service: "api", state: "running", status: "Up", ports: [] },
          ],
          state,
          appPortHealthchecks: [],
        }) as any,
    });
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.worktree.status).toBe("stopping");
    expect(body.activeOperation?.kind).toBe("down");
  });

  test("reports unknown when status collection throws and state exists", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const { sessionRootForWorktree } = await import("@worktreeos/core/paths");
    const correctRoot = sessionRootForWorktree(wt);
    await mkdir(correctRoot, { recursive: true });
    const state = {
      initialized: true,
      projectName: "p",
      composeFile: "/c.yaml",
      lastUp: "2026-05-18T00:00:00.000Z",
      worktreeRoot: wt,
      sourcePath: wt,
    };
    await writeFile(join(correctRoot, "state.json"), JSON.stringify(state));

    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext({ state, worktreeRoot: wt }),
      statusRunner: async () => {
        throw new Error("docker unreachable");
      },
    });
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.worktree.status).toBe("unknown");
    expect(body.state).not.toBeNull();
    expect(body.statusError).toBe("docker unreachable");
  });

  test("reports pending in worktree detail when active up runs against uninitialized state", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const { sessionNameForWorktree } = await import("@worktreeos/core/paths");
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import(
      "@worktreeos/daemon/operation-registry"
    );
    const { DaemonSessionRegistry } = await import(
      "@worktreeos/daemon/daemon-sessions"
    );
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const registry = new OperationRegistry();
    const sessionName = sessionNameForWorktree(wt);
    const begin = registry.begin(sessionName, "up");
    if (!begin.ok) throw new Error("begin failed");
    const handler = createUiApiHandler({
      registry,
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext({ worktreeRoot: wt }),
    });
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.worktree.status).toBe("pending");
    expect(body.state).toBeNull();
    expect(body.services).toEqual([]);
    expect(body.activeOperation?.operationId).toBe(begin.record.operationId);
    expect(body.activeOperation?.kind).toBe("up");
    expect(body.worktree.activeOperation?.operationId).toBe(
      begin.record.operationId,
    );
  });

  test("reports pending in project summary when active up runs against uninitialized worktree", async () => {
    const repoRoot = join(tmpHome, "repo");
    await mkdir(repoRoot, { recursive: true });
    const { saveProjects: save } = await import(
      "@worktreeos/core/project-registry"
    );
    await save(
      [
        {
          id: "p1",
          displayName: "repo",
          sourcePath: repoRoot,
          createdAt: "2026-05-18T00:00:00.000Z",
          lastSeenAt: "2026-05-18T00:00:00.000Z",
        },
      ],
      { filePath: resolve(tmpHome, "projects.json") },
    );
    const { sessionNameForWorktree } = await import("@worktreeos/core/paths");
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import(
      "@worktreeos/daemon/operation-registry"
    );
    const { DaemonSessionRegistry } = await import(
      "@worktreeos/daemon/daemon-sessions"
    );
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const registry = new OperationRegistry();
    const sessionName = sessionNameForWorktree(repoRoot);
    const begin = registry.begin(sessionName, "up");
    if (!begin.ok) throw new Error("begin failed");
    const handler = createUiApiHandler({
      registry,
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () =>
        [
          `worktree ${repoRoot}`,
          "HEAD aaa",
          "branch refs/heads/main",
          "",
          "",
        ].join("\n"),
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext(),
    });
    const res = await handler(new Request("http://x/ui/v1/projects"));
    const body = (await res!.json()) as ProjectListResponse;
    const wt = body.projects[0]!.worktrees[0]!;
    expect(wt.status).toBe("pending");
    expect(wt.activeOperation?.operationId).toBe(begin.record.operationId);
    expect(wt.activeOperation?.kind).toBe("up");
  });

  test("persists a failure marker so failed status survives daemon restart", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const { sessionUpFailurePath } = await import("@worktreeos/core/paths");
    const failurePath = sessionUpFailurePath(wt);
    await mkdir(join(failurePath, ".."), { recursive: true });
    await writeFile(
      failurePath,
      JSON.stringify({
        failedAt: "2026-05-18T00:00:00.000Z",
        message: "init script crashed",
        operationId: "op-prev",
      }),
    );
    // Simulate a fresh daemon: empty registry, no active op, no latest op.
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import(
      "@worktreeos/daemon/operation-registry"
    );
    const { DaemonSessionRegistry } = await import(
      "@worktreeos/daemon/daemon-sessions"
    );
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext({ worktreeRoot: wt }),
    });
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.worktree.status).toBe("failed");
    expect(body.statusError).toBe("init script crashed");
  });

  test("reports failed when last up crashed before initializing state", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const { sessionNameForWorktree } = await import("@worktreeos/core/paths");
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import(
      "@worktreeos/daemon/operation-registry"
    );
    const { DaemonSessionRegistry } = await import(
      "@worktreeos/daemon/daemon-sessions"
    );
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const registry = new OperationRegistry();
    const sessionName = sessionNameForWorktree(wt);
    const begin = registry.begin(sessionName, "up");
    if (!begin.ok) throw new Error("begin failed");
    registry.finish(begin.record, "failed", "init script crashed");
    const handler = createUiApiHandler({
      registry,
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext({ worktreeRoot: wt }),
    });
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.worktree.status).toBe("failed");
    expect(body.state).toBeNull();
    expect(body.activeOperation).toBeUndefined();
  });

  test("uninitialized worktree without active up stays not_started in project summary", async () => {
    const repoRoot = join(tmpHome, "repo");
    await mkdir(repoRoot, { recursive: true });
    const { saveProjects: save } = await import(
      "@worktreeos/core/project-registry"
    );
    await save(
      [
        {
          id: "p1",
          displayName: "repo",
          sourcePath: repoRoot,
          createdAt: "2026-05-18T00:00:00.000Z",
          lastSeenAt: "2026-05-18T00:00:00.000Z",
        },
      ],
      { filePath: resolve(tmpHome, "projects.json") },
    );
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import(
      "@worktreeos/daemon/operation-registry"
    );
    const { DaemonSessionRegistry } = await import(
      "@worktreeos/daemon/daemon-sessions"
    );
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () =>
        [
          `worktree ${repoRoot}`,
          "HEAD aaa",
          "branch refs/heads/main",
          "",
          "",
        ].join("\n"),
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext(),
    });
    const res = await handler(new Request("http://x/ui/v1/projects"));
    const body = (await res!.json()) as ProjectListResponse;
    const wt = body.projects[0]!.worktrees[0]!;
    expect(wt.status).toBe("not_started");
    expect(wt.activeOperation).toBeUndefined();
  });

  test("reports pending when an active up is running before healthchecks", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const { sessionRootForWorktree, sessionNameForWorktree } = await import(
      "@worktreeos/core/paths"
    );
    const correctRoot = sessionRootForWorktree(wt);
    await mkdir(correctRoot, { recursive: true });
    const state = {
      initialized: true,
      projectName: "p",
      composeFile: "/c.yaml",
      lastUp: "2026-05-18T00:00:00.000Z",
      worktreeRoot: wt,
      sourcePath: wt,
    };
    await writeFile(join(correctRoot, "state.json"), JSON.stringify(state));
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import("@worktreeos/daemon/operation-registry");
    const { DaemonSessionRegistry } = await import("@worktreeos/daemon/daemon-sessions");
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const registry = new OperationRegistry();
    const sessionName = sessionNameForWorktree(wt);
    registry.begin(sessionName, "up");
    const handler = createUiApiHandler({
      registry,
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext({ state, worktreeRoot: wt }),
      statusRunner: async () => ({ kind: "no-deployment" }) as any,
    });
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.worktree.status).toBe("pending");
  });
});

describe("UI API: routing & static fallback", () => {
  test("unknown /ui/v1/* path returns API JSON not-found, not SPA HTML", async () => {
    daemon = await startWithHome({
      resolveSession: async () => fakeContext(),

    });
    const res = await fetchUi("/ui/v1/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not-found");
  });

  test("web listener separates UI API from static fallback", async () => {
    const assetRoot = join(tmpHome, "dist");
    await mkdir(assetRoot, { recursive: true });
    await writeFile(join(assetRoot, "index.html"), "<html>app</html>");
    daemon = await startWithHome({
      resolveSession: async () => fakeContext(),
      web: { host: "127.0.0.1", port: 0, assetRoot },
    });
    expect(daemon.webUrl).toBeDefined();
    // SPA route returns index.html
    const spa = await fetch(`${daemon.webUrl}/sessions/x`);
    expect(spa.status).toBe(200);
    expect((await spa.text()).includes("app")).toBe(true);
    // UI API route returns JSON, not HTML
    const api = await fetch(`${daemon.webUrl}/ui/v1/projects`);
    expect(api.status).toBe(200);
    expect(api.headers.get("content-type")).toContain("application/json");
    // Unknown UI API route returns JSON 404, not SPA HTML
    const missing = await fetch(`${daemon.webUrl}/ui/v1/does-not-exist`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("application/json");
  });
});

describe("UI API: worktree remove submission", () => {
  async function buildRemoveHandler(opts: {
    sourcePath: string;
    targetPath: string;
    initialized?: boolean;
    registry?: import("@worktreeos/daemon/operation-registry").OperationRegistry;
    events?: import("@worktreeos/daemon/event-bus").DaemonEventBus;
    sessionName?: string;
    gitCalls?: Array<{ cwd: string; args: string[] }>;
    gitRemoveFails?: { message: string };
    /**
     * Porcelain output the simulated git runner returns for
     * `git status --porcelain=v1 --untracked-files=all`. Empty by default
     * (clean worktree).
     */
    dirtyStatus?: string;
    downRunner?: (ctx: any) => Promise<{ kind: "no-deployment" | "stopped" }>;
  }) {
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import(
      "@worktreeos/daemon/operation-registry"
    );
    const { DaemonSessionRegistry } = await import(
      "@worktreeos/daemon/daemon-sessions"
    );
    const { TunnelRegistry } = await import(
      "@worktreeos/runtime/tunnel-registry"
    );
    const registry = opts.registry ?? new OperationRegistry();
    const gitCalls = opts.gitCalls ?? [];
    const ctxState = opts.initialized
      ? {
          initialized: true,
          projectName: "test-proj",
          composeFile: "/c.yaml",
        }
      : null;
    const handler = createUiApiHandler({
      registry,
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      events: opts.events,
      gitRunner: async (cwd: string, args: string[]) => {
        gitCalls.push({ cwd, args });
        if (args[0] === "status" && args[1] === "--porcelain=v1") {
          return opts.dirtyStatus ?? "";
        }
        if (args[0] === "worktree" && args[1] === "remove") {
          if (opts.gitRemoveFails) {
            const { GitError } = await import("@worktreeos/core/git");
            throw new GitError(opts.gitRemoveFails.message);
          }
          return "";
        }
        return "";
      },
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async (cwd) =>
        fakeContext({
          worktreeRoot: cwd,
          source: { path: opts.sourcePath, bare: false, detached: false },
          sessionName: opts.sessionName ?? "ui-remove",
          state: ctxState as any,
        }),
      ...(opts.downRunner ? { downRunner: opts.downRunner as any } : {}),
    });
    return { registry, handler, gitCalls };
  }

  test("submits worktree-remove and returns operation id", async () => {
    const sourcePath = join(tmpHome, "main");
    const target = join(tmpHome, "feature");
    await mkdir(sourcePath, { recursive: true });
    await mkdir(target, { recursive: true });
    const { registry, handler, gitCalls } = await buildRemoveHandler({
      sourcePath,
      targetPath: target,
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: target }),
      }),
    );
    expect(res!.status).toBe(202);
    const body = (await res!.json()) as {
      operationId: string;
      kind: string;
      sessionName: string;
    };
    expect(body.kind).toBe("worktree-remove");
    expect(typeof body.operationId).toBe("string");

    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const rec = registry.get(body.operationId);
      if (rec && rec.status !== "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(registry.get(body.operationId)!.status).toBe("succeeded");
    const removeCalls = gitCalls.filter(
      (c) => c.args[0] === "worktree" && c.args[1] === "remove",
    );
    expect(removeCalls.length).toBe(1);
    expect(removeCalls[0]!.cwd).toBe(sourcePath);
    expect(removeCalls[0]!.args).toEqual(["worktree", "remove", target]);
  });

  test("clean removal runs dirty preflight before unforced git remove", async () => {
    const sourcePath = join(tmpHome, "main");
    const target = join(tmpHome, "feature");
    await mkdir(sourcePath, { recursive: true });
    await mkdir(target, { recursive: true });
    const { registry, handler, gitCalls } = await buildRemoveHandler({
      sourcePath,
      targetPath: target,
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: target }),
      }),
    );
    expect(res!.status).toBe(202);
    const body = (await res!.json()) as { operationId: string };
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const rec = registry.get(body.operationId);
      if (rec && rec.status !== "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(registry.get(body.operationId)!.status).toBe("succeeded");
    const statusCalls = gitCalls.filter((c) => c.args[0] === "status");
    expect(statusCalls.length).toBe(1);
    expect(statusCalls[0]!.cwd).toBe(target);
    expect(statusCalls[0]!.args).toEqual([
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    const removeCalls = gitCalls.filter(
      (c) => c.args[0] === "worktree" && c.args[1] === "remove",
    );
    expect(removeCalls[0]!.args).toEqual(["worktree", "remove", target]);
  });

  test("unconfirmed dirty removal returns worktree-dirty without cleanup", async () => {
    const sourcePath = join(tmpHome, "main");
    const target = join(tmpHome, "feature");
    await mkdir(sourcePath, { recursive: true });
    await mkdir(target, { recursive: true });
    let downCalls = 0;
    const { handler, gitCalls } = await buildRemoveHandler({
      sourcePath,
      targetPath: target,
      initialized: true,
      dirtyStatus: " M edited.ts\n?? new.ts\n",
      downRunner: async () => {
        downCalls += 1;
        return { kind: "stopped" };
      },
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: target }),
      }),
    );
    expect(res!.status).toBe(409);
    const body = (await res!.json()) as {
      error: string;
      message: string;
      path: string;
      changes: {
        total: number;
        staged: number;
        unstaged: number;
        untracked: number;
        unmerged: number;
      };
    };
    expect(body.error).toBe("worktree-dirty");
    expect(body.path).toBe(target);
    expect(body.changes.total).toBe(2);
    expect(body.changes.unstaged).toBe(1);
    expect(body.changes.untracked).toBe(1);
    expect(downCalls).toBe(0);
    const removeCalls = gitCalls.filter(
      (c) => c.args[0] === "worktree" && c.args[1] === "remove",
    );
    expect(removeCalls.length).toBe(0);
  });

  test("confirmed dirty removal forwards --force to git worktree remove", async () => {
    const sourcePath = join(tmpHome, "main");
    const target = join(tmpHome, "feature");
    await mkdir(sourcePath, { recursive: true });
    await mkdir(target, { recursive: true });
    const { registry, handler, gitCalls } = await buildRemoveHandler({
      sourcePath,
      targetPath: target,
      dirtyStatus: " M edited.ts\n",
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: target, discardChanges: true }),
      }),
    );
    expect(res!.status).toBe(202);
    const body = (await res!.json()) as { operationId: string };
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const rec = registry.get(body.operationId);
      if (rec && rec.status !== "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(registry.get(body.operationId)!.status).toBe("succeeded");
    // Preflight is skipped when discardChanges is true.
    const statusCalls = gitCalls.filter((c) => c.args[0] === "status");
    expect(statusCalls.length).toBe(0);
    const removeCalls = gitCalls.filter(
      (c) => c.args[0] === "worktree" && c.args[1] === "remove",
    );
    expect(removeCalls[0]!.args).toEqual([
      "worktree",
      "remove",
      "--force",
      target,
    ]);
  });

  test("dirty failure propagates as failed operation", async () => {
    const sourcePath = join(tmpHome, "main");
    const target = join(tmpHome, "feature");
    await mkdir(sourcePath, { recursive: true });
    await mkdir(target, { recursive: true });
    const { registry, handler } = await buildRemoveHandler({
      sourcePath,
      targetPath: target,
      gitRemoveFails: {
        message:
          "git -C /main worktree remove /feature failed (exit 128): fatal: dirty",
      },
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: target }),
      }),
    );
    expect(res!.status).toBe(202);
    const body = (await res!.json()) as { operationId: string };
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const rec = registry.get(body.operationId);
      if (rec && rec.status !== "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const rec = registry.get(body.operationId)!;
    expect(rec.status).toBe("failed");
    expect(rec.failureMessage ?? "").toContain("fatal: dirty");
  });

  test("removes uninitialized worktree without running down", async () => {
    const sourcePath = join(tmpHome, "main");
    const target = join(tmpHome, "feature");
    await mkdir(sourcePath, { recursive: true });
    await mkdir(target, { recursive: true });
    let downCalls = 0;
    const { registry, handler, gitCalls } = await buildRemoveHandler({
      sourcePath,
      targetPath: target,
      initialized: false,
      downRunner: async () => {
        downCalls += 1;
        return { kind: "no-deployment" };
      },
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: target }),
      }),
    );
    expect(res!.status).toBe(202);
    const body = (await res!.json()) as { operationId: string };
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const rec = registry.get(body.operationId);
      if (rec && rec.status !== "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(registry.get(body.operationId)!.status).toBe("succeeded");
    expect(downCalls).toBe(0);
    const removeCalls = gitCalls.filter(
      (c) => c.args[0] === "worktree" && c.args[1] === "remove",
    );
    expect(removeCalls.length).toBe(1);
  });

  test("rejects removal of source worktree with validation error", async () => {
    const sourcePath = join(tmpHome, "main");
    await mkdir(sourcePath, { recursive: true });
    const { handler } = await buildRemoveHandler({
      sourcePath,
      targetPath: sourcePath,
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: sourcePath }),
      }),
    );
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as { error: string; message: string };
    expect(body.error).toBe("validation");
    expect(body.message).toContain("primary/source worktree");
  });

  test("returns 409 conflict when session has active mutating operation", async () => {
    const sourcePath = join(tmpHome, "main");
    const target = join(tmpHome, "feature");
    await mkdir(sourcePath, { recursive: true });
    await mkdir(target, { recursive: true });
    const { OperationRegistry } = await import(
      "@worktreeos/daemon/operation-registry"
    );
    const registry = new OperationRegistry();
    registry.begin("ui-remove", "up");
    const { handler } = await buildRemoveHandler({
      sourcePath,
      targetPath: target,
      registry,
      sessionName: "ui-remove",
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: target }),
      }),
    );
    expect(res!.status).toBe(409);
  });

  test("publishes worktree.removed event after successful removal", async () => {
    const sourcePath = join(tmpHome, "main");
    const target = join(tmpHome, "feature");
    await mkdir(sourcePath, { recursive: true });
    await mkdir(target, { recursive: true });
    const { DaemonEventBus } = await import("@worktreeos/daemon/event-bus");
    const events = new DaemonEventBus();
    const captured: import("@worktreeos/core/unified-events").UnifiedEventEnvelope[] =
      [];
    events.subscribe((env) => captured.push(env));
    const { registry, handler } = await buildRemoveHandler({
      sourcePath,
      targetPath: target,
      events,
      sessionName: "ui-rm-evt",
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: target }),
      }),
    );
    const body = (await res!.json()) as { operationId: string };
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const rec = registry.get(body.operationId);
      if (rec && rec.status !== "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const types = captured.map((e) => e.type);
    expect(types).toContain("operation.started");
    expect(types).toContain("operation.finished");
    expect(types).toContain("worktree.removed");
    const removed = captured.find((e) => e.type === "worktree.removed");
    expect(removed?.sessionName).toBe("ui-rm-evt");
    expect(removed?.worktreePath).toBe(target);
  });

  test("removes worktree when deploy config is missing from source", async () => {
    const sourcePath = join(tmpHome, "main");
    const target = join(tmpHome, "feature");
    await mkdir(sourcePath, { recursive: true });
    await mkdir(target, { recursive: true });
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import(
      "@worktreeos/daemon/operation-registry"
    );
    const { DaemonSessionRegistry } = await import(
      "@worktreeos/daemon/daemon-sessions"
    );
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const { ConfigError } = await import("@worktreeos/core/config");
    const registry = new OperationRegistry();
    const gitCalls: Array<{ cwd: string; args: string[] }> = [];
    let downCalls = 0;
    const handler = createUiApiHandler({
      registry,
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async (cwd: string, args: string[]) => {
        gitCalls.push({ cwd, args });
        if (args[0] === "worktree" && args[1] === "list") {
          return [
            `worktree ${sourcePath}`,
            "HEAD aaa",
            "branch refs/heads/main",
            "",
            `worktree ${target}`,
            "HEAD bbb",
            "branch refs/heads/feature",
            "",
            "",
          ].join("\n");
        }
        return "";
      },
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => {
        throw new ConfigError(
          `deploy config not found at ${join(sourcePath, ".wos", "deploy.yaml")}`,
        );
      },
      downRunner: async () => {
        downCalls += 1;
        return { kind: "no-deployment" };
      },
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: target }),
      }),
    );
    expect(res!.status).toBe(202);
    const body = (await res!.json()) as { operationId: string; kind: string };
    expect(body.kind).toBe("worktree-remove");
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const rec = registry.get(body.operationId);
      if (rec && rec.status !== "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(registry.get(body.operationId)!.status).toBe("succeeded");
    expect(downCalls).toBe(0);
    const removeCalls = gitCalls.filter(
      (c) => c.args[0] === "worktree" && c.args[1] === "remove",
    );
    expect(removeCalls.length).toBe(1);
    expect(removeCalls[0]!.cwd).toBe(sourcePath);
    expect(removeCalls[0]!.args).toEqual(["worktree", "remove", target]);
  });
});

describe("UI API: latest operation and failure context", () => {
  test("exposes latestOperation metadata after a finished op", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const { sessionRootForWorktree, sessionNameForWorktree } = await import(
      "@worktreeos/core/paths"
    );
    const correctRoot = sessionRootForWorktree(wt);
    await mkdir(correctRoot, { recursive: true });
    const state = {
      initialized: true,
      projectName: "p",
      composeFile: "/c.yaml",
      worktreeRoot: wt,
      sourcePath: wt,
    };
    await writeFile(join(correctRoot, "state.json"), JSON.stringify(state));

    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import(
      "@worktreeos/daemon/operation-registry"
    );
    const { DaemonSessionRegistry } = await import(
      "@worktreeos/daemon/daemon-sessions"
    );
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const registry = new OperationRegistry();
    const sessionName = sessionNameForWorktree(wt);
    const begin = registry.begin(sessionName, "up");
    if (!begin.ok) throw new Error("begin failed");
    registry.finish(begin.record, "succeeded");
    const handler = createUiApiHandler({
      registry,
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext({ state, worktreeRoot: wt }),
      statusRunner: async () =>
        ({
          kind: "ok",
          services: [],
          state,
          appPortHealthchecks: [],
        }) as any,
    });
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.latestOperation?.operationId).toBe(begin.record.operationId);
    expect(body.latestOperation?.kind).toBe("up");
    expect(body.latestOperation?.status).toBe("succeeded");
    expect(body.failureContext).toBeUndefined();
    expect(body.activeOperation).toBeUndefined();
  });

  test("populates failureContext with init channel for failed init-script step", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const { sessionNameForWorktree } = await import("@worktreeos/core/paths");
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import(
      "@worktreeos/daemon/operation-registry"
    );
    const { DaemonSessionRegistry } = await import(
      "@worktreeos/daemon/daemon-sessions"
    );
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const registry = new OperationRegistry();
    const sessionName = sessionNameForWorktree(wt);
    const begin = registry.begin(sessionName, "up");
    if (!begin.ok) throw new Error("begin failed");
    const observer = registry.observerFor(begin.record);
    observer.emit({ type: "step", id: "first-run-setup", state: "running" });
    observer.emit({ type: "step", id: "init-script", state: "running" });
    observer.emit({ type: "step", id: "init-script", state: "failed" });
    registry.finish(begin.record, "failed", "init failed");
    const handler = createUiApiHandler({
      registry,
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext({ state: null, worktreeRoot: wt }),
      statusRunner: async () => ({ kind: "no-deployment" }) as any,
    });
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.latestOperation?.status).toBe("failed");
    expect(body.latestOperation?.failureMessage).toBe("init failed");
    expect(body.failureContext?.channel).toBe("init");
    expect(body.failureContext?.step).toBe("init-script");
    expect(body.failureContext?.message).toBe("init failed");
    expect(body.failureContext?.kind).toBe("up");
  });

  test("active and latest operations coexist independently", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const { sessionRootForWorktree, sessionNameForWorktree } = await import(
      "@worktreeos/core/paths"
    );
    const correctRoot = sessionRootForWorktree(wt);
    await mkdir(correctRoot, { recursive: true });
    const state = {
      initialized: true,
      projectName: "p",
      composeFile: "/c.yaml",
      worktreeRoot: wt,
      sourcePath: wt,
    };
    await writeFile(join(correctRoot, "state.json"), JSON.stringify(state));
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import(
      "@worktreeos/daemon/operation-registry"
    );
    const { DaemonSessionRegistry } = await import(
      "@worktreeos/daemon/daemon-sessions"
    );
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    let tick = 0;
    const registry = new OperationRegistry({
      now: () => new Date(2026, 0, 1, 0, 0, tick++),
    });
    const sessionName = sessionNameForWorktree(wt);
    // First op failed.
    const failed = registry.begin(sessionName, "service-restart");
    if (!failed.ok) throw new Error("begin failed");
    registry.finish(failed.record, "failed", "service blew up");
    // Now a fresh up is running, strictly after the failed op.
    const running = registry.begin(sessionName, "up");
    if (!running.ok) throw new Error("begin running failed");
    const handler = createUiApiHandler({
      registry,
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext({ state, worktreeRoot: wt }),
      statusRunner: async () =>
        ({
          kind: "ok",
          services: [],
          state,
          appPortHealthchecks: [],
        }) as any,
    });
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.activeOperation?.operationId).toBe(running.record.operationId);
    expect(body.activeOperation?.status).toBe("running");
    // latestForSession orders by startedAt ascending; the newest one is `up`.
    expect(body.latestOperation?.operationId).toBe(running.record.operationId);
    // The latest is currently running (no failure context yet).
    expect(body.failureContext).toBeUndefined();
  });

  test("remains valid response without latestOperation when registry has no history", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import(
      "@worktreeos/daemon/operation-registry"
    );
    const { DaemonSessionRegistry } = await import(
      "@worktreeos/daemon/daemon-sessions"
    );
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext({ state: null, worktreeRoot: wt }),
      statusRunner: async () => ({ kind: "no-deployment" }) as any,
    });
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.latestOperation).toBeUndefined();
    expect(body.failureContext).toBeUndefined();
    expect(body.worktree.status).toBe("not_started");
  });
});

describe("UI API: worktree create", () => {
  async function buildCreateHandler(opts: {
    project: {
      id: string;
      displayName: string;
      sourcePath: string;
    };
    gitCreateFails?: { message: string };
    branchExists?: boolean;
    expectedTargetPath?: string;
    expectedBranch?: string;
  }) {
    await saveProjects(
      [
        {
          id: opts.project.id,
          displayName: opts.project.displayName,
          sourcePath: opts.project.sourcePath,
          createdAt: "2026-01-01T00:00:00.000Z",
          lastSeenAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      { filePath: resolve(tmpHome, "projects.json") },
    );
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import(
      "@worktreeos/daemon/operation-registry"
    );
    const { DaemonSessionRegistry } = await import(
      "@worktreeos/daemon/daemon-sessions"
    );
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const { DaemonEventBus } = await import("@worktreeos/daemon/event-bus");
    const { GitError } = await import("@worktreeos/core/git");
    const registry = new OperationRegistry();
    const events = new DaemonEventBus();
    const captured: any[] = [];
    const subscription = events.subscribe(
      (env) => captured.push(env.event),
    );
    const gitCalls: Array<{ cwd: string; args: string[] }> = [];
    const handler = createUiApiHandler({
      registry,
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      events,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      gitRunner: async (cwd: string, args: string[]) => {
        gitCalls.push({ cwd, args });
        if (
          args[0] === "rev-parse" &&
          args[1] === "--verify" &&
          args[2] === "--quiet"
        ) {
          if (opts.branchExists === false) {
            throw new GitError("git rev-parse failed (exit 1):");
          }
          return "abc\n";
        }
        if (args[0] === "worktree" && args[1] === "add") {
          if (opts.gitCreateFails) {
            throw new GitError(opts.gitCreateFails.message);
          }
          if (opts.expectedTargetPath) {
            // pretend git created the worktree directory
            await mkdir(opts.expectedTargetPath, { recursive: true });
          }
          return "";
        }
        return "";
      },
      resolveSession: async () => fakeContext(),
    });
    return { registry, handler, events, captured, gitCalls, subscription };
  }

  test("creates detached worktree under WOS_HOME/worktrees", async () => {
    const sourcePath = join(tmpHome, "main");
    await mkdir(sourcePath, { recursive: true });
    const projectId = "p1";
    const { registry, handler, gitCalls, captured } = await buildCreateHandler({
      project: { id: projectId, displayName: "app", sourcePath },
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, name: "feature-a" }),
      }),
    );
    expect(res!.status).toBe(202);
    const body = (await res!.json()) as {
      operationId: string;
      kind: string;
      sessionName: string;
      targetPath: string;
      projectId: string;
    };
    expect(body.kind).toBe("worktree-create");
    expect(body.projectId).toBe(projectId);
    expect(body.targetPath.startsWith(resolve(tmpHome, "worktrees"))).toBe(true);
    expect(body.targetPath.endsWith("/feature-a")).toBe(true);

    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const rec = registry.get(body.operationId);
      if (rec && rec.status !== "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(registry.get(body.operationId)!.status).toBe("succeeded");
    const { realpathSync } = await import("node:fs");
    const resolvedSource = realpathSync(sourcePath);
    const addCalls = gitCalls.filter(
      (c) => c.args[0] === "worktree" && c.args[1] === "add",
    );
    expect(addCalls.length).toBe(1);
    expect(addCalls[0]!.cwd).toBe(resolvedSource);
    expect(addCalls[0]!.args).toEqual([
      "worktree",
      "add",
      "--detach",
      body.targetPath,
      "HEAD",
    ]);
    const created = captured.find((e: any) => e.type === "worktree.created");
    expect(created).toBeDefined();
    expect(created.worktree.mode).toBe("detached");
    expect(created.worktree.worktreePath).toBe(body.targetPath);
  });

  test("creates branch-attached worktree when branch exists", async () => {
    const sourcePath = join(tmpHome, "main");
    await mkdir(sourcePath, { recursive: true });
    const { registry, handler, gitCalls, captured } = await buildCreateHandler({
      project: { id: "p1", displayName: "app", sourcePath },
      branchExists: true,
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: "p1",
          name: "wt",
          branch: "feature/login",
        }),
      }),
    );
    expect(res!.status).toBe(202);
    const body = (await res!.json()) as {
      operationId: string;
      branch: string;
      targetPath: string;
    };
    expect(body.branch).toBe("feature/login");
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const rec = registry.get(body.operationId);
      if (rec && rec.status !== "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(registry.get(body.operationId)!.status).toBe("succeeded");
    const addCalls = gitCalls.filter(
      (c) => c.args[0] === "worktree" && c.args[1] === "add",
    );
    expect(addCalls[0]!.args).toEqual([
      "worktree",
      "add",
      body.targetPath,
      "feature/login",
    ]);
    const created = captured.find((e: any) => e.type === "worktree.created");
    expect(created.worktree.mode).toBe("branch");
    expect(created.worktree.branch).toBe("feature/login");
  });

  test("rejects unsafe worktree names", async () => {
    const sourcePath = join(tmpHome, "main");
    await mkdir(sourcePath, { recursive: true });
    const { handler } = await buildCreateHandler({
      project: { id: "p1", displayName: "app", sourcePath },
    });
    for (const name of ["", "..", "../escape", "a/b"]) {
      const res = await handler(
        new Request("http://x/ui/v1/worktrees/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: "p1", name }),
        }),
      );
      expect(res!.status).toBe(400);
    }
  });

  test("rejects when the target path already exists", async () => {
    const sourcePath = join(tmpHome, "main");
    await mkdir(sourcePath, { recursive: true });
    const { handler } = await buildCreateHandler({
      project: { id: "p1", displayName: "app", sourcePath },
    });
    // Pre-create the target path so the daemon refuses the create request.
    const segmentDir = join(tmpHome, "worktrees");
    await mkdir(segmentDir, { recursive: true });
    // Walk worktrees children to find the project directory; there should be
    // exactly one. Then create `existing` under it.
    const segments = await (await import("node:fs/promises")).readdir(
      segmentDir,
    );
    // The project directory doesn't exist yet; the handler will create it.
    // Instead, derive the expected path by importing managed-worktrees helpers.
    const { resolveManagedWorktreePath } = await import(
      "@worktreeos/core/managed-worktrees"
    );
    const target = resolveManagedWorktreePath({
      record: {
        id: "p1",
        displayName: "app",
        sourcePath,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      },
      name: "existing",
    });
    await mkdir(target.targetPath, { recursive: true });
    void segments;
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: "p1", name: "existing" }),
      }),
    );
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as { message: string };
    expect(body.message).toContain("already exists");
  });

  test("rejects when the branch does not exist", async () => {
    const sourcePath = join(tmpHome, "main");
    await mkdir(sourcePath, { recursive: true });
    const { handler } = await buildCreateHandler({
      project: { id: "p1", displayName: "app", sourcePath },
      branchExists: false,
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: "p1",
          name: "wt",
          branch: "missing",
        }),
      }),
    );
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as { message: string };
    expect(body.message).toContain("missing");
  });

  test("git failure surfaces as failed operation without worktree.created event", async () => {
    const sourcePath = join(tmpHome, "main");
    await mkdir(sourcePath, { recursive: true });
    const { registry, handler, captured } = await buildCreateHandler({
      project: { id: "p1", displayName: "app", sourcePath },
      gitCreateFails: {
        message: "git worktree add failed (exit 128): fatal: oops",
      },
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: "p1", name: "wt" }),
      }),
    );
    expect(res!.status).toBe(202);
    const body = (await res!.json()) as { operationId: string };
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const rec = registry.get(body.operationId);
      if (rec && rec.status !== "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(registry.get(body.operationId)!.status).toBe("failed");
    expect(registry.get(body.operationId)!.failureMessage).toContain("oops");
    expect(
      captured.some((e: any) => e.type === "worktree.created"),
    ).toBe(false);
  });

  test("rejects unknown project id", async () => {
    const sourcePath = join(tmpHome, "main");
    await mkdir(sourcePath, { recursive: true });
    const { handler } = await buildCreateHandler({
      project: { id: "p1", displayName: "app", sourcePath },
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: "missing", name: "wt" }),
      }),
    );
    expect(res!.status).toBe(404);
  });
});

describe("UI API: terminal-layer (HTTP)", () => {
  async function buildHandler(): Promise<{
    handler: (req: Request) => Promise<Response | null>;
    manager: any;
  }> {
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import(
      "@worktreeos/daemon/operation-registry"
    );
    const { DaemonSessionRegistry } = await import(
      "@worktreeos/daemon/daemon-sessions"
    );
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const { TerminalSessionManager } = await import(
      "@worktreeos/daemon/terminal-layer/manager"
    );
    const { createFakeTerminalRuntime } = await import(
      "@worktreeos/daemon/terminal-layer/testing"
    );
    const r = createFakeTerminalRuntime();
    const manager = new TerminalSessionManager({ runtime: r.runtime });
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      terminalLayer: manager,
      gitRunner: async () => "",
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext(),
    });
    return { handler, manager };
  }

  test("creates a terminal session via the new layer", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const { handler } = await buildHandler();
    const res = await handler(
      new Request("http://x/ui/v1/terminal-layer/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ worktreePath: wt, cols: 90, rows: 25 }),
      }),
    );
    expect(res!.status).toBe(201);
    const body = (await res!.json()) as { session: any };
    expect(body.session.status).toBe("running");
    expect(body.session.cols).toBe(90);
    expect(body.session.rows).toBe(25);
  });

  test("rejects create with missing worktreePath", async () => {
    const { handler } = await buildHandler();
    const res = await handler(
      new Request("http://x/ui/v1/terminal-layer/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res!.status).toBe(400);
  });

  test("rejects create with non-existent worktree path", async () => {
    const { handler } = await buildHandler();
    const res = await handler(
      new Request("http://x/ui/v1/terminal-layer/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ worktreePath: join(tmpHome, "missing") }),
      }),
    );
    expect(res!.status).toBe(400);
  });

  test("lists terminal sessions, optionally filtered by path", async () => {
    const wt1 = join(tmpHome, "wt1");
    const wt2 = join(tmpHome, "wt2");
    await mkdir(wt1, { recursive: true });
    await mkdir(wt2, { recursive: true });
    const { handler } = await buildHandler();
    for (const p of [wt1, wt1, wt2]) {
      await handler(
        new Request("http://x/ui/v1/terminal-layer/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ worktreePath: p }),
        }),
      );
    }
    const all = (await (
      await handler(new Request("http://x/ui/v1/terminal-layer/sessions"))
    )!.json()) as { sessions: any[] };
    expect(all.sessions.length).toBe(3);
    const filtered = (await (
      await handler(
        new Request(
          `http://x/ui/v1/terminal-layer/sessions?path=${encodeURIComponent(wt1)}`,
        ),
      )
    )!.json()) as { sessions: any[] };
    expect(filtered.sessions.length).toBe(2);
  });

  test("returns 404 for unknown terminal id", async () => {
    const { handler } = await buildHandler();
    const res = await handler(
      new Request("http://x/ui/v1/terminal-layer/sessions/missing"),
    );
    expect(res!.status).toBe(404);
  });

  test("terminate returns updated metadata", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const { handler } = await buildHandler();
    const create = (await (
      await handler(
        new Request("http://x/ui/v1/terminal-layer/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ worktreePath: wt }),
        }),
      )
    )!.json()) as { session: { id: string } };
    const res = await handler(
      new Request(
        `http://x/ui/v1/terminal-layer/sessions/${create.session.id}/terminate`,
        { method: "POST" },
      ),
    );
    expect(res!.status).toBe(202);
  });

  test("renames a terminal session via PATCH", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const { handler } = await buildHandler();
    const create = (await (
      await handler(
        new Request("http://x/ui/v1/terminal-layer/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ worktreePath: wt }),
        }),
      )
    )!.json()) as { session: { id: string } };
    const res = await handler(
      new Request(
        `http://x/ui/v1/terminal-layer/sessions/${create.session.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "api logs" }),
        },
      ),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { session: { title?: string } };
    expect(body.session.title).toBe("api logs");
  });

  test("rename returns 404 for an unknown terminal id", async () => {
    const { handler } = await buildHandler();
    const res = await handler(
      new Request("http://x/ui/v1/terminal-layer/sessions/missing", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "x" }),
      }),
    );
    expect(res!.status).toBe(404);
  });

  test("returns 503 when terminal-layer is not configured", async () => {
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import(
      "@worktreeos/daemon/operation-registry"
    );
    const { DaemonSessionRegistry } = await import(
      "@worktreeos/daemon/daemon-sessions"
    );
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => "",
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext(),
    });
    const res = await handler(
      new Request("http://x/ui/v1/terminal-layer/sessions"),
    );
    expect(res!.status).toBe(503);
  });

  test("WS attach is rejected when server is not provided", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const { handler } = await buildHandler();
    const create = (await (
      await handler(
        new Request("http://x/ui/v1/terminal-layer/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ worktreePath: wt }),
        }),
      )
    )!.json()) as { session: { id: string } };
    const res = await handler(
      new Request(
        `http://x/ui/v1/terminal-layer/sessions/${create.session.id}/attach`,
        {},
      ),
    );
    expect(res!.status).toBe(501);
  });
});

describe("UI API: worktree git status line", () => {
  async function buildGitDetailHandler(
    wt: string,
    gitRunner: (root: string, args: string[]) => Promise<string>,
  ) {
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import(
      "@worktreeos/daemon/operation-registry"
    );
    const { DaemonSessionRegistry } = await import(
      "@worktreeos/daemon/daemon-sessions"
    );
    const { TunnelRegistry } = await import(
      "@worktreeos/runtime/tunnel-registry"
    );
    return createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async () => fakeContext(),
    });
  }

  function worktreeListMain(wt: string): string {
    return [`worktree ${wt}`, "HEAD aaa", "branch refs/heads/main", "", ""].join(
      "\n",
    );
  }

  test("tracking branch reports ahead/behind, dirty, and last commit", async () => {
    const wt = join(tmpHome, "wt-git");
    await mkdir(wt, { recursive: true });
    const handler = await buildGitDetailHandler(wt, async (_root, args) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return worktreeListMain(wt);
      }
      if (args[0] === "rev-list") {
        return "2\t1\n";
      }
      if (args[0] === "status") {
        return " M src/a.ts\n?? new.txt\n";
      }
      if (args[0] === "log") {
        return "ab12cd|Fix the thing|2026-05-30T10:00:00+00:00\n";
      }
      return "";
    });
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.worktree.aheadCount).toBe(2);
    expect(body.worktree.behindCount).toBe(1);
    expect(body.worktree.uncommittedCount).toBe(2);
    expect(body.worktree.lastCommitHash).toBe("ab12cd");
    expect(body.worktree.lastCommitSubject).toBe("Fix the thing");
    expect(body.worktree.lastCommitTime).toBe("2026-05-30T10:00:00+00:00");
  });

  test("no upstream omits ahead/behind but keeps dirty + last commit", async () => {
    const wt = join(tmpHome, "wt-noup");
    await mkdir(wt, { recursive: true });
    const handler = await buildGitDetailHandler(wt, async (_root, args) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return worktreeListMain(wt);
      }
      if (args[0] === "rev-list") {
        throw new Error("no upstream configured for branch 'main'");
      }
      if (args[0] === "status") {
        return " M src/a.ts\n";
      }
      if (args[0] === "log") {
        return "ab12cd|Initial|2026-05-30T10:00:00+00:00\n";
      }
      return "";
    });
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.worktree.aheadCount).toBeUndefined();
    expect(body.worktree.behindCount).toBeUndefined();
    expect(body.worktree.uncommittedCount).toBe(1);
    expect(body.worktree.lastCommitHash).toBe("ab12cd");
  });

  test("git failures omit status fields without breaking detail", async () => {
    const wt = join(tmpHome, "wt-fail");
    await mkdir(wt, { recursive: true });
    const handler = await buildGitDetailHandler(wt, async (_root, args) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return worktreeListMain(wt);
      }
      // rev-list, status, log all fail.
      throw new Error("git boom");
    });
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.worktree.branch).toBe("main");
    expect(body.worktree.aheadCount).toBeUndefined();
    expect(body.worktree.behindCount).toBeUndefined();
    expect(body.worktree.uncommittedCount).toBeUndefined();
    expect(body.worktree.lastCommitHash).toBeUndefined();
  });
});

describe("UI API: project settings (patch/delete)", () => {
  async function buildProjectSettingsHandler(names: string[]) {
    const filePath = resolve(tmpHome, "projects.json");
    const ids: string[] = [];
    const dirs: string[] = [];
    let n = 0;
    for (const name of names) {
      const dir = join(tmpHome, name);
      await mkdir(dir, { recursive: true });
      dirs.push(dir);
      const r = await registerProjectBySourcePath(dir, {
        filePath,
        newId: () => `pid-${++n}`,
      });
      ids.push(r.project.id);
    }
    const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
    const { OperationRegistry } = await import(
      "@worktreeos/daemon/operation-registry"
    );
    const { DaemonSessionRegistry } = await import(
      "@worktreeos/daemon/daemon-sessions"
    );
    const { TunnelRegistry } = await import(
      "@worktreeos/runtime/tunnel-registry"
    );
    const { DaemonEventBus } = await import("@worktreeos/daemon/event-bus");
    const events = new DaemonEventBus();
    const captured: Array<{ type: string }> = [];
    events.subscribe((env) => captured.push(env.event as { type: string }));
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      events,
      projectsFilePath: filePath,
      gitRunner: async () => "",
      resolveSession: async () => fakeContext(),
    });
    return { handler, ids, dirs, captured, filePath };
  }

  const patch = (id: string, body: unknown) =>
    new Request(`http://x/ui/v1/projects/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("PATCH renames a project and emits project.updated", async () => {
    const { handler, ids, captured } = await buildProjectSettingsHandler(["a"]);
    const res = await handler(patch(ids[0]!, { displayName: "Alpha" }));
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      project: { displayName: string };
      projects: unknown[];
    };
    expect(body.project.displayName).toBe("Alpha");
    expect(captured.some((e) => e.type === "project.updated")).toBe(true);
  });

  test("PATCH recolors a project", async () => {
    const { handler, ids } = await buildProjectSettingsHandler(["a"]);
    const res = await handler(patch(ids[0]!, { colorSlot: 7 }));
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { project: { colorSlot: number } };
    expect(body.project.colorSlot).toBe(7);
  });

  test("PATCH reorders projects to a dense range", async () => {
    const { handler, ids } = await buildProjectSettingsHandler(["a", "b", "c"]);
    const res = await handler(patch(ids[2]!, { order: 0 }));
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      projects: Array<{ id: string; order: number }>;
    };
    const order = Object.fromEntries(body.projects.map((p) => [p.id, p.order]));
    expect(order[ids[2]!]).toBe(0);
    expect(order[ids[0]!]).toBe(1);
    expect(order[ids[1]!]).toBe(2);
  });

  test("PATCH rejects an out-of-range color slot", async () => {
    const { handler, ids } = await buildProjectSettingsHandler(["a"]);
    const res = await handler(patch(ids[0]!, { colorSlot: 999 }));
    expect(res!.status).toBe(400);
    expect(((await res!.json()) as { error: string }).error).toBe("validation");
  });

  test("PATCH on an unknown project is 404", async () => {
    const { handler } = await buildProjectSettingsHandler(["a"]);
    const res = await handler(patch("nope", { displayName: "x" }));
    expect(res!.status).toBe(404);
  });

  test("DELETE forgets the project but leaves its directory on disk", async () => {
    const { handler, ids, dirs, captured, filePath } =
      await buildProjectSettingsHandler(["a", "b"]);
    const res = await handler(
      new Request(`http://x/ui/v1/projects/${ids[0]}`, { method: "DELETE" }),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { projects: Array<{ id: string }> };
    expect(body.projects.some((p) => p.id === ids[0])).toBe(false);
    expect(captured.some((e) => e.type === "project.removed")).toBe(true);
    const remaining = await loadProjects({ filePath });
    expect(remaining.some((p) => p.id === ids[0])).toBe(false);
    // Registry-only: the source directory must still exist.
    expect(existsSync(dirs[0]!)).toBe(true);
  });

  test("DELETE on an unknown project is 404", async () => {
    const { handler } = await buildProjectSettingsHandler(["a"]);
    const res = await handler(
      new Request("http://x/ui/v1/projects/nope", { method: "DELETE" }),
    );
    expect(res!.status).toBe(404);
  });
});
