import {
  defaultGitRunner,
  ensureCurrentWorktree,
  gitRunnerInCwd,
  NotInsideWorktreeError,
  type GitRunner,
} from "@worktreeos/core/git";
import {
  createDaemonBootstrap,
  DaemonProtocolError,
  DaemonStartupError,
  type DaemonBootstrap,
} from "@worktreeos/daemon/daemon-bootstrap";
import { isTerminalEnvelope } from "@worktreeos/daemon/daemon-protocol";
import { createUiClient, UiSessionBusyError, type UiClient } from "@worktreeos/daemon/ui-client";
import type { ConflictResponse } from "@worktreeos/daemon/daemon-protocol";
import { detachedRenderer } from "@worktreeos/ui/detached-renderer";
import type { DeploymentMode } from "@worktreeos/core/config";
import type { Renderer } from "@worktreeos/ui/renderer";
import { formatStatusTable } from "@worktreeos/ui/format";
import { parseUpArgs, UpArgsError } from "./up";
import { resolveWorktreeDetailUrl } from "./web-url";

export interface DaemonModeOptions {
  gitRunner?: GitRunner;
  /** Override the daemon HTTP bootstrap (tests). */
  bootstrap?: DaemonBootstrap;
  /** Override UI API client (tests). Defaults to a client at the discovered `webUrl`. */
  uiClient?: UiClient;
  /**
   * Test seam: override the foreground progress renderer. Used only by the
   * non-`-d` `wos up` path. `up -d` does not create a renderer.
   */
  rendererFactory?: () => Renderer;
  /** Override stdout sink (tests). Defaults to `process.stdout.write`. */
  stdoutWrite?: (text: string) => void;
  /** Override stderr sink (tests). Defaults to `process.stderr.write`. */
  stderrWrite?: (text: string) => void;
  /**
   * Test seam: resolve the worktree web detail URL. Defaults to
   * {@link resolveWorktreeDetailUrl} which reads daemon metadata from disk.
   */
  resolveWebUrl?: (worktreeRoot: string) => Promise<string | null>;
  /**
   * Absolute path passed via the global `--cwd` option. Used as the starting
   * directory for resolving the current worktree. If set and `gitRunner` is not
   * provided, a git runner is created with an explicit `cwd` so as not to
   * change `process.cwd()`.
   */
  cwd?: string;
}

/**
 * Returns the git runner for a command: an explicit one from options wins,
 * otherwise a runner is built from the global `--cwd` (if set), otherwise the
 * default runner backed by `process.cwd()`.
 */
function resolveGitRunner(opts: DaemonModeOptions): GitRunner {
  if (opts.gitRunner) return opts.gitRunner;
  if (opts.cwd) return gitRunnerInCwd(opts.cwd);
  return defaultGitRunner;
}

