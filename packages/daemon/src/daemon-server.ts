import { readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname } from "node:path";
import { OperationRegistry } from "./operation-registry";
import { DaemonSessionRegistry, type FollowerStarter } from "./daemon-sessions";
import { DaemonEventBus } from "./event-bus";
import {
  createCertificateEventPublisher,
  createTunnelEventPublisher,
} from "./unified-publishers";
import { SessionMonitorRegistry } from "./session-monitor";
import { DockerStateStore } from "./docker/docker-state-store";
import {
  createBackendRegistry,
  type BackendRegistry,
} from "./backend/adapters";
import { DAEMON_PROTOCOL_VERSION } from "./daemon-protocol";
import { resolveSessionContext, type SessionContext } from "@worktreeos/core/session-context";
import { runUpOperation } from "@worktreeos/runtime/operations";
import {
  startTunnelServer,
  type StartTunnelServerOptions,
  type TunnelServer,
} from "@worktreeos/runtime/tunnel";
import { TunnelRegistry } from "@worktreeos/runtime/tunnel-registry";
import type { ServiceSelectionInput } from "@worktreeos/compose/service-selection";
import {
  DEFAULT_TUNNEL_PORT,
  effectiveHealthcheckDefaults,
  loadGlobalConfig,
  type GlobalConfig,
  type GlobalTunnelWebUiConfig,
} from "@worktreeos/core/global-config";
import { defaultNotificationsConfig } from "@worktreeos/core/notifications";
import {
  daemonMetadataPath,
  type DaemonMetadata,
} from "./daemon-paths";
import {
  startDaemonWeb,
  type DaemonWebHandle,
  type DaemonWebOptions,
} from "./daemon-web";
import { createAcmeManager, type AcmeManager } from "./acme/manager";
import { CertificateStatusRegistry } from "./acme/status";
import { resolveListenerSsl } from "./acme/listener-resolve";
import { createRenewalScheduler } from "./acme/scheduler";
import { rotateTunnelListener } from "./acme/rotation";
import {
  AgentActivityIngest,
  createAndPersistAgentToken,
} from "./agent-activity-ingest";
import { NotificationService } from "./notifications/service";
import { loadOrCreateVapidKeys } from "./notifications/vapid";
import { TranscriptTelemetryReader } from "./terminal-layer/transcript-telemetry";
import { ensureAgentPluginsInjected } from "./agent-plugin-install";
import { selectNextFreePort } from "./setup-environment";
import { createUiApiHandler } from "./ui-api";
import { isCompiledStandalone } from "./daemon-bootstrap";
import {
  TerminalSessionManager,
  type TerminalRestoreResult,
} from "./terminal-layer/manager";
import { bunTerminalRuntime } from "./terminal-layer/bun-terminal-runtime";
import { selectTerminalBackend } from "./terminal-layer/select-backend";
import { publishTerminalLifecycle } from "./terminal-layer/event-publisher";
import { createTerminalLayerWsHandlers } from "./terminal-layer/ws-handler";
import { discoverProjectsFromSessions } from "@worktreeos/core/project-discovery";
import { restoreMonitorsFromSessions } from "./monitor-restoration";
import { restoreTunnelsFromSessions } from "./tunnel-restoration";
import { createDaemonLogger, type DaemonLogger, type ModuleLogger } from "./logger";
import {
  defaultWorktreeGitRunner,
  type WorktreeGitRunner,
} from "@worktreeos/core/git";
import {
  defaultDockerRunner,
  type DockerRunner,
} from "@worktreeos/compose/compose";
import { DockerClient } from "./docker/docker-client";

/**
 * Prepend the running wos binary's directory to a `PATH` value so spawned
 * sessions can resolve `wos` (and thus `wos agent-hook`) without it being on
 * the user's global `PATH`. In a compiled binary `process.execPath` is the wos
 * executable; in `bun run` dev it points at bun (harmless — wos is launched
 * differently there). Idempotent: skips the prepend when the directory is
 * already first.
 */
/**
 * Upper bound on distinct ports the free-port fallback will attempt to bind
 * before giving up. Generous: the next free port is almost always within a
 * handful of the preferred one, and this only guards against a pathological
 * scan when a huge contiguous range is occupied.
 */
const FREE_PORT_FALLBACK_ATTEMPTS = 64;

/**
 * Synchronous port-free probe via a throwaway loopback bind. Advisory only: it
 * feeds `selectNextFreePort` to pick a candidate, but the real `Bun.serve` bind
 * remains authoritative (the fallback loop re-probes on a lost race).
 */
