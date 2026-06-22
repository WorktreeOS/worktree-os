import {
  composeDown,
  composeExecArgs,
  composePs,
  composeStopService,
  composeUpService,
  defaultDockerRunner,
  type ComposeContext,
  type DockerRunner,
  type StreamingDockerRunner,
} from "@worktreeos/compose/compose";
import {
  buildComposeCommandEnvironment,
  type ComposeTunnelHostnames,
  type ComposeTunnelUrls,
} from "@worktreeos/compose/compose-env";
import { nullObserver, type DeploymentObserver } from "@worktreeos/core/events";
import { formatStatusTable } from "@worktreeos/ui/format";
import { INIT_SERVICE_NAME } from "@worktreeos/compose/generated-compose";
import { uniqueExposeServices } from "@worktreeos/compose/compose-mode";
import {
  isComposeMode,
  isShellMode,
  type ResolvedHealthcheckDefaults,
} from "@worktreeos/core/config";
import { stateFilePath, writeState } from "@worktreeos/core/state";
import {
  shellServiceStatuses,
  startShellServiceFromConfig,
  stopAllShellServices,
  stopOneShellService,
  type ShellProcessHost,
} from "./shell";
import {
  deployedAppServiceNames,
  runAppPortHealthchecks,
  waitingHealthcheckSnapshot,
  type AppPortHealthcheckResult,
  type HealthcheckHttpClient,
} from "./healthchecks";
import type { AvailabilityChecker } from "@worktreeos/compose/port-allocator";
import { parseComposePs, type ServiceStatus } from "@worktreeos/compose/ps";
import { runUpProgram, type TunnelPreparer } from "./up-program";
import type { ServiceSelectionInput } from "@worktreeos/compose/service-selection";
import type { RuntimeArgumentMap } from "@worktreeos/compose/runtime-arguments";
import type { SessionContext } from "@worktreeos/core/session-context";
import type { WosState } from "@worktreeos/core/state";
import type { PackageManagerCacheCommandRunner } from "./package-cache";

export { DeploymentCancelledError } from "./cancellation";

export interface UpOperationOptions {
  force?: boolean;
  /** Skip tunnel route registration for this operation. */
  noTunnel?: boolean;
  composeRunner?: DockerRunner;
  streamingRunner?: StreamingDockerRunner;
  isPortAvailable?: AvailabilityChecker;
  now?: () => Date;
  maxAttempts?: number;
  cacheRoot?: string;
  packageManagerCacheRunner?: PackageManagerCacheCommandRunner;
  healthcheckHttp?: HealthcheckHttpClient;
  healthcheckDefaults?: ResolvedHealthcheckDefaults;
  tunnelPreparer?: TunnelPreparer;
  /**
   * Daemon-owned mutable signal forwarded to `runUpProgram`. `composeStarted`
   * flips to `true` once `docker compose up` succeeds; daemon callers consult
   * it on throw to decide whether to unregister tunnel routes.
   */
  progress?: { composeStarted: boolean };
  /**
   * Optional selective generated-mode startup selection. Forwarded to
   * `runUpProgram`. `undefined` preserves the existing full-deployment
   * behavior; `services`/`target` are rejected for compose mode.
   */
  selection?: ServiceSelectionInput;
  /**
   * Submitted runtime argument values. Forwarded to `runUpProgram`.
   * Generated-compose mode only; compose mode rejects non-empty maps.
   */
  runtimeArguments?: RuntimeArgumentMap;
  /** Host-process boundary for shell mode (tests inject a fake). */
  shellProcessHost?: ShellProcessHost;
  /** Base environment inherited by shell service processes. */
  shellBaseEnv?: Record<string, string>;
  /** Optional LAN bind address for managed service publishing/advertising. */
  serviceBind?: string;
  /**
   * Commit (HEAD) captured by the daemon just before deploy. Forwarded to
   * `runUpProgram` and persisted as `lastUpCommit` on success.
   */
  deployCommit?: string;
  /**
   * Abort signal forwarded to `runUpProgram`. When fired (an explicit stop
   * request), the healthcheck wait loop exits immediately and the program
   * throws `DeploymentCancelledError` instead of running to its full timeout.
   */
  signal?: AbortSignal;
}

