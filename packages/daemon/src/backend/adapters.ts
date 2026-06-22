import type { ComposeContext, DockerRunner } from "@worktreeos/compose/compose";
import type { ServiceStatus } from "@worktreeos/compose/ps";
import type {
  ResolvedHealthcheckDefaults,
  WosConfig,
} from "@worktreeos/core/config";
import type { PortAssignments, WosState } from "@worktreeos/core/state";
import type { HealthcheckHttpClient } from "@worktreeos/runtime/healthchecks";
import type { TunnelRegistry } from "@worktreeos/runtime/tunnel-registry";
import type { FollowerStarter, ServiceStreamContext } from "../daemon-sessions";
import type { SnapshotCollector } from "../session-monitor";
import {
  createRuntimeCollector,
  createShellCollector,
} from "../session-monitor-runtime";
import { cachedSessionServicesOrNull } from "../docker/docker-cache-adapter";
import { createDockerLogFollowerStarter } from "../docker/docker-log-follower";
import { DockerClient } from "../docker/docker-client";
import type { DockerStateStore } from "../docker/docker-state-store";
import { resolveSessionServiceStreamContext } from "../monitor-restoration";
import { shellServiceStatuses } from "@worktreeos/runtime/shell";
import { createShellFollowerStarter } from "./shell-log-follower";
import {
  readSessionState,
  selectBackendId,
  selectBackendIdForSession,
  type DeploymentBackendId,
} from "./backend-selection";

export type { DeploymentBackendId };

/**
 * Per-session context passed to {@link DeploymentBackendAdapter.createMonitorCollector}.
 * Carries both Docker-relevant fields (compose context, port assignments) and
 * shell-relevant fields; each backend reads only what it needs.
 */
export interface BackendSessionContext {
  sessionName: string;
  config: WosConfig;
  tunnels: TunnelRegistry;
  worktreeRoot?: string;
  composeContext?: ComposeContext;
  portAssignments?: PortAssignments;
  healthcheckHttp?: HealthcheckHttpClient;
  healthcheckDefaults?: ResolvedHealthcheckDefaults;
  env?: NodeJS.ProcessEnv;
}

/**
 * Runtime-neutral deployment backend boundary. The daemon routes log
 * following, monitoring, status snapshots, and service-stream enumeration
 * through the adapter selected for a session, so shell-mode sessions never
 * touch Docker and Docker-backed sessions keep all Docker access encapsulated
 * inside the Docker adapter.
 */
export interface DeploymentBackendAdapter {
  readonly id: DeploymentBackendId;
  /** On-demand service-log follower starter for this backend. */
  readonly followerStarter: FollowerStarter;
  /** Build a monitor snapshot collector for a session. */
  createMonitorCollector(ctx: BackendSessionContext): SnapshotCollector;
  /** Resolve the log-stream context (service enumeration) for a session. */
  resolveStreamContext(sessionName: string): Promise<ServiceStreamContext | null>;
  /**
   * Best-effort runtime-neutral service snapshot for status. `undefined` when
   * the backend cannot observe yet (e.g. the Docker cache has not synced).
   */
  collectServiceSnapshot(
    sessionName: string,
  ): ServiceStatus[] | undefined | Promise<ServiceStatus[] | undefined>;
}

export interface DockerBackendDeps {
  dockerState: DockerStateStore;
  client?: DockerClient;
  dockerRunner?: DockerRunner;
  /** Test/override seam for the log follower starter. */
  followerStarter?: FollowerStarter;
  warn?: (msg: string) => void;
}

export function createDockerBackendAdapter(
  deps: DockerBackendDeps,
): DeploymentBackendAdapter {
  const followerStarter =
    deps.followerStarter ??
    createDockerLogFollowerStarter({
      client: deps.client ?? new DockerClient(),
      store: deps.dockerState,
    });
  return {
    id: "docker",
    followerStarter,
    createMonitorCollector(ctx) {
      return createRuntimeCollector({
        sessionName: ctx.sessionName,
        composeContext:
          ctx.composeContext ?? { projectName: "", composeFile: "" },
        config: ctx.config,
        tunnels: ctx.tunnels,
        worktreeRoot: ctx.worktreeRoot,
        portAssignments: ctx.portAssignments,
        healthcheckHttp: ctx.healthcheckHttp,
        healthcheckDefaults: ctx.healthcheckDefaults,
        dockerState: deps.dockerState,
      });
    },
    resolveStreamContext(sessionName) {
      return resolveSessionServiceStreamContext({
        sessionName,
        dockerRunner: deps.dockerRunner,
        warn: deps.warn,
      });
    },
    collectServiceSnapshot(sessionName) {
      return cachedSessionServicesOrNull(deps.dockerState, sessionName);
    },
  };
}

export interface ShellBackendDeps {
  env?: NodeJS.ProcessEnv;
  pollMs?: number;
}

export function createShellBackendAdapter(
  deps: ShellBackendDeps = {},
): DeploymentBackendAdapter {
  const followerStarter = createShellFollowerStarter({
    env: deps.env,
    pollMs: deps.pollMs,
  });
  return {
    id: "shell",
    followerStarter,
    createMonitorCollector(ctx) {
      return createShellCollector({
        sessionName: ctx.sessionName,
        config: ctx.config,
        tunnels: ctx.tunnels,
        healthcheckHttp: ctx.healthcheckHttp,
        healthcheckDefaults: ctx.healthcheckDefaults,
        env: deps.env,
      });
    },
    resolveStreamContext(sessionName) {
      return resolveShellStreamContext(sessionName, deps.env);
    },
    collectServiceSnapshot(sessionName) {
      const state = readSessionState(sessionName, deps.env);
      return state?.shell ? shellServiceStatuses(state) : undefined;
    },
  };
}

/**
 * Build a `ServiceStreamContext` for a shell-mode session by enumerating the
 * managed shell services from persisted state. The compose context is a stub
 * (shell followers ignore it); `allowedServices` and `aggregateServices` are
 * the recorded shell services so log streams only open for managed services.
 */
export async function resolveShellStreamContext(
  sessionName: string,
  env?: NodeJS.ProcessEnv,
): Promise<ServiceStreamContext | null> {
  const state = readSessionState(sessionName, env);
  if (!state?.shell) return null;
  const services = Object.keys(state.shell.services);
  return {
    ctx: { projectName: state.projectName, composeFile: state.composeFile },
    allowedServices: services,
    aggregateServices: services,
  };
}

export interface BackendRegistry {
  readonly docker: DeploymentBackendAdapter;
  readonly shell: DeploymentBackendAdapter;
  /** Select the adapter for a session, preferring a resolved config. */
  forSession(sessionName: string, config?: WosConfig): DeploymentBackendAdapter;
  /** Select the adapter for an already-resolved config or state. */
  select(opts: { config?: WosConfig; state?: WosState | null }): DeploymentBackendAdapter;
}

export function createBackendRegistry(deps: {
  docker: DockerBackendDeps;
  shell?: ShellBackendDeps;
  env?: NodeJS.ProcessEnv;
}): BackendRegistry {
  const docker = createDockerBackendAdapter(deps.docker);
  const shell = createShellBackendAdapter({ env: deps.env, ...deps.shell });
  const pick = (id: DeploymentBackendId): DeploymentBackendAdapter =>
    id === "shell" ? shell : docker;
  return {
    docker,
    shell,
    forSession(sessionName, config) {
      const id = config
        ? selectBackendId({ config })
        : selectBackendIdForSession(sessionName, deps.env);
      return pick(id);
    },
    select(opts) {
      return pick(selectBackendId(opts));
    },
  };
}