/** `wos up` routed through the local daemon. */
export async function runUpViaDaemon(
  args: string[],
  opts: DaemonModeOptions = {},
): Promise<number> {
  const stdoutWrite =
    opts.stdoutWrite ?? ((text: string) => process.stdout.write(text));
  const stderrWrite =
    opts.stderrWrite ?? ((text: string) => process.stderr.write(text));
  const resolveWebUrl =
    opts.resolveWebUrl ?? ((path: string) => resolveWorktreeDetailUrl(path));

  let force: boolean;
  let detached: boolean;
  let noTunnel: boolean;
  let services: string[] | undefined;
  let target: string | undefined;
  let runtimeArguments: Record<string, string> | undefined;
  try {
    const parsed = parseUpArgs(args);
    ({ force, detached, noTunnel, services, target } = parsed);
    runtimeArguments = parsed.arguments;
  } catch (e) {
    if (e instanceof UpArgsError) {
      stderrWrite(`wos up failed: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
  const gitRunner = resolveGitRunner(opts);

  let worktreeRoot: string;
  try {
    ({ worktreeRoot } = await ensureCurrentWorktree(gitRunner));
  } catch (e) {
    if (e instanceof NotInsideWorktreeError) {
      stderrWrite(`${e.message}\n`);
      return 1;
    }
    stderrWrite(`wos up failed: ${(e as Error).message}\n`);
    return 1;
  }

  const bootstrap = opts.bootstrap ?? createDaemonBootstrap();
  let baseUrl: string;
  try {
    baseUrl = await ensureDaemon(bootstrap);
  } catch (e) {
    stderrWrite(`wos up failed: ${(e as Error).message}\n`);
    return 1;
  }

  const uiClient = opts.uiClient ?? createUiClient({ baseUrl });

  if (detached) {
    return runDetachedUp({
      uiClient,
      worktreeRoot,
      force,
      noTunnel,
      services,
      target,
      runtimeArguments,
      stdoutWrite,
      stderrWrite,
      resolveWebUrl,
    });
  }

  return runForegroundUp({
    uiClient,
    worktreeRoot,
    force,
    noTunnel,
    services,
    target,
    runtimeArguments,
    stdoutWrite,
    stderrWrite,
    resolveWebUrl,
    rendererFactory: opts.rendererFactory,
  });
}

interface ModeArgs {
  uiClient: UiClient;
  worktreeRoot: string;
  force: boolean;
  noTunnel: boolean;
  services?: string[];
  target?: string;
  runtimeArguments?: Record<string, string>;
  stdoutWrite: (text: string) => void;
  stderrWrite: (text: string) => void;
  resolveWebUrl: (worktreeRoot: string) => Promise<string | null>;
}

/**
 * Foreground `wos up`: submit the daemon operation, stream progress as
 * non-interactive text, print final service summary and worktree web URL
 * on success, exit immediately after the operation reaches a terminal state.
 */
async function runForegroundUp(
  args: ModeArgs & { rendererFactory?: () => Renderer },
): Promise<number> {
  const {
    uiClient,
    worktreeRoot,
    force,
    noTunnel,
    services,
    target,
    runtimeArguments,
    stdoutWrite,
    stderrWrite,
    resolveWebUrl,
  } = args;
  let mode: DeploymentMode | undefined;
  if (!args.rendererFactory) {
    try {
      const detail = await uiClient.getWorktreeDetail(worktreeRoot);
      if (detail.projectConfig?.status === "valid") {
        mode = detail.projectConfig.mode;
      }
    } catch {
      // Fall back to default (Docker) step labels when detail is unavailable.
    }
  }
  const renderer = args.rendererFactory
    ? args.rendererFactory()
    : detachedRenderer({ mode });
  await renderer.start();

  try {
    const accepted = await uiClient.submitUp({
      path: worktreeRoot,
      force,
      noTunnel,
      services,
      target,
      arguments: runtimeArguments,
    });
    const result = await drainEventsFromUi(uiClient, accepted.operationId, renderer);
    if (result.status === "succeeded") {
      // Final service summary on success.
      try {
        const res = await uiClient.getWorktreeDetail(worktreeRoot);
        stdoutWrite(
          formatStatusTable(
            res.services ?? [],
            res.appPortHealthchecks ?? [],
            res.tunnels ?? [],
            { hyperlinks: Boolean(process.stdout.isTTY) },
          ) + "\n",
        );
      } catch (e) {
        stderrWrite(
          `wos up: status query failed: ${(e as Error).message}\n`,
        );
      }
      // Worktree web detail URL: best-effort; falls back to a notice when
      // the daemon has no `webUrl` in its metadata.
      const url = await resolveWebUrl(worktreeRoot).catch(() => null);
      if (url) {
        stdoutWrite(`Open in web UI: ${url}\n`);
      } else {
        stdoutWrite(
          "Web UI unavailable (web.port not bound) — run 'wos web' once it becomes available.\n",
        );
      }
      await renderer.stop();
      return 0;
    }
    await renderer.stop();
    stderrWrite(
      `wos up failed: ${result.failureMessage ?? "operation failed"}\n`,
    );
    return 1;
  } catch (e) {
    if (e instanceof UiSessionBusyError) {
      const conflict = e.body as ConflictResponse | undefined;
      const msg =
        conflict?.sessionName && conflict.active
          ? `session ${conflict.sessionName} is busy (active op ${conflict.active.operationId})`
          : "session is busy";
      renderer.observer.emit({ type: "failure", message: msg });
      await renderer.stop();
      stderrWrite(`wos up failed: ${msg}\n`);
      return 1;
    }
    renderer.observer.emit({ type: "failure", message: (e as Error).message });
    await renderer.stop();
    stderrWrite(`wos up failed: ${(e as Error).message}\n`);
    return 1;
  }
}

/**
 * Daemon-detached `wos up -d`: submit the `up` operation to the daemon,
 * print an accepted-start message with the current worktree web URL when
 * available, and exit immediately after the daemon accepts the operation.
 */
async function runDetachedUp(args: ModeArgs): Promise<number> {
  const {
    uiClient,
    worktreeRoot,
    force,
    noTunnel,
    services,
    target,
    runtimeArguments,
    stdoutWrite,
    stderrWrite,
    resolveWebUrl,
  } = args;
  try {
    await uiClient.submitUp({
      path: worktreeRoot,
      force,
      noTunnel,
      services,
      target,
      arguments: runtimeArguments,
    });
  } catch (e) {
    if (e instanceof UiSessionBusyError) {
      const conflict = e.body as ConflictResponse | undefined;
      const msg =
        conflict?.sessionName && conflict.active
          ? `session ${conflict.sessionName} is busy (active op ${conflict.active.operationId})`
          : "session is busy";
      stderrWrite(`wos up failed: ${msg}\n`);
      return 1;
    }
    stderrWrite(`wos up failed: ${(e as Error).message}\n`);
    return 1;
  }
  stdoutWrite("wos up: deployment started in the background.\n");
  const url = await resolveWebUrl(worktreeRoot).catch(() => null);
  if (url) {
    stdoutWrite(`Progress and logs: ${url}\n`);
  } else {
    stdoutWrite(
      "Web UI unavailable (web.port not bound) — run 'wos web' once it becomes available.\n",
    );
  }
  return 0;
}

/**
 * `wos worktree remove [--force]` routed through the local daemon.
 *
 * Resolves the current worktree locally (so we can reject runs outside a Git
 * tree with the same message other commands use), then submits the
 * `worktree-remove` operation through the UI API and streams its events until
 * a terminal envelope arrives.
 */
export async function runWorktreeRemoveViaDaemon(
  args: { force: boolean },
  opts: DaemonModeOptions = {},
): Promise<number> {
  const gitRunner = resolveGitRunner(opts);
  const stderrWrite =
    opts.stderrWrite ?? ((text: string) => process.stderr.write(text));
  const stdoutWrite =
    opts.stdoutWrite ?? ((text: string) => process.stdout.write(text));

  let worktreeRoot: string;
  try {
    ({ worktreeRoot } = await ensureCurrentWorktree(gitRunner));
  } catch (e) {
    if (e instanceof NotInsideWorktreeError) {
      stderrWrite(`${e.message}\n`);
      return 1;
    }
    stderrWrite(`wos worktree remove failed: ${(e as Error).message}\n`);
    return 1;
  }

  const bootstrap = opts.bootstrap ?? createDaemonBootstrap();
  let baseUrl: string;
  try {
    baseUrl = await ensureDaemon(bootstrap);
  } catch (e) {
    stderrWrite(`wos worktree remove failed: ${(e as Error).message}\n`);
    return 1;
  }

  const uiClient = opts.uiClient ?? createUiClient({ baseUrl });

  let accepted: { operationId: string };
  try {
    accepted = await uiClient.submitWorktreeRemove({
      path: worktreeRoot,
      discardChanges: args.force,
    });
  } catch (e) {
    if (e instanceof UiSessionBusyError) {
      const conflict = e.body as ConflictResponse | undefined;
      const msg =
        conflict?.sessionName && conflict.active
          ? `session ${conflict.sessionName} is busy (active op ${conflict.active.operationId})`
          : "session is busy";
      stderrWrite(`wos worktree remove failed: ${msg}\n`);
      return 1;
    }
    stderrWrite(`wos worktree remove failed: ${(e as Error).message}\n`);
    return 1;
  }

  let status: "succeeded" | "failed" = "failed";
  let failureMessage: string | undefined;
  try {
    for await (const env of uiClient.streamOperationEvents(
      accepted.operationId,
    )) {
      if (isTerminalEnvelope(env)) {
        status = env.terminal.status;
        failureMessage = env.terminal.failureMessage;
        continue;
      }
      if (env.event.type === "log") {
        const target = env.event.stream === "stderr" ? stderrWrite : stdoutWrite;
        target(env.event.chunk);
      } else if (env.event.type === "failure") {
        stderrWrite(`${env.event.message}\n`);
      }
    }
  } catch (e) {
    stderrWrite(`wos worktree remove failed: ${(e as Error).message}\n`);
    return 1;
  }

  if (status === "failed") {
    stderrWrite(
      `wos worktree remove failed: ${failureMessage ?? "operation failed"}\n`,
    );
    return 1;
  }
  return 0;
}

/** `wos down` routed through the local daemon. */
export async function runDownViaDaemon(
  _args: string[],
  opts: DaemonModeOptions = {},
): Promise<number> {
  const gitRunner = resolveGitRunner(opts);
  let worktreeRoot: string;
  try {
    ({ worktreeRoot } = await ensureCurrentWorktree(gitRunner));
  } catch (e) {
    if (e instanceof NotInsideWorktreeError) {
      process.stderr.write(`${e.message}\n`);
      return 1;
    }
    process.stderr.write(`wos down failed: ${(e as Error).message}\n`);
    return 1;
  }

  const bootstrap = opts.bootstrap ?? createDaemonBootstrap();
  let baseUrl: string;
  try {
    baseUrl = await ensureDaemon(bootstrap);
  } catch (e) {
    process.stderr.write(`wos down failed: ${(e as Error).message}\n`);
    return 1;
  }

  const uiClient = opts.uiClient ?? createUiClient({ baseUrl });

  try {
    const accepted = await uiClient.submitDown({ path: worktreeRoot });
    let status: "succeeded" | "failed" = "failed";
    let failureMessage: string | undefined;
    for await (const env of uiClient.streamOperationEvents(accepted.operationId)) {
      if (isTerminalEnvelope(env)) {
        status = env.terminal.status;
        failureMessage = env.terminal.failureMessage;
        continue;
      }
      if (env.event.type === "log") {
        const target =
          env.event.stream === "stderr" ? process.stderr : process.stdout;
        target.write(env.event.chunk);
      } else if (env.event.type === "failure") {
        process.stderr.write(`${env.event.message}\n`);
      }
    }
    if (status === "failed") {
      process.stderr.write(
        `wos down failed: ${failureMessage ?? "operation failed"}\n`,
      );
      return 1;
    }
    return 0;
  } catch (e) {
    if (e instanceof UiSessionBusyError) {
      const conflict = e.body as ConflictResponse | undefined;
      const msg =
        conflict?.sessionName && conflict.active
          ? `session ${conflict.sessionName} is busy (active op ${conflict.active.operationId})`
          : "session is busy";
      process.stderr.write(`wos down failed: ${msg}\n`);
      return 1;
    }
    process.stderr.write(`wos down failed: ${(e as Error).message}\n`);
    return 1;
  }
}

/** `wos status` routed through the local daemon. */
export async function runStatusViaDaemon(
  _args: string[],
  opts: DaemonModeOptions = {},
): Promise<number> {
  const gitRunner = resolveGitRunner(opts);
  let worktreeRoot: string;
  try {
    ({ worktreeRoot } = await ensureCurrentWorktree(gitRunner));
  } catch (e) {
    if (e instanceof NotInsideWorktreeError) {
      process.stderr.write(`${e.message}\n`);
      return 1;
    }
    process.stderr.write(`wos status failed: ${(e as Error).message}\n`);
    return 1;
  }
  const bootstrap = opts.bootstrap ?? createDaemonBootstrap();
  let baseUrl: string;
  try {
    baseUrl = await ensureDaemon(bootstrap);
  } catch (e) {
    process.stderr.write(`wos status failed: ${(e as Error).message}\n`);
    return 1;
  }
  const uiClient = opts.uiClient ?? createUiClient({ baseUrl });
  try {
    const res = await uiClient.getWorktreeDetail(worktreeRoot);
    if (res.worktree.status === "not-started") {
      process.stdout.write(
        "no wos deployment has been initialized for the current worktree\n",
      );
      return 0;
    }
    process.stdout.write(
      formatStatusTable(
        res.services ?? [],
        res.appPortHealthchecks ?? [],
        res.tunnels ?? [],
        { hyperlinks: Boolean(process.stdout.isTTY) },
      ) + "\n",
    );
    return 0;
  } catch (e) {
    process.stderr.write(`wos status failed: ${(e as Error).message}\n`);
    return 1;
  }
}

/**
 * Ensure a healthy, protocol-compatible daemon is reachable over HTTP and
 * return its base URL for `UiClient({ baseUrl })`.
 */
export async function ensureDaemon(bootstrap: DaemonBootstrap): Promise<string> {
  try {
    const running = await bootstrap.ensureRunning();
    return running.baseUrl;
  } catch (e) {
    if (e instanceof DaemonStartupError) {
      throw new Error(
        `daemon could not be started: ${e.message}. Try running 'wos start --foreground' manually to inspect.`,
      );
    }
    if (e instanceof DaemonProtocolError) {
      throw new Error(e.message);
    }
    throw e;
  }
}

async function drainEventsFromUi(
  client: UiClient,
  operationId: string,
  renderer: Renderer,
): Promise<{ status: "succeeded" | "failed"; failureMessage?: string }> {
  let terminal: { status: "succeeded" | "failed"; failureMessage?: string } | null = null;
  for await (const env of client.streamOperationEvents(operationId)) {
    if (isTerminalEnvelope(env)) {
      terminal = env.terminal;
      continue;
    }
    renderer.observer.emit(env.event);
  }
  return terminal ?? { status: "failed", failureMessage: "stream ended without terminal" };
}