/**
 * Daemon-callable `up` operation. Accepts a resolved session context,
 * options, a stdout callback (for the final formatted status line), and a
 * deployment observer for streamed events. Does not write to CLI stderr on
 * normal failures — callers are responsible for translating errors into
 * client diagnostics or daemon responses.
 */
export async function runUpOperation(
  ctx: SessionContext,
  opts: UpOperationOptions,
  stdout: (text: string) => void,
  observer: DeploymentObserver = nullObserver,
): Promise<WosState> {
  return runUpProgram({
    worktreeRoot: ctx.worktreeRoot,
    config: ctx.config,
    source: ctx.source,
    projectName: ctx.projectName,
    force: opts.force,
    noTunnel: opts.noTunnel,
    composeRunner: opts.composeRunner,
    streamingRunner: opts.streamingRunner,
    isPortAvailable: opts.isPortAvailable,
    now: opts.now,
    maxAttempts: opts.maxAttempts,
    cacheRoot: opts.cacheRoot,
    packageManagerCacheRunner: opts.packageManagerCacheRunner,
    healthcheckHttp: opts.healthcheckHttp,
    healthcheckDefaults: opts.healthcheckDefaults,
    tunnelPreparer: opts.tunnelPreparer,
    progress: opts.progress,
    selection: opts.selection,
    runtimeArguments: opts.runtimeArguments,
    shellProcessHost: opts.shellProcessHost,
    shellBaseEnv: opts.shellBaseEnv,
    serviceBind: opts.serviceBind,
    deployCommit: opts.deployCommit,
    signal: opts.signal,
    stdout,
    observer,
  });
}

export type DownOutcome =
  | { kind: "no-deployment" }
  | { kind: "stopped" };

export interface DownOperationOptions {
  composeRunner?: DockerRunner;
  /** Host-process boundary for shell mode (tests inject a fake). */
  shellProcessHost?: ShellProcessHost;
}

function composeContextFromState(ctx: SessionContext): ComposeContext {
  const state = ctx.state!;
  return {
    projectName: state.projectName,
    composeFile: state.composeFile,
    composeFiles: state.composeFiles,
  };
}

/** Daemon-callable `down` operation. */
export async function runDownOperation(
  ctx: SessionContext,
  opts: DownOperationOptions = {},
): Promise<DownOutcome> {
  if (!ctx.state || !ctx.state.initialized) return { kind: "no-deployment" };
  if (isShellMode(ctx.config)) {
    await stopAllShellServices(ctx.state, { shellProcessHost: opts.shellProcessHost });
    // Clear the persisted shell service records. Unlike `docker compose down`,
    // stopping host processes leaves their state recorded, so a later status
    // snapshot would keep reporting them as `exited` — which classifies as
    // `failed` and would pin the worktree in the failed state forever. Dropping
    // the records yields a clean `stopped` (no managed services) instead.
    await writeState(stateFilePath(ctx.worktreeRoot), {
      ...ctx.state,
      shell: { services: {} },
    });
    return { kind: "stopped" };
  }
  const composeRunner = opts.composeRunner ?? defaultDockerRunner;
  const env = await composeCommandEnvForCtx(ctx);
  await composeDown(
    composeContextFromState(ctx),
    { removeOrphans: true },
    composeRunner,
    env ? { env } : undefined,
  );
  return { kind: "stopped" };
}