function probePortFree(port: number, host: string): boolean {
  try {
    const server = Bun.listen({
      hostname: host,
      port,
      socket: { data() {}, open() {}, close() {}, error() {} },
    });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

export function prependBinaryDir(
  currentPath: string | undefined,
  execPath: string = process.execPath,
): string {
  const binDir = dirname(execPath);
  const existing = currentPath ?? "";
  if (existing.length === 0) return binDir;
  const first = existing.split(delimiter)[0];
  if (first === binDir) return existing;
  return `${binDir}${delimiter}${existing}`;
}

/**
 * Wrap a worktree git runner so every `git` invocation is timed under the
 * `perf` module (`op: "git"`). When logging or perf is off, the span degrades
 * to a plain call with no overhead. Covers all daemon-side git, including the
 * serial per-worktree calls behind the project list — the canonical hang.
 */
function timedWorktreeGitRunner(
  runner: WorktreeGitRunner,
  perf: ModuleLogger,
): WorktreeGitRunner {
  return (worktreeRoot, args) =>
    perf.span("git", args.join(" "), () => runner(worktreeRoot, args), {
      cwd: worktreeRoot,
    });
}

/** Wrap a docker runner so each `docker`/`docker compose` call is timed. */
function timedDockerRunner(
  runner: DockerRunner,
  perf: ModuleLogger,
): DockerRunner {
  return (args, opts) =>
    perf.span("compose", args.join(" "), () => runner(args, opts));
}

export interface DaemonOptions {
  /** Override metadata path. Defaults to `<wos-home>/daemon.json`. */
  metadataPath?: string;
  /** Inject a session resolver for tests; defaults to the real implementation. */
  resolveSession?: (cwd: string) => Promise<SessionContext>;
  /** Inject a follower starter for tests. */
  followerStarter?: FollowerStarter;
  /**
   * Override the global config used to configure tunneling. Tests may pass a
   * stub here to enable or disable the daemon-owned tunnel server.
   */
  globalConfig?: GlobalConfig;
  /**
   * Override the function used to start the daemon-owned local HTTP tunnel
   * server. Tests can pass a stub that returns a fake `TunnelServer`.
   */
  tunnelServerStarter?: (opts: StartTunnelServerOptions) => Promise<TunnelServer>;
  /**
   * Web/management listener configuration. The listener is mandatory: bind
   * failure fails daemon startup. Defaults to an ephemeral loopback port
   * (useful for tests); production passes the configured `web.host`/`web.port`.
   */
  web?: DaemonWebOptions;
  /**
   * How long (ms) to retry the control-plane listener bind on `EADDRINUSE`
   * before failing. Covers the brief window where a just-stopped daemon is
   * still releasing the port during `wos restart` (notably on Windows).
   * Defaults to 5000; tests that assert a genuine bind failure pass `0`.
   */
  bindRetryMs?: number;
  /**
   * Override the docker runner used by lightweight `docker compose ps` calls
   * driving sidebar status, monitor restoration, and lazy log follower start
   * (tests).
   */
  dockerRunner?: import("@worktreeos/compose/compose").DockerRunner;
  /**
   * Keep-alive interval for the NDJSON log stream in milliseconds. Forwarded
   * to the UI API handler (tests).
   */
  logStreamKeepaliveMs?: number;
  /**
   * Override the function that actually runs the up program (tests). Mirrors
   * the same hook in `createUiApiHandler` so unit tests can drive failure
   * scenarios — e.g. simulate a successful compose-up followed by a failed
   * healthcheck — without spinning up real Docker.
   */
  upRunner?: typeof runUpOperation;
  /**
   * Override the terminal-layer runtime used to spawn PTY sessions. Tests
   * inject a fake runtime to drive lifecycle deterministically without
   * spawning real subprocesses.
   */
  terminalRuntime?: import("./terminal-layer/runtime").TerminalRuntime;
  /**
   * Override the worktree-scoped git runner used by the UI API handler.
   * Tests inject a stub to simulate clean/dirty worktree status output and
   * `git worktree remove` outcomes without invoking the system git binary.
   */
  gitRunner?: import("@worktreeos/core/git").WorktreeGitRunner;
  /**
   * When false, skip tunnel/monitor restoration and project discovery on
   * startup. Defaults to true (production behavior).
   */
  restorePersistedState?: boolean;
  /**
   * Override the ACME manager used for Let's Encrypt certificate issuance and
   * renewal. Tests inject a stub so issuance can be exercised without hitting
   * the real ACME servers.
   */
  acmeManager?: AcmeManager;
  /**
   * Schedule daemon lifecycle restart work requested via the UI API. Forwarded
   * to `createUiApiHandler` and invoked AFTER the restart response is built so
   * the current daemon delivers the HTTP response before exiting. Tests inject
   * a fake scheduler to observe scheduling; production wires this to a
   * detached child process that re-runs `wos restart`.
   */
  restartScheduler?: () => void | Promise<void>;
  /**
   * Schedule daemon shutdown work requested via `POST /ui/v1/daemon/stop`.
   * Invoked AFTER the response is built. Tests inject a fake scheduler;
   * production wires this to the foreground daemon's graceful shutdown path.
   */
  stopScheduler?: () => void | Promise<void>;
  /**
   * Override the daemon file logger (tests). Defaults to a logger built from
   * `globalConfig.logging` — disabled (no-op) unless logging is enabled in
   * `<wos-home>/config.json`.
   */
  logger?: DaemonLogger;
  /**
   * Injectable first-run setup-environment probes/runners for the
   * `/ui/v1/setup/*` onboarding endpoints (tests). Forwarded verbatim to the UI
   * API handler; each field defaults to the real host probe.
   */
  setupEnvironment?: import("./ui-api").UiApiDependencies["setupEnvironment"];
}

export interface DaemonHandle {
  metadataPath: string;
  /** Fresh identifier generated for this daemon startup. */
  daemonId: string;
  /**
   * Client-facing local URL for the mandatory web listener (loopback-mapped
   * for wildcard binds). Use {@link webBindHostname} to inspect the actual
   * bind interface (e.g. `0.0.0.0` for public exposure).
   */
  webUrl: string;
  /** Actual bind hostname of the web listener (e.g. `127.0.0.1` or `0.0.0.0`). */
  webBindHostname: string;
  /** Effective scheme of the web listener — `http` or `https`. */
  webScheme: "http" | "https";
  stop: () => Promise<void>;
  registry: OperationRegistry;
  sessions: DaemonSessionRegistry;
  tunnels: TunnelRegistry;
  events: DaemonEventBus;
  monitors: SessionMonitorRegistry;
  terminalLayer: TerminalSessionManager;
  /** Read-only certificate status registry exposed for status APIs and tests. */
  certificateStatus: CertificateStatusRegistry;
  /** Docker state cache (initial sync, events, periodic reconcile). */
  dockerState: DockerStateStore;
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<DaemonHandle> {
  const metadataPath = opts.metadataPath ?? daemonMetadataPath();
  const daemonId = crypto.randomUUID();
  const globalConfig = opts.globalConfig ?? (await loadGlobalConfig());
  // Opt-in file logger built from `globalConfig.logging`; a no-op (zero
  // overhead, no file handle) unless logging is enabled in config.json.
  const logger = opts.logger ?? createDaemonLogger(globalConfig.logging);
  const perfLog = logger.module("perf");
  const dockerLog = logger.module("docker");
  const tunnelLog = logger.module("tunnel");
  const acmeLog = logger.module("acme");
  const resolveSessionRaw =
    opts.resolveSession ?? ((cwd: string) => resolveSessionContext({ cwd }));
  // Time worktree resolution (`op: "resolve-session"`) — it shells out to git
  // and is the cwd→worktree step behind agent-event attribution.
  const resolveSession: (cwd: string) => Promise<SessionContext> = (cwd) =>
    perfLog.span("resolve-session", cwd, () => resolveSessionRaw(cwd), { cwd });
  const registry = new OperationRegistry();
  // Single Docker engine client shared by the state store and backends, with
  // its HTTP calls timed under `op: "docker-http"`.
  const dockerClient = new DockerClient({ logger: logger.module("docker-http") });
  // Daemon-side docker compose runner, timed under `op: "compose"`.
  const dockerRunner: DockerRunner = timedDockerRunner(
    opts.dockerRunner ?? defaultDockerRunner,
    perfLog,
  );
  const dockerState = new DockerStateStore({
    client: dockerClient,
    logger: (level, msg, err) => {
      if (level === "error") {
        dockerLog.error(msg, { error: String(err ?? "") });
        process.stderr.write(`wos daemon: docker-state ${msg}: ${String(err ?? "")}\n`);
      }
    },
  });
  // Initial sync is fire-and-forget so daemon startup is not blocked when the
  // Docker socket is briefly unavailable.
  void dockerState.start().catch((e) => {
    dockerLog.error("state store start failed", { error: (e as Error).message });
    process.stderr.write(`wos daemon: docker state store start failed: ${(e as Error).message}\n`);
  });
  // Deployment backends. Docker-backed modes stream logs from the Docker logs
  // API and read the Docker state cache; shell mode tails persisted log files
  // and reads shell process metadata. The registry selects per session so
  // shell-mode sessions never touch Docker. Tests can still inject
  // `followerStarter` to bypass Docker for Docker-backed sessions.
  const backends: BackendRegistry = createBackendRegistry({
    docker: {
      dockerState,
      dockerRunner,
      client: dockerClient,
      followerStarter: opts.followerStarter,
      warn: (m) => {
        dockerLog.warn(m);
        process.stderr.write(`${m}\n`);
      },
    },
  });
  const sessions = new DaemonSessionRegistry({
    starter: (args) =>
      backends.forSession(args.sessionName ?? "").followerStarter(args),
  });
  sessions.setStreamContextResolver((sessionName) =>
    backends.forSession(sessionName).resolveStreamContext(sessionName),
  );
  const tunnels = new TunnelRegistry();
  const events = new DaemonEventBus();
  tunnels.setEventPublisher(createTunnelEventPublisher(events));
  const monitors = new SessionMonitorRegistry(events);
  const healthcheckDefaults = effectiveHealthcheckDefaults(globalConfig);
  tunnels.setServiceRoutePolicy(globalConfig.tunnel.serviceTunnels.whitelistIps);
  const terminalRuntime = opts.terminalRuntime ?? bunTerminalRuntime;
  const terminalBackend = await selectTerminalBackend({
    backendId: globalConfig.terminalBackend,
    runtime: terminalRuntime,
  });
  // Agent plugin binding: per-run bearer token + spawn-time environment so
  // agent-side plugins can POST activity events back to this daemon. The web
  // URL is only known after the web listener starts, so the env provider
  // reads it lazily from `metadata` state captured below.
  let agentDaemonUrl: string | undefined;
  const agentToken = createAndPersistAgentToken();
  if (globalConfig.autoInjectAgentPlugins) {
    void ensureAgentPluginsInjected();
  }
  const terminalLayer = new TerminalSessionManager({
    backend: terminalBackend,
    logger,
    onLifecycle: (event) => publishTerminalLifecycle(events, event),
    agentEnv: (sessionId) => ({
      ...(agentDaemonUrl ? { WOS_DAEMON_URL: agentDaemonUrl } : {}),
      WOS_TERMINAL_SESSION_ID: sessionId,
      WOS_AGENT_TOKEN: agentToken,
    }),
  });
  const terminalAvailability = terminalBackend.isAvailable();
  if (!terminalAvailability.available) {
    process.stderr.write(
      `wos daemon: terminal sessions disabled (${terminalAvailability.reason ?? `backend ${terminalBackend.id} unavailable`})\n`,
    );
  }
  // Restored terminal sessions whose record carries a persisted transcript
  // binding; re-bound below once the telemetry reader exists so their
  // `agentTelemetry` is recomputed without waiting for a fresh hook event.
  let restoredTerminals: TerminalRestoreResult[] = [];
  if (opts.restorePersistedState !== false) {
    try {
      restoredTerminals = await terminalLayer.restore({
        onError: (e) =>
          process.stderr.write(
            `wos daemon: terminal restore failed: ${e.message}\n`,
          ),
      });
      if (restoredTerminals.length > 0) {
        process.stderr.write(
          `wos daemon: restored ${restoredTerminals.length} terminal session(s) from ${terminalBackend.id} backend\n`,
        );
      }
    } catch (e) {
      process.stderr.write(
        `wos daemon: terminal restore failed: ${(e as Error).message}\n`,
      );
    }
  }
  const certificateStatus = new CertificateStatusRegistry();
  const acmeManager: AcmeManager =
    opts.acmeManager ?? createAcmeManager({ logger: acmeLog });
  const certificateEvents = createCertificateEventPublisher(events);
  // Direct lifecycle dispatch — driven by listener-resolve and the renewal
  // scheduler so each event fires exactly when the underlying ACME action
  // succeeds or fails, never when the status is merely transitioning.
  const publishCertificateLifecycle = (
    signal: import("./acme/status").CertificateLifecycleSignal,
  ) => {
    if (signal.kind === "issued") {
      certificateEvents.publishIssued({
        listenerKind: signal.listenerKind,
        source: signal.source,
        hostnames: signal.hostnames,
        ...(signal.notAfter ? { notAfter: signal.notAfter } : {}),
      });
    } else if (signal.kind === "renewed") {
      certificateEvents.publishRenewed({
        listenerKind: signal.listenerKind,
        source: signal.source,
        hostnames: signal.hostnames,
        ...(signal.notAfter ? { notAfter: signal.notAfter } : {}),
      });
    } else if (signal.kind === "activated") {
      certificateEvents.publishActivated({
        listenerKind: signal.listenerKind,
        source: signal.source,
        activatedAt: signal.activatedAt,
      });
    } else {
      certificateEvents.publishFailed({
        listenerKind: signal.listenerKind,
        source: signal.source,
        phase: signal.phase,
        message: signal.message,
      });
    }
  };
  if (globalConfig.tunnel.enabled) {
    const starter = opts.tunnelServerStarter ?? startTunnelServer;
    let tunnelTls: { cert: string; key: string } | undefined;
    if (globalConfig.tunnel.ssl?.enabled) {
      const result = await resolveListenerSsl({
        kind: "tunnel",
        ssl: globalConfig.tunnel.ssl,
        ctx: { tunnelDomain: globalConfig.tunnel.domain },
        acmeManager,
        statusRegistry: certificateStatus,
        onLifecycle: publishCertificateLifecycle,
      });
      if (result.failed) {
        tunnelLog.warn("tunnel SSL disabled", { error: result.errorMessage });
        process.stderr.write(
          `wos daemon: tunnel SSL disabled — ${result.errorMessage}\n`,
        );
      } else {
        tunnelTls = result.tls;
      }
    }
    try {
      const tunnelServer = await starter({
        port: globalConfig.tunnel.port,
        ...(globalConfig.tunnel.publicPort !== undefined
          ? { publicPort: globalConfig.tunnel.publicPort }
          : {}),
        domain: globalConfig.tunnel.domain,
        ...(tunnelTls ? { tls: tunnelTls } : {}),
      });
      tunnels.setServer(tunnelServer);
    } catch (e) {
      tunnelLog.error("tunnel server bind failed", {
        port: globalConfig.tunnel.port,
        error: (e as Error).message,
      });
      process.stderr.write(
        `wos daemon: tunnel server bind failed on port ${globalConfig.tunnel.port}: ${(e as Error).message}\n`,
      );
    }
  }

  if (opts.restorePersistedState !== false) {
    // Service tunnel restoration only runs when service tunnel publication
    // is enabled. With it disabled, persisted tunnel restore labels are left
    // intact on disk but no routes are registered and no active-tunnel events
    // are emitted. The daemon-scoped Web UI route is registered separately,
    // further below, after the local Web UI listener is bound.
    if (globalConfig.tunnel.serviceTunnels.enabled) {
      try {
        const tunnelResult = await restoreTunnelsFromSessions(tunnels, {
          warn: (m) => {
            tunnelLog.warn(m);
            process.stderr.write(`${m}\n`);
          },
          dockerRunner,
          dockerState,
        });
        if (tunnelResult.restored > 0) {
          process.stderr.write(
            `wos daemon: restored ${tunnelResult.restored} tunnel route(s) from existing state\n`,
          );
        }
      } catch (e) {
        process.stderr.write(
          `wos daemon: tunnel restoration failed: ${(e as Error).message}\n`,
        );
      }
    }

    try {
      const discovered = await discoverProjectsFromSessions();
      if (discovered.registered.length > 0) {
        process.stderr.write(
          `wos daemon: auto-registered ${discovered.registered.length} project(s) from existing sessions\n`,
        );
      }
    } catch (e) {
      process.stderr.write(
        `wos daemon: project discovery failed: ${(e as Error).message}\n`,
      );
    }

    try {
      const result = await restoreMonitorsFromSessions(monitors, tunnels, {
        warn: (m) => process.stderr.write(`${m}\n`),
        healthcheckDefaults,
        dockerState,
        createCollector: ({ sessionName, state, config, worktreeRoot }) =>
          backends.select({ config, state }).createMonitorCollector({
            sessionName,
            config,
            tunnels,
            worktreeRoot,
            composeContext: {
              projectName: state.projectName,
              composeFile: state.composeFile,
              composeFiles: state.composeFiles,
            },
            portAssignments: state.portAssignments,
            healthcheckDefaults,
          }),
      });
      if (result.restored > 0) {
        process.stderr.write(
          `wos daemon: restored ${result.restored} session monitor(s) from existing state\n`,
        );
      }
    } catch (e) {
      process.stderr.write(
        `wos daemon: monitor restoration failed: ${(e as Error).message}\n`,
      );
    }
  }

  const tunnelWebUi: GlobalTunnelWebUiConfig = globalConfig.tunnel.webUi;
  // When the caller did not provide a scheduler, leave it undefined — the UI
  // API handler returns 503 on the restart endpoint. The CLI entrypoint that
  // boots the daemon supplies the production scheduler explicitly so tests
  // and embedded callers can opt out by passing `restartScheduler: undefined`.
  const restartScheduler = opts.restartScheduler;
  const transcriptTelemetry = terminalLayer
    ? new TranscriptTelemetryReader({ terminalLayer, logger })
    : undefined;
  // Eagerly re-bind restored sessions that carry a persisted transcript
  // binding so telemetry is recomputed from the transcript before any client
  // attaches, seeding compact-carry from the record. Live sessions re-bind on
  // their next `session_start` event as usual.
  if (transcriptTelemetry) {
    for (const entry of restoredTerminals) {
      const transcript = entry.transcript;
      if (!transcript) continue;
      transcriptTelemetry.bind(
        entry.metadata.id,
        transcript.path,
        transcript.agentSessionId,
        undefined,
        {
          mainCarry: transcript.mainCarry,
          subagentCarry: transcript.subagentCarry,
        },
        // Re-select the parser from the persisted agent (absent on pre-codex
        // records → claude). The fallback model is recomputed from the rollout's
        // own session_meta, so it is not persisted.
        { agent: transcript.agent ?? "claude" },
      );
    }
  }
  const agentActivity = new AgentActivityIngest({
    token: agentToken,
    terminalLayer,
    events,
    logger,
    ...(transcriptTelemetry ? { transcriptTelemetry } : {}),
    resolveWorktreePath: async (cwd) => {
      try {
        const ctx = await resolveSession(cwd);
        return ctx.worktreeRoot;
      } catch {
        return null;
      }
    },
  });
  agentActivity.startStalenessSweep();

  // Notification engine: one decider, many deliverers. Subscribes to the bus
  // (agent.done / agent.question) and fans out to the Telegram / Web Push
  // channels. `notification.raised` and Web Push are delivered only when no
  // browser client is focused (the user is away); presence is reported by the
  // web client through POST /ui/v1/presence. The VAPID keypair is generated once
  // and persisted in the state dir for Web Push.
  const vapidKeys = await loadOrCreateVapidKeys();
  const notifications = new NotificationService({
    bus: events,
    config: globalConfig.notifications ?? defaultNotificationsConfig(),
    vapid: vapidKeys,
  });
  notifications.start();

  // Declared before the UI API handler so health responses can lazily read
  // the bound listener location.
  let web: DaemonWebHandle | undefined;

  const uiApiHandler = createUiApiHandler({
    registry,
    sessions,
    tunnels,
    events,
    agentActivity,
    notifications,
    monitors,
    dockerState,
    terminalLayer,
    resolveSession,
    gitRunner: timedWorktreeGitRunner(
      opts.gitRunner ?? defaultWorktreeGitRunner,
      perfLog,
    ),
    dockerRunner,
    logStreamKeepaliveMs: opts.logStreamKeepaliveMs,
    // Resolve healthcheck defaults fresh per operation so a saved config change
    // applies without a daemon restart. The startup-captured `healthcheckDefaults`
    // is still used for boot-time monitor restoration above.
    healthcheckDefaultsLoader: async () =>
      effectiveHealthcheckDefaults(await loadGlobalConfig()),
    tunnelWebUi,
    certificateStatus,
    restartScheduler,
    stopScheduler: opts.stopScheduler,
    daemonId,
    webInfo: () =>
      web
        ? { host: web.hostname, port: web.port, scheme: web.scheme }
        : undefined,
    ...(opts.setupEnvironment
      ? { setupEnvironment: opts.setupEnvironment }
      : {}),
  });

  const terminalWs = createTerminalLayerWsHandlers(terminalLayer);

  // The web listener is the mandatory control plane: bind or TLS-resolution
  // failure fails daemon startup instead of falling back to a degraded mode.
  const webOpts: DaemonWebOptions = { ...(opts.web ?? {}) };
  if (globalConfig.web?.ssl?.enabled && !webOpts.tls) {
    const sslResult = await resolveListenerSsl({
      kind: "web",
      ssl: globalConfig.web.ssl,
      ctx: {
        publicHostname: tunnelWebUi.enabled ? tunnelWebUi.hostname : undefined,
      },
      acmeManager,
      statusRegistry: certificateStatus,
      onLifecycle: publishCertificateLifecycle,
    });
    if (sslResult.failed) {
      throw new Error(
        `daemon web SSL resolution failed: ${sslResult.errorMessage ?? "unknown error"}`,
      );
    }
    if (sslResult.tls) webOpts.tls = sslResult.tls;
  }
  // Bind the mandatory control-plane listener. On `wos restart` the previous
  // daemon can still be releasing the port for a moment after it stops
  // answering health checks — slower on Windows, and when the web UI kept SSE
  // connections open — so retry briefly on EADDRINUSE instead of failing the
  // restart. Other bind errors (bad host, permission) fail fast.
  const BIND_RETRY_INTERVAL_MS = 100;
  const bindRetryMs = opts.bindRetryMs ?? 5_000;
  let bindError: Error | undefined;
  const bindDeadline = Date.now() + bindRetryMs;
  for (;;) {
    bindError = undefined;
    web = await startDaemonWeb(
      { ...webOpts, onBindError: (e) => (bindError = e) },
      {
        uiApiHandler,
        websocketHandlers: terminalWs,
      },
    );
    if (web) break;
    const addressInUse =
      (bindError as NodeJS.ErrnoException | undefined)?.code === "EADDRINUSE";
    process.stderr.write(
      `[bindretry] web=${!!web} code=${(bindError as NodeJS.ErrnoException | undefined)?.code} inUse=${addressInUse} remaining=${bindDeadline - Date.now()}ms\n`,
    );
    if (!addressInUse || Date.now() >= bindDeadline) break;
    await new Promise((resolve) => setTimeout(resolve, BIND_RETRY_INTERVAL_MS));
  }
  // Free-port fallback: the configured/default port is still busy after the
  // restart-retry window. Rather than fail startup, probe upward for the next
  // free port and bind it — the effective port is recorded in daemon metadata
  // below (from `web.port`), so discovery and agents follow the selected port.
  // Only applies to a concrete non-zero preferred port (port 0 already means
  // "let the OS pick a free port"). A non-EADDRINUSE error is not a port
  // conflict and falls through to the hard failure below.
  const preferredPort = webOpts.port ?? 0;
  if (
    !web &&
    preferredPort !== 0 &&
    (bindError as NodeJS.ErrnoException | undefined)?.code === "EADDRINUSE"
  ) {
    const host = webOpts.host ?? "127.0.0.1";
    let searchFrom = preferredPort + 1;
    for (
      let attempt = 0;
      attempt < FREE_PORT_FALLBACK_ATTEMPTS && searchFrom <= 65535;
      attempt++
    ) {
      const candidate = selectNextFreePort(searchFrom, (p) => probePortFree(p, host));
      bindError = undefined;
      web = await startDaemonWeb(
        { ...webOpts, port: candidate, onBindError: (e) => (bindError = e) },
        { uiApiHandler, websocketHandlers: terminalWs },
      );
      if (web) {
        process.stderr.write(
          `wos daemon: web.port ${preferredPort} is in use; bound free port ${candidate} instead\n`,
        );
        break;
      }
      // A race lost the candidate to another listener; probe past it. A
      // non-EADDRINUSE error is not a port conflict — stop and let the hard
      // failure below report it.
      if ((bindError as NodeJS.ErrnoException | undefined)?.code !== "EADDRINUSE") {
        break;
      }
      searchFrom = candidate + 1;
    }
  }
  if (!web) {
    const host = webOpts.host ?? "127.0.0.1";
    const port = webOpts.port ?? 0;
    throw new Error(
      `daemon web listener could not bind ${host}:${port}: ${(bindError as Error | undefined)?.message ?? "unknown error"}. ` +
        `Free the port or change web.host/web.port in the global config.`,
    );
  }
  agentDaemonUrl = web.url;

  if (tunnelWebUi.enabled) {
    if (!tunnels.getServer()) {
      process.stderr.write(
        `wos daemon: public web tunnel route ${tunnelWebUi.hostname} not registered (tunnel server unavailable)\n`,
      );
    } else {
      const result = tunnels.registerDaemonRoute({
        hostname: tunnelWebUi.hostname,
        hostPort: web.port,
        backendProtocol: web.scheme === "https" ? "https" : "http",
        routeType: "daemon-web-ui",
        whitelistIps: tunnelWebUi.whitelistIps,
      });
      if (!result.ok) {
        process.stderr.write(
          `wos daemon: public web tunnel route ${tunnelWebUi.hostname} not registered (${result.reason})\n`,
        );
      }
    }
  }

  const metadata: DaemonMetadata = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    protocol: DAEMON_PROTOCOL_VERSION,
    daemonId,
    webUrl: web.url,
    webHost: web.hostname,
    webPort: web.port,
    webScheme: web.scheme,
  };
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + "\n");

  // Wire the renewal scheduler so the tunnel listener renews before expiry
  // and rotates in place. The local Web UI listener is always HTTP, so no
  // ACME listener is registered for it.
  const acmeListeners: import("./acme/scheduler").ManagedListener[] = [];
  if (
    globalConfig.tunnel.enabled &&
    globalConfig.tunnel.ssl?.enabled &&
    globalConfig.tunnel.ssl.source === "letsencrypt"
  ) {
    acmeListeners.push({
      kind: "tunnel",
      letsencrypt: globalConfig.tunnel.ssl.letsencrypt,
      hostnames: [
        globalConfig.tunnel.domain,
        `*.${globalConfig.tunnel.domain}`,
      ],
      rotate: async (material) => {
        const tunnelStarter = opts.tunnelServerStarter ?? startTunnelServer;
        const rotation = await rotateTunnelListener({
          registry: tunnels,
          material,
          start: async (tls) =>
            await tunnelStarter({
              port: globalConfig.tunnel.enabled
                ? globalConfig.tunnel.port
                : DEFAULT_TUNNEL_PORT,
              ...(globalConfig.tunnel.publicPort !== undefined
                ? { publicPort: globalConfig.tunnel.publicPort }
                : {}),
              domain: globalConfig.tunnel.enabled
                ? globalConfig.tunnel.domain
                : "",
              tls,
            }),
        });
        if (!rotation.ok) throw new Error(rotation.message ?? "rotation failed");
      },
    });
  }
  const scheduler =
    acmeListeners.length > 0
      ? createRenewalScheduler({
          manager: acmeManager,
          statusRegistry: certificateStatus,
          onLifecycle: publishCertificateLifecycle,
          listeners: acmeListeners,
          logger: acmeLog,
        })
      : undefined;
  scheduler?.start();

  const stop = async () => {
    if (scheduler) await scheduler.stop();
    agentActivity.stopStalenessSweep();
    notifications.stop();
    transcriptTelemetry?.stop();
    await web.stop();
    await terminalLayer.shutdown();
    monitors.shutdown();
    events.shutdown();
    await sessions.shutdown();
    await tunnels.shutdown();
    await dockerState.stop();
    await logger.close();
    // Only remove the metadata file if it still belongs to this process — on
    // restart the successor daemon has already written its own metadata, and
    // deleting it here would strip the new daemon's discovery file.
    try {
      const current = JSON.parse(
        await readFile(metadataPath, "utf8"),
      ) as DaemonMetadata;
      if (current.pid === process.pid) {
        await rm(metadataPath, { force: true });
      }
    } catch {
      /* missing or unreadable — nothing to clean up */
    }
  };

  return {
    metadataPath,
    daemonId,
    webUrl: web.url,
    webBindHostname: web.hostname,
    webScheme: web.scheme,
    stop,
    registry,
    sessions,
    tunnels,
    events,
    monitors,
    terminalLayer,
    certificateStatus,
    dockerState,
  };
}

export function runtimeArgumentsFromUpRequest(
  req: { arguments?: unknown },
): Record<string, string> | undefined {
  if (req.arguments === undefined) return undefined;
  if (
    req.arguments === null ||
    typeof req.arguments !== "object" ||
    Array.isArray(req.arguments)
  ) {
    throw new Error("arguments must be a string-to-string object");
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.arguments as Record<string, unknown>)) {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("arguments keys must be non-empty strings");
    }
    if (typeof value !== "string") {
      throw new Error(`arguments[${key}] must be a string`);
    }
    result[key] = value;
  }
  return result;
}

