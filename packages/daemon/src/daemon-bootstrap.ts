import { rm } from "node:fs/promises";
import { closeSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { daemonMetadataPath, type DaemonMetadata } from "./daemon-paths";
import { DAEMON_PROTOCOL_VERSION } from "./daemon-protocol";
import type { UiHealthResponse } from "./ui-protocol";

const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const HEALTH_POLL_INTERVAL_MS = 50;
const SHUTDOWN_WAIT_MS = 5_000;

export class DaemonError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message);
  }
}

export class DaemonStartupError extends DaemonError {}

/**
 * A daemon answered the HTTP health check but speaks an incompatible
 * protocol version. `wos restart` recovers by replacing the daemon.
 */
export class DaemonProtocolError extends DaemonError {}

/**
 * Detect whether the current process runs inside a Bun standalone executable.
 * The compiled binary serves modules from the synthetic `/$bunfs/` virtual
 * filesystem; this prefix on `import.meta.url` is the canonical marker.
 */
export function isCompiledStandalone(): boolean {
  return (
    typeof import.meta.url === "string" && import.meta.url.includes("/$bunfs/")
  );
}

export interface SpawnCommandInputs {
  /** Override compiled-standalone detection (tests). */
  compiled?: boolean;
  /** Override `process.execPath` (tests). */
  execPath?: string;
  /** Override `process.argv[1]` (tests). */
  script?: string;
}

/**
 * Build the argv used to spawn `start --foreground` from the currently
 * running executable. In a compiled binary this is just `[binary, "start",
 * "--foreground"]` — we never inject the embedded entrypoint path because the
 * standalone executable already knows it and rejects extra script args. In a
 * source checkout we pass the original CLI script alongside Bun so `bun
 * apps/cli/index.ts start --foreground` runs the same code path the user
 * invoked.
 */
export function resolveDaemonSpawnCommand(
  inputs: SpawnCommandInputs = {},
): string[] {
  const compiled = inputs.compiled ?? isCompiledStandalone();
  const execPath = inputs.execPath ?? process.execPath;
  const script = inputs.script ?? process.argv[1];
  if (compiled) {
    return [execPath, "start", "--foreground"];
  }
  if (typeof script === "string" && script.length > 0) {
    return [execPath, script, "start", "--foreground"];
  }
  return [execPath, "start", "--foreground"];
}

export interface DaemonBootstrapOptions {
  /** Override metadata path. Defaults to `<wos-home>/daemon.json`. */
  metadataPath?: string;
  /** Total milliseconds to wait for the daemon to become healthy on auto-start. */
  startupTimeoutMs?: number;
  /** Health check timeout per attempt. */
  healthTimeoutMs?: number;
  /** Override fetch (tests). */
  fetch?: typeof fetch;
  /** Override spawn for tests (used to launch the daemon foreground process). */
  spawn?: (cmd: string[]) => { exited: Promise<number>; pid: number };
}

/** A healthy, protocol-compatible daemon reachable over HTTP. */
export interface RunningDaemon {
  baseUrl: string;
  health: UiHealthResponse;
}

export type DaemonDiscovery =
  | { kind: "healthy"; baseUrl: string; health: UiHealthResponse }
  | {
      kind: "incompatible";
      baseUrl: string;
      health: UiHealthResponse;
      pid?: number;
    }
  | { kind: "absent" };

/**
 * HTTP daemon bootstrap: discovery via `<wos-home>/daemon.json` + the
 * `GET /ui/v1/health` endpoint, stale-metadata cleanup, and `wos start
 * --foreground` auto-start. This replaces the retired Unix-socket
 * `createDaemonClient`; daemon operations go through `UiClient({ baseUrl })`.
 */
