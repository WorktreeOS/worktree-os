import {
  isComposeMode,
  isShellMode,
  type ComposeModeConfig,
  type WosConfig,
  type ResolvedHealthcheckDefaults,
} from "@worktreeos/core/config";
import { runShellUpProgram, type ShellProcessHost } from "./shell";
import {
  resolveServiceSelection,
  ServiceSelectionError,
  type ResolvedServiceSelection,
  type ServiceSelectionInput,
} from "@worktreeos/compose/service-selection";
import {
  validateRuntimeArguments,
  RuntimeArgumentError,
  type RuntimeArgumentMap,
} from "@worktreeos/compose/runtime-arguments";
import { resolveWorkingDir } from "@worktreeos/compose/generated-compose";
import { isSourceWorktree, type WorktreeEntry } from "@worktreeos/core/git";
import {
  readState,
  stateFilePath,
  writeState,
  type WosState,
  type PortAssignments,
} from "@worktreeos/core/state";
import { generateDeploymentId } from "@worktreeos/core/tunnel-metadata";
import {
  firstRunSetup,
  forceRemoveCloneVolumes,
  runContainerInit,
} from "./setup";
import {
  INIT_SERVICE_NAME,
  writeGeneratedCompose,
} from "@worktreeos/compose/generated-compose";
import { buildComposeCommandEnvironment } from "@worktreeos/compose/compose-env";
import {
  collectComposeExposeBindings,
  resolveComposeConfigPath,
  uniqueExposeServices,
  writeComposeOverlay,
  writeSanitizedComposeBase,
} from "@worktreeos/compose/compose-mode";
import {
  resolvePackageManagerCacheMounts,
  type PackageManagerCacheCommandRunner,
  type PackageManagerCacheMount,
} from "./package-cache";
import {
  ComposeError,
  composeDownStreamed,
  composePsStreamed,
  composeUpStreamed,
  defaultDockerRunner,
  defaultStreamingDockerRunner,
  extractPortNumbers,
  isPortConflictStderr,
  type ComposeContext,
  type DockerRunner,
  type DockerResult,
  type StreamingDockerRunner,
} from "@worktreeos/compose/compose";
import { parseComposePs } from "@worktreeos/compose/ps";
import { formatHealthchecks, formatStatus } from "@worktreeos/ui/format";
import {
  hasRequiredHealthcheckFailure,
  runAppPortHealthchecks,
  summarizeHealthcheckFailures,
  waitingHealthcheckSnapshot,
  type AppPortHealthcheckResult,
  type HealthcheckHttpClient,
} from "./healthchecks";
import {
  allocatePorts,
  assertStaticPortsAvailable,
  assignStaticPorts,
  collectBindings,
  defaultIsPortAvailable,
  type AvailabilityChecker,
} from "@worktreeos/compose/port-allocator";
import {
  logSink,
  nullObserver,
  type DeploymentObserver,
} from "@worktreeos/core/events";
import { throwIfDeploymentCancelled } from "./cancellation";

export function bufferedToStreaming(buffered: DockerRunner): StreamingDockerRunner {
  return async (args, sinks, opts) => {
    const r: DockerResult = await buffered(args, opts);
    if (r.stdout.length > 0) sinks.onStdout?.(r.stdout);
    if (r.stderr.length > 0) sinks.onStderr?.(r.stderr);
    return { exitCode: r.exitCode, stderr: r.stderr };
  };
}

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Tunnel resolution maps returned by a `TunnelPreparer`, both keyed by
 * `service -> containerPort (string) -> value`. `hostnames` carries the bare
 * public hostname (used by `${...hostname[<port>]}`); `urls` carries the full
 * reachable URL with scheme and port (used by `${...url[<port>]}`). When a
 * configured port has no active tunnel, both maps omit the entry and templates
 * fall back to `localhost`.
 */
export interface TunnelResolution {
  hostnames: Record<string, Record<string, string>>;
  urls: Record<string, Record<string, string>>;
}

/** Empty resolution used when no tunnels are opened. */
export function emptyTunnelResolution(): TunnelResolution {
  return { hostnames: {}, urls: {} };
}

