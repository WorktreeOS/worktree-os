import type { MonitorSnapshot, SnapshotCollector } from "./session-monitor";
import {
  composePs,
  defaultDockerRunner,
  type ComposeContext,
  type DockerRunner,
} from "@worktreeos/compose/compose";
import { buildComposeCommandEnvironment } from "@worktreeos/compose/compose-env";
import { INIT_SERVICE_NAME } from "@worktreeos/compose/generated-compose";
import { uniqueExposeServices } from "@worktreeos/compose/compose-mode";
import { parseComposePs, type ServiceStatus } from "@worktreeos/compose/ps";
import { cachedSessionServicesOrNull } from "./docker/docker-cache-adapter";
import type { DockerStateStore } from "./docker/docker-state-store";
import {
  deployedAppServiceNames,
  runAppPortHealthchecks,
  type HealthcheckHttpClient,
} from "@worktreeos/runtime/healthchecks";
import { shellServiceStatuses } from "@worktreeos/runtime/shell";
import { readSessionState } from "./backend/backend-selection";
import type { TunnelRegistry } from "@worktreeos/runtime/tunnel-registry";
import {
  isComposeMode,
  type WosConfig,
  type ResolvedHealthcheckDefaults,
} from "@worktreeos/core/config";
import type { PortAssignments } from "@worktreeos/core/state";

export interface RuntimeCollectorOptions {
  sessionName: string;
  composeContext: ComposeContext;
  config: WosConfig;
  tunnels: TunnelRegistry;
  dockerRunner?: DockerRunner;
  /**
   * Daemon Docker state cache. When provided and synced, the collector reads
   * managed service state from the cache instead of `docker compose ps`. When
   * omitted or not yet synced, it falls back to the Compose status path.
   */
  dockerState?: DockerStateStore;
  healthcheckHttp?: HealthcheckHttpClient;
  healthcheckDefaults?: ResolvedHealthcheckDefaults;
  /**
   * Worktree root used to resolve `compose.env_file` paths when the session
   * runs in compose mode. Optional for backwards compatibility: when omitted
   * in compose mode, env files are not loaded.
   */
  worktreeRoot?: string;
  /**
   * Persisted port assignments for compose-mode expose template resolution.
   * When omitted, inline templates pass through unresolved (best-effort).
   */
  portAssignments?: PortAssignments;
}

/**
 * Build a snapshot collector that pulls `docker compose ps`, runs app-port
 * healthchecks (generated mode only), and reads the tunnel registry. Errors
 * raised during any single collection step propagate so the monitor can
 * decide to skip the tick; partial snapshots are not returned.
 */
export function createRuntimeCollector(
  opts: RuntimeCollectorOptions,
): SnapshotCollector {
  const dockerRunner = opts.dockerRunner ?? defaultDockerRunner;
  return {
    async collect(): Promise<MonitorSnapshot> {
      const composeModeActive = isComposeMode(opts.config);
      const tunnelHostnames = opts.tunnels.hostnameMap(opts.sessionName);
      const tunnelUrls = opts.tunnels.urlMap(opts.sessionName);
      // Prefer the daemon Docker state cache when it is available and synced.
      // The cache is already scoped to managed services for the session's mode
      // (init excluded, compose mode only labels `compose.expose` services), so
      // app-port healthchecks below scope to exactly the deployed services.
      let services: ServiceStatus[] | undefined = cachedSessionServicesOrNull(
        opts.dockerState,
        opts.sessionName,
      );
      if (services === undefined) {
        const env =
          composeModeActive && opts.worktreeRoot && isComposeMode(opts.config)
            ? await buildComposeCommandEnvironment({
                config: opts.config.compose,
                worktreeRoot: opts.worktreeRoot,
                assignments: opts.portAssignments,
                tunnelHostnames,
                tunnelUrls,
              }).catch(() => undefined)
            : undefined;
        const psOut = await composePs(
          opts.composeContext,
          dockerRunner,
          env ? { env } : undefined,
        );
        services = parseComposePs(psOut).filter(
          (s) => s.service !== INIT_SERVICE_NAME,
        );
        if (composeModeActive && isComposeMode(opts.config)) {
          const exposeSet = new Set(
            uniqueExposeServices(opts.config.compose.expose),
          );
          services = services.filter((s) => exposeSet.has(s.service));
        }
      }
      const healthchecks = composeModeActive
        ? []
        : await runAppPortHealthchecks({
            config: opts.config,
            services,
            http: opts.healthcheckHttp,
            defaults: opts.healthcheckDefaults,
            mode: "single",
            selectedServices: deployedAppServiceNames(services),
          });
      return {
        compose: services.map((s) => ({
          service: s.service,
          state: s.state,
          status: s.status,
        })),
        healthchecks: healthchecks.map((h) => ({
          service: h.service,
          containerPort: h.containerPort,
          state: h.state,
          observedStatus: h.observedStatus,
          expectedStatus: h.expectedStatus,
          url: h.url,
          message: h.message,
        })),
        tunnels: opts.tunnels.snapshot(opts.sessionName),
      };
    },
  };
}

export interface ShellCollectorOptions {
  sessionName: string;
  config: WosConfig;
  tunnels: TunnelRegistry;
  healthcheckHttp?: HealthcheckHttpClient;
  healthcheckDefaults?: ResolvedHealthcheckDefaults;
  /** Environment used to resolve the session state path (tests). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Build a snapshot collector for a shell-mode session. Reads managed service
 * state from persisted shell process metadata (no Docker), runs app-port
 * healthchecks against the assigned host ports, and reads the tunnel registry.
 */
export function createShellCollector(
  opts: ShellCollectorOptions,
): SnapshotCollector {
  return {
    async collect(): Promise<MonitorSnapshot> {
      const state = readSessionState(opts.sessionName, opts.env);
      const services: ServiceStatus[] = state?.shell
        ? shellServiceStatuses(state)
        : [];
      const healthchecks = await runAppPortHealthchecks({
        config: opts.config,
        services,
        http: opts.healthcheckHttp,
        defaults: opts.healthcheckDefaults,
        mode: "single",
        selectedServices: deployedAppServiceNames(services),
      });
      return {
        compose: services.map((s) => ({
          service: s.service,
          state: s.state,
          status: s.status,
        })),
        healthchecks: healthchecks.map((h) => ({
          service: h.service,
          containerPort: h.containerPort,
          state: h.state,
          observedStatus: h.observedStatus,
          expectedStatus: h.expectedStatus,
          url: h.url,
          message: h.message,
        })),
        tunnels: opts.tunnels.snapshot(opts.sessionName),
      };
    },
  };
}