export class ServiceOperationError extends Error {
  readonly code:
    | "no-deployment"
    | "invalid-service"
    | "internal-service"
    | "unexposed-service"
    | "unsupported-mode"
    | "invalid-command";
  constructor(
    code:
      | "no-deployment"
      | "invalid-service"
      | "internal-service"
      | "unexposed-service"
      | "unsupported-mode"
      | "invalid-command",
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

export interface ServiceOperationOptions {
  composeRunner?: DockerRunner;
  /**
   * Tunnel hostnames for compose-mode expose template resolution and for
   * shell-mode `WOS_SERVICE_HOSTNAME` resolution on restart.
   */
  tunnelHostnames?: ComposeTunnelHostnames;
  /**
   * Tunnel URLs for compose-mode and shell-mode `${...url[<port>]}` template
   * resolution on restart.
   */
  tunnelUrls?: ComposeTunnelUrls;
  /** Host-process boundary for shell mode (tests inject a fake). */
  shellProcessHost?: ShellProcessHost;
}

function requireInitializedShellService(
  ctx: SessionContext,
  service: string,
): void {
  if (typeof service !== "string" || service.trim().length === 0) {
    throw new ServiceOperationError("invalid-service", "service name is required");
  }
  if (!ctx.state || !ctx.state.initialized) {
    throw new ServiceOperationError(
      "no-deployment",
      "no wos deployment has been initialized for the current worktree",
    );
  }
  const known =
    service in ctx.config.app.services ||
    ctx.state.shell?.services[service] !== undefined;
  if (!known) {
    throw new ServiceOperationError(
      "invalid-service",
      `service "${service}" is not managed by the shell-mode session`,
    );
  }
}

function requireInitializedService(
  ctx: SessionContext,
  service: string,
): ComposeContext {
  if (typeof service !== "string" || service.trim().length === 0) {
    throw new ServiceOperationError(
      "invalid-service",
      "service name is required",
    );
  }
  if (service === INIT_SERVICE_NAME) {
    throw new ServiceOperationError(
      "internal-service",
      `service ${INIT_SERVICE_NAME} is internal and cannot be controlled directly`,
    );
  }
  if (!ctx.state || !ctx.state.initialized) {
    throw new ServiceOperationError(
      "no-deployment",
      "no wos deployment has been initialized for the current worktree",
    );
  }
  if (isComposeMode(ctx.config)) {
    const exposed = uniqueExposeServices(ctx.config.compose.expose);
    if (!exposed.includes(service)) {
      throw new ServiceOperationError(
        "unexposed-service",
        `service "${service}" is not listed in compose.expose; only exposed services can be controlled by wos`,
      );
    }
  }
  return composeContextFromState(ctx);
}

async function composeCommandEnvForCtx(
  ctx: SessionContext,
  tunnelHostnames?: ComposeTunnelHostnames,
  tunnelUrls?: ComposeTunnelUrls,
): Promise<Record<string, string> | undefined> {
  if (!isComposeMode(ctx.config)) return undefined;
  return await buildComposeCommandEnvironment({
    config: ctx.config.compose,
    worktreeRoot: ctx.worktreeRoot,
    assignments: ctx.state?.portAssignments,
    tunnelHostnames,
    tunnelUrls,
  });
}

/** Daemon-callable service stop operation. */
export async function runServiceStopOperation(
  ctx: SessionContext,
  service: string,
  opts: ServiceOperationOptions = {},
): Promise<void> {
  if (isShellMode(ctx.config)) {
    requireInitializedShellService(ctx, service);
    await stopOneShellService(ctx.state!, service, {
      shellProcessHost: opts.shellProcessHost,
    });
    return;
  }
  const composeCtx = requireInitializedService(ctx, service);
  const composeRunner = opts.composeRunner ?? defaultDockerRunner;
  const env = await composeCommandEnvForCtx(ctx, opts.tunnelHostnames, opts.tunnelUrls);
  await composeStopService(composeCtx, service, composeRunner, env ? { env } : undefined);
}

/** Daemon-callable service restart operation: removes the existing container and brings it back up. */
export async function runServiceRestartOperation(
  ctx: SessionContext,
  service: string,
  opts: ServiceOperationOptions = {},
): Promise<void> {
  if (isShellMode(ctx.config)) {
    requireInitializedShellService(ctx, service);
    const state = ctx.state!;
    if (state.shell?.services[service]) {
      await stopOneShellService(state, service, {
        shellProcessHost: opts.shellProcessHost,
      });
    }
    const meta = await startShellServiceFromConfig({
      config: ctx.config,
      service,
      worktreeRoot: ctx.worktreeRoot,
      assignments: state.portAssignments ?? {},
      tunnelHostnames: opts.tunnelHostnames,
      tunnelUrls: opts.tunnelUrls,
      runtimeArguments: state.shell?.runtimeArguments,
      host: opts.shellProcessHost,
    });
    const services = { ...(state.shell?.services ?? {}), [service]: meta };
    await writeState(stateFilePath(ctx.worktreeRoot), {
      ...state,
      backend: "shell",
      mode: "shell",
      shell: {
        services,
        ...(state.shell?.runtimeArguments
          ? { runtimeArguments: state.shell.runtimeArguments }
          : {}),
      },
    });
    return;
  }
  const composeCtx = requireInitializedService(ctx, service);
  const composeRunner = opts.composeRunner ?? defaultDockerRunner;
  const env = await composeCommandEnvForCtx(ctx, opts.tunnelHostnames, opts.tunnelUrls);
  await composeUpService(composeCtx, service, composeRunner, env ? { env } : undefined);
}

/**
 * A spawnable Docker Compose exec command resolved from persisted session
 * state. The terminal layer spawns `program` with `args`; when `env` is set it
 * carries the resolved Compose command environment (compose mode only) and
 * replaces the inherited environment for the spawned process.
 */
export interface ServiceExecCommand {
  program: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ServiceExecOptions {
  /** Tunnel hostnames for compose-mode expose template resolution. */
  tunnelHostnames?: ComposeTunnelHostnames;
  /** Tunnel URLs for compose-mode `${...url[<port>]}` template resolution. */
  tunnelUrls?: ComposeTunnelUrls;
}

/**
 * Build the Docker Compose exec command for running `command` inside `service`
 * for the current worktree. Validates the target against the initialized
 * deployment using the same boundary as service stop/restart, rejects
 * shell-mode deployments as unsupported, and never spawns anything — it only
 * constructs the command so the terminal layer can own the interactive PTY.
 */
export async function buildServiceExecCommand(
  ctx: SessionContext,
  service: string,
  command: string[],
  opts: ServiceExecOptions = {},
): Promise<ServiceExecCommand> {
  if (isShellMode(ctx.config)) {
    throw new ServiceOperationError(
      "unsupported-mode",
      "exec is not supported for shell-mode deployments",
    );
  }
  if (!Array.isArray(command) || command.length === 0) {
    throw new ServiceOperationError(
      "invalid-command",
      "a command is required",
    );
  }
  const composeCtx = requireInitializedService(ctx, service);
  const env = await composeCommandEnvForCtx(
    ctx,
    opts.tunnelHostnames,
    opts.tunnelUrls,
  );
  return {
    program: "docker",
    args: composeExecArgs(composeCtx, service, command),
    ...(env ? { env } : {}),
  };
}

export type StatusOutcome =
  | { kind: "no-deployment" }
  | {
      kind: "ok";
      services: ServiceStatus[];
      state: WosState;
      appPortHealthchecks: AppPortHealthcheckResult[];
    };

export interface StatusOperationOptions {
  composeRunner?: DockerRunner;
  healthcheckHttp?: HealthcheckHttpClient;
  healthcheckDefaults?: ResolvedHealthcheckDefaults;
  /**
   * Skip running real HTTP healthchecks and instead report enabled app ports
   * as `waiting`. Used by the daemon while an `up` operation is still polling
   * its own healthchecks so clients can see the in-progress state.
   */
  reportHealthchecksAsWaiting?: boolean;
  /** Tunnel hostnames for compose-mode expose template resolution. */
  tunnelHostnames?: ComposeTunnelHostnames;
  /** Tunnel URLs for compose-mode `${expose.<service>.url[<port>]}` resolution. */
  tunnelUrls?: ComposeTunnelUrls;
  /** Host-process boundary for shell mode (tests inject a fake). */
  shellProcessHost?: ShellProcessHost;
  /**
   * Pre-collected managed service list. When provided (including an empty
   * array), the operation uses it instead of running `docker compose ps`. The
   * daemon supplies this from its Docker state cache; the list is already
   * scoped to managed services for the session's mode (init excluded, and in
   * compose mode only `compose.expose` services). App-port healthchecks scope
   * to whichever services this list contains.
   */
  serviceSnapshot?: ServiceStatus[];
}

/** Daemon-callable `status` operation. */
export async function runStatusOperation(
  ctx: SessionContext,
  opts: StatusOperationOptions = {},
): Promise<StatusOutcome> {
  if (!ctx.state || !ctx.state.initialized) return { kind: "no-deployment" };
  if (isShellMode(ctx.config)) {
    const services = shellServiceStatuses(ctx.state, opts.shellProcessHost);
    const deployedServices = deployedAppServiceNames(services);
    const appPortHealthchecks = opts.reportHealthchecksAsWaiting
      ? waitingHealthcheckSnapshot(
          ctx.config,
          services,
          opts.healthcheckDefaults,
          deployedServices,
        )
      : await runAppPortHealthchecks({
          config: ctx.config,
          services,
          http: opts.healthcheckHttp,
          defaults: opts.healthcheckDefaults,
          selectedServices: deployedServices,
        });
    return { kind: "ok", services, state: ctx.state, appPortHealthchecks };
  }
  let services: ServiceStatus[];
  if (opts.serviceSnapshot !== undefined) {
    // Docker cache snapshot is already scoped to managed services for the
    // session's mode, so no compose ps / init / expose filtering is needed.
    services = opts.serviceSnapshot;
  } else {
    const composeRunner = opts.composeRunner ?? defaultDockerRunner;
    const env = await composeCommandEnvForCtx(ctx, opts.tunnelHostnames, opts.tunnelUrls);
    const psOutput = await composePs(
      composeContextFromState(ctx),
      composeRunner,
      env ? { env } : undefined,
    );
    services = parseComposePs(psOutput).filter(
      (s) => s.service !== INIT_SERVICE_NAME,
    );
    if (isComposeMode(ctx.config)) {
      const exposeSet = new Set(uniqueExposeServices(ctx.config.compose.expose));
      services = services.filter((s) => exposeSet.has(s.service));
    }
  }
  let appPortHealthchecks: AppPortHealthcheckResult[];
  if (isComposeMode(ctx.config)) {
    appPortHealthchecks = [];
  } else {
    const deployedServices = deployedAppServiceNames(services);
    appPortHealthchecks = opts.reportHealthchecksAsWaiting
      ? waitingHealthcheckSnapshot(
          ctx.config,
          services,
          opts.healthcheckDefaults,
          deployedServices,
        )
      : await runAppPortHealthchecks({
          config: ctx.config,
          services,
          http: opts.healthcheckHttp,
          defaults: opts.healthcheckDefaults,
          selectedServices: deployedServices,
        });
  }
  return { kind: "ok", services, state: ctx.state, appPortHealthchecks };
}

/** Compatibility helper for plain-text status output. */
export function formatStatusOutcome(
  outcome: StatusOutcome,
  opts: { hyperlinks?: boolean } = {},
): string {
  if (outcome.kind === "no-deployment") {
    return "no wos deployment has been initialized for the current worktree\n";
  }
  return (
    formatStatusTable(outcome.services, outcome.appPortHealthchecks, [], {
      hyperlinks: opts.hyperlinks,
    }) + "\n"
  );
}

/** Compatibility helper for plain-text down output. */
export function formatDownOutcome(outcome: DownOutcome): string {
  if (outcome.kind === "no-deployment") {
    return "no wos deployment has been initialized for the current worktree\n";
  }
  return "";
}