export interface TunnelPreparer {
  /**
   * Reset any previously opened tunnels and open new tunnels for every app
   * port the daemon manages. Returns the hostname and full-URL maps used by
   * template resolution.
   */
  prepare(assignments: PortAssignments): Promise<TunnelResolution>;
  /**
   * Called when the operation is running with `--no-tunnel`. Implementations
   * should unregister any stale tunnel routes for the session so status
   * reflects the skip.
   */
  skip(): Promise<void>;
}

export interface RunUpDeps {
  worktreeRoot: string;
  config: WosConfig;
  source: WorktreeEntry;
  projectName: string;
  force?: boolean;
  /**
   * Skip tunnel route registration for this run. When `true`, the tunnel
   * preparer is not invoked and hostname templates fall back to `localhost`.
   */
  noTunnel?: boolean;
  composeRunner?: DockerRunner;
  streamingRunner?: StreamingDockerRunner;
  isPortAvailable?: AvailabilityChecker;
  now?: () => Date;
  maxAttempts?: number;
  stdout?: (text: string) => void;
  observer?: DeploymentObserver;
  cacheRoot?: string;
  packageManagerCacheRunner?: PackageManagerCacheCommandRunner;
  healthcheckHttp?: HealthcheckHttpClient;
  healthcheckDefaults?: ResolvedHealthcheckDefaults;
  signal?: AbortSignal;
  /**
   * Optional daemon-owned tunnel preparer. When omitted, no tunnels are opened
   * and hostname templates fall back to `localhost`.
   */
  tunnelPreparer?: TunnelPreparer;
  /**
   * Daemon-owned mutable signal. `runUpProgram` sets `composeStarted = true`
   * immediately after `docker compose up` succeeds (in both generated and
   * compose modes). The daemon reads this in its catch block to decide whether
   * to unregister tunnel routes on failure: a post-compose-up failure (e.g.
   * required app-port healthcheck) leaves routes in place so the user can
   * still reach the running containers via the public URL.
   */
  progress?: { composeStarted: boolean };
  /**
   * Selective generated-mode startup selection. `all` (or undefined) preserves
   * full-deployment behavior. `services` and `target` are rejected when the
   * resolved config uses `mode: compose`.
   */
  selection?: ServiceSelectionInput;
  /**
   * Submitted runtime argument values. Keys must be declared by
   * `config.arguments`; unknown keys fail validation before Docker Compose
   * startup. Generated-compose mode only. Compose mode rejects any non-empty
   * runtime argument map.
   */
  runtimeArguments?: RuntimeArgumentMap;
  /** Host-process boundary for shell mode (tests inject a fake). */
  shellProcessHost?: ShellProcessHost;
  /** Base environment inherited by shell service processes. Defaults to `process.env`. */
  shellBaseEnv?: Record<string, string>;
  /**
   * Optional LAN bind address. In generated mode, managed compose ports are
   * published on both loopback and this address. In all modes, the `localhost`
   * fallback of `${...hostname[<port>]}` / `${...url[<port>]}` templates resolves
   * to this address instead. Unset preserves prior behavior.
   */
  serviceBind?: string;
  /**
   * Commit (HEAD) captured by the caller just before deploy. Persisted as
   * `lastUpCommit` on success so worktree detail can compute commits-since-deploy.
   * Left unset when HEAD could not be read.
   */
  deployCommit?: string;
}

