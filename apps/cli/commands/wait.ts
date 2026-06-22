import {
  defaultGitRunner,
  ensureCurrentWorktree,
  gitRunnerInCwd,
  NotInsideWorktreeError,
  type GitRunner,
} from "@worktreeos/core/git";
import {
  createDaemonBootstrap,
  type DaemonBootstrap,
} from "@worktreeos/daemon/daemon-bootstrap";
import { createUiClient, type UiClient } from "@worktreeos/daemon/ui-client";
import type {
  DeploymentStatus,
  WorktreeDetailResponse,
} from "@worktreeos/daemon/ui-protocol";
import { formatStatusTable } from "@worktreeos/ui/format";
import { ensureDaemon } from "./daemon-mode";

/** Default timeout for `wos wait`. */
export const DEFAULT_WAIT_TIMEOUT_MS = 60_000;

/** Deployment status poll interval (ms). */
export const DEFAULT_WAIT_POLL_INTERVAL_MS = 500;

export interface ParsedWaitArgs {
  timeoutMs: number;
}

export interface WaitArgError {
  error: string;
}

/**
 * Parses a duration in milliseconds. Accepts plain numbers (treated as
 * milliseconds) and `ms`, `s`, `m` suffixes. Returns `null` for invalid or
 * non-positive values.
 */
export function parseDuration(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/i.exec(trimmed);
  if (!match) return null;
  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const suffix = (match[2] ?? "ms").toLowerCase();
  let ms: number;
  if (suffix === "ms") ms = numeric;
  else if (suffix === "s") ms = numeric * 1000;
  else if (suffix === "m") ms = numeric * 60 * 1000;
  else return null;
  ms = Math.round(ms);
  if (ms <= 0) return null;
  return ms;
}

/**
 * Parses arguments for the `wait` command. `--timeout <duration>` is optional
 * and defaults to 60000 ms. Unknown arguments are returned as an error.
 */
export function parseWaitArgs(args: string[]): ParsedWaitArgs | WaitArgError {
  let timeoutMs = DEFAULT_WAIT_TIMEOUT_MS;
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "--timeout") {
      const value = args[i + 1];
      if (value === undefined) {
        return { error: "--timeout requires a duration argument" };
      }
      const parsed = parseDuration(value);
      if (parsed === null) {
        return { error: `invalid --timeout value: ${value}` };
      }
      timeoutMs = parsed;
      i += 2;
      continue;
    }
    if (arg.startsWith("--timeout=")) {
      const value = arg.slice("--timeout=".length);
      if (value.length === 0) {
        return { error: "--timeout requires a duration argument" };
      }
      const parsed = parseDuration(value);
      if (parsed === null) {
        return { error: `invalid --timeout value: ${value}` };
      }
      timeoutMs = parsed;
      i += 1;
      continue;
    }
    return { error: `unknown argument: ${arg}` };
  }
  return { timeoutMs };
}

