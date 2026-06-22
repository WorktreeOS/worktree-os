import { loadConfig } from "@worktreeos/core/config";
import {
  effectiveHealthcheckDefaults,
  loadGlobalConfig,
} from "@worktreeos/core/global-config";
import {
  defaultGitRunner,
  ensureCurrentWorktree,
  listWorktrees,
  NotInsideWorktreeError,
  selectSourceWorktree,
  type GitRunner,
} from "@worktreeos/core/git";
import { computeProjectName } from "@worktreeos/core/project-name";
import type { PortAssignments } from "@worktreeos/core/state";
import { plainRenderer, type Renderer } from "@worktreeos/ui/renderer";
import {
  bufferedToStreaming,
  runUpProgram,
  type RunUpDeps,
  type TunnelPreparer,
} from "@worktreeos/runtime/up-program";
import { registerProjectBySourcePath } from "@worktreeos/core/project-registry";

export { bufferedToStreaming, runUpProgram };
export type { RunUpDeps, TunnelPreparer };

export class UpArgsError extends Error {}

export interface ParsedUpArgs {
  force: boolean;
  detached: boolean;
  noTunnel: boolean;
  /** Explicit service list from positional `app,api` argument. */
  services?: string[];
  /** Target name from `--target <name>`. Mutually exclusive with `services`. */
  target?: string;
  /**
   * Runtime argument values parsed from repeated `--arg KEY=VALUE` flags.
   * `undefined` when no `--arg` flag was passed; otherwise a map keyed by
   * declared runtime argument name.
   */
  arguments?: Record<string, string>;
}

export function parseUpArgs(args: string[]): ParsedUpArgs {
  let force = false;
  let detached = false;
  let noTunnel = false;
  let target: string | undefined;
  let services: string[] | undefined;
  let runtimeArguments: Record<string, string> | undefined;
  const recordArg = (raw: string): void => {
    const eq = raw.indexOf("=");
    if (eq <= 0) {
      throw new UpArgsError(`--arg requires KEY=VALUE (got "${raw}")`);
    }
    const key = raw.slice(0, eq);
    const value = raw.slice(eq + 1);
    if (key.length === 0) {
      throw new UpArgsError(`--arg requires a non-empty key`);
    }
    if (runtimeArguments === undefined) runtimeArguments = {};
    if (Object.prototype.hasOwnProperty.call(runtimeArguments, key)) {
      throw new UpArgsError(`--arg ${key} was specified more than once`);
    }
    runtimeArguments[key] = value;
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "-d") {
      detached = true;
      continue;
    }
    if (arg === "--no-tunnel") {
      noTunnel = true;
      continue;
    }
    if (arg === "--target") {
      const value = args[i + 1];
      if (value === undefined || value.length === 0) {
        throw new UpArgsError("--target requires a target name");
      }
      target = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--target=")) {
      const value = arg.slice("--target=".length);
      if (value.length === 0) {
        throw new UpArgsError("--target requires a target name");
      }
      target = value;
      continue;
    }
    if (arg === "--arg") {
      const value = args[i + 1];
      if (value === undefined) {
        throw new UpArgsError("--arg requires KEY=VALUE");
      }
      recordArg(value);
      i += 1;
      continue;
    }
    if (arg.startsWith("--arg=")) {
      recordArg(arg.slice("--arg=".length));
      continue;
    }
    if (arg.startsWith("--")) {
      throw new UpArgsError(`unknown option "${arg}"`);
    }
    if (services !== undefined) {
      throw new UpArgsError(
        `unexpected argument "${arg}"; service list must be a single comma-separated value`,
      );
    }
    const items = arg.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    if (items.length === 0) {
      throw new UpArgsError("service list must contain at least one service");
    }
    services = items;
  }
  if (services !== undefined && target !== undefined) {
    throw new UpArgsError("--target and explicit services are mutually exclusive");
  }
  return { force, detached, noTunnel, services, target, arguments: runtimeArguments };
}

export interface RunUpOptions {
  gitRunner?: GitRunner;
}

/**
 * Legacy non-daemon `up` path. Kept as a thin wrapper that runs `runUpProgram`
 * with a plain text renderer for callers that bypass the daemon (tests for the
 * worktree guard, embedded scripts). Production CLI dispatch goes through
 * `runUpViaDaemon` in `commands/daemon-mode.ts`.
 */
export async function runUp(args: string[], opts: RunUpOptions = {}): Promise<number> {
  let parsed: ParsedUpArgs;
  try {
    parsed = parseUpArgs(args);
  } catch (e) {
    if (e instanceof UpArgsError) {
      process.stderr.write(`wos up: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
  const { force, noTunnel, services, target } = parsed;
  const runtimeArguments = parsed.arguments;
  const gitRunner = opts.gitRunner ?? defaultGitRunner;

  let worktreeRoot: string;
  try {
    ({ worktreeRoot } = await ensureCurrentWorktree(gitRunner));
  } catch (e) {
    if (e instanceof NotInsideWorktreeError) {
      process.stderr.write(`${e.message}\n`);
      return 1;
    }
    process.stderr.write(`wos up failed: ${(e as Error).message}\n`);
    return 1;
  }

  let renderer: Renderer | null = null;
  try {
    const worktrees = await listWorktrees(gitRunner);
    const source = selectSourceWorktree(worktrees);
    const config = await loadConfig(source.path, worktreeRoot);
    const globalConfig = await loadGlobalConfig();
    const projectName = computeProjectName(worktreeRoot, source.path);
    renderer = plainRenderer();
    await renderer.start();

    await runUpProgram({
      worktreeRoot,
      config,
      source,
      projectName,
      force,
      noTunnel,
      observer: renderer.observer,
      stdout: renderer.stdout,
      healthcheckDefaults: effectiveHealthcheckDefaults(globalConfig),
      selection: target !== undefined
        ? { kind: "target", target }
        : services !== undefined
          ? { kind: "services", services }
          : undefined,
      runtimeArguments,
    });
    try {
      await registerProjectBySourcePath(source.path);
    } catch {
      // Project registration is best-effort; never block a successful up.
    }

    await renderer.stop();
    return 0;
  } catch (e) {
    renderer?.observer.emit({ type: "failure", message: (e as Error).message });
    await renderer?.stop();
    process.stderr.write(`wos up failed: ${(e as Error).message}\n`);
    return 1;
  }
}

export type { PortAssignments };
