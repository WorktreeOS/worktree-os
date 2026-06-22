import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  wosHome,
  SESSIONS_DIRNAME,
  SESSION_STATE_FILENAME,
} from "@worktreeos/core/paths";
import { readState, type WosState } from "@worktreeos/core/state";
import {
  isComposeMode,
  loadConfig,
  type WosConfig,
  type ResolvedHealthcheckDefaults,
} from "@worktreeos/core/config";
import {
  defaultWorktreeGitRunner,
  type WorktreeGitRunner,
} from "@worktreeos/core/git";
import { resolveSourcePathFromState } from "@worktreeos/core/project-discovery";
import type { TunnelRegistry } from "@worktreeos/runtime/tunnel-registry";
import type { SessionMonitorRegistry, SnapshotCollector } from "./session-monitor";
import { createRuntimeCollector } from "./session-monitor-runtime";
import type { DockerStateStore } from "./docker/docker-state-store";
import type { ServiceStreamContext } from "./daemon-sessions";
import {
  composePs,
  defaultDockerRunner,
  type ComposeContext,
  type DockerRunner,
} from "@worktreeos/compose/compose";
import { buildComposeCommandEnvironment } from "@worktreeos/compose/compose-env";
import { parseComposePs } from "@worktreeos/compose/ps";
import { INIT_SERVICE_NAME } from "@worktreeos/compose/generated-compose";
import { uniqueExposeServices } from "@worktreeos/compose/compose-mode";

export interface MonitorRestorationOptions {
  env?: NodeJS.ProcessEnv;
  sessionsDir?: string;
  /** Override the state reader for tests. */
  readStateFn?: typeof readState;
  /**
   * Optional override that resolves a runtime config for a session. Receives
   * the resolved source/primary worktree path and the session's current
   * worktree root so it can select the effective `.wos/deploy*.yaml` file.
   * Defaults to `loadConfig(sourcePath, worktreeRoot)`.
   */
  loadConfigFn?: (sourcePath: string, worktreeRoot: string) => Promise<unknown>;
  /** Override the git runner used to look up the source worktree from state. */
  gitRunner?: WorktreeGitRunner;
  /** Override the logger sink (tests). */
  warn?: (msg: string) => void;
  /** Effective healthcheck timing defaults (from global config.json). */
  healthcheckDefaults?: ResolvedHealthcheckDefaults;
  /**
   * Daemon Docker state cache. Forwarded to each restored monitor's runtime
   * collector so restored monitors read managed service state from the cache
   * instead of enumerating services via `docker compose ps`.
   */
  dockerState?: DockerStateStore;
  /**
   * Backend-aware collector factory. When provided, the daemon selects the
   * deployment backend (Docker vs shell) for each restored session and builds
   * the matching snapshot collector. When omitted, the Docker runtime
   * collector is used (backwards-compatible default for existing callers).
   */
  createCollector?: (args: {
    sessionName: string;
    state: WosState;
    config: WosConfig;
    worktreeRoot: string;
  }) => SnapshotCollector;
}

export interface MonitorRestorationResult {
  restored: number;
  skipped: number;
}

/**
 * Scan `<wos-home>/sessions/*` for initialized wos deployments and
 * register a runtime collector with the session monitor registry for each
 * resolvable session. Sessions whose state file is missing, unparseable, or
 * whose worktree config cannot be loaded are skipped without failing daemon
 * startup.
 *
 * Service log followers are NOT spawned here. After change
 * `make-service-logs-on-demand`, service log streams start only when a client
 * subscribes to a `service:<name>` channel.
 */