export function createDaemonBootstrap(opts: DaemonBootstrapOptions = {}) {
  const metadataPath = opts.metadataPath ?? daemonMetadataPath();
  const startupTimeout = opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const healthTimeout = opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const doFetch = opts.fetch ?? fetch;
  // Capture the auto-started daemon's stdout+stderr next to its metadata so a
  // background start that never becomes healthy leaves an inspectable trace.
  const daemonLogPath = join(dirname(metadataPath), "daemon.log");
  const doSpawn =
    opts.spawn ??
    ((cmd: string[]) => {
      // Redirect the foreground daemon's output to `<wos-home>/daemon.log`.
      // Without this its crash output is discarded and `wos start` can only
      // report a bare startup timeout — invisible in CI and to users. The log
      // is truncated per spawn so it always reflects the latest start attempt;
      // if it cannot be opened we fall back to discarding output as before.
      let logFd: number | undefined;
      try {
        logFd = openSync(daemonLogPath, "w");
      } catch {
        logFd = undefined;
      }
      const out: number | "ignore" = logFd ?? "ignore";
      const finish = (proc: { exited: Promise<number>; pid: number }) => {
        // The child inherits its own dup of the handle; release the parent's.
        if (logFd !== undefined) {
          try {
            closeSync(logFd);
          } catch {
            /* best-effort */
          }
        }
        return { exited: proc.exited, pid: proc.pid };
      };
      if (process.platform === "win32") {
        // The launcher calls `process.exit` once the daemon reports healthy. On
        // Windows a referenced child is torn down on parent exit and `unref`
        // alone is insufficient — the daemon must be `detached` to survive
        // (POSIX children already survive as orphans, so that path is unchanged).
        const proc = Bun.spawn(cmd, {
          stdout: out,
          stderr: out,
          stdin: "ignore",
          detached: true,
          // Keep the background daemon from popping a console window.
          windowsHide: true,
        });
        proc.unref();
        return finish(proc);
      }
      const proc = Bun.spawn(cmd, { stdout: out, stderr: out });
      return finish(proc);
    });

  /**
   * Read the tail of the captured daemon log so startup failures can surface
   * the foreground daemon's actual error instead of a bare timeout. Returns an
   * empty string when no log is available.
   */
  function readDaemonLogTail(): string {
    try {
      const data = readFileSync(daemonLogPath, "utf8").trimEnd();
      if (!data) return "";
      const tail = data.length > 4000 ? `…${data.slice(-4000)}` : data;
      return `\n--- daemon log (${daemonLogPath}) ---\n${tail}\n--- end daemon log ---`;
    } catch {
      return "";
    }
  }

  async function readMetadata(): Promise<DaemonMetadata | null> {
    try {
      const file = Bun.file(metadataPath);
      if (!(await file.exists())) return null;
      const parsed = (await file.json()) as DaemonMetadata;
      if (!parsed || typeof parsed !== "object") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async function healthAt(baseUrl: string): Promise<UiHealthResponse | null> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), healthTimeout);
    try {
      const res = await doFetch(
        `${baseUrl.replace(/\/+$/, "")}/ui/v1/health`,
        { signal: ac.signal },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as UiHealthResponse;
      if (!body || body.ok !== true) return null;
      return body;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function discover(): Promise<DaemonDiscovery> {
    const metadata = await readMetadata();
    if (!metadata || typeof metadata.webUrl !== "string" || !metadata.webUrl) {
      return { kind: "absent" };
    }
    const health = await healthAt(metadata.webUrl);
    if (!health) return { kind: "absent" };
    if (health.protocol !== DAEMON_PROTOCOL_VERSION) {
      return {
        kind: "incompatible",
        baseUrl: metadata.webUrl,
        health,
        pid: health.pid ?? metadata.pid,
      };
    }
    return { kind: "healthy", baseUrl: metadata.webUrl, health };
  }

  async function cleanupStaleMetadata(): Promise<void> {
    await rm(metadataPath, { force: true });
  }

  async function spawnAndWaitHealthy(): Promise<RunningDaemon> {
    const child = doSpawn(resolveDaemonSpawnCommand());
    // Watch the foreground daemon for an early exit so a crash fails fast with
    // its captured output instead of waiting out the full startup timeout.
    let childExitCode: number | null = null;
    void child.exited
      .then((code) => {
        childExitCode = code;
      })
      .catch(() => {
        childExitCode = -1;
      });
    const deadline = Date.now() + startupTimeout;
    while (Date.now() < deadline) {
      const found = await discover();
      if (found.kind === "healthy") {
        return { baseUrl: found.baseUrl, health: found.health };
      }
      if (childExitCode !== null) {
        // The launcher process exited before we observed health. Re-check once:
        // a successor daemon may already be answering (and a healthy daemon
        // never exits during startup, so a real crash stays absent here). Only
        // a still-absent daemon is a genuine startup failure.
        const recheck = await discover();
        if (recheck.kind === "healthy") {
          return { baseUrl: recheck.baseUrl, health: recheck.health };
        }
        throw new DaemonStartupError(
          `daemon process exited with code ${childExitCode} before becoming healthy.${readDaemonLogTail()}`,
        );
      }
      await sleep(HEALTH_POLL_INTERVAL_MS);
    }
    throw new DaemonStartupError(
      `daemon did not become healthy within ${startupTimeout}ms (metadata: ${metadataPath})${readDaemonLogTail()}`,
    );
  }

  async function requestStop(found: DaemonDiscovery): Promise<void> {
    if (found.kind === "healthy") {
      let scheduled = false;
      try {
        const res = await doFetch(
          `${found.baseUrl.replace(/\/+$/, "")}/ui/v1/daemon/stop`,
          { method: "POST" },
        );
        scheduled = res.ok;
      } catch {
        // Daemon may have already exited between health check and stop.
      }
      if (!scheduled) {
        // Stop endpoint unavailable (e.g. embedded daemon without a stop
        // scheduler) — fall back to terminating the reported pid.
        const pid = found.health.pid;
        if (typeof pid === "number" && pid > 0) {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // Process already gone or not killable — proceed regardless.
          }
        }
      }
    } else if (found.kind === "incompatible") {
      // An incompatible (socket-era) daemon has no HTTP stop endpoint we can
      // rely on; terminate by pid as the migration path.
      if (typeof found.pid === "number" && found.pid > 0) {
        try {
          process.kill(found.pid, "SIGTERM");
        } catch {
          // Process already gone or not killable — proceed regardless.
        }
      }
    }
    const deadline = Date.now() + SHUTDOWN_WAIT_MS;
    while (Date.now() < deadline) {
      if ((await discover()).kind === "absent") break;
      await sleep(HEALTH_POLL_INTERVAL_MS);
    }
  }

  return {
    metadataPath,
    readMetadata,
    healthAt,
    discover,

    /**
     * Reuse a healthy daemon or auto-start one. A responding but
     * protocol-incompatible daemon throws `DaemonProtocolError` so commands
     * fail with an actionable mismatch error instead of silently replacing a
     * daemon another client may be using; `wos restart` recovers.
     */
    async ensureRunning(): Promise<RunningDaemon> {
      const found = await discover();
      if (found.kind === "healthy") {
        return { baseUrl: found.baseUrl, health: found.health };
      }
      if (found.kind === "incompatible") {
        throw new DaemonProtocolError(
          `daemon at ${found.baseUrl} speaks protocol ${found.health.protocol ?? "unknown"} ` +
            `but this CLI requires ${DAEMON_PROTOCOL_VERSION}. Run 'wos restart' to replace it.`,
        );
      }
      await cleanupStaleMetadata();
      return spawnAndWaitHealthy();
    },

    async start(): Promise<{
      kind: "started" | "already-running";
      daemon: RunningDaemon;
    }> {
      const found = await discover();
      if (found.kind === "healthy") {
        return {
          kind: "already-running",
          daemon: { baseUrl: found.baseUrl, health: found.health },
        };
      }
      if (found.kind === "incompatible") {
        await requestStop(found);
      }
      await cleanupStaleMetadata();
      return { kind: "started", daemon: await spawnAndWaitHealthy() };
    },

    async stop(): Promise<{ stopped: boolean }> {
      const found = await discover();
      if (found.kind === "absent") {
        await cleanupStaleMetadata();
        return { stopped: false };
      }
      await requestStop(found);
      await cleanupStaleMetadata();
      return { stopped: true };
    },

    async restart(): Promise<RunningDaemon> {
      const found = await discover();
      if (found.kind !== "absent") {
        await requestStop(found);
      }
      await cleanupStaleMetadata();
      return spawnAndWaitHealthy();
    },
  };
}

export type DaemonBootstrap = ReturnType<typeof createDaemonBootstrap>;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