export async function runUpProgram(deps: RunUpDeps): Promise<WosState> {
  if (isShellMode(deps.config)) {
    return runShellUpProgram(deps);
  }
  if (isComposeMode(deps.config)) {
    if (deps.selection && deps.selection.kind !== "all") {
      throw new Error(
        "selective startup (services/target) is supported only in generated-compose mode",
      );
    }
    if (deps.runtimeArguments && Object.keys(deps.runtimeArguments).length > 0) {
      throw new RuntimeArgumentError(
        "runtime arguments are supported only in generated-compose mode",
      );
    }
    return runUpProgramComposeMode(deps, deps.config.compose);
  }
  validateRuntimeArguments(deps.config, deps.runtimeArguments);
  const composeRunner = deps.composeRunner ?? defaultDockerRunner;
  const streamingRunner =
    deps.streamingRunner ??
    (deps.composeRunner
      ? bufferedToStreaming(deps.composeRunner)
      : defaultStreamingDockerRunner);
  const isPortAvailable = deps.isPortAvailable ?? defaultIsPortAvailable;
  const now = deps.now ?? (() => new Date());
  const startedAtMs = now().getTime();
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const observer = deps.observer ?? nullObserver;
  const deploymentSink = logSink(observer, "deployment");

  observer.emit({ type: "step", id: "prepare", state: "running" });
  const statePath = stateFilePath(deps.worktreeRoot);
  const existing = await readState(statePath);
  let selection: ResolvedServiceSelection;
  try {
    selection = resolveServiceSelection(
      deps.config,
      deps.selection ?? { kind: "all" },
    );
  } catch (e) {
    if (e instanceof ServiceSelectionError) {
      observer.emit({
        type: "step",
        id: "prepare",
        state: "failed",
        message: e.message,
      });
      throw e;
    }
    throw e;
  }
  const selectedSet = new Set(selection.services);
  const bindings = collectBindings(deps.config, selectedSet);
  observer.emit({ type: "step", id: "prepare", state: "done" });

  if (existing?.initialized && existing.composeFile) {
    if (await Bun.file(existing.composeFile).exists()) {
      observer.emit({ type: "step", id: "release-ports", state: "running" });
      await composeDownStreamed(
        { projectName: existing.projectName, composeFile: existing.composeFile },
        deploymentSink,
        streamingRunner,
      );
      observer.emit({ type: "step", id: "release-ports", state: "done" });
    }
  }

  const sourceMode = isSourceWorktree(deps.worktreeRoot, deps.source);
  if (deps.force && !sourceMode) {
    await forceRemoveCloneVolumes(deps.worktreeRoot, deps.config.cloneVolumes);
  }

  const dynamicPorts = deps.config.dynamicPorts !== false;
  const excludedHostPorts = new Set<number>();
  let attempt = 0;
  let initialAssignments: PortAssignments;
  if (dynamicPorts) {
    initialAssignments = await allocatePorts(
      {
        projectName: deps.projectName,
        range: deps.config.hostPorts,
        bindings,
        previous: existing?.portAssignments,
        excludedHostPorts,
      },
      isPortAvailable,
    );
  } else {
    initialAssignments = assignStaticPorts(bindings);
    await assertStaticPortsAvailable(initialAssignments, isPortAvailable);
  }
  const needsSetup = !existing || !existing.initialized || !!deps.force;
  const packageManagerCaches: PackageManagerCacheMount[] =
    needsSetup && deps.config.app.initScript.length > 0
      ? await resolvePackageManagerCacheMounts(
          deps.config.app,
          deps.packageManagerCacheRunner,
        )
      : [];

  const tunnelPreparer = deps.noTunnel ? undefined : deps.tunnelPreparer;
  if (deps.noTunnel) {
    await deps.tunnelPreparer?.skip();
  }
  let { hostnames: tunnelHostnames, urls: tunnelUrls } =
    (await tunnelPreparer?.prepare(initialAssignments)) ?? emptyTunnelResolution();

  const deploymentId = generateDeploymentId();
  let composeFile = await writeGeneratedCompose({
    config: deps.config,
    worktreeRoot: deps.worktreeRoot,
    projectName: deps.projectName,
    portAssignments: initialAssignments,
    packageManagerCaches,
    tunnelHostnames,
    tunnelUrls,
    deploymentId,
    selectedServices: selectedSet,
    runtimeArguments: deps.runtimeArguments,
    serviceBind: deps.serviceBind,
  });
  const ctx: ComposeContext = { projectName: deps.projectName, composeFile };

  let state: WosState;
  if (needsSetup) {
    if (existing?.initialized && deps.force) {
      await writeState(statePath, {
        ...existing,
        initialized: false,
        projectName: deps.projectName,
        composeFile,
        portAssignments: initialAssignments,
        worktreeRoot: deps.worktreeRoot,
        sourcePath: deps.source.path,
      });
    }
    observer.emit({ type: "step", id: "first-run-setup", state: "running" });
    const serviceInits = selection.services
      .filter((name) => {
        const svc = deps.config.app.services[name];
        return svc !== undefined && (svc.initScript ?? []).length > 0;
      })
      .map((name) => {
        const svc = deps.config.app.services[name]!;
        return {
          service: name,
          commands: svc.initScript ?? [],
          workingDir: resolveWorkingDir(svc.cwd),
        };
      });
    await firstRunSetup({
      sourceRoot: deps.source.path,
      currentRoot: deps.worktreeRoot,
      cloneVolumes: sourceMode ? [] : deps.config.cloneVolumes,
      initScript: deps.config.app.initScript,
      serviceInits,
      cacheEntries: deps.config.cache,
      cacheRoot: deps.cacheRoot,
      observer,
      runInit: async (commands) => {
        observer.emit({ type: "step", id: "init-script", state: "running" });
        try {
          await runContainerInit({
            composeContext: ctx,
            commands,
            runner: composeRunner,
            streamingRunner,
            observer,
          });
          observer.emit({ type: "step", id: "init-script", state: "done" });
        } catch (e) {
          observer.emit({
            type: "step",
            id: "init-script",
            state: "failed",
            message: (e as Error).message,
          });
          throw e;
        }
      },
      runServiceInit: async (phase) => {
        observer.emit({ type: "step", id: "init-script", state: "running" });
        try {
          await runContainerInit({
            composeContext: ctx,
            commands: phase.commands,
            runner: composeRunner,
            streamingRunner,
            observer,
            workingDir: phase.workingDir,
          });
          observer.emit({ type: "step", id: "init-script", state: "done" });
        } catch (e) {
          observer.emit({
            type: "step",
            id: "init-script",
            state: "failed",
            message: `service ${phase.service} init failed: ${(e as Error).message}`,
          });
          throw e;
        }
      },
    });
    observer.emit({ type: "step", id: "first-run-setup", state: "done" });
    state = {
      initialized: true,
      projectName: deps.projectName,
      composeFile,
      portAssignments: initialAssignments,
      worktreeRoot: deps.worktreeRoot,
      sourcePath: deps.source.path,
      deploymentId,
    };
  } else {
    state = {
      ...existing,
      projectName: deps.projectName,
      composeFile,
      portAssignments: initialAssignments,
      worktreeRoot: deps.worktreeRoot,
      sourcePath: deps.source.path,
      deploymentId,
    };
  }
  await writeState(statePath, state);

  let currentAssignments = initialAssignments;
  throwIfDeploymentCancelled(deps.signal);
  observer.emit({ type: "step", id: "compose-up", state: "running" });
  while (true) {
    attempt += 1;
    try {
      await composeUpStreamed(ctx, deploymentSink, streamingRunner);
      break;
    } catch (e) {
      if (!(e instanceof ComposeError) || !isPortConflictStderr(e.stderr)) {
        observer.emit({
          type: "step",
          id: "compose-up",
          state: "failed",
          message: (e as Error).message,
        });
        throw e;
      }
      if (!dynamicPorts) {
        observer.emit({
          type: "step",
          id: "compose-up",
          state: "failed",
          message: (e as Error).message,
        });
        throw new ComposeError(
          `static host port conflict; wos does not reallocate when dynamic_ports is false: ${e.message}`,
          e.stderr,
        );
      }
      const ourAssignedPorts = new Set<number>();
      for (const ports of Object.values(currentAssignments)) {
        for (const p of Object.values(ports)) ourAssignedPorts.add(p);
      }
      const stderrPorts = extractPortNumbers(e.stderr);
      const conflicting = stderrPorts.filter((p) => ourAssignedPorts.has(p));
      const toExclude = conflicting.length > 0 ? conflicting : [...ourAssignedPorts];
      for (const p of toExclude) excludedHostPorts.add(p);
      if (attempt >= maxAttempts) {
        observer.emit({
          type: "step",
          id: "compose-up",
          state: "failed",
          message: `port allocation exhausted after ${attempt} attempt(s)`,
        });
        throw new ComposeError(
          `host-port allocation could not be completed after ${attempt} attempt(s); last error: ${e.message}`,
          e.stderr,
        );
      }
      observer.emit({
        type: "retry",
        attempt,
        maxAttempts,
        reason: `port conflict on ${toExclude.join(", ")}`,
      });
      await composeDownStreamed(ctx, deploymentSink, streamingRunner);
      currentAssignments = await allocatePorts(
        {
          projectName: deps.projectName,
          range: deps.config.hostPorts,
          bindings,
          previous: currentAssignments,
          excludedHostPorts,
        },
        isPortAvailable,
      );
      ({ hostnames: tunnelHostnames, urls: tunnelUrls } =
        (await tunnelPreparer?.prepare(currentAssignments)) ?? emptyTunnelResolution());
      composeFile = await writeGeneratedCompose({
        config: deps.config,
        worktreeRoot: deps.worktreeRoot,
        projectName: deps.projectName,
        portAssignments: currentAssignments,
        packageManagerCaches,
        tunnelHostnames,
        tunnelUrls,
        deploymentId,
        selectedServices: selectedSet,
        runtimeArguments: deps.runtimeArguments,
        serviceBind: deps.serviceBind,
      });
      ctx.composeFile = composeFile;
      state = { ...state, composeFile, portAssignments: currentAssignments };
      await writeState(statePath, state);
    }
  }
  if (deps.progress) deps.progress.composeStarted = true;
  observer.emit({ type: "step", id: "compose-up", state: "done" });

  observer.emit({ type: "step", id: "status", state: "running" });
  const psOutput = await composePsStreamed(ctx, deploymentSink, streamingRunner);
  const services = parseComposePs(psOutput).filter(
    (s) => s.service !== INIT_SERVICE_NAME,
  );
  observer.emit({ type: "step", id: "status", state: "done" });
  observer.emit({
    type: "services-discovered",
    services: services.map((s) => s.service),
    composeContext: { projectName: ctx.projectName, composeFile: ctx.composeFile },
  });

  observer.emit({ type: "step", id: "healthcheck", state: "running" });
  stdout(formatStatus(services) + "\n");
  const waitingSnapshot = waitingHealthcheckSnapshot(
    deps.config,
    services,
    deps.healthcheckDefaults,
    selectedSet,
  );
  const waitingLines = formatHealthchecks(waitingSnapshot);
  if (waitingLines.length > 0) stdout(waitingLines + "\n");
  const maxAttemptsByTarget = new Map<string, number>();
  for (const w of waitingSnapshot) {
    if (w.retries !== undefined) {
      maxAttemptsByTarget.set(`${w.service}:${w.containerPort}`, w.retries);
    }
  }
  let healthchecks: AppPortHealthcheckResult[];
  try {
    healthchecks = await runAppPortHealthchecks({
      config: deps.config,
      services,
      http: deps.healthcheckHttp,
      defaults: deps.healthcheckDefaults,
      mode: "wait",
      signal: deps.signal,
      selectedServices: selectedSet,
      onAttempt: (a) => {
        const outcome = a.matched
          ? "ok"
          : a.status !== undefined
          ? `HTTP ${a.status}`
          : a.error ?? "error";
        stdout(
          `  healthcheck ${a.service}:${a.containerPort} attempt ${a.attempt} ${a.url} → ${outcome}\n`,
        );
        observer.emit({
          type: "healthcheck-attempt",
          service: a.service,
          containerPort: a.containerPort,
          attempt: a.attempt,
          maxAttempts:
            maxAttemptsByTarget.get(`${a.service}:${a.containerPort}`) ??
            a.attempt,
          url: a.url,
          status: a.status,
          error: a.error,
          matched: a.matched,
        });
      },
    });
  } catch (e) {
    observer.emit({
      type: "step",
      id: "healthcheck",
      state: "failed",
      message: (e as Error).message,
    });
    throw e;
  }
  // An aborted wait loop returns failure results rather than throwing; treat a
  // stop request as a cancellation instead of a healthcheck failure so the
  // daemon tears down cleanly rather than surfacing a scary failure.
  throwIfDeploymentCancelled(deps.signal);
  const healthLines = formatHealthchecks(healthchecks);
  if (healthLines.length > 0) stdout(healthLines + "\n");

  if (hasRequiredHealthcheckFailure(healthchecks)) {
    const message = `app-port healthcheck failed: ${summarizeHealthcheckFailures(healthchecks)}`;
    observer.emit({ type: "step", id: "healthcheck", state: "failed", message });
    throw new Error(message);
  }
  observer.emit({ type: "step", id: "healthcheck", state: "done" });

  const finishedAt = now();
  const lastUp = finishedAt.toISOString();
  const durationMs = finishedAt.getTime() - startedAtMs;
  state = {
    ...state,
    portAssignments: currentAssignments,
    composeFile,
    lastUp,
    ...(deps.deployCommit ? { lastUpCommit: deps.deployCommit } : {}),
    ...(Number.isFinite(durationMs) && durationMs >= 0
      ? { lastUpDurationMs: durationMs }
      : {}),
    deploymentId,
  };
  await writeState(statePath, state);
  observer.emit({ type: "complete", lastUp });
  return state;
}

