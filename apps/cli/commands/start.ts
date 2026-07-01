import { mkdirSync } from "node:fs";
import { startDaemon, defaultRestartScheduler } from "@worktreeos/daemon/daemon-server";
import { daemonMetadataPath } from "@worktreeos/daemon/daemon-paths";
import { wosHome } from "@worktreeos/core/paths";
import {
  createDaemonBootstrap,
  DaemonStartupError,
  type DaemonBootstrapOptions,
} from "@worktreeos/daemon/daemon-bootstrap";
import {
  loadGlobalConfig,
  type GlobalConfig,
  type TerminalBackendId,
} from "@worktreeos/core/global-config";
import { OUTSIDE_TMUX_WARNING } from "@worktreeos/daemon/setup-environment";
import { defaultLauncher, type WebLauncher } from "./web";

export interface StartCommandOptions {
  metadataPath?: string;
  loadConfig?: () => Promise<GlobalConfig>;
  startDaemonFn?: typeof startDaemon;
  /**
   * Invoked when a client schedules daemon shutdown via
   * `POST /ui/v1/daemon/stop`. Called after a short delay so the HTTP response
   * is flushed first. Defaults to stopping the daemon and exiting the process.
   */
  onStopRequested?: () => void;
}

export interface RunStartForegroundResult {
  /** Client-facing URL of the daemon HTTP listener. */
  webUrl: string;
  /** Stop and clean up the daemon. */
  stop: () => Promise<void>;
}

/**
 * Start the daemon in the foreground. Resolves once the listener is bound and
 * metadata has been written; bind or TLS failures reject. Callers are
 * responsible for awaiting the returned `stop` (typically via signal handlers).
 */
export async function runStartForeground(
  opts: StartCommandOptions = {},
): Promise<RunStartForegroundResult> {
  const loadConfig = opts.loadConfig ?? (() => loadGlobalConfig());
  const start = opts.startDaemonFn ?? startDaemon;
  const config = await loadConfig();
  let stopRequested: () => void = () => {};
  const handle = await start({
    metadataPath: opts.metadataPath,
    web: { port: config.web.port, host: config.web.host },
    restartScheduler: defaultRestartScheduler,
    stopScheduler: () => {
      // Deferred so the HTTP response is flushed before shutdown begins.
      setTimeout(() => stopRequested(), 50);
    },
  });
  const stop = async () => {
    await handle.stop();
  };
  stopRequested =
    opts.onStopRequested ??
    (() => {
      void stop().finally(() => process.exit(0));
    });
  return { webUrl: handle.webUrl, stop };
}

export type StartMode = "foreground" | "background" | "unknown";

export interface ParsedStartArgs {
  mode: StartMode;
}

export function parseStartArgs(args: string[]): ParsedStartArgs {
  if (args.length === 0) return { mode: "background" };
  if (args.length === 1 && args[0] === "--foreground") {
    return { mode: "foreground" };
  }
  return { mode: "unknown" };
}

export interface StartBackgroundDeps {
  /** Browser launcher used to open onboarding on first run (tests). */
  launcher?: WebLauncher;
  /**
   * Query the daemon's first-run status. Returns `null` when unreachable so the
   * URL is still printed without opening a browser (tests).
   */
  fetchSetupRequired?: (baseUrl: string) => Promise<boolean | null>;
  stdoutWrite?: (text: string) => void;
  stderrWrite?: (text: string) => void;
}

/** Read `GET /ui/v1/setup/status` and report whether onboarding is pending. */
async function fetchSetupRequired(baseUrl: string): Promise<boolean | null> {
  try {
    const res = await fetch(new URL("/ui/v1/setup/status", baseUrl));
    if (!res.ok) return null;
    const body = (await res.json()) as { setupRequired?: unknown };
    return body.setupRequired === true;
  } catch {
    return null;
  }
}

export async function runStartBackground(
  bootstrapOpts?: DaemonBootstrapOptions,
  deps: StartBackgroundDeps = {},
): Promise<number> {
  const stdoutWrite = deps.stdoutWrite ?? ((s: string) => void process.stdout.write(s));
  const stderrWrite = deps.stderrWrite ?? ((s: string) => void process.stderr.write(s));
  const bootstrap = createDaemonBootstrap(bootstrapOpts);
  try {
    const result = await bootstrap.start();
    const url = result.daemon.baseUrl;
    stderrWrite(
      result.kind === "already-running"
        ? "wos: daemon is already running\n"
        : "wos: daemon started\n",
    );
    stdoutWrite(`Web UI: ${url}\n`);

    // First run: guide the user into the web onboarding checklist. Opening the
    // browser is best-effort — always print the URL so it is reachable anyway.
    const setupRequired = await (deps.fetchSetupRequired ?? fetchSetupRequired)(url);
    if (setupRequired) {
      const launcher = deps.launcher ?? defaultLauncher(process.platform);
      const opened = await launcher(url);
      stdoutWrite(
        opened.ok
          ? "First run — opened the setup page in your browser.\n"
          : `First run — open ${url} to finish setup.\n`,
      );
    }
    return 0;
  } catch (e) {
    if (e instanceof DaemonStartupError) {
      stderrWrite(
        `wos start failed: ${e.message}\nTry running 'wos start --foreground' manually to inspect.\n`,
      );
      return 1;
    }
    throw e;
  }
}

