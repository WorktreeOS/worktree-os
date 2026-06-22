import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { resolve } from "node:path";
import { writeFile, access } from "node:fs/promises";
import { startDaemon, type DaemonHandle } from "@worktreeos/daemon/daemon-server";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
  withDaemonDefaults,
} from "./helpers/daemon-test-harness.ts";
import {
  createDaemonBootstrap,
  DaemonProtocolError,
  DaemonStartupError,
  resolveDaemonSpawnCommand,
} from "@worktreeos/daemon/daemon-bootstrap";
import { DAEMON_PROTOCOL_VERSION } from "@worktreeos/daemon/daemon-protocol";
import type { SessionContext } from "@worktreeos/core/session-context";

function fakeContext(overrides: Partial<SessionContext> = {}): SessionContext {
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
    ...overrides,
  };
}

let home: string;
let metadataPath: string;
let daemon: DaemonHandle | null;

beforeEach(async () => {
  home = await createDaemonTestHome("wos-bootstrap-");
  metadataPath = resolve(home, "daemon.json");
  daemon = null;
});

afterEach(async () => {
  await teardownDaemonTestHome(home, daemon);
});

async function startTestDaemon(metadata = metadataPath): Promise<DaemonHandle> {
  return startDaemon(
    withDaemonDefaults(home, {
      metadataPath: metadata,
      resolveSession: async () => fakeContext(),
    }),
  );
}