export function selectionFromUpRequest(
  req: { services?: string[]; target?: string },
): ServiceSelectionInput | undefined {
  if (req.services !== undefined && req.target !== undefined) {
    throw new Error("services and target are mutually exclusive");
  }
  if (req.target !== undefined) {
    if (typeof req.target !== "string" || req.target.length === 0) {
      throw new Error("target must be a non-empty string");
    }
    return { kind: "target", target: req.target };
  }
  if (req.services !== undefined) {
    if (!Array.isArray(req.services) || req.services.length === 0) {
      throw new Error("services must be a non-empty array");
    }
    for (const name of req.services) {
      if (typeof name !== "string" || name.length === 0) {
        throw new Error("services entries must be non-empty strings");
      }
    }
    return { kind: "services", services: req.services };
  }
  return undefined;
}

/**
 * Build the argv for the Windows restart launcher.
 *
 * Why a PowerShell `Start-Process` launcher instead of a direct spawn:
 * `Bun.serve` creates an *inheritable* listening socket on Windows, and any
 * child spawned with `bInheritHandles=TRUE` — which is what both `Bun.spawn`
 * and `node:child_process` do — inherits that socket handle. The restart child
 * outlives this daemon (it stops the daemon, then spawns the replacement on the
 * same port), so an inherited socket keeps the old TCP port bound for the
 * child's entire lifetime: the new daemon can never bind and the process hangs
 * holding a dead port until it is killed. `Start-Process` launches with
 * `bInheritHandles=FALSE`, severing the inheritance so the restart child — and
 * the daemon it spawns — start with a clean handle table. `-WindowStyle Hidden`
 * keeps it silent. Verified empirically; a direct `Bun.spawn` here regresses.
 *
 * POSIX is unaffected (its sockets are close-on-exec), and the terminal
 * `wos restart` works on Windows too because its parent is the shell, which
 * never held the daemon socket. `cmd` is `[exec, ...args]`; args are wrapped in
 * double quotes and passed to `Start-Process` as a single verbatim argument
 * string so paths with spaces survive.
 */
