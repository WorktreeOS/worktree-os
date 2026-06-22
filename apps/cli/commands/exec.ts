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
import {
  createUiClient,
  UiApiError,
  type UiClient,
} from "@worktreeos/daemon/ui-client";
import {
  daemonMetadataPath,
  type DaemonMetadata,
} from "@worktreeos/daemon/daemon-paths";
import { UI_API_VERSION } from "@worktreeos/daemon/ui-protocol";
import { ensureDaemon } from "./daemon-mode";
import { attachTerminal, type AttachOptions } from "./terminal-attach";

export const EXEC_USAGE = `wos exec <service> [--] <command...>

Run a command inside a running Docker-backed service for the current worktree.
Use '--' to separate the command when it begins with a flag, for example:
  wos exec api -- bun test
  wos exec api -- --version
`;

export interface ParsedExecArgs {
  service: string;
  command: string[];
}

export interface ExecArgsError {
  error: string;
}

/**
 * Parse `wos exec <service> [--] <command...>`. The first token is the service
 * name. An optional `--` separator follows, after which every remaining token
 * is preserved verbatim as the command argv (including leading flags). Rejects
 * a missing service or a missing command without contacting the daemon.
 */
export function parseExecArgs(argv: string[]): ParsedExecArgs | ExecArgsError {
  const first = argv[0];
  if (first === undefined || first === "--" || first.startsWith("-")) {
    return { error: "a service is required" };
  }
  let rest = argv.slice(1);
  if (rest[0] === "--") rest = rest.slice(1);
  if (rest.length === 0) {
    return { error: "a command is required" };
  }
  return { service: first, command: rest };
}

export interface ExecOptions {
  /** Absolute path passed via the global `--cwd` option. */
  cwd?: string;
  gitRunner?: GitRunner;
  /** Override the daemon HTTP bootstrap (tests). */
  bootstrap?: DaemonBootstrap;
  stdoutWrite?: (text: string) => void;
  stderrWrite?: (text: string) => void;
  /** Resolve the daemon base `webUrl` (tests). Defaults to daemon metadata. */
  resolveWebUrl?: () => Promise<string | null>;
  /** Build the UI client for the resolved `webUrl` (tests). */
  uiClientFactory?: (baseUrl: string) => UiClient;
  /** Attach to the terminal session (tests). Defaults to {@link attachTerminal}. */
  attach?: (opts: AttachOptions) => Promise<number>;
  /** Terminal dimensions (tests). Defaults to the local stdout size. */
  cols?: number;
  rows?: number;
}

/**
 * Read the daemon base web URL from daemon metadata. Returns `null` when the
 * metadata is missing or has no `webUrl` (the daemon started but its web
 * listener is not bound).
 */
export async function resolveDaemonWebUrl(
  opts: { metadataPath?: string } = {},
): Promise<string | null> {
  const path = opts.metadataPath ?? daemonMetadataPath();
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    const metadata = (await file.json()) as DaemonMetadata;
    return metadata.webUrl ?? null;
  } catch {
    return null;
  }
}

/**
 * Build the terminal attach WebSocket URL from the daemon base web URL and the
 * server-provided attach path. Converts the HTTP(S) scheme to WS(S).
 */
export function buildAttachWsUrl(webBaseUrl: string, attachPath: string): string {
  const trimmed = webBaseUrl.replace(/\/+$/, "");
  const wsBase = trimmed.replace(/^http(s?):/i, "ws$1:");
  return `${wsBase}${attachPath}`;
}

/** `wos exec <service> [--] <command...>` routed through the daemon web API. */
export async function runExec(
  argv: string[],
  opts: ExecOptions = {},
): Promise<number> {
  const stdoutWrite =
    opts.stdoutWrite ?? ((text: string) => process.stdout.write(text));
  const stderrWrite =
    opts.stderrWrite ?? ((text: string) => process.stderr.write(text));

  const parsed = parseExecArgs(argv);
  if ("error" in parsed) {
    stderrWrite(`wos exec: ${parsed.error}\n${EXEC_USAGE}`);
    return 2;
  }

  const gitRunner =
    opts.gitRunner ?? (opts.cwd ? gitRunnerInCwd(opts.cwd) : defaultGitRunner);
  let worktreeRoot: string;
  try {
    ({ worktreeRoot } = await ensureCurrentWorktree(gitRunner));
  } catch (e) {
    if (e instanceof NotInsideWorktreeError) {
      stderrWrite(`${e.message}\n`);
      return 1;
    }
    stderrWrite(`wos exec failed: ${(e as Error).message}\n`);
    return 1;
  }

  const bootstrap = opts.bootstrap ?? createDaemonBootstrap();
  let ensuredBaseUrl: string;
  try {
    ensuredBaseUrl = await ensureDaemon(bootstrap);
  } catch (e) {
    stderrWrite(`wos exec failed: ${(e as Error).message}\n`);
    return 1;
  }

  const webUrl = await (opts.resolveWebUrl ?? (async () => ensuredBaseUrl))();
  if (!webUrl) {
    stderrWrite(
      "wos exec failed: the daemon web listener is unavailable, but exec requires it. " +
        "Fix web.port or run 'wos restart'.\n",
    );
    return 1;
  }

  const uiClient = (opts.uiClientFactory ??
    ((baseUrl: string) => createUiClient({ baseUrl })))(webUrl);

  try {
    const health = await uiClient.health();
    if (!health.ok || health.version !== UI_API_VERSION) {
      stderrWrite(
        `wos exec failed: daemon web listener reported an incompatible UI API (version ${health.version ?? "unknown"}, expected ${UI_API_VERSION}). Run 'wos restart'.\n`,
      );
      return 1;
    }
  } catch (e) {
    stderrWrite(
      `wos exec failed: daemon web listener health check failed: ${(e as Error).message}. Run 'wos restart'.\n`,
    );
    return 1;
  }

  const cols = opts.cols ?? process.stdout.columns ?? 80;
  const rows = opts.rows ?? process.stdout.rows ?? 24;

  let created;
  try {
    created = await uiClient.submitExec({
      path: worktreeRoot,
      service: parsed.service,
      command: parsed.command,
      cols,
      rows,
    });
  } catch (e) {
    const message = e instanceof UiApiError ? e.message : (e as Error).message;
    stderrWrite(`wos exec failed: ${message}\n`);
    return 1;
  }

  const attach = opts.attach ?? attachTerminal;
  try {
    return await attach({
      url: buildAttachWsUrl(webUrl, created.attachPath),
      cols,
      rows,
    });
  } catch (e) {
    stderrWrite(`wos exec failed: ${(e as Error).message}\n`);
    return 1;
  }
}