describe("daemon bootstrap: discovery", () => {
  test("discovers a healthy daemon through metadata + HTTP health", async () => {
    daemon = await startTestDaemon();
    const bootstrap = createDaemonBootstrap({ metadataPath });
    const found = await bootstrap.discover();
    expect(found.kind).toBe("healthy");
    if (found.kind === "healthy") {
      expect(found.baseUrl).toBe(daemon.webUrl);
      expect(found.health.protocol).toBe(DAEMON_PROTOCOL_VERSION);
    }
  });

  test("reports absent when no metadata exists", async () => {
    const bootstrap = createDaemonBootstrap({
      metadataPath: resolve(home, "missing.json"),
      healthTimeoutMs: 200,
    });
    expect((await bootstrap.discover()).kind).toBe("absent");
  });

  test("treats stale metadata pointing at a dead URL as absent", async () => {
    await writeFile(
      metadataPath,
      JSON.stringify({
        pid: 0,
        webUrl: "http://127.0.0.1:9",
        protocol: DAEMON_PROTOCOL_VERSION,
      }),
    );
    const bootstrap = createDaemonBootstrap({
      metadataPath,
      healthTimeoutMs: 300,
    });
    expect((await bootstrap.discover()).kind).toBe("absent");
  });

  test("tolerates legacy socketPath fields in metadata", async () => {
    daemon = await startTestDaemon();
    const current = await Bun.file(metadataPath).json();
    await writeFile(
      metadataPath,
      JSON.stringify({ ...current, socketPath: "/tmp/legacy.sock" }),
    );
    const bootstrap = createDaemonBootstrap({ metadataPath });
    expect((await bootstrap.discover()).kind).toBe("healthy");
  });

  test("flags a responding daemon with a different protocol as incompatible", async () => {
    await writeFile(
      metadataPath,
      JSON.stringify({ pid: 0, webUrl: "http://127.0.0.1:65000" }),
    );
    const bootstrap = createDaemonBootstrap({
      metadataPath,
      fetch: (async () =>
        new Response(
          JSON.stringify({ ok: true, version: "1", protocol: "2", pid: 0 }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    });
    const found = await bootstrap.discover();
    expect(found.kind).toBe("incompatible");
  });
});

describe("daemon bootstrap: ensureRunning", () => {
  test("reuses an existing healthy daemon without spawning", async () => {
    daemon = await startTestDaemon();
    let spawned = 0;
    const bootstrap = createDaemonBootstrap({
      metadataPath,
      spawn: () => {
        spawned += 1;
        return { exited: Promise.resolve(0), pid: 1 };
      },
    });
    const running = await bootstrap.ensureRunning();
    expect(running.baseUrl).toBe(daemon.webUrl);
    expect(spawned).toBe(0);
  });

  test("fails fast with DaemonStartupError when the daemon never appears", async () => {
    const bootstrap = createDaemonBootstrap({
      metadataPath: resolve(home, "absent.json"),
      startupTimeoutMs: 300,
      healthTimeoutMs: 100,
      spawn: () => ({ exited: Promise.resolve(0), pid: 1 }),
    });
    let caught: unknown;
    try {
      await bootstrap.ensureRunning();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DaemonStartupError);
  });

  test("throws an actionable protocol mismatch error for incompatible daemons", async () => {
    await writeFile(
      metadataPath,
      JSON.stringify({ pid: 0, webUrl: "http://127.0.0.1:65000" }),
    );
    const bootstrap = createDaemonBootstrap({
      metadataPath,
      fetch: (async () =>
        new Response(
          JSON.stringify({ ok: true, version: "1", protocol: "2", pid: 0 }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    });
    let caught: unknown;
    try {
      await bootstrap.ensureRunning();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DaemonProtocolError);
    expect((caught as Error).message).toContain("wos restart");
  });

  test("cleans stale metadata and spawns a fresh daemon", async () => {
    await writeFile(
      metadataPath,
      JSON.stringify({ pid: 0, webUrl: "http://127.0.0.1:9" }),
    );
    let spawnedDaemon: DaemonHandle | null = null;
    const bootstrap = createDaemonBootstrap({
      metadataPath,
      startupTimeoutMs: 5000,
      healthTimeoutMs: 200,
      spawn: () => {
        const p = startTestDaemon().then((d) => {
          spawnedDaemon = d;
          return 0;
        });
        return { exited: p, pid: process.pid };
      },
    });
    const running = await bootstrap.ensureRunning();
    expect(running.health.protocol).toBe(DAEMON_PROTOCOL_VERSION);
    if (spawnedDaemon) await (spawnedDaemon as DaemonHandle).stop();
  });
});

describe("daemon bootstrap: start/stop/restart", () => {
  test("start() returns already-running for a healthy daemon", async () => {
    daemon = await startTestDaemon();
    let spawned = 0;
    const bootstrap = createDaemonBootstrap({
      metadataPath,
      spawn: () => {
        spawned += 1;
        return { exited: Promise.resolve(0), pid: 1 };
      },
    });
    const result = await bootstrap.start();
    expect(result.kind).toBe("already-running");
    expect(spawned).toBe(0);
  });

  test("start() spawns when no healthy daemon responds", async () => {
    let spawnedDaemon: DaemonHandle | null = null;
    const bootstrap = createDaemonBootstrap({
      metadataPath,
      startupTimeoutMs: 5000,
      healthTimeoutMs: 200,
      spawn: () => {
        const p = startTestDaemon().then((d) => {
          spawnedDaemon = d;
          return 0;
        });
        return { exited: p, pid: process.pid };
      },
    });
    const result = await bootstrap.start();
    expect(result.kind).toBe("started");
    if (spawnedDaemon) await (spawnedDaemon as DaemonHandle).stop();
  });

  test("stop() on an absent daemon cleans stale metadata and reports stopped=false", async () => {
    await writeFile(
      metadataPath,
      JSON.stringify({ pid: 0, webUrl: "http://127.0.0.1:9" }),
    );
    const bootstrap = createDaemonBootstrap({
      metadataPath,
      healthTimeoutMs: 200,
    });
    const result = await bootstrap.stop();
    expect(result.stopped).toBe(false);
    let exists = true;
    try {
      await access(metadataPath);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  test("stop() requests shutdown over HTTP and waits until the daemon stops responding", async () => {
    let stopScheduled = false;
    daemon = await startDaemon(
      withDaemonDefaults(home, {
        metadataPath,
        resolveSession: async () => fakeContext(),
        stopScheduler: () => {
          stopScheduled = true;
          // Simulate the foreground daemon shutting down after the response.
          setTimeout(() => {
            const d = daemon;
            daemon = null;
            void d?.stop();
          }, 20);
        },
      }),
    );
    const bootstrap = createDaemonBootstrap({
      metadataPath,
      healthTimeoutMs: 500,
    });
    const result = await bootstrap.stop();
    expect(result.stopped).toBe(true);
    expect(stopScheduled).toBe(true);
    expect((await bootstrap.discover()).kind).toBe("absent");
  });

  test("restart() from stale metadata cleans up and spawns fresh", async () => {
    await writeFile(
      metadataPath,
      JSON.stringify({ pid: 0, webUrl: "http://127.0.0.1:9" }),
    );
    let spawnedCount = 0;
    const bootstrap = createDaemonBootstrap({
      metadataPath,
      startupTimeoutMs: 300,
      healthTimeoutMs: 100,
      spawn: () => {
        spawnedCount += 1;
        return { exited: Promise.resolve(0), pid: 1 };
      },
    });
    let caught: unknown;
    try {
      await bootstrap.restart();
    } catch (e) {
      caught = e;
    }
    expect(spawnedCount).toBe(1);
    expect(caught).toBeInstanceOf(DaemonStartupError);
  });
});

describe("resolveDaemonSpawnCommand", () => {
  test("source mode spawns bun against the running CLI entrypoint with start --foreground", () => {
    const cmd = resolveDaemonSpawnCommand({
      compiled: false,
      execPath: "/opt/homebrew/bin/bun",
      script: "/repo/apps/cli/index.ts",
    });
    expect(cmd).toEqual([
      "/opt/homebrew/bin/bun",
      "/repo/apps/cli/index.ts",
      "start",
      "--foreground",
    ]);
  });

  test("compiled mode spawns the running executable with start --foreground", () => {
    const cmd = resolveDaemonSpawnCommand({
      compiled: true,
      execPath: "/usr/local/bin/wos",
      script: "/$bunfs/root/apps/cli/index.ts",
    });
    expect(cmd).toEqual(["/usr/local/bin/wos", "start", "--foreground"]);
    expect(cmd).not.toContain("bun");
    expect(cmd).not.toContain("/$bunfs/root/apps/cli/index.ts");
  });

  test("compiled-mode spawn never invokes `bun run` or the source entrypoint", () => {
    const cmd = resolveDaemonSpawnCommand({
      compiled: true,
      execPath: "/srv/dist/wos",
      script: "/$bunfs/root/apps/cli/index.ts",
    });
    expect(cmd.includes("run")).toBe(false);
    expect(cmd.includes("daemon")).toBe(false);
    for (const arg of cmd) {
      expect(arg.includes("apps/cli")).toBe(false);
      expect(arg.includes("apps\\cli")).toBe(false);
    }
  });
});