export interface RunWaitOptions {
  gitRunner?: GitRunner;
  /** Override the daemon HTTP bootstrap (tests). */
  bootstrap?: DaemonBootstrap;
  uiClient?: UiClient;
  /**
   * Absolute path from the global `--cwd` option. Used only to resolve the
   * current worktree; does not change `process.cwd()`.
   */
  cwd?: string;
  stdoutWrite?: (text: string) => void;
  stderrWrite?: (text: string) => void;
  /** Poll interval (ms). Defaults to `DEFAULT_WAIT_POLL_INTERVAL_MS`. */
  pollIntervalMs?: number;
  /** Returns the current timestamp (for tests). */
  now?: () => number;
  /** Sleep function (for tests). Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

const USAGE = `wos wait [--timeout <duration>]

  Wait until the current worktree deployment reaches running. Returns 0 on
  success and a non-zero code on timeout or terminal failure.

Options:
  --timeout <duration>   Maximum wait time. Accepts milliseconds and
                          ms/s/m suffixes. Defaults to 1m.
`;

const TERMINAL_FAILURE_STATUSES = new Set<DeploymentStatus>([
  "failed",
  "stopped",
]);

function resolveGitRunner(opts: RunWaitOptions): GitRunner {
  if (opts.gitRunner) return opts.gitRunner;
  if (opts.cwd) return gitRunnerInCwd(opts.cwd);
  return defaultGitRunner;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * `wos wait` via the local daemon: waits until the worktree status reaches
 * `running`, fails terminally, or times out.
 */
export async function runWaitViaDaemon(
  args: string[],
  opts: RunWaitOptions = {},
): Promise<number> {
  const stdoutWrite =
    opts.stdoutWrite ?? ((text: string) => process.stdout.write(text));
  const stderrWrite =
    opts.stderrWrite ?? ((text: string) => process.stderr.write(text));

  const parsed = parseWaitArgs(args);
  if ("error" in parsed) {
    stderrWrite(`wos wait: ${parsed.error}\n${USAGE}`);
    return 2;
  }
  const { timeoutMs } = parsed;

  const gitRunner = resolveGitRunner(opts);
  let worktreeRoot: string;
  try {
    ({ worktreeRoot } = await ensureCurrentWorktree(gitRunner));
  } catch (e) {
    if (e instanceof NotInsideWorktreeError) {
      stderrWrite(`${e.message}\n`);
      return 1;
    }
    stderrWrite(`wos wait failed: ${(e as Error).message}\n`);
    return 1;
  }

  const bootstrap = opts.bootstrap ?? createDaemonBootstrap();
  let baseUrl: string;
  try {
    baseUrl = await ensureDaemon(bootstrap);
  } catch (e) {
    stderrWrite(`wos wait failed: ${(e as Error).message}\n`);
    return 1;
  }

  const uiClient = opts.uiClient ?? createUiClient({ baseUrl });
  const pollInterval = opts.pollIntervalMs ?? DEFAULT_WAIT_POLL_INTERVAL_MS;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;
  const deadline = now() + timeoutMs;

  let lastDetail: WorktreeDetailResponse | undefined;
  let lastError: string | undefined;
  for (;;) {
    try {
      lastDetail = await uiClient.getWorktreeDetail(worktreeRoot);
      lastError = undefined;
    } catch (e) {
      lastError = (e as Error).message;
      lastDetail = undefined;
    }

    if (lastDetail) {
      const status = lastDetail.worktree.status;
      if (status === "running") {
        stdoutWrite(formatDetailTable(lastDetail) + "\n");
        return 0;
      }
      if (status === "not_started") {
        stderrWrite(
          "no wos deployment has been initialized for the current worktree\n",
        );
        return 1;
      }
      if (TERMINAL_FAILURE_STATUSES.has(status)) {
        stderrWrite(
          `wos wait failed: deployment status is ${status}\n`,
        );
        const table = formatDetailTable(lastDetail);
        if (table) stderrWrite(table + "\n");
        return 1;
      }
      // pending / checking / running_partial / unknown → keep polling
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      const observed = lastDetail?.worktree.status ?? "unknown";
      stderrWrite(
        `wos wait: timed out after ${timeoutMs}ms (last status: ${observed})\n`,
      );
      if (lastError) {
        stderrWrite(`wos wait: last error: ${lastError}\n`);
      }
      if (lastDetail) {
        const table = formatDetailTable(lastDetail);
        if (table) stderrWrite(table + "\n");
      }
      return 1;
    }
    await sleep(Math.min(pollInterval, remaining));
  }
}

function formatDetailTable(detail: WorktreeDetailResponse): string {
  const services = detail.services ?? [];
  if (services.length === 0) return "";
  return formatStatusTable(
    services,
    detail.appPortHealthchecks ?? [],
    detail.tunnels ?? [],
    { hyperlinks: Boolean(process.stdout.isTTY) },
  );
}