export async function runStop(
  bootstrapOpts?: DaemonBootstrapOptions,
): Promise<number> {
  const bootstrap = createDaemonBootstrap(bootstrapOpts);
  try {
    const result = await bootstrap.stop();
    if (result.stopped) {
      process.stderr.write("wos: daemon stopped\n");
    } else {
      process.stderr.write("wos: no daemon was running\n");
    }
    return 0;
  } catch (e) {
    process.stderr.write(`wos stop failed: ${(e as Error).message}\n`);
    return 1;
  }
}

export async function runRestart(
  bootstrapOpts?: DaemonBootstrapOptions,
): Promise<number> {
  const bootstrap = createDaemonBootstrap(bootstrapOpts);
  process.stderr.write("wos: restarting daemon...\n");
  try {
    await bootstrap.restart();
  } catch (e) {
    if (e instanceof DaemonStartupError) {
      process.stderr.write(
        `wos restart failed: ${e.message}\nTry running 'wos start --foreground' manually to inspect.\n`,
      );
      return 1;
    }
    throw e;
  }
  process.stderr.write("wos: daemon restarted successfully\n");
  return 0;
}

/**
 * Stability warning copy for the effective terminal backend, or `null` when no
 * warning applies. Emitted on `wos start` for the `default` backend; `tmux` is
 * silent. Pure so the wiring can be unit-tested without starting a daemon.
 */
export function backendStartupWarning(
  backend: TerminalBackendId,
): string | null {
  return backend === "default" ? OUTSIDE_TMUX_WARNING : null;
}

/**
 * Anchor the long-lived daemon process to the stable `<wos-home>` directory.
 *
 * The daemon is spawned from — and so inherits the working directory of —
 * whatever invoked it, which is almost always a worktree. It never relies on
 * its own `process.cwd()` for git/docker/terminal work (those always receive an
 * explicit path), but every `Bun.spawn` still inherits that cwd, and
 * `posix_spawn` fails with `ENOENT` when the inherited directory no longer
 * exists. So removing the worktree the daemon happened to start in strands the
 * next spawn with `ENOENT: no such file or directory, posix_spawn 'git'`.
 * Re-rooting at `<wos-home>` (which outlives any worktree) removes that
 * dependency for git, docker, and terminal spawns alike. Best-effort: if it
 * fails the daemon keeps the inherited cwd and still works while it survives.
 */
function anchorDaemonCwd(): void {
  try {
    const home = wosHome();
    mkdirSync(home, { recursive: true });
    process.chdir(home);
  } catch {
    // Leave the inherited cwd in place.
  }
}

export async function runStart(args: string[]): Promise<number> {
  const { mode } = parseStartArgs(args);
  if (mode === "unknown") {
    process.stderr.write(
      "wos start: unknown arguments. Use 'wos start' or 'wos start --foreground'.\n",
    );
    return 2;
  }
  // Non-fatal: warn when terminal sessions will run on the unstable default
  // backend, without blocking startup.
  const warning = backendStartupWarning((await loadGlobalConfig()).terminalBackend);
  if (warning) process.stderr.write(`${warning}\n`);
  if (mode === "background") {
    return runStartBackground();
  }

  // Detach from the (possibly transient) worktree this process was launched in
  // before binding the listener, so a later worktree removal can't break the
  // daemon's git/docker/terminal spawns. See `anchorDaemonCwd`.
  anchorDaemonCwd();

  // Foreground daemon server.
  let stopping = false;
  let handle: RunStartForegroundResult;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`daemon: received ${signal}, shutting down\n`);
    try {
      await handle.stop();
    } catch (e) {
      process.stderr.write(`daemon shutdown error: ${(e as Error).message}\n`);
    }
    process.exit(0);
  };
  try {
    handle = await runStartForeground({
      onStopRequested: () => void shutdown("daemon stop request"),
    });
  } catch (e) {
    process.stderr.write(`wos start failed: ${(e as Error).message}\n`);
    return 1;
  }
  process.stdout.write(`wos daemon listening on ${handle.webUrl}\n`);
  process.stdout.write(`metadata: ${daemonMetadataPath()}\n`);

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));

  // Keep the event loop alive forever; signals do the cleanup.
  await new Promise<void>(() => {});
  return 0;
}