export async function restoreMonitorsFromSessions(
  monitors: SessionMonitorRegistry,
  tunnels: TunnelRegistry,
  opts: MonitorRestorationOptions = {},
): Promise<MonitorRestorationResult> {
  const env = opts.env ?? process.env;
  const sessionsDir =
    opts.sessionsDir ?? resolve(wosHome(env), SESSIONS_DIRNAME);
  const readStateFn = opts.readStateFn ?? readState;
  const loadConfigFn =
    opts.loadConfigFn ??
    (loadConfig as (sourcePath: string, worktreeRoot: string) => Promise<unknown>);
  const gitRunner = opts.gitRunner ?? defaultWorktreeGitRunner;
  const warn = opts.warn;

  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return { restored: 0, skipped: 0 };
  }

  let restored = 0;
  let skipped = 0;
  for (const name of entries) {
    const sessionRoot = resolve(sessionsDir, name);
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(sessionRoot);
    } catch {
      skipped += 1;
      continue;
    }
    if (!st.isDirectory()) {
      skipped += 1;
      continue;
    }
    let state: WosState | null = null;
    try {
      state = await readStateFn(resolve(sessionRoot, SESSION_STATE_FILENAME));
    } catch {
      state = null;
    }
    if (
      !state ||
      !state.initialized ||
      typeof state.projectName !== "string" ||
      typeof state.composeFile !== "string" ||
      typeof state.worktreeRoot !== "string"
    ) {
      skipped += 1;
      continue;
    }
    const worktreeRoot = state.worktreeRoot;
    let sourcePath: string | null;
    try {
      sourcePath = await resolveSourcePathFromState(state, gitRunner);
    } catch {
      sourcePath = null;
    }
    if (!sourcePath) {
      warn?.(
        `wos daemon: skipping monitor for ${name}: cannot resolve source worktree for ${worktreeRoot}`,
      );
      skipped += 1;
      continue;
    }
    let config: any;
    try {
      config = await loadConfigFn(sourcePath, worktreeRoot);
    } catch (e) {
      warn?.(
        `wos daemon: skipping monitor for ${name}: ${(e as Error).message}`,
      );
      skipped += 1;
      continue;
    }
    try {
      const collector = opts.createCollector
        ? opts.createCollector({ sessionName: name, state, config, worktreeRoot })
        : createRuntimeCollector({
            sessionName: name,
            composeContext: {
              projectName: state.projectName,
              composeFile: state.composeFile,
              composeFiles: state.composeFiles,
            },
            config,
            tunnels,
            worktreeRoot,
            portAssignments: state.portAssignments,
            healthcheckDefaults: opts.healthcheckDefaults,
            dockerState: opts.dockerState,
          });
      monitors.start(name, collector, worktreeRoot);
      restored += 1;
    } catch (e) {
      warn?.(
        `wos daemon: failed to restore monitor for ${name}: ${(e as Error).message}`,
      );
      skipped += 1;
      continue;
    }
  }
  return { restored, skipped };
}

/**
 * Build a `ServiceStreamContext` for a session by reading its persisted state
 * and (when compose mode is active) inspecting `docker compose ps` for the
 * aggregate service list. Used by the daemon as the on-demand resolver so the
 * service log stream registry can spawn followers when a client subscribes.
 *
 * Returns `null` when the session state cannot be resolved. Errors enumerating
 * Docker services degrade to an empty `aggregateServices` list — single
 * `service:<name>` subscriptions still work because the spawn does not need
 * the aggregate list.
 */
export async function resolveSessionServiceStreamContext(opts: {
  sessionName: string;
  dockerRunner?: DockerRunner;
  warn?: (msg: string) => void;
  gitRunner?: WorktreeGitRunner;
  env?: NodeJS.ProcessEnv;
}): Promise<ServiceStreamContext | null> {
  const dockerRunner = opts.dockerRunner ?? defaultDockerRunner;
  const gitRunner = opts.gitRunner ?? defaultWorktreeGitRunner;
  const env = opts.env ?? process.env;
  const statePath = resolve(
    wosHome(env),
    SESSIONS_DIRNAME,
    opts.sessionName,
    SESSION_STATE_FILENAME,
  );
  let state: WosState | null;
  try {
    state = await readState(statePath);
  } catch {
    return null;
  }
  if (
    !state ||
    !state.initialized ||
    typeof state.projectName !== "string" ||
    typeof state.composeFile !== "string"
  ) {
    return null;
  }
  let config: WosConfig | undefined;
  if (typeof state.worktreeRoot === "string") {
    try {
      const sourcePath = await resolveSourcePathFromState(state, gitRunner);
      if (sourcePath) {
        config = (await loadConfig(sourcePath, state.worktreeRoot)) as WosConfig;
      }
    } catch {
      config = undefined;
    }
  }
  const ctx: ComposeContext = {
    projectName: state.projectName,
    composeFile: state.composeFile,
    composeFiles: state.composeFiles,
  };
  const composeModeActive = config !== undefined && isComposeMode(config);
  const composeEnv =
    composeModeActive && state.worktreeRoot && config && isComposeMode(config)
      ? await buildComposeCommandEnvironment({
          config: config.compose,
          worktreeRoot: state.worktreeRoot,
          assignments: state.portAssignments,
        }).catch(() => undefined)
      : undefined;

  let aggregateServices: string[] = [];
  try {
    const stdout = await composePs(
      ctx,
      dockerRunner,
      composeEnv ? { env: composeEnv } : undefined,
    );
    aggregateServices = parseComposePs(stdout)
      .filter((s) => s.service && s.service !== INIT_SERVICE_NAME)
      .map((s) => s.service);
  } catch (e) {
    opts.warn?.(
      `wos daemon: failed to enumerate services for ${opts.sessionName}: ${(e as Error).message}`,
    );
  }

  let allowedServices: string[] | undefined;
  if (composeModeActive && config && isComposeMode(config)) {
    allowedServices = uniqueExposeServices(config.compose.expose);
    aggregateServices = aggregateServices.filter((s) =>
      allowedServices!.includes(s),
    );
  }

  return {
    ctx,
    env: composeEnv,
    allowedServices,
    aggregateServices,
  };
}
