import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SESSIONS_DIRNAME,
  SESSION_STATE_FILENAME,
  wosHome,
} from "@worktreeos/core/paths";
import { deploymentModeOf, type WosConfig } from "@worktreeos/core/config";
import { stateBackend, type DeploymentBackendId, type WosState } from "@worktreeos/core/state";

export type { DeploymentBackendId };

/**
 * Synchronously read a session's persisted state by session name. Returns
 * `null` when the file is missing or unparseable. This module imports no
 * Docker code so shell-mode callers never pull in the Docker runtime.
 */
export function readSessionState(
  sessionName: string,
  env: NodeJS.ProcessEnv = process.env,
): WosState | null {
  try {
    const path = resolve(
      wosHome(env),
      SESSIONS_DIRNAME,
      sessionName,
      SESSION_STATE_FILENAME,
    );
    return JSON.parse(readFileSync(path, "utf8")) as WosState;
  } catch {
    return null;
  }
}

/**
 * Resolve which deployment backend owns a session. A resolved config (when
 * available) is authoritative; otherwise the persisted state's backend
 * discriminator is used, defaulting to `docker` for legacy state.
 */
export function selectBackendId(opts: {
  config?: WosConfig;
  state?: WosState | null;
}): DeploymentBackendId {
  if (opts.config) {
    return deploymentModeOf(opts.config) === "shell" ? "shell" : "docker";
  }
  if (opts.state) return stateBackend(opts.state);
  return "docker";
}

/** Resolve the backend for a session by reading its persisted state. */
export function selectBackendIdForSession(
  sessionName: string,
  env: NodeJS.ProcessEnv = process.env,
): DeploymentBackendId {
  const state = readSessionState(sessionName, env);
  return selectBackendId({ state });
}