export function buildWindowsRestartLauncher(cmd: string[]): string[] {
  const psSingleQuote = (s: string) => s.replace(/'/g, "''");
  const exec = cmd[0] ?? "";
  const argList = cmd
    .slice(1)
    .map((a) => `"${a}"`)
    .join(" ");
  const psCommand =
    `Start-Process -FilePath '${psSingleQuote(exec)}'` +
    (argList ? ` -ArgumentList '${psSingleQuote(argList)}'` : "") +
    " -WindowStyle Hidden";
  return [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    psCommand,
  ];
}

/**
 * Production daemon restart scheduler. Launches a child process that re-runs
 * `wos restart`, which stops the current daemon and starts a fresh one. The
 * child outlives this process so the restart can proceed after the current
 * daemon exits.
 *
 * On Windows the child must be launched without inheriting this daemon's
 * listening socket (see `buildWindowsRestartLauncher`); on POSIX a plain
 * detached-by-orphan `Bun.spawn` suffices.
 *
 * The spawn is performed inside a microtask so the HTTP response that
 * triggered the restart is fully flushed before any child process work begins.
 */
export function defaultRestartScheduler(): void {
  queueMicrotask(() => {
    try {
      const compiled = isCompiledStandalone();
      const execPath = process.execPath;
      const script = process.argv[1];
      const cmd =
        compiled || typeof script !== "string" || script.length === 0
          ? [execPath, "restart"]
          : [execPath, script, "restart"];
      const spawnCmd =
        process.platform === "win32" ? buildWindowsRestartLauncher(cmd) : cmd;
      const proc = Bun.spawn(spawnCmd, {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
        ...(process.platform === "win32" ? { windowsHide: true } : {}),
      });
      proc.unref();
    } catch (e) {
      process.stderr.write(
        `wos daemon: restart scheduling failed: ${(e as Error).message}\n`,
      );
    }
  });
}
