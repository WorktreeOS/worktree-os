import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateConfig, type WosConfig } from "@worktreeos/core/config";
import type { SessionContext } from "@worktreeos/core/session-context";
import type { WorktreeEntry } from "@worktreeos/core/git";
import type { WosState } from "@worktreeos/core/state";
import {
  runShellUpProgram,
  isProcessAlive,
} from "@worktreeos/runtime/shell";
import {
  runStatusOperation,
  runDownOperation,
} from "@worktreeos/runtime/operations";
import { readState, stateFilePath } from "@worktreeos/core/state";

// A tiny HTTP server that binds the wos-assigned host port. Proves the
// `WOS_SERVICE_PORT` contract end-to-end: the process listens on the injected
// port and the app-port healthcheck reaches it on localhost.
const SERVER_JS = `const port = Number(process.env.WOS_SERVICE_PORT);
if (!Number.isInteger(port) || port <= 0) {
  console.error("missing WOS_SERVICE_PORT");
  process.exit(1);
}
Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("ok") });
setInterval(() => {}, 1 << 30);
`;

const FAST_HEALTH = {
  timeoutMs: 10000,
  startPeriodMs: 0,
  intervalMs: 150,
  retries: 60,
  requestTimeoutMs: 2000,
};

let home: string;
let worktreeRoot: string;
let prevHome: string | undefined;
let startedPids: number[] = [];

beforeEach(async () => {
  prevHome = process.env.WOS_HOME;
  home = await mkdtemp(join(tmpdir(), "wos-shell-e2e-home-"));
  worktreeRoot = await mkdtemp(join(tmpdir(), "wos-shell-e2e-wt-"));
  process.env.WOS_HOME = home;
  startedPids = [];
});

afterEach(async () => {
  // Defensively kill anything still alive so the suite never leaks servers.
  // Include pids recorded in persisted state (a failed `up` leaves the process
  // running, mirroring Docker behavior).
  const pids = new Set(startedPids);
  try {
    const persisted = await readState(stateFilePath(worktreeRoot));
    for (const svc of Object.values(persisted?.shell?.services ?? {})) {
      pids.add(svc.pid);
    }
  } catch {
    /* no state */
  }
  for (const pid of pids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
  if (prevHome === undefined) delete process.env.WOS_HOME;
  else process.env.WOS_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
  await rm(worktreeRoot, { recursive: true, force: true });
});

function source(): WorktreeEntry {
  return { path: worktreeRoot, bare: false, detached: false };
}

function ctxFor(config: WosConfig, state: WosState): SessionContext {
  return {
    worktreeRoot,
    source: source(),
    config,
    projectName: "e2e",
    sessionName: "e2e-session",
    sessionRoot: join(home, "sessions", "e2e-session"),
    state,
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

describe("shell-mode end to end", () => {
  test("starts a host process that binds WOS_SERVICE_PORT, passes healthcheck, then stops", async () => {
    await writeFile(join(worktreeRoot, "server.js"), SERVER_JS);
    const config = validateConfig({
      mode: "shell",
      app: {
        services: {
          app: { script: ["bun server.js"], ports: [3000] },
        },
      },
    });

    const state = await runShellUpProgram({
      worktreeRoot,
      config,
      source: source(),
      projectName: "e2e",
      stdout: () => {},
      healthcheckDefaults: FAST_HEALTH,
    });
    const pid = state.shell!.services.app!.pid;
    startedPids.push(pid);

    expect(state.backend).toBe("shell");
    const hostPort = state.portAssignments!.app!["3000"]!;
    // Default host-port range is 20000..29999.
    expect(hostPort).toBeGreaterThanOrEqual(20000);
    expect(hostPort).toBeLessThanOrEqual(29999);
    expect(isProcessAlive(pid)).toBe(true);

    // The server is reachable on the assigned host port.
    const probe = await fetch(`http://127.0.0.1:${hostPort}/`);
    expect(probe.status).toBe(200);
    expect(await probe.text()).toBe("ok");

    // Status reports the service running with the assigned host port.
    const status = await runStatusOperation(ctxFor(config, state));
    expect(status.kind).toBe("ok");
    if (status.kind === "ok") {
      expect(status.services.map((s) => s.service)).toEqual(["app"]);
      expect(status.services[0]!.state).toBe("running");
      expect(status.services[0]!.ports[0]!.hostPort).toBe(hostPort);
      const hc = status.appPortHealthchecks.find((h) => h.service === "app");
      expect(hc?.state).toBe("healthy");
    }

    // Down terminates the process group.
    const down = await runDownOperation(ctxFor(config, state));
    expect(down).toEqual({ kind: "stopped" });
    const stopped = await waitUntil(() => !isProcessAlive(pid));
    expect(stopped).toBe(true);
  }, 30000);

  test("fails the up operation when the service ignores its assigned port", async () => {
    // This server binds a fixed wrong port, so the healthcheck on the assigned
    // host port never succeeds and `up` fails.
    await writeFile(
      join(worktreeRoot, "bad.js"),
      `Bun.serve({ port: 0, fetch: () => new Response("x") }); setInterval(()=>{}, 1<<30);`,
    );
    const config = validateConfig({
      mode: "shell",
      app: {
        services: {
          app: { script: ["bun bad.js"], ports: [3000] },
        },
      },
    });
    await expect(
      runShellUpProgram({
        worktreeRoot,
        config,
        source: source(),
        projectName: "e2e",
        stdout: () => {},
        healthcheckDefaults: {
          timeoutMs: 800,
          startPeriodMs: 0,
          intervalMs: 100,
          retries: 6,
          requestTimeoutMs: 300,
        },
      }),
    ).rejects.toThrow(/healthcheck failed/);
    // The spawned process is recorded in state; afterEach terminates it.
  }, 30000);
});