/**
 * Compose-mode `up`. Reads the user-owned Compose file referenced by
 * `compose.config`, writes a wos-owned sanitized base copy plus an overlay
 * that publishes only `compose.expose` ports with wos-allocated host
 * ports, then runs Docker Compose with both files. Allocates host ports,
 * prepares tunnels, resolves expose templates in `compose.environment`, and
 * retries on wos-owned port conflicts. Skips init scripts/healthchecks.
 */
async function runUpProgramComposeMode(
  deps: RunUpDeps,
  compose: ComposeModeConfig,
): Promise<WosState> {
  const composeRunner = deps.composeRunner ?? defaultDockerRunner;
  const streamingRunner =
    deps.streamingRunner ??
    (deps.composeRunner
      ? bufferedToStreaming(deps.composeRunner)
      : defaultStreamingDockerRunner);
  const isPortAvailable = deps.isPortAvailable ?? defaultIsPortAvailable;
  const now = deps.now ?? (() => new Date());
  const startedAtMs = now().getTime();
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const observer = deps.observer ?? nullObserver;
  const deploymentSink = logSink(observer, "deployment");

  observer.emit({ type: "step", id: "prepare", state: "running" });
  const statePath = stateFilePath(deps.worktreeRoot);
  const existing = await readState(statePath);
  const userComposeFile = resolveComposeConfigPath(
    compose.config,
    deps.worktreeRoot,
  );
  if (!(await Bun.file(userComposeFile).exists())) {
    observer.emit({
      type: "step",
      id: "prepare",
      state: "failed",
      message: `compose.config file not found: ${userComposeFile}`,
    });
    throw new Error(`compose.config file not found: ${userComposeFile}`);
  }
  const bindings = collectComposeExposeBindings(compose.expose);
  observer.emit({ type: "step", id: "prepare", state: "done" });

  // Take down any prior deployment using whichever Compose file set the last
  // session recorded (multi-file when available, single-file otherwise).
  if (existing?.initialized && existing.composeFile) {
    const prevFiles =
      existing.composeFiles && existing.composeFiles.length > 0
        ? existing.composeFiles
        : [existing.composeFile];
    const allExist = await Promise.all(
      prevFiles.map((f) => Bun.file(f).exists()),
    );
    if (allExist.every((ok) => ok)) {
      observer.emit({ type: "step", id: "release-ports", state: "running" });
      // Use a best-effort env without templates: previous run's assignments
      // are still in `existing.portAssignments` if needed, but `down` does
      // not depend on resolved values.
      const downEnv = await buildComposeCommandEnvironment({
        config: compose,
        worktreeRoot: deps.worktreeRoot,
      }).catch(() => undefined);
      await composeDownStreamed(
        {
          projectName: existing.projectName,
          composeFile: prevFiles[0]!,
          composeFiles: prevFiles,
        },
        deploymentSink,
        streamingRunner,
        undefined,
        downEnv ? { env: downEnv } : undefined,
      );
      observer.emit({ type: "step", id: "release-ports", state: "done" });
    }
  }

  const sourceMode = isSourceWorktree(deps.worktreeRoot, deps.source);
  if (deps.force && !sourceMode) {
    await forceRemoveCloneVolumes(deps.worktreeRoot, deps.config.cloneVolumes);
  }

  const dynamicPorts = deps.config.dynamicPorts !== false;
  const excludedHostPorts = new Set<number>();
  let assignments: PortAssignments;
  if (dynamicPorts) {
    assignments = await allocatePorts(
      {
        projectName: deps.projectName,
        range: deps.config.hostPorts,
        bindings,
        previous: existing?.portAssignments,
        excludedHostPorts,
      },
      isPortAvailable,
    );
  } else {
    assignments = assignStaticPorts(bindings);
    await assertStaticPortsAvailable(assignments, isPortAvailable);
  }

  // Prepare tunnels for compose expose entries when tunneling is enabled.
  const tunnelPreparer = deps.noTunnel ? undefined : deps.tunnelPreparer;
  if (deps.noTunnel) {
    await deps.tunnelPreparer?.skip();
  }
  let { hostnames: tunnelHostnames, urls: tunnelUrls } =
    (await tunnelPreparer?.prepare(assignments)) ?? emptyTunnelResolution();

  const deploymentId = generateDeploymentId();

  // Write wos-owned compose artifacts.
  const sanitizedBase = await writeSanitizedComposeBase(
    deps.worktreeRoot,
    userComposeFile,
  );
  let overlayPath = await writeComposeOverlay(
    deps.worktreeRoot,
    compose.expose,
    assignments,
    { tunnelHostnames, projectName: deps.projectName, deploymentId },
  );
  let composeFiles: string[] = [sanitizedBase, overlayPath];
  const ctx: ComposeContext = {
    projectName: deps.projectName,
    composeFile: sanitizedBase,
    composeFiles,
  };

  // Build resolved command environment.
  let commandEnv = await buildComposeCommandEnvironment({
    config: compose,
    worktreeRoot: deps.worktreeRoot,
    assignments,
    tunnelHostnames,
    tunnelUrls,
    serviceBind: deps.serviceBind,
  });

  const needsSetup = !existing || !existing.initialized || !!deps.force;
  let state: WosState;
  if (needsSetup) {
    if (existing?.initialized && deps.force) {
      await writeState(statePath, {
        ...existing,
        initialized: false,
        projectName: deps.projectName,
        composeFile: sanitizedBase,
        composeFiles,
        portAssignments: assignments,
        worktreeRoot: deps.worktreeRoot,
        sourcePath: deps.source.path,
      });
    }
    observer.emit({ type: "step", id: "first-run-setup", state: "running" });
    await firstRunSetup({
      sourceRoot: deps.source.path,
      currentRoot: deps.worktreeRoot,
      cloneVolumes: sourceMode ? [] : deps.config.cloneVolumes,
      // Compose mode has no wos-generated init service.
      initScript: [],
      cacheEntries: deps.config.cache,
      cacheRoot: deps.cacheRoot,
      observer,
      runInit: async () => {
        // Never invoked because initScript is empty in compose mode.
      },
    });
    observer.emit({ type: "step", id: "first-run-setup", state: "done" });
    state = {
      initialized: true,
      projectName: deps.projectName,
      composeFile: sanitizedBase,
      composeFiles,
      portAssignments: assignments,
      worktreeRoot: deps.worktreeRoot,
      sourcePath: deps.source.path,
      deploymentId,
    };
  } else {
    state = {
      ...existing,
      projectName: deps.projectName,
      composeFile: sanitizedBase,
      composeFiles,
      portAssignments: assignments,
      worktreeRoot: deps.worktreeRoot,
      sourcePath: deps.source.path,
      deploymentId,
    };
  }
  await writeState(statePath, state);

  // Up + retry on wos-owned port conflicts.
  let attempt = 0;
  throwIfDeploymentCancelled(deps.signal);
  observer.emit({ type: "step", id: "compose-up", state: "running" });
  while (true) {
    attempt += 1;
    try {
      await composeUpStreamed(ctx, deploymentSink, streamingRunner, {
        env: commandEnv,
      });
      break;
    } catch (e) {
      if (!(e instanceof ComposeError) || !isPortConflictStderr(e.stderr)) {
        observer.emit({
          type: "step",
          id: "compose-up",
          state: "failed",
          message: (e as Error).message,
        });
        throw e;
      }
      if (!dynamicPorts) {
        observer.emit({
          type: "step",
          id: "compose-up",
          state: "failed",
          message: (e as Error).message,
        });
        throw new ComposeError(
          `static host port conflict; wos does not reallocate when dynamic_ports is false: ${e.message}`,
          e.stderr,
        );
      }
      const ourAssignedPorts = new Set<number>();
      for (const ports of Object.values(assignments)) {
        for (const p of Object.values(ports)) ourAssignedPorts.add(p);
      }
      const stderrPorts = extractPortNumbers(e.stderr);
      const conflicting = stderrPorts.filter((p) => ourAssignedPorts.has(p));
      const toExclude = conflicting.length > 0 ? conflicting : [...ourAssignedPorts];
      for (const p of toExclude) excludedHostPorts.add(p);
      if (attempt >= maxAttempts) {
        observer.emit({
          type: "step",
          id: "compose-up",
          state: "failed",
          message: `port allocation exhausted after ${attempt} attempt(s)`,
        });
        throw new ComposeError(
          `host-port allocation could not be completed after ${attempt} attempt(s); last error: ${e.message}`,
          e.stderr,
        );
      }
      observer.emit({
        type: "retry",
        attempt,
        maxAttempts,
        reason: `port conflict on ${toExclude.join(", ")}`,
      });
      await composeDownStreamed(ctx, deploymentSink, streamingRunner, undefined, {
        env: commandEnv,
      });
      assignments = await allocatePorts(
        {
          projectName: deps.projectName,
          range: deps.config.hostPorts,
          bindings,
          previous: assignments,
          excludedHostPorts,
        },
        isPortAvailable,
      );
      ({ hostnames: tunnelHostnames, urls: tunnelUrls } =
        (await tunnelPreparer?.prepare(assignments)) ?? emptyTunnelResolution());
      overlayPath = await writeComposeOverlay(
        deps.worktreeRoot,
        compose.expose,
        assignments,
        { tunnelHostnames, projectName: deps.projectName, deploymentId },
      );
      composeFiles = [sanitizedBase, overlayPath];
      ctx.composeFile = sanitizedBase;
      ctx.composeFiles = composeFiles;
      commandEnv = await buildComposeCommandEnvironment({
        config: compose,
        worktreeRoot: deps.worktreeRoot,
        assignments,
        tunnelHostnames,
        tunnelUrls,
        serviceBind: deps.serviceBind,
      });
      state = {
        ...state,
        composeFile: sanitizedBase,
        composeFiles,
        portAssignments: assignments,
        deploymentId,
      };
      await writeState(statePath, state);
    }
  }
  if (deps.progress) deps.progress.composeStarted = true;
  observer.emit({ type: "step", id: "compose-up", state: "done" });

  observer.emit({ type: "step", id: "status", state: "running" });
  const psOutput = await composePsStreamed(
    ctx,
    deploymentSink,
    streamingRunner,
    { env: commandEnv },
  );
  const exposeSet = new Set(uniqueExposeServices(compose.expose));
  const services = parseComposePs(psOutput).filter((s) =>
    exposeSet.has(s.service),
  );
  observer.emit({ type: "step", id: "status", state: "done" });
  observer.emit({
    type: "services-discovered",
    services: services.map((s) => s.service),
    composeContext: {
      projectName: ctx.projectName,
      composeFile: ctx.composeFile,
      composeFiles: ctx.composeFiles,
    },
  });

  stdout(formatStatus(services) + "\n");

  const finishedAt = now();
  const lastUp = finishedAt.toISOString();
  const durationMs = finishedAt.getTime() - startedAtMs;
  state = {
    ...state,
    composeFile: sanitizedBase,
    composeFiles,
    lastUp,
    ...(deps.deployCommit ? { lastUpCommit: deps.deployCommit } : {}),
    ...(Number.isFinite(durationMs) && durationMs >= 0
      ? { lastUpDurationMs: durationMs }
      : {}),
    deploymentId,
  };
  await writeState(statePath, state);
  observer.emit({ type: "complete", lastUp });
  return state;
}
