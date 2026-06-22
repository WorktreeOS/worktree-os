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
import type { FollowerStarter } from "@worktreeos/daemon/daemon-sessions";
import type { ServiceFollower } from "@worktreeos/runtime/service-logs";
import type { UnifiedEventEnvelope } from "@worktreeos/core/unified-events";
import { splitEnvelopeStream } from "@worktreeos/daemon/daemon-protocol";

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
    projectName: "p",
    sessionName: "fake-session",
    sessionRoot: "/tmp/fake-session",
    state: null,
    ...overrides,
  };
}

let tmpHome: string;
let daemon: DaemonHandle;

beforeEach(async () => {
  tmpHome = await createDaemonTestHome("wos-uni-");
});

afterEach(async () => {
  await teardownDaemonTestHome(tmpHome, daemon);
  daemon = undefined as unknown as DaemonHandle;
});

function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${daemon.webUrl}${path}`, init);
}

describe("service log streams do not publish unified events", () => {
  test("on-demand service log chunks stay off the unified event bus", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { sessionRootForWorktree, sessionNameForWorktree } = await import(
      "@worktreeos/core/paths"
    );
    const worktreeRoot = resolve(tmpHome, "wt");
    await mkdir(worktreeRoot, { recursive: true });
    await Bun.write(
      resolve(worktreeRoot, ".wos", "deploy.yaml"),
      "app:\n  services: {}\n",
    );
    const sessionName = sessionNameForWorktree(worktreeRoot);
    const sessionRoot = sessionRootForWorktree(worktreeRoot);
    await mkdir(sessionRoot, { recursive: true });
    const composeFile = resolve(sessionRoot, "compose.yaml");
    await writeFile(composeFile, "services: {}\n");
    await writeFile(
      resolve(sessionRoot, "state.json"),
      JSON.stringify({
        initialized: true,
        projectName: "p",
        composeFile,
        worktreeRoot,
        sourcePath: worktreeRoot,
      }),
    );

    const handles: Array<{
      sink: (svc: string, st: "stdout" | "stderr", chunk: string) => void;
    }> = [];
    const starter: FollowerStarter = ({ services, sink }) =>
      services.map((s) => {
        handles.push({ sink });
        return {
          service: s,
          channel: `service:${s}` as const,
          stop: () => {},
          done: Promise.resolve(),
        } satisfies ServiceFollower;
      });

    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => fakeContext(),
        followerStarter: starter,
        dockerRunner: async (args) => {
          if (args.includes("ps")) {
            return {
              stdout: JSON.stringify([{ Service: "api", State: "running" }]),
              stderr: "",
              exitCode: 0,
            };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      }),
    );

    const collected: UnifiedEventEnvelope[] = [];
    daemon.events.subscribe((env) => collected.push(env));

    // Open a request-scoped service log stream — this triggers an async
    // follower spawn but no log.appended events should reach the bus.
    const sub = daemon.sessions.subscribe(sessionName, () => {}, {
      channel: "service:api",
    });
    // Wait until the follower has spawned via the resolver chain.
    const deadline = Date.now() + 1500;
    while (handles.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    handles[0]!.sink("api", "stdout", "hello\n");
    handles[0]!.sink("api", "stderr", "boom\n");
    sub.unsubscribe();
    expect(collected.filter((e) => e.type === "log.appended")).toEqual([]);
  });
});

describe("operation conflict publishes unified event", () => {
  test("emits operation.conflict and preserves NDJSON 409 response", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => fakeContext(),
      }),
    );
    const captured: UnifiedEventEnvelope[] = [];
    daemon.events.subscribe((env) => captured.push(env));
    // Block the session with an existing running op.
    const first = daemon.registry.begin("fake-session", "up");
    expect(first.ok).toBe(true);
    const res = await fetchUi("/ui/v1/worktrees/up", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/some/dir" }),
    });
    expect(res.status).toBe(409);
    const types = captured.map((e) => e.type);
    expect(types).toContain("operation.conflict");
  });
});

describe("operation NDJSON stream still works while bus is active", () => {
  test("subscribers to /ui/v1/operations/:id/events get original envelopes", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => fakeContext(),
      }),
    );
    // Manually start an operation and emit one event.
    const begin = daemon.registry.begin("fake-session", "up");
    expect(begin.ok).toBe(true);
    if (!begin.ok) return;
    const observer = daemon.registry.observerFor(begin.record);
    observer.emit({ type: "step", id: "compose-up", state: "running" });
    daemon.registry.finish(begin.record, "succeeded");

    const res = await fetchUi(
      `/ui/v1/operations/${begin.record.operationId}/events`,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    const { envelopes } = splitEnvelopeStream(text);
    expect(envelopes.length).toBeGreaterThan(0);
    // First envelope is a deployment step.
    expect((envelopes[0] as { event: { type: string } }).event.type).toBe(
      "step",
    );
  });
});

describe("tunnel registry publishes unified events", () => {
  test("publishes reset/dropped via the bus", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => fakeContext(),
      }),
    );
    const captured: UnifiedEventEnvelope[] = [];
    daemon.events.subscribe((env) => captured.push(env));
    // Seed a tunnel session record so reset emits an event.
    daemon.tunnels.snapshot("sess-x"); // no-op; ensures session map shape stable
    // Open is fully driven via adapter; here we exercise the simpler paths.
    await daemon.tunnels.reset("sess-1"); // no records → no publication
    expect(captured.find((e) => e.type === "tunnel.reset")).toBeUndefined();
    // Force a tunnel record through the registry directly to verify publish.
    (daemon.tunnels as any).sessions.set("sess-1", {
      active: new Map(),
      failed: new Map(),
    });
    await daemon.tunnels.reset("sess-1");
    expect(captured.find((e) => e.type === "tunnel.reset")).toBeDefined();
    await daemon.tunnels.drop("sess-1");
    expect(captured.find((e) => e.type === "tunnel.dropped")).toBeDefined();
  });
});
