import { dirname } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import type { DeploymentMode } from "./config";
import {
  sessionRootForWorktree,
  sessionStatePath,
  sessionUpFailurePath,
} from "./paths";

export type PortAssignments = Record<string, Record<string, number>>;

/**
 * Deployment backend that owns a session's runtime state. Docker-backed modes
 * (`generated`, `compose`) use `"docker"`; `shell` mode uses `"shell"`.
 */
export type DeploymentBackendId = "docker" | "shell";

/**
 * Persisted metadata for a single shell-mode service process. Written
 * immediately after spawn so `status`, `down`, service actions, logs, and
 * daemon restart recovery work without the original `up` process.
 */
export interface ShellServiceRuntimeState {
  /** Root process id of the spawned shell command. */
  pid: number;
  /**
   * Process group id when the platform supports starting the service in its
   * own group. Used to terminate the whole process tree on stop/down.
   */
  processGroupId?: number;
  /** Resolved shell command argv used to start the service. */
  command: string[];
  /** Absolute working directory the process was started from. */
  cwd: string;
  /** Names of environment variables injected into the process. */
  environmentKeys: string[];
  /** Absolute paths of the stdout/stderr log files for the process. */
  logFiles: { stdout: string; stderr: string };
  /** ISO timestamp recorded when the process was spawned. */
  startedAt: string;
  /** Configured service port (as string) -> allocated host port. */
  ports: Record<string, number>;
}

/** Shell backend runtime state persisted under the session root. */
export interface ShellRuntimeState {
  services: Record<string, ShellServiceRuntimeState>;
  /**
   * Submitted runtime argument values from the last `up`. Persisted so service
   * restart can re-resolve `${ARG}` environment templates without the original
   * submission. Mirrors compose mode's "resolve once" model.
   */
  runtimeArguments?: Record<string, string>;
}

export interface WosState {
  initialized: boolean;
  projectName: string;
  composeFile: string;
  /**
   * Ordered list of Compose files Docker Compose should run with. In
   * compose mode this is `[sanitizedBase, overlay]`; in generated mode it is
   * omitted (callers fall back to `composeFile`).
   */
  composeFiles?: string[];
  lastUp?: string;
  /**
   * Commit (HEAD) that was deployed at the last successful `up`. Optional for
   * backwards compatibility — state written before this field existed omits it,
   * and it is left unset when HEAD could not be read at deploy time. Used to
   * compute deploy freshness (commits-since-deploy) in worktree detail.
   */
  lastUpCommit?: string;
  /**
   * Duration of the last successful `up` in milliseconds. Optional and
   * best-effort: state written before this field existed (or runs where the
   * duration could not be measured) omit it. Persisted so a not-started
   * worktree's last-run figure survives daemon restarts (the in-memory latest
   * operation is lost on restart). Canonical durable source for deploy
   * duration; the worktree detail reads this first and falls back to the
   * latest operation only when absent.
   */
  lastUpDurationMs?: number;
  portAssignments?: PortAssignments;
  /**
   * Absolute path of the worktree that owns this state. Optional for
   * backwards compatibility — older `state.json` files written before this
   * field existed may omit it; readers must treat absent values gracefully.
   */
  worktreeRoot?: string;
  /** Absolute path of the resolved primary/source worktree at last `up`. */
  sourcePath?: string;
  /**
   * Deployment identity persisted alongside Compose artifacts so daemon
   * startup restoration can distinguish current containers from stale ones.
   * Written on every `up` that generates Compose artifacts.
   */
  deploymentId?: string;
  /**
   * Selected deployment backend for this session. Optional for backwards
   * compatibility — state files written before shell mode omit it and MUST be
   * read as Docker-backed via {@link stateBackend}.
   */
  backend?: DeploymentBackendId;
  /**
   * Resolved deployment mode at last `up`. Optional for backwards
   * compatibility; absent values are Docker-backed (`generated`/`compose`).
   */
  mode?: DeploymentMode;
  /**
   * Shell backend runtime state. Present only when `backend === "shell"`.
   */
  shell?: ShellRuntimeState;
}

/**
 * Resolve the backend that owns a session's state. State written before the
 * backend discriminator existed is Docker-backed by definition.
 */
export function stateBackend(state: WosState): DeploymentBackendId {
  return state.backend ?? "docker";
}

export class StateError extends Error {}

export function stateFilePath(worktreeRoot: string): string {
  return sessionStatePath(worktreeRoot);
}

export async function readState(path: string): Promise<WosState | null> {
  const f = Bun.file(path);
  if (!(await f.exists())) return null;
  try {
    return (await f.json()) as WosState;
  } catch (e) {
    throw new StateError(`failed to read state at ${path}: ${(e as Error).message}`);
  }
}

export async function writeState(path: string, state: WosState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(state, null, 2) + "\n");
}

/**
 * Persistent marker for a failed `up` attempt that did not finish initializing
 * the worktree. Survives daemon restarts so the UI keeps showing the failure
 * state instead of bouncing back to `not_started`.
 */
export interface UpFailureRecord {
  failedAt: string;
  message: string;
  operationId?: string;
}

export function upFailureFilePath(worktreeRoot: string): string {
  return sessionUpFailurePath(worktreeRoot);
}

export async function readUpFailure(
  path: string,
): Promise<UpFailureRecord | null> {
  const f = Bun.file(path);
  if (!(await f.exists())) return null;
  try {
    return (await f.json()) as UpFailureRecord;
  } catch (e) {
    throw new StateError(
      `failed to read up-failure marker at ${path}: ${(e as Error).message}`,
    );
  }
}

export async function writeUpFailure(
  path: string,
  rec: UpFailureRecord,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(rec, null, 2) + "\n");
}

export async function clearUpFailure(path: string): Promise<void> {
  await rm(path, { force: true });
}

/**
 * Removes persistent wos artifacts for the given worktree: `state.json`,
 * generated compose files, and the last failed up-operation marker — i.e.
 * the entire `<wos-home>/sessions/<sessionName>`.
 * Idempotent: a missing directory is treated as successfully removed.
 */
export async function removeSessionRootForWorktree(
  worktreeRoot: string,
): Promise<void> {
  await rm(sessionRootForWorktree(worktreeRoot), {
    recursive: true,
    force: true,
  });
}
