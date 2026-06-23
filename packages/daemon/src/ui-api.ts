import { resolve, isAbsolute, relative as relativePath, sep as pathSep } from "node:path";
import { realpath, readFile, writeFile } from "node:fs/promises";
import { timingSafeEqual as timingSafeEqualBuf } from "node:crypto";
import {
  encodeEnvelope,
  encodeSessionLogEnvelope,
  type ConflictResponse,
  type OperationMetadata,
  type StreamEnvelope,
} from "./daemon-protocol";
import {
  buildClearCookieHeader,
  buildSetCookieHeader,
  DEFAULT_AUTH_COOKIE_MAX_AGE_SECONDS,
  extractAuthCookie,
  isEffectivelyHttpsRequest,
  isPublicTunnelRequest,
  signAuthCookie,
  verifyAuthCookie,
} from "./public-auth";
import {
  buildManagementSnapshot,
  diffChangedPaths,
  effectiveHealthcheckDefaults,
  loadGlobalConfig,
  resolveCommitMessageProvider,
  restartRequiredForSave,
  saveGlobalConfig,
  type GlobalConfig,
  type GlobalTunnelWebUiConfig,
} from "@worktreeos/core/global-config";
import { loadRepoConfig } from "@worktreeos/core/repo-config";
import { generateCommitMessage, LlmError } from "@worktreeos/core/llm";
import { spawn as nodeSpawn } from "node:child_process";
import type { OperationRegistry } from "./operation-registry";
import type { DaemonSessionRegistry } from "./daemon-sessions";
import type { TunnelRegistry } from "@worktreeos/runtime/tunnel-registry";
import type { AgentActivityIngest } from "./agent-activity-ingest";
import type { NotificationService } from "./notifications/service";
import {
  ensureClaudePluginInstalled,
  ensureCodexPluginInstalled,
  getAgentPluginStatus,
  injectOpencodePlugin,
  injectPiExtension,
  reinstallClaudePlugin,
} from "./agent-plugin-install";
import { DaemonEventBus } from "./event-bus";
import type { SessionMonitorRegistry } from "./session-monitor";
import {
  TerminalSessionManagerError,
  type TerminalSessionManager,
} from "./terminal-layer/manager";
import { detectTerminalBackendAvailability } from "./terminal-layer/tmux-backend";
import {
  handleTerminalCreate as handleTerminalLayerCreate,
  handleTerminalGet as handleTerminalLayerGet,
  handleTerminalList as handleTerminalLayerList,
  handleTerminalRename as handleTerminalLayerRename,
  handleTerminalTerminate as handleTerminalLayerTerminate,
  buildTerminalForbiddenResponse,
  type TerminalApiContext,
  type TerminalCreateBody,
  type TerminalRenameBody,
} from "./terminal-layer/api";
import type { TerminalLayerWsData } from "./terminal-layer/ws-handler";
import {
  createRuntimeCollector,
  createShellCollector,
} from "./session-monitor-runtime";
import { cachedSessionServicesOrNull } from "./docker/docker-cache-adapter";
import { shellServiceStatuses } from "@worktreeos/runtime/shell";
import type { DockerStateStore } from "./docker/docker-state-store";
import {
  encodeSseFrame,
  encodeSseKeepalive,
  parseLastEventId,
} from "./unified-event-sse";
import {
  publishOperationConflict,
  publishOperationFinished,
  publishOperationStarted,
  publishProjectAdded,
  publishProjectUpdated,
  publishStatusCatalogChanged,
  publishWorktreeBoardChanged,
  publishWorktreeCommentChanged,
  publishWorktreeCreated,
  publishWorktreeRemoved,
  publishWorktreeStatusChanged,
  publishWorktreeUpdated,
  wrapObserverWithUnified,
} from "./unified-publishers";
import {
  addWorktreeComment,
  getWorktreeComments,
  getWorktreeDisplayName,
  getWorktreeNote,
  loadProjects,
  ProjectRegistryError,
  registerProjectBySourcePath,
  removeWorktreeComment,
  removeWorktreeDisplayName,
  setWorktreeDisplayName,
  setWorktreeNote,
  type ProjectRecord,
} from "@worktreeos/core/project-registry";
import {
  createStatus,
  deleteStatus,
  loadStatusCatalog,
  StatusCatalogError,
  updateStatus,
} from "@worktreeos/core/status-catalog";
import {
  appendOrder,
  clearAssignment,
  getAssignment,
  loadBoard,
  reassignStatusToUnassigned,
  setAssignment,
  type WorktreeBoardFile,
} from "@worktreeos/core/worktree-board";
import {
  resolveProjectPath,
  ProjectResolveError,
} from "@worktreeos/core/project-resolve";
import {
  branchExistsInSource,
  collectStagedDiffSet,
  collectUnstagedDiffSet,
  commit as gitCommit,
  createBranchInPlace,
  fetch as gitFetch,
  createBranchWorktreeFromSource,
  createDetachedWorktreeFromSource,
  defaultWorktreeGitRunner,
  detectHeadState,
  GitError,
  isSourceWorktree,
  NothingStagedError,
  parsePorcelainEntries,
  parseWorktreeList,
  push as gitPush,
  readStagedDiff,
  readUnstagedDiff,
  readWorktreeDirtyStatus,
  removeWorktreeFromSource,
  selectSourceWorktree,
  SOURCE_WORKTREE_REMOVE_MESSAGE,
  stageAllChanges,
  stageFiles,
  unstageFiles,
  type HeadState,
  type WorktreeDirtyStatus,
  type WorktreeEntry,
  type WorktreeGitRunner,
} from "@worktreeos/core/git";
import { existsSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { dirname, basename } from "node:path";
import {
  ManagedWorktreePathError,
  resolveManagedWorktreePath,
} from "@worktreeos/core/managed-worktrees";
import { buildDiffSet } from "@worktreeos/core/diff-parse";
import type { ReviewDiffResponse } from "@worktreeos/core/diff-types";
import {
  sessionNameForWorktree,
  sessionRootForWorktree,
} from "@worktreeos/core/paths";
import {
  clearUpFailure,
  readState,
  readUpFailure,
  removeSessionRootForWorktree,
  stateBackend,
  stateFilePath,
  upFailureFilePath,
  writeUpFailure,
  type WosState,
  type UpFailureRecord,
} from "@worktreeos/core/state";
import { resolveSessionContext, type SessionContext } from "@worktreeos/core/session-context";
import {
  ConfigError,
  deploymentModeOf,
  isComposeMode,
  isShellMode,
  loadConfig,
  selectDeployConfig,
  ROOT_DEPLOY_CONFIG_FILENAME,
  WORKTREE_DEPLOY_CONFIG_FILENAME,
  PROJECT_CONFIG_DIRNAME,
  type ResolvedHealthcheckDefaults,
} from "@worktreeos/core/config";
import { buildComposeCommandEnvironment } from "@worktreeos/compose/compose-env";
import {
  buildServiceExecCommand,
  DeploymentCancelledError,
  runDownOperation,
  runServiceRestartOperation,
  runServiceStopOperation,
  runStatusOperation,
  runUpOperation,
  ServiceOperationError,
  type ServiceExecCommand,
} from "@worktreeos/runtime/operations";
import type { DeploymentObserver } from "@worktreeos/core/events";
import { computeProjectName } from "@worktreeos/core/project-name";
import {
  composePs,
  defaultDockerRunner,
  type DockerRunner,
} from "@worktreeos/compose/compose";
import { parseComposePs } from "@worktreeos/compose/ps";
import { INIT_SERVICE_NAME } from "@worktreeos/compose/generated-compose";
import { emptyTunnelResolution, type TunnelPreparer } from "@worktreeos/runtime/up-program";
import { runtimeArgumentsFromUpRequest, selectionFromUpRequest } from "./daemon-server";
import {
  UI_API_VERSION,
  WORKTREE_FILE_MAX_BYTES,
  type DiffResponse,
  type DirectoryListResponse,
  type DirectorySuggestion,
  type ProjectConfigStatus,
  type SetupStatusResponse,
  type WorktreeFileContentResponse,
  type WorktreeFileEntry,
  type WorktreeFileErrorBody,
  type WorktreeFileTreeResponse,
  type WorktreeFileWriteRequest,
  type WorktreeFileWriteResponse,
  type WorktreeUpConfigErrorBody,
  type ProjectAddRequest,
  type ProjectAddResponse,
  type ProjectListResponse,
  type ProjectPathValidateResponse,
  type ProjectSummary,
  type ServiceSummary,
  type WorktreeResourceUsage,
  type WorktreeCreateRequest,
  type WorktreeCreateResponse,
  type WorktreeDetailResponse,
  type DeployFreshness,
  type WorktreeRenameRequest,
  type WorktreeRenameResponse,
  type WorktreeNoteRequest,
  type WorktreeNoteResponse,
  type StatusCatalogResponse,
  type StatusCreateRequest,
  type StatusCreateResponse,
  type StatusUpdateRequest,
  type StatusUpdateResponse,
  type StatusDeleteResponse,
  type WorktreeStatusRequest,
  type WorktreeStatusResponse,
  type WorktreeCommentsResponse,
  type WorktreeCommentAddRequest,
  type WorktreeCommentAddResponse,
  type WorktreeCommentDeleteRequest,
  type WorkflowStatusDto,
  type WorktreeOpenEditorRequest,
  type WorktreeOpenEditorResponse,
  type WorktreeFailureContext,
  type WorktreeSummary,
  type WorktreeDirtyErrorBody,
  type WorktreeDownRequest,
  type WorktreeDownResponse,
  type WorktreeRemoveRequest,
  type WorktreeRemoveResponse,
  type WorktreeServiceRequest,
  type WorktreeServiceRestartResponse,
  type WorktreeServiceStopResponse,
  type WorktreeExecRequest,
  type WorktreeExecResponse,
  type WorktreeGitStageRequest,
  type WorktreeGitStageResponse,
  type WorktreeGitCommitRequest,
  type WorktreeGitCommitResponse,
  type WorktreeGitBranchRequest,
  type WorktreeGitBranchResponse,
  type WorktreeGitFetchRequest,
  type WorktreeGitFetchResponse,
  type WorktreeGitPushRequest,
  type WorktreeGitPushResponse,
  type WorktreeCommitMessageRequest,
  type WorktreeCommitMessageResponse,
  type GitWriteErrorBody,
  type WorktreeUpRequest,
  type WorktreeUpResponse,
  type DaemonRestartResponse,
  type DaemonStopResponse,
  type UiHealthResponse,
} from "./ui-protocol";
import { DAEMON_PROTOCOL_VERSION } from "./daemon-protocol";
import {
  classifyDeploymentStatus,
  type ServiceCollectionState,
} from "@worktreeos/core/deployment-status";

const UI_API_PREFIX = "/ui/v1";
const DEFAULT_LOG_STREAM_KEEPALIVE_MS = 15_000;
/**
 * Upper bound the stop request waits for an aborted `up` to unwind before it
 * proceeds to take the deployment down anyway. The healthcheck wait loop exits
 * immediately on abort, so the common case resolves far sooner; this only
 * guards against a stop landing while a non-interruptible step (e.g. a long
 * `docker compose up`) is mid-flight.
 */
const ABORT_DRAIN_TIMEOUT_MS = 15_000;
const NDJSON_HEARTBEAT = new TextEncoder().encode("\n");
/**
 * Hard cap on directory entries returned to a single autocomplete request.
 * Keeps response payload bounded for very wide directories and limits the
 * number of per-entry git probes we run when computing Git markers.
 */
const DIRECTORY_AUTOCOMPLETE_LIMIT = 200;

/**
 * Bounds for the Mission Control snapshot-stream cadence (the artificial
 * render delay, in ms). The spike found 250 ms–2 s felt live; the upper bound
 * is generous so a user can throttle a busy wall, and the default lands on a
 * calm 1 s. The stream clamps any client-requested cadence into this range.
 */
const SNAPSHOT_CADENCE_MIN_MS = 250;
const SNAPSHOT_CADENCE_MAX_MS = 5_000;
const SNAPSHOT_CADENCE_DEFAULT_MS = 1_000;

/** Clamp a client-supplied snapshot cadence into the safe range. */
export function clampSnapshotCadenceMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return SNAPSHOT_CADENCE_DEFAULT_MS;
  return Math.min(
    SNAPSHOT_CADENCE_MAX_MS,
    Math.max(SNAPSHOT_CADENCE_MIN_MS, Math.round(value)),
  );
}

export interface UiApiDependencies {
  registry: OperationRegistry;
  sessions: DaemonSessionRegistry;
  tunnels: TunnelRegistry;
  /** Unified event bus. Required for the SSE event stream. */
  events?: DaemonEventBus;
  /** Session monitor registry used to start monitors on service discovery. */
  monitors?: SessionMonitorRegistry;
  /**
   * Daemon Docker state cache. When provided and synced, worktree detail and
   * project/worktree summaries read managed service state and counts from the
   * cache instead of running `docker compose ps`.
   */
  dockerState?: DockerStateStore;
  /**
   * Terminal-layer session manager. When provided, `/ui/v1/terminal-layer/*`
   * routes expose snapshot/control/attachment APIs backed by the actor and
   * WebSocket protocol. When omitted, all terminal routes return 503.
   */
  terminalLayer?: TerminalSessionManager;
  /**
   * Agent activity ingest pipeline. When provided, `POST /ui/v1/agent-events`
   * accepts plugin-reported activity events (bearer-token authenticated,
   * independent of the UI cookie auth). When omitted, the route returns 503.
   */
  agentActivity?: AgentActivityIngest;
  /**
   * Notification service (engine + channels + config persistence). When
   * provided, the `/ui/v1/settings/notifications*` routes read/update rules and
   * channel config, register Web Push subscriptions, and send test
   * notifications. When omitted, those routes return 503.
   */
  notifications?: NotificationService;
  /**
   * Keepalive interval for the SSE event stream in milliseconds. Defaults to
   * 15s. Set to `0` or a negative value to disable keepalive comments.
   */
  eventStreamKeepaliveMs?: number;
  /**
   * Keepalive interval for the NDJSON log stream in milliseconds. Defaults to
   * 15s. Set to `0` or a negative value to disable heartbeats — useful for
   * tests that assert exact envelope counts.
   */
  logStreamKeepaliveMs?: number;
  /** Override session resolver (tests). */
  resolveSession?: (cwd: string) => Promise<SessionContext>;
  /** Override worktree git runner (tests). */
  gitRunner?: WorktreeGitRunner;
  /** Optional override of the projects.json path (tests). */
  projectsFilePath?: string;
  /** Optional override of the statuses.json path (tests). */
  statusesFilePath?: string;
  /** Optional override of the board.json path (tests). */
  boardFilePath?: string;
  /** Hook called after a successful up submission (for tests/integration). */
  onUpSubmitted?: (ctx: SessionContext, operationId: string) => void;
  /** Provide the function that actually runs the up operation (tests). */
  upRunner?: typeof runUpOperation;
  /** Provide the function that runs down (tests). */
  downRunner?: typeof runDownOperation;
  /** Provide the function that runs service-stop (tests). */
  serviceStopRunner?: typeof runServiceStopOperation;
  /** Provide the function that runs service-restart (tests). */
  serviceRestartRunner?: typeof runServiceRestartOperation;
  /** Provide the function that builds the service exec command (tests). */
  serviceExecRunner?: typeof buildServiceExecCommand;
  /** Provide the function that runs status (tests). */
  statusRunner?: typeof runStatusOperation;
  /** Provide the docker runner used for lightweight sidebar ps checks (tests). */
  dockerRunner?: DockerRunner;
  /**
   * Resolve effective healthcheck timing defaults for the next status/up
   * operation. Read fresh per operation (not captured at startup) so a saved
   * `healthcheck` config change applies without a daemon restart; in-flight
   * operations keep the timing they already resolved. Defaults to reading
   * `<wos-home>/config.json`.
   */
  healthcheckDefaultsLoader?: () => Promise<ResolvedHealthcheckDefaults>;
  /**
   * Effective tunnel Web UI config. When `enabled`, tunnel-host requests gate
   * `/ui/v1/*` (except auth endpoints) behind a signed cookie keyed by the
   * configured secret.
   */
  tunnelWebUi?: GlobalTunnelWebUiConfig;
  /**
   * Read-only certificate status registry. When provided, the settings
   * snapshot includes per-listener certificate status.
   */
  certificateStatus?: import("./acme/status").CertificateStatusRegistry;
  /**
   * Override the auth cookie max age in milliseconds (tests). Defaults to
   * 30 days.
   */
  authCookieMaxAgeMs?: number;
  /** Override "now" for cookie issuance/verification (tests). */
  nowMs?: () => number;
  /**
   * Schedule daemon lifecycle restart work. Invoked AFTER the
   * `POST /ui/v1/daemon/restart` handler has built its HTTP response, so the
   * implementation must defer the actual process restart (e.g. detach a child
   * process) and never block the response. When omitted, the restart endpoint
   * returns a `503` error so environments without lifecycle control cannot
   * accidentally trigger restarts. Production callers wire this to spawn
   * `wos restart` in a detached child process.
   */
  restartScheduler?: () => void | Promise<void>;
  /**
   * Schedule daemon shutdown work. Invoked AFTER the `POST /ui/v1/daemon/stop`
   * handler has built its HTTP response, so the implementation must defer the
   * actual shutdown and never block the response. When omitted, the stop
   * endpoint returns a `503` error. Production callers wire this to the
   * foreground daemon's graceful shutdown path; stopping the daemon never
   * stops deployed worktree services.
   */
  stopScheduler?: () => void | Promise<void>;
  /**
   * Identifier generated fresh per daemon startup, surfaced through
   * `GET /ui/v1/health` so clients can distinguish a restarted daemon from
   * stale metadata. Defaults to a random UUID per handler creation.
   */
  daemonId?: string;
  /**
   * Lazily resolve the bound web listener location for health responses. The
   * listener binds after the handler is created, so this is read per request.
   */
  webInfo?: () =>
    | { host: string; port: number; scheme: "http" | "https" }
    | undefined;
  /**
   * Resolve the configured editor command for `POST /ui/v1/worktrees/open-editor`
   * (tests). Defaults to reading `editorCommand` from the global config.
   */
  editorCommandLoader?: () => Promise<string | undefined>;
  /**
   * Spawn the editor process (tests). Defaults to `node:child_process` spawn
   * with `shell: true`, detached, stdio ignored. Returns a handle exposing an
   * `unref` so the daemon does not wait on the editor.
   */
  editorSpawn?: (
    command: string,
    env: NodeJS.ProcessEnv,
  ) => { unref: () => void };
  /**
   * Resolve the effective global config for AI commit-message generation
   * (tests). Defaults to reading `<wos-home>/config.json`.
   */
  commitMessageConfigLoader?: () => Promise<GlobalConfig>;
  /** Generate a commit message from the staged diff (tests). */
  commitMessageGenerator?: typeof generateCommitMessage;
}

/**
 * Create the unified UI API request handler. Returns `null` for requests that
 * are not /ui/v1 routes — callers should fall back to their own logic.
 */
export function createUiApiHandler(
  deps: UiApiDependencies,
): (req: Request, server?: import("bun").Server) => Promise<Response | null> {
  const projectsFilePath = deps.projectsFilePath;
  const gitRunner = deps.gitRunner ?? defaultWorktreeGitRunner;
  const commitMessageConfigLoader =
    deps.commitMessageConfigLoader ?? (() => loadGlobalConfig());
  const commitMessageGenerator =
    deps.commitMessageGenerator ?? generateCommitMessage;
  const resolveSession =
    deps.resolveSession ?? ((cwd: string) => resolveSessionContext({ cwd }));
  const statusRunner = deps.statusRunner ?? runStatusOperation;
  const upRunnerFn = deps.upRunner ?? runUpOperation;
  const downRunnerFn = deps.downRunner ?? runDownOperation;
  const serviceStopRunnerFn =
    deps.serviceStopRunner ?? runServiceStopOperation;
  const serviceRestartRunnerFn =
    deps.serviceRestartRunner ?? runServiceRestartOperation;
  const serviceExecRunnerFn = deps.serviceExecRunner ?? buildServiceExecCommand;
  const dockerRunner = deps.dockerRunner ?? defaultDockerRunner;
  const logStreamKeepaliveMs =
    deps.logStreamKeepaliveMs ?? DEFAULT_LOG_STREAM_KEEPALIVE_MS;
  const tunnelWebUi: GlobalTunnelWebUiConfig =
    deps.tunnelWebUi ?? { enabled: false };
  const publicTerminalEnabled =
    tunnelWebUi.enabled && tunnelWebUi.terminalEnabled === true;
  const authCookieMaxAgeMs =
    deps.authCookieMaxAgeMs ?? DEFAULT_AUTH_COOKIE_MAX_AGE_SECONDS * 1000;
  const nowMs = deps.nowMs ?? (() => Date.now());
  const restartScheduler = deps.restartScheduler;
  const stopScheduler = deps.stopScheduler;
  const daemonId = deps.daemonId ?? crypto.randomUUID();
  const webInfo = deps.webInfo ?? (() => undefined);
  const editorCommandLoader =
    deps.editorCommandLoader ??
    (async () => (await loadGlobalConfig()).editorCommand);
  const healthcheckDefaultsLoader =
    deps.healthcheckDefaultsLoader ??
    (async () => effectiveHealthcheckDefaults(await loadGlobalConfig()));
  const editorSpawn =
    deps.editorSpawn ??
    ((command: string, env: NodeJS.ProcessEnv) =>
      nodeSpawn(command, [], {
        shell: true,
        env,
        stdio: ["ignore", "ignore", "ignore"],
        detached: true,
      }));
  const daemonStartedAt = nowMs();

  /**
   * In-flight `up` operations that can be aborted by a stop request, keyed by
   * session name. `abort` fires the operation's `AbortSignal` (interrupting the
   * healthcheck wait loop); `done` resolves once the operation's async runner
   * has fully unwound and released the registry lock, so a follow-up `down` can
   * take everything down without a 409 conflict.
   */
  const activeUpControls = new Map<
    string,
    { abort: AbortController; done: Promise<void> }
  >();

  /**
   * Abort any in-flight `up` for the session and wait (bounded) for it to
   * unwind. Returns once the operation released its registry lock, or after the
   * drain timeout — whichever comes first. Safe to call when no `up` is active.
   */
  async function abortActiveUp(sessionName: string): Promise<void> {
    const control = activeUpControls.get(sessionName);
    if (!control) return;
    control.abort.abort();
    await Promise.race([
      control.done,
      new Promise<void>((r) => setTimeout(r, ABORT_DRAIN_TIMEOUT_MS)),
    ]);
  }

  return async (
    req: Request,
    server?: import("bun").Server,
  ): Promise<Response | null> => {
    const url = new URL(req.url);
    if (!url.pathname.startsWith(UI_API_PREFIX)) return null;
    const sub = url.pathname.slice(UI_API_PREFIX.length);

    const auth = classifyRequestAuth(req, server);

    try {
      if (sub === "/auth/login" && req.method === "POST") {
        return handleAuthLogin(req);
      }
      if (sub === "/auth/session" && req.method === "GET") {
        return jsonResponse(200, {
          authenticated: auth.cookieValid,
          requiresAuth: auth.isPublic,
          daemonStartedAt,
        });
      }
      if (sub === "/auth/logout" && req.method === "POST") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": buildClearCookieHeader(),
          },
        });
      }

      // Bearer-token authenticated plugin ingest; deliberately outside the
      // UI cookie gate (plugins have no cookie session).
      if (sub === "/agent-events" && req.method === "POST") {
        if (!deps.agentActivity) {
          return errorResponse(
            503,
            "unavailable",
            "agent activity ingest unavailable",
          );
        }
        return deps.agentActivity.handle(req);
      }

      if (auth.isPublic && !auth.cookieValid) {
        return new Response(
          JSON.stringify({ error: "unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      if (sub === "/health" && req.method === "GET") {
        // Public tunnel clients only get minimal readiness; local clients get
        // the discovery metadata the CLI needs (protocol check, daemon id).
        if (auth.isPublic) {
          return jsonResponse(200, {
            ok: true,
            version: UI_API_VERSION,
          } satisfies UiHealthResponse);
        }
        const web = webInfo();
        return jsonResponse(200, {
          ok: true,
          version: UI_API_VERSION,
          protocol: DAEMON_PROTOCOL_VERSION,
          pid: process.pid,
          daemonId,
          startedAt: new Date(daemonStartedAt).toISOString(),
          ...(web
            ? { webHost: web.host, webPort: web.port, webScheme: web.scheme }
            : {}),
        } satisfies UiHealthResponse);
      }

      if (sub === "/setup/status" && req.method === "GET") {
        if (auth.isPublic) {
          return errorResponse(
            403,
            "forbidden",
            "setup status is not available on public/remote daemon web access",
          );
        }
        return handleSetupStatus();
      }

      if (sub === "/settings/config") {
        if (auth.isPublic) {
          return errorResponse(
            403,
            "forbidden",
            "settings management is not available on public/remote daemon web access",
          );
        }
        if (req.method === "GET") {
          const snapshot = await buildManagementSnapshot();
          const certificateStatus = deps.certificateStatus?.snapshot() ?? {};
          return jsonResponse(200, { config: snapshot, certificateStatus });
        }
        if (req.method === "PUT") {
          const body = await safeJson<unknown>(req);
          // Capture the previously persisted config before overwriting it so the
          // save can report whether a restart is actually required.
          const prev = await loadGlobalConfig();
          const result = await saveGlobalConfig(body);
          if (!result.ok) {
            return new Response(
              JSON.stringify({
                error: "validation",
                message: result.errors[0]?.message ?? "invalid settings",
                errors: result.errors,
              }),
              {
                status: 400,
                headers: { "content-type": "application/json" },
              },
            );
          }
          const next = await loadGlobalConfig();
          const changedPaths = diffChangedPaths(prev, next);
          // Live-apply the service-tunnel IP whitelist without a restart. The
          // updated policy affects subsequently opened/restored service tunnels;
          // already-active routes keep the policy they were registered with.
          if (changedPaths.includes("tunnel.serviceTunnels.whitelistIps")) {
            deps.tunnels.setServiceRoutePolicy(
              next.tunnel.serviceTunnels.whitelistIps,
            );
          }
          const certificateStatus = deps.certificateStatus?.snapshot() ?? {};
          return jsonResponse(200, {
            config: result.snapshot,
            certificateStatus,
            restartRequired: restartRequiredForSave(prev, next),
          });
        }
        return errorResponse(405, "method-not-allowed", `method ${req.method} not allowed`);
      }

      if (sub === "/settings/notifications") {
        if (auth.isPublic) {
          return errorResponse(
            403,
            "forbidden",
            "notification settings are not available on public/remote daemon web access",
          );
        }
        if (!deps.notifications) {
          return errorResponse(503, "unavailable", "notifications are not enabled");
        }
        if (req.method === "GET") {
          return jsonResponse(200, {
            config: deps.notifications.getRedactedConfig(),
            vapidPublicKey: deps.notifications.vapidPublicKey(),
          });
        }
        if (req.method === "PUT") {
          const body = await safeJson<unknown>(req);
          const config = await deps.notifications.updateSettings(
            (body ?? {}) as Parameters<NotificationService["updateSettings"]>[0],
          );
          return jsonResponse(200, { config });
        }
        return errorResponse(405, "method-not-allowed", `method ${req.method} not allowed`);
      }

      if (sub === "/settings/notifications/subscribe") {
        if (auth.isPublic) {
          return errorResponse(
            403,
            "forbidden",
            "notification settings are not available on public/remote daemon web access",
          );
        }
        if (!deps.notifications) {
          return errorResponse(503, "unavailable", "notifications are not enabled");
        }
        if (req.method !== "POST") {
          return errorResponse(405, "method-not-allowed", `method ${req.method} not allowed`);
        }
        const body = await safeJson<unknown>(req);
        const result = await deps.notifications.registerSubscription(body);
        if (!result.ok) {
          return errorResponse(400, "invalid", result.error ?? "invalid subscription");
        }
        return jsonResponse(200, { ok: true });
      }

      if (sub === "/settings/notifications/test") {
        if (auth.isPublic) {
          return errorResponse(
            403,
            "forbidden",
            "notification settings are not available on public/remote daemon web access",
          );
        }
        if (!deps.notifications) {
          return errorResponse(503, "unavailable", "notifications are not enabled");
        }
        if (req.method !== "POST") {
          return errorResponse(405, "method-not-allowed", `method ${req.method} not allowed`);
        }
        const body = (await safeJson<{ channel?: string; kind?: string }>(req)) ?? {};
        if (typeof body.channel !== "string") {
          return errorResponse(400, "invalid", "channel is required");
        }
        const kind =
          body.kind === "agent.done" || body.kind === "agent.question"
            ? body.kind
            : "agent.question";
        const result = await deps.notifications.sendTest(body.channel, kind);
        return jsonResponse(result.ok ? 200 : 502, {
          ok: result.ok,
          ...(result.error ? { error: result.error } : {}),
        });
      }

      // Client focus presence: the web client reports its window focus state so
      // the notification engine can gate delivery on real presence. Reachable by
      // any authenticated client (local or public); it records only a transient
      // focus bit and exposes no config. Malformed beacon bodies are rejected
      // without throwing and never alter recorded presence.
      if (sub === "/presence" && req.method === "POST") {
        if (!deps.notifications) {
          return errorResponse(503, "unavailable", "notifications are not enabled");
        }
        const body = await safeJson<{ clientId?: unknown; state?: unknown }>(req);
        const clientId = body?.clientId;
        const state = body?.state;
        if (
          typeof clientId !== "string" ||
          clientId.length === 0 ||
          (state !== "focused" && state !== "away")
        ) {
          return errorResponse(400, "invalid", "clientId and state are required");
        }
        deps.notifications.touchPresence(clientId, state);
        return new Response(null, { status: 204 });
      }

      if (sub === "/settings/terminal-backend/availability") {
        if (auth.isPublic) {
          return errorResponse(
            403,
            "forbidden",
            "settings management is not available on public/remote daemon web access",
          );
        }
        if (req.method !== "GET") {
          return errorResponse(
            405,
            "method-not-allowed",
            `method ${req.method} not allowed`,
          );
        }
        // Probe the multiplexer freshly per request (no adapter cache) so the
        // Terminal settings page's "Check again" reflects an install that
        // happened since the page loaded.
        const tmux = detectTerminalBackendAvailability();
        return jsonResponse(200, {
          tmux: {
            available: tmux.available,
            ...(tmux.reason ? { reason: tmux.reason } : {}),
            binary: tmux.binary,
            platform: tmux.platform,
          },
        });
      }

      if (sub === "/daemon/restart") {
        if (auth.isPublic) {
          return errorResponse(
            403,
            "forbidden",
            "daemon restart is not available on public/remote daemon web access",
          );
        }
        if (req.method !== "POST") {
          return errorResponse(
            405,
            "method-not-allowed",
            `method ${req.method} not allowed`,
          );
        }
        return handleDaemonRestart();
      }

      if (sub === "/daemon/stop") {
        if (auth.isPublic) {
          return errorResponse(
            403,
            "forbidden",
            "daemon stop is not available on public/remote daemon web access",
          );
        }
        if (req.method !== "POST") {
          return errorResponse(
            405,
            "method-not-allowed",
            `method ${req.method} not allowed`,
          );
        }
        return handleDaemonStop();
      }

      if (sub === "/projects" && req.method === "GET") {
        return handleProjectList();
      }
      if (sub === "/projects" && req.method === "POST") {
        return handleProjectAdd(await safeJson<ProjectAddRequest>(req));
      }
      if (sub === "/projects/validate" && req.method === "GET") {
        // Filesystem-touching read endpoint — gated by the same public-host
        // policy as terminal access. Local clients are always allowed.
        if (isPublicTerminalDenied(auth)) {
          return errorResponse(
            403,
            "forbidden",
            "filesystem browsing is not available for public clients without terminal access",
          );
        }
        const path = url.searchParams.get("path");
        if (!path) return errorResponse(400, "validation", "path is required");
        return handleProjectPathValidate(path);
      }
      if (sub === "/filesystem/directories" && req.method === "GET") {
        if (isPublicTerminalDenied(auth)) {
          return errorResponse(
            403,
            "forbidden",
            "filesystem browsing is not available for public clients without terminal access",
          );
        }
        const path = url.searchParams.get("path");
        if (!path) return errorResponse(400, "validation", "path is required");
        return handleDirectoryList(path);
      }
      if (sub === "/worktrees" && req.method === "GET") {
        const path = url.searchParams.get("path");
        if (!path) return errorResponse(400, "validation", "path is required");
        return handleWorktreeDetail(path);
      }
      if (sub === "/worktrees/up" && req.method === "POST") {
        return handleWorktreeUp(await safeJson<WorktreeUpRequest>(req));
      }
      if (sub === "/worktrees/down" && req.method === "POST") {
        return handleWorktreeDown(await safeJson<WorktreeDownRequest>(req));
      }
      if (sub === "/worktrees/remove" && req.method === "POST") {
        return handleWorktreeRemove(
          await safeJson<WorktreeRemoveRequest>(req),
        );
      }
      if (sub === "/worktrees/create" && req.method === "POST") {
        return handleWorktreeCreate(
          await safeJson<WorktreeCreateRequest>(req),
        );
      }
      if (sub === "/worktrees/name" && req.method === "PATCH") {
        return handleWorktreeRename(
          await safeJson<WorktreeRenameRequest>(req),
        );
      }
      if (sub === "/worktrees/note" && req.method === "PATCH") {
        return handleWorktreeNote(
          await safeJson<WorktreeNoteRequest>(req),
        );
      }
      if (sub === "/worktrees/status" && req.method === "PATCH") {
        return handleWorktreeStatus(
          await safeJson<WorktreeStatusRequest>(req),
        );
      }
      if (sub === "/worktrees/comments" && req.method === "GET") {
        const path = url.searchParams.get("path");
        if (!path) return errorResponse(400, "validation", "path is required");
        return handleWorktreeCommentsList(path);
      }
      if (sub === "/worktrees/comments" && req.method === "POST") {
        return handleWorktreeCommentAdd(
          await safeJson<WorktreeCommentAddRequest>(req),
        );
      }
      if (sub === "/worktrees/comments" && req.method === "DELETE") {
        return handleWorktreeCommentDelete(
          await safeJson<WorktreeCommentDeleteRequest>(req),
        );
      }
      if (sub === "/statuses" && req.method === "GET") {
        return handleStatusList();
      }
      if (sub === "/statuses" && req.method === "POST") {
        return handleStatusCreate(await safeJson<StatusCreateRequest>(req));
      }
      if (sub.startsWith("/statuses/") && req.method === "PATCH") {
        const id = decodeURIComponent(sub.slice("/statuses/".length));
        return handleStatusUpdate(id, await safeJson<StatusUpdateRequest>(req));
      }
      if (sub.startsWith("/statuses/") && req.method === "DELETE") {
        const id = decodeURIComponent(sub.slice("/statuses/".length));
        return handleStatusDelete(id);
      }
      if (sub === "/worktrees/open-editor" && req.method === "POST") {
        if (auth.isPublic) {
          return errorResponse(
            403,
            "forbidden",
            "opening an editor is not available on public/remote daemon web access",
          );
        }
        return handleWorktreeOpenEditor(
          await safeJson<WorktreeOpenEditorRequest>(req),
        );
      }
      if (sub === "/worktrees/services/stop" && req.method === "POST") {
        return handleServiceAction(
          "service-stop",
          await safeJson<WorktreeServiceRequest>(req),
        );
      }
      if (sub === "/worktrees/services/restart" && req.method === "POST") {
        return handleServiceAction(
          "service-restart",
          await safeJson<WorktreeServiceRequest>(req),
        );
      }
      if (sub === "/worktrees/exec" && req.method === "POST") {
        return handleWorktreeExec(
          await safeJson<WorktreeExecRequest>(req),
          auth,
        );
      }
      if (sub === "/worktrees/git/stage" && req.method === "POST") {
        return handleGitStage(
          await safeJson<WorktreeGitStageRequest>(req),
          "stage",
        );
      }
      if (sub === "/worktrees/git/unstage" && req.method === "POST") {
        return handleGitStage(
          await safeJson<WorktreeGitStageRequest>(req),
          "unstage",
        );
      }
      if (sub === "/worktrees/git/commit" && req.method === "POST") {
        return handleGitCommit(await safeJson<WorktreeGitCommitRequest>(req));
      }
      if (sub === "/worktrees/git/fetch" && req.method === "POST") {
        return handleGitFetch(await safeJson<WorktreeGitFetchRequest>(req));
      }
      if (sub === "/worktrees/git/push" && req.method === "POST") {
        return handleGitPush(await safeJson<WorktreeGitPushRequest>(req));
      }
      if (sub === "/worktrees/git/branch" && req.method === "POST") {
        return handleGitBranch(await safeJson<WorktreeGitBranchRequest>(req));
      }
      if (sub === "/worktrees/git/commit-message" && req.method === "POST") {
        return handleGitCommitMessage(
          await safeJson<WorktreeCommitMessageRequest>(req),
        );
      }
      if (sub === "/worktrees/logs" && req.method === "GET") {
        const sessionName = url.searchParams.get("session");
        if (!sessionName) {
          return errorResponse(400, "validation", "session is required");
        }
        const channel = url.searchParams.get("channel");
        if (channel !== null) {
          const validation = validateChannel(channel);
          if (!validation.ok) {
            return errorResponse(400, "validation", validation.message);
          }
          return handleLogStream(req, sessionName, validation.channel);
        }
        return handleLogStream(req, sessionName);
      }
      if (sub === "/events" && req.method === "GET") {
        return handleEventStream(req, url);
      }
      if (sub === "/worktrees/diff/staged" && req.method === "GET") {
        const path = url.searchParams.get("path");
        if (!path) return errorResponse(400, "validation", "path is required");
        return handleDiff(path, "staged");
      }
      if (sub === "/worktrees/diff/unstaged" && req.method === "GET") {
        const path = url.searchParams.get("path");
        if (!path) return errorResponse(400, "validation", "path is required");
        return handleDiff(path, "unstaged");
      }
      if (sub === "/worktrees/diff/review" && req.method === "GET") {
        const path = url.searchParams.get("path");
        if (!path) return errorResponse(400, "validation", "path is required");
        return handleReviewDiff(path);
      }
      if (sub === "/worktrees/files/tree" && req.method === "GET") {
        if (isPublicTerminalDenied(auth)) {
          return fileErrorResponse(403, {
            error: "permission-denied",
            message:
              "filesystem browsing is not available for public clients without terminal access",
          });
        }
        const path = url.searchParams.get("path");
        const dir = url.searchParams.get("dir") ?? "";
        if (!path) {
          return fileErrorResponse(400, {
            error: "validation",
            message: "path is required",
          });
        }
        return handleWorktreeFileTree(path, dir);
      }
      if (sub === "/worktrees/files/content" && req.method === "GET") {
        if (isPublicTerminalDenied(auth)) {
          return fileErrorResponse(403, {
            error: "permission-denied",
            message:
              "filesystem browsing is not available for public clients without terminal access",
          });
        }
        const path = url.searchParams.get("path");
        const file = url.searchParams.get("file") ?? "";
        if (!path) {
          return fileErrorResponse(400, {
            error: "validation",
            message: "path is required",
          });
        }
        if (file.length === 0) {
          return fileErrorResponse(400, {
            error: "validation",
            message: "file is required",
          });
        }
        return handleWorktreeFileRead(path, file);
      }
      if (sub === "/worktrees/files/content" && req.method === "PUT") {
        if (isPublicTerminalDenied(auth)) {
          return fileErrorResponse(403, {
            error: "permission-denied",
            message:
              "filesystem browsing is not available for public clients without terminal access",
          });
        }
        return handleWorktreeFileWrite(
          await safeJson<WorktreeFileWriteRequest>(req),
        );
      }

      // ---------- Terminal (new layer) ----------
      // Public/tunnel requests are denied by default — terminal endpoints
      // execute shell commands inside a worktree, so authenticated public
      // clients pass through only when `tunnel.webUi.terminalEnabled` is true.
      // Unauthenticated public requests are already rejected by the 401 gate
      // above, before any terminal runtime or session lookup.
      if (sub === "/agent-plugins" && req.method === "GET") {
        const claude = getAgentPluginStatus("claude");
        const codex = getAgentPluginStatus("codex");
        return jsonResponse(200, {
          claude: { installed: claude.installed, outdated: claude.outdated ?? false },
          opencode: { installed: getAgentPluginStatus("opencode").installed },
          codex: { installed: codex.installed, outdated: codex.outdated ?? false },
          // pi has no version to repair (opencode tier): installed-only, no `outdated`.
          pi: { installed: getAgentPluginStatus("pi").installed },
        });
      }
      if (sub === "/agent-plugins/install" && req.method === "POST") {
        // Installs when missing, updates when outdated; the claude path migrates
        // legacy injected hooks away first.
        const claudeResult = await ensureClaudePluginInstalled();
        let opencodeChanged = false;
        try {
          opencodeChanged = injectOpencodePlugin();
        } catch (e) {
          return errorResponse(
            500,
            "install-failed",
            `failed to install the opencode plugin: ${(e as Error).message}`,
          );
        }
        let piChanged = false;
        try {
          piChanged = injectPiExtension();
        } catch (e) {
          return errorResponse(
            500,
            "install-failed",
            `failed to install the pi extension: ${(e as Error).message}`,
          );
        }
        // Codex install is best-effort and never fails the whole request: a
        // claude/opencode user without the `codex` CLI must still install their
        // own plugin. The codex outcome (including a typed `codex-cli-not-found`)
        // rides back in the response body for the codex banner to surface.
        const codexResult = await ensureCodexPluginInstalled();
        if (!claudeResult.ok) {
          return errorResponse(
            claudeResult.error === "claude-cli-not-found" ? 409 : 500,
            claudeResult.error,
            claudeResult.message,
          );
        }
        const claude = getAgentPluginStatus("claude");
        const codex = getAgentPluginStatus("codex");
        return jsonResponse(200, {
          claude: {
            installed: claude.installed,
            outdated: claude.outdated ?? false,
            migratedLegacyHooks: claudeResult.migratedLegacyHooks,
          },
          opencode: {
            installed: getAgentPluginStatus("opencode").installed,
            changed: opencodeChanged,
          },
          codex: {
            installed: codex.installed,
            outdated: codex.outdated ?? false,
            ...(codexResult.ok
              ? {}
              : { error: codexResult.error, message: codexResult.message }),
          },
          pi: {
            installed: getAgentPluginStatus("pi").installed,
            changed: piChanged,
          },
        });
      }
      if (sub === "/agent-plugins/reinstall" && req.method === "POST") {
        // Claude-only: fully remove and reinstall the plugin to repair a
        // stale/corrupt registry. OpenCode has no versioned registry to
        // repair, so its entry is left untouched.
        const claudeResult = await reinstallClaudePlugin();
        if (!claudeResult.ok) {
          return errorResponse(
            claudeResult.error === "claude-cli-not-found" ? 409 : 500,
            claudeResult.error,
            claudeResult.message,
          );
        }
        const claude = getAgentPluginStatus("claude");
        return jsonResponse(200, {
          claude: {
            installed: claude.installed,
            outdated: claude.outdated ?? false,
            migratedLegacyHooks: claudeResult.migratedLegacyHooks,
          },
        });
      }

      if (sub === "/terminal-layer/sessions" && req.method === "GET") {
        if (!deps.terminalLayer) {
          return errorResponse(
            503,
            "terminal-unavailable",
            "terminal-layer is not enabled on this daemon",
          );
        }
        if (isPublicTerminalDenied(auth)) return buildTerminalForbiddenResponse();
        const path = url.searchParams.get("path") ?? undefined;
        return handleTerminalLayerList(buildTerminalCtx(auth), path);
      }
      if (sub === "/terminal-layer/sessions" && req.method === "POST") {
        if (!deps.terminalLayer) {
          return errorResponse(
            503,
            "terminal-unavailable",
            "terminal-layer is not enabled on this daemon",
          );
        }
        if (isPublicTerminalDenied(auth)) return buildTerminalForbiddenResponse();
        return handleTerminalLayerCreate(
          buildTerminalCtx(auth),
          await safeJson<TerminalCreateBody>(req),
        );
      }
      const tlGet = sub.match(/^\/terminal-layer\/sessions\/([^/]+)$/);
      if (tlGet && req.method === "GET") {
        if (!deps.terminalLayer) {
          return errorResponse(
            503,
            "terminal-unavailable",
            "terminal-layer is not enabled on this daemon",
          );
        }
        if (isPublicTerminalDenied(auth)) return buildTerminalForbiddenResponse();
        return handleTerminalLayerGet(buildTerminalCtx(auth), tlGet[1]!);
      }
      if (tlGet && req.method === "PATCH") {
        if (!deps.terminalLayer) {
          return errorResponse(
            503,
            "terminal-unavailable",
            "terminal-layer is not enabled on this daemon",
          );
        }
        if (isPublicTerminalDenied(auth)) return buildTerminalForbiddenResponse();
        return handleTerminalLayerRename(
          buildTerminalCtx(auth),
          tlGet[1]!,
          await safeJson<TerminalRenameBody>(req),
        );
      }
      const tlTerm = sub.match(/^\/terminal-layer\/sessions\/([^/]+)\/terminate$/);
      if (tlTerm && req.method === "POST") {
        if (!deps.terminalLayer) {
          return errorResponse(
            503,
            "terminal-unavailable",
            "terminal-layer is not enabled on this daemon",
          );
        }
        if (isPublicTerminalDenied(auth)) return buildTerminalForbiddenResponse();
        return handleTerminalLayerTerminate(buildTerminalCtx(auth), tlTerm[1]!);
      }
      const tlAttach = sub.match(/^\/terminal-layer\/sessions\/([^/]+)\/attach$/);
      if (tlAttach && req.method === "GET") {
        if (!deps.terminalLayer) {
          return errorResponse(
            503,
            "terminal-unavailable",
            "terminal-layer is not enabled on this daemon",
          );
        }
        if (isPublicTerminalDenied(auth)) return buildTerminalForbiddenResponse();
        const id = tlAttach[1]!;
        const meta = deps.terminalLayer.get(id);
        if (!meta) {
          return errorResponse(404, "not-found", `terminal session ${id} not found`);
        }
        if (!server) {
          return errorResponse(
            501,
            "no-websocket",
            "WebSocket transport is not available on this listener",
          );
        }
        const attachmentId =
          url.searchParams.get("attachmentId") ?? crypto.randomUUID();
        const upgraded = server.upgrade(req, {
          data: {
            kind: "terminal-layer",
            terminalId: id,
            attachmentId,
          } satisfies TerminalLayerWsData,
        });
        if (upgraded) return new Response(null, { status: 101 });
        return errorResponse(400, "upgrade-failed", "failed to upgrade to WebSocket");
      }

      // Mission Control snapshot stream: one SSE connection multiplexing the
      // current-screen snapshots of a set of sessions at a clamped cadence.
      // Purely passive — it never opens a terminal attachment, so it does NOT
      // register terminal presence with the notification engine.
      if (sub === "/terminal-layer/snapshots" && req.method === "GET") {
        if (!deps.terminalLayer) {
          return errorResponse(
            503,
            "terminal-unavailable",
            "terminal-layer is not enabled on this daemon",
          );
        }
        if (isPublicTerminalDenied(auth)) return buildTerminalForbiddenResponse();
        return handleSnapshotStream(req, url);
      }
      const tlSnapshot = sub.match(
        /^\/terminal-layer\/sessions\/([^/]+)\/snapshot$/,
      );
      if (tlSnapshot && req.method === "GET") {
        if (!deps.terminalLayer) {
          return errorResponse(
            503,
            "terminal-unavailable",
            "terminal-layer is not enabled on this daemon",
          );
        }
        if (isPublicTerminalDenied(auth)) return buildTerminalForbiddenResponse();
        const captured = await deps.terminalLayer.captureScreenSnapshot(
          tlSnapshot[1]!,
        );
        if (!captured) {
          return errorResponse(
            404,
            "not-found",
            `terminal session ${tlSnapshot[1]} not found`,
          );
        }
        return jsonResponse(200, captured);
      }

      const opEvents = sub.match(/^\/operations\/([^/]+)\/events$/);
      if (opEvents && req.method === "GET") {
        return handleOperationEvents(opEvents[1]!);
      }
      const opMeta = sub.match(/^\/operations\/([^/]+)$/);
      if (opMeta && req.method === "GET") {
        return handleOperationMeta(opMeta[1]!);
      }

      return errorResponse(404, "not-found", `unknown UI API path ${sub}`);
    } catch (e) {
      return errorResponse(500, "server-error", (e as Error).message);
    }
  };

  // ---------- Handlers ----------

  function classifyRequestAuth(
    req: Request,
    _server: import("bun").Server | undefined,
  ): {
    isPublic: boolean;
    cookieValid: boolean;
  } {
    if (!tunnelWebUi.enabled) return { isPublic: false, cookieValid: false };
    const isPublic = isPublicTunnelRequest(
      req,
      tunnelWebUi.enabled,
      tunnelWebUi.hostname,
    );
    const cookie = extractAuthCookie(req);
    const cookieValid = verifyAuthCookie(tunnelWebUi.secret, cookie, {
      nowMs: nowMs(),
      maxAgeMs: authCookieMaxAgeMs,
    });
    return { isPublic, cookieValid };
  }

  async function handleAuthLogin(req: Request): Promise<Response> {
    let body: { secret?: unknown } | null;
    try {
      body = (await req.json()) as { secret?: unknown };
    } catch {
      body = null;
    }
    if (!tunnelWebUi.enabled) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    const submitted = body && typeof body.secret === "string" ? body.secret : "";
    const expected = tunnelWebUi.secret;
    let valid = false;
    if (submitted.length === expected.length && submitted.length > 0) {
      const a = Buffer.from(submitted, "utf8");
      const b = Buffer.from(expected, "utf8");
      try {
        valid = a.length === b.length && timingSafeEqualBuf(a, b);
      } catch {
        valid = false;
      }
    }
    if (!valid) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    const token = signAuthCookie(tunnelWebUi.secret, nowMs());
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "set-cookie": buildSetCookieHeader(token, {
          maxAgeSeconds: Math.max(1, Math.floor(authCookieMaxAgeMs / 1000)),
          secure: isEffectivelyHttpsRequest(req),
        }),
      },
    });
  }

  async function handleProjectList(): Promise<Response> {
    const projects = await loadProjects({ filePath: projectsFilePath });
    const summaries: ProjectSummary[] = [];
    for (const p of projects) {
      summaries.push(await buildProjectSummary(p));
    }
    return jsonResponse(200, { projects: summaries } satisfies ProjectListResponse);
  }

  async function handleProjectAdd(body: ProjectAddRequest | null): Promise<Response> {
    if (!body || typeof body.path !== "string" || body.path.length === 0) {
      return errorResponse(400, "validation", "path is required");
    }
    try {
      const resolved = await resolveProjectPath(body.path, { gitRunner });
      const result = await registerProjectBySourcePath(resolved.sourcePath, {
        filePath: projectsFilePath,
      });
      const summary = await buildProjectSummary(result.project, resolved.worktrees);
      if (result.created) {
        publishProjectAdded(deps.events, result.project);
      } else {
        publishProjectUpdated(deps.events, result.project);
      }
      const payload: ProjectAddResponse = {
        project: summary,
        created: result.created,
      };
      return jsonResponse(result.created ? 201 : 200, payload);
    } catch (e) {
      if (e instanceof ProjectResolveError) {
        return errorResponse(400, "validation", e.message);
      }
      return errorResponse(500, "server-error", (e as Error).message);
    }
  }

  async function handleDirectoryList(pathArg: string): Promise<Response> {
    if (typeof pathArg !== "string" || pathArg.length === 0) {
      return errorResponse(400, "validation", "path is required");
    }
    const normalized = resolve(pathArg);
    // Resolve which directory to list. When the path is itself an existing
    // directory we list its children; when it does not exist we fall back to
    // its parent so a partial trailing segment can still be autocompleted.
    let listDir = normalized;
    let stats;
    try {
      stats = await stat(normalized);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        const parent = dirname(normalized);
        if (parent !== normalized) {
          try {
            const parentStats = await stat(parent);
            if (parentStats.isDirectory()) {
              listDir = parent;
              stats = parentStats;
            }
          } catch {
            // Parent is unreadable or missing — fall through to not-found.
          }
        }
        if (listDir === normalized) {
          return errorResponse(
            404,
            "not-found",
            `path not found: ${normalized}`,
          );
        }
      } else if (err.code === "EACCES" || err.code === "EPERM") {
        return errorResponse(
          403,
          "permission-denied",
          `cannot access ${normalized}`,
        );
      } else {
        return errorResponse(500, "server-error", err.message);
      }
    }
    if (stats && !stats.isDirectory()) {
      return errorResponse(
        400,
        "not-directory",
        `path is not a directory: ${normalized}`,
      );
    }
    let entries;
    try {
      entries = await readdir(listDir, { withFileTypes: true });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "EACCES" || err.code === "EPERM") {
        return errorResponse(
          403,
          "permission-denied",
          `cannot read ${listDir}`,
        );
      }
      return errorResponse(500, "server-error", err.message);
    }
    const directories: DirectorySuggestion[] = [];
    for (const e of entries) {
      if (directories.length >= DIRECTORY_AUTOCOMPLETE_LIMIT) break;
      // Skip dotfiles and the conventional `.git` worktree directory so the
      // suggestion list stays focused on user-meaningful directories. The
      // user can still paste a hidden path manually and validate it.
      if (e.name.startsWith(".")) continue;
      const childPath = resolve(listDir, e.name);
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try {
          const childStats = await stat(childPath);
          isDir = childStats.isDirectory();
        } catch {
          // Skip broken symlinks and unreadable targets.
          continue;
        }
      }
      if (!isDir) continue;
      const suggestion: DirectorySuggestion = {
        path: childPath,
        name: basename(childPath),
        isGitWorktree: false,
      };
      // Lightweight worktree probe: a worktree/repository root contains a
      // `.git` entry (a directory for a primary repo, a gitdir-pointer file
      // for a linked worktree). This is a single cheap stat — the autocomplete
      // never spawns git, so the listing stays fast even on large directories.
      try {
        await stat(resolve(childPath, ".git"));
        suggestion.isGitWorktree = true;
      } catch {
        // No `.git` entry — not a worktree root.
      }
      directories.push(suggestion);
    }
    directories.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
    const payload: DirectoryListResponse = {
      path: listDir,
      entries: directories,
    };
    return jsonResponse(200, payload);
  }

  async function handleProjectPathValidate(pathArg: string): Promise<Response> {
    if (typeof pathArg !== "string" || pathArg.length === 0) {
      return errorResponse(400, "validation", "path is required");
    }
    try {
      const resolved = await resolveProjectPath(pathArg, { gitRunner });
      const rootCfgPath = resolve(
        resolved.sourcePath,
        PROJECT_CONFIG_DIRNAME,
        ROOT_DEPLOY_CONFIG_FILENAME,
      );
      const worktreeCfgPath = resolve(
        resolved.sourcePath,
        PROJECT_CONFIG_DIRNAME,
        WORKTREE_DEPLOY_CONFIG_FILENAME,
      );
      const [hasRootConfig, hasWorktreeConfig] = await Promise.all([
        Bun.file(rootCfgPath).exists(),
        Bun.file(worktreeCfgPath).exists(),
      ]);
      const missingMessages: string[] = [];
      if (!hasRootConfig) {
        missingMessages.push(
          `${PROJECT_CONFIG_DIRNAME}/${ROOT_DEPLOY_CONFIG_FILENAME} is missing; root worktree service startup will not be available until it exists`,
        );
      }
      if (!hasWorktreeConfig) {
        missingMessages.push(
          `${PROJECT_CONFIG_DIRNAME}/${WORKTREE_DEPLOY_CONFIG_FILENAME} is missing; secondary worktree service startup will not be available until it exists`,
        );
      }
      const payload: ProjectPathValidateResponse = {
        valid: true,
        inputPath: resolved.inputPath,
        sourcePath: resolved.sourcePath,
        ...(missingMessages.length === 0
          ? {}
          : {
              warning: {
                code: "missing-config",
                message: missingMessages.join(" "),
              },
            }),
      };
      return jsonResponse(200, payload);
    } catch (e) {
      if (e instanceof ProjectResolveError) {
        const payload: ProjectPathValidateResponse = {
          valid: false,
          message: e.message,
        };
        return jsonResponse(200, payload);
      }
      return errorResponse(500, "server-error", (e as Error).message);
    }
  }

  async function handleWorktreeDetail(pathArg: string): Promise<Response> {
    const worktreePath = resolve(pathArg);
    const sessionName = sessionNameForWorktree(worktreePath);
    const activeOp = deps.registry.activeMutatingFor(sessionName);
    const sessionRoot = sessionRootForWorktree(worktreePath);

    let state: WosState | null = null;
    try {
      state = await readState(stateFilePath(worktreePath));
    } catch {
      state = null;
    }

    let projectId = "";
    let projectName = "";
    let isSource = false;
    let branch: string | undefined;
    let branchRef: string | undefined;
    let head: string | undefined;
    let detached = false;
    let displayName: string | undefined;
    let note: string | undefined;
    try {
      const wts = await listWorktreesForRoot(worktreePath);
      const me = wts.find((w) => resolve(w.path) === worktreePath);
      if (me) {
        branch = me.branch;
        branchRef = me.branchRef;
        head = me.head;
        detached = me.detached;
      }
      const sel = selectSourceWorktree(wts);
      isSource = isSourceWorktree(worktreePath, sel);
      projectName = computeProjectName(worktreePath, sel.path);
      const project = await findProjectBySource(sel.path);
      if (project) {
        projectId = project.id;
        displayName = getWorktreeDisplayName(project, worktreePath);
        note = getWorktreeNote(project, worktreePath);
      }
    } catch {
      // Continue with empty values; detail can still be returned.
    }

    const latestOp = deps.registry.latestForSession(sessionName);
    const hasState = state !== null && state.initialized === true;
    let upFailure = null as Awaited<ReturnType<typeof readUpFailure>>;
    if (!hasState) {
      try {
        upFailure = await readUpFailure(upFailureFilePath(worktreePath));
      } catch {
        upFailure = null;
      }
    }
    const baseClassification = classifyForUi({
      hasState,
      activeOp,
      latestOp,
      hasPersistedUpFailure: upFailure !== null,
    });
    const gitStatus = await computeWorktreeGitStatus(
      worktreePath,
      branch,
      detached,
    );
    const workflowAssignment = getAssignment(
      await loadBoard({ filePath: deps.boardFilePath }),
      worktreePath,
    );
    const summary: WorktreeSummary = {
      path: worktreePath,
      branch,
      branchRef,
      head,
      detached,
      isSource,
      sessionName,
      status: baseClassification.status,
      ...gitStatus,
      ...(displayName ? { displayName } : {}),
      ...(note ? { note } : {}),
      ...(workflowAssignment
        ? {
            workflowStatusId: workflowAssignment.statusId,
            workflowOrder: workflowAssignment.order,
          }
        : {}),
      ...(baseClassification.summary
        ? { serviceSummary: baseClassification.summary }
        : {}),
      ...(activeOp ? { activeOperation: toMeta(activeOp) } : {}),
    };

    const latestMeta = latestOp ? toMeta(latestOp) : undefined;
    const failureContext = latestOp ? buildFailureContext(latestOp) : undefined;
    const deploymentOptions = await loadDeploymentOptionsFromSource(worktreePath);
    const projectConfig = await resolveProjectConfigStatus(worktreePath);

    if (baseClassification.status === "not_started" || !hasState) {
      const launchPreview = await buildLaunchPreview(
        worktreePath,
        deploymentOptions,
        state,
        latestOp,
      );
      return jsonResponse(200, {
        worktree: summary,
        projectId,
        projectName,
        state: null,
        services: [],
        ...(baseClassification.summary
          ? { serviceSummary: baseClassification.summary }
          : {}),
        appPortHealthchecks: [],
        tunnels: deps.tunnels.snapshot(sessionName),
        ...(activeOp ? { activeOperation: toMeta(activeOp) } : {}),
        ...(latestMeta ? { latestOperation: latestMeta } : {}),
        ...(failureContext ? { failureContext } : {}),
        ...(upFailure ? { statusError: upFailure.message } : {}),
        ...(deploymentOptions ? { deploymentOptions } : {}),
        ...(launchPreview ? { launchPreview } : {}),
        projectConfig,
      } satisfies WorktreeDetailResponse);
    }

    let ctx: SessionContext;
    try {
      ctx = await resolveSession(worktreePath);
    } catch (e) {
      return jsonResponse(200, {
        worktree: summary,
        projectId,
        projectName,
        state,
        services: [],
        appPortHealthchecks: [],
        tunnels: deps.tunnels.snapshot(sessionName),
        statusError: (e as Error).message,
        ...(activeOp ? { activeOperation: toMeta(activeOp) } : {}),
        ...(latestMeta ? { latestOperation: latestMeta } : {}),
        ...(failureContext ? { failureContext } : {}),
        ...(deploymentOptions ? { deploymentOptions } : {}),
        projectConfig,
      } satisfies WorktreeDetailResponse);
    }

    const upInProgress =
      activeOp !== null && activeOp.kind === "up" && activeOp.status === "running";
    let services: import("@worktreeos/compose/ps").ServiceStatus[] = [];
    let healthchecks: import("@worktreeos/runtime/healthchecks").AppPortHealthcheckResult[] = [];
    let statusError: string | undefined;
    let collectedServices = false;
    let collectedNoDeployment = false;
    try {
      // Shell-mode status is computed from persisted process metadata by the
      // status runner; the Docker state cache is consulted only for
      // Docker-backed sessions.
      const serviceSnapshot = isShellMode(ctx.config)
        ? undefined
        : cachedSessionServicesOrNull(deps.dockerState, sessionName);
      const outcome = await statusRunner(ctx, {
        reportHealthchecksAsWaiting: upInProgress,
        healthcheckDefaults: await healthcheckDefaultsLoader(),
        ...(serviceSnapshot !== undefined ? { serviceSnapshot } : {}),
      });
      if (outcome.kind === "ok") {
        services = outcome.services;
        healthchecks = outcome.appPortHealthchecks;
        collectedServices = true;
      } else {
        collectedNoDeployment = true;
      }
    } catch (e) {
      statusError = (e as Error).message;
    }

    // Treat snapshots that already report waiting healthchecks as the
    // healthcheck phase so an in-progress `up` surfaces as `checking` instead
    // of `pending` while ports are being polled.
    const inHealthcheckPhase =
      upInProgress &&
      collectedServices &&
      healthchecks.some((h) => h.state === "waiting");
    const refined = classifyForUi({
      hasState: true,
      activeOp,
      latestOp,
      // Only feed services into the classifier when we actually collected a
      // status snapshot — otherwise fall back to state-based heuristics so a
      // transient docker/config error does not flip the badge to `stopped`.
      services: collectedServices
        ? services.map((s) => ({ state: s.state }))
        : collectedNoDeployment
          ? []
          : undefined,
      healthchecks: collectedServices
        ? healthchecks.map((h) => ({ state: h.state }))
        : undefined,
      isHealthcheckPhase: inHealthcheckPhase,
    });
    const resourceUsage = collectedServices
      ? aggregateResourceUsage(services)
      : undefined;
    const refinedSummary: WorktreeSummary = {
      ...summary,
      status: refined.status,
      ...(refined.summary ? { serviceSummary: refined.summary } : {}),
      ...(resourceUsage ? { resourceUsage } : {}),
    };
    const deployFreshness = await computeDeployFreshness(
      worktreePath,
      state,
      latestOp,
      head,
    );
    return jsonResponse(200, {
      worktree: refinedSummary,
      projectId,
      projectName: projectName || ctx.projectName,
      state,
      services,
      ...(refined.summary ? { serviceSummary: refined.summary } : {}),
      appPortHealthchecks: healthchecks,
      tunnels: deps.tunnels.snapshot(sessionName),
      ...(activeOp ? { activeOperation: toMeta(activeOp) } : {}),
      ...(latestMeta ? { latestOperation: latestMeta } : {}),
      ...(failureContext ? { failureContext } : {}),
      ...(statusError ? { statusError } : {}),
      ...(deploymentOptions ? { deploymentOptions } : {}),
      projectConfig,
      ...(deployFreshness ? { deployFreshness } : {}),
    } satisfies WorktreeDetailResponse);
    void sessionRoot; // session root referenced for potential future use
  }

  async function handleDaemonRestart(): Promise<Response> {
    if (!restartScheduler) {
      return errorResponse(
        503,
        "restart-unavailable",
        "daemon restart is not available in this process",
      );
    }
    const payload: DaemonRestartResponse = {
      status: "scheduled",
      scheduledAt: new Date(nowMs()).toISOString(),
    };
    const response = jsonResponse(202, payload);
    // Schedule restart AFTER the response has been built. Any synchronous
    // failure inside the scheduler is converted to a structured error so the
    // current daemon stays up; asynchronous failures are surfaced to stderr
    // since the response has already been committed.
    try {
      const out = restartScheduler();
      if (out && typeof (out as Promise<unknown>).then === "function") {
        void (out as Promise<unknown>).catch((e) => {
          process.stderr.write(
            `wos daemon: restart scheduling failed: ${(e as Error).message}\n`,
          );
        });
      }
    } catch (e) {
      return errorResponse(
        500,
        "restart-failed",
        `daemon restart scheduling failed: ${(e as Error).message}`,
      );
    }
    return response;
  }

  async function handleDaemonStop(): Promise<Response> {
    if (!stopScheduler) {
      return errorResponse(
        503,
        "stop-unavailable",
        "daemon stop is not available in this process",
      );
    }
    const payload: DaemonStopResponse = {
      status: "scheduled",
      scheduledAt: new Date(nowMs()).toISOString(),
    };
    const response = jsonResponse(202, payload);
    // Schedule shutdown AFTER the response has been built. Synchronous
    // scheduling failures keep the daemon up and surface as structured errors;
    // asynchronous failures go to stderr since the response is committed.
    try {
      const out = stopScheduler();
      if (out && typeof (out as Promise<unknown>).then === "function") {
        void (out as Promise<unknown>).catch((e) => {
          process.stderr.write(
            `wos daemon: stop scheduling failed: ${(e as Error).message}\n`,
          );
        });
      }
    } catch (e) {
      return errorResponse(
        500,
        "stop-failed",
        `daemon stop scheduling failed: ${(e as Error).message}`,
      );
    }
    return response;
  }

  async function handleSetupStatus(): Promise<Response> {
    const snapshot = await buildManagementSnapshot();
    const projects = await loadProjects({ filePath: projectsFilePath });
    const setupRequired = !snapshot.exists && projects.length === 0;
    const payload: SetupStatusResponse = {
      setupRequired,
      globalConfig: snapshot,
      projectCount: projects.length,
    };
    return jsonResponse(200, payload);
  }

  /**
   * Resolve the effective project deploy config status for a worktree. Selects
   * `.wos/deploy.yaml` (source) or `.wos/deploy.worktree.yaml` (secondary) from
   * the current worktree, and returns one of `valid`, `missing`, `invalid`, or
   * `unknown` so the UI and launch gate can express config state without
   * re-implementing resolution.
   */
  async function resolveProjectConfigStatus(
    worktreePath: string,
  ): Promise<ProjectConfigStatus> {
    let sourcePath: string;
    try {
      const wts = await listWorktreesForRoot(worktreePath);
      sourcePath = selectSourceWorktree(wts).path;
    } catch (e) {
      return { status: "unknown", message: (e as Error).message };
    }
    const selection = selectDeployConfig(sourcePath, worktreePath);
    const cfgPath = selection.path;
    const filename =
      selection.kind === "root"
        ? ROOT_DEPLOY_CONFIG_FILENAME
        : WORKTREE_DEPLOY_CONFIG_FILENAME;
    const exists = await Bun.file(cfgPath).exists();
    if (!exists) {
      return {
        status: "missing",
        path: cfgPath,
        message: `${PROJECT_CONFIG_DIRNAME}/${filename} is missing in the source worktree; service startup is unavailable until it is added`,
      };
    }
    try {
      const cfg = await loadConfig(sourcePath, worktreePath);
      return {
        status: "valid",
        path: cfgPath,
        mode: deploymentModeOf(cfg),
      };
    } catch (e) {
      if (e instanceof ConfigError) {
        return { status: "invalid", path: cfgPath, message: e.message };
      }
      return {
        status: "invalid",
        path: cfgPath,
        message: (e as Error).message,
      };
    }
  }

  async function loadDeploymentOptionsFromSource(
    worktreePath: string,
  ): Promise<import("./ui-protocol").GeneratedDeploymentOptions | undefined> {
    try {
      const wts = await listWorktreesForRoot(worktreePath);
      const source = selectSourceWorktree(wts);
      const cfg = await loadConfig(source.path, worktreePath);
      if (isComposeMode(cfg)) return undefined;
      const targets: Record<string, string[]> = {};
      for (const [name, entries] of Object.entries(cfg.targets ?? {})) {
        targets[name] = [...entries];
      }
      const portSet = new Set<number>();
      for (const svc of Object.values(cfg.app.services)) {
        for (const p of svc.ports) portSet.add(p.containerPort);
      }
      for (const dep of Object.values(cfg.deps)) {
        for (const p of dep.ports) portSet.add(p);
      }
      return {
        targets,
        appServices: Object.keys(cfg.app.services).sort(),
        deps: Object.keys(cfg.deps).sort(),
        arguments: [...(cfg.arguments ?? [])],
        ports: [...portSet].sort((a, b) => a - b),
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Best-effort launch preview for a not-started worktree: service count,
   * configured ports, and last-run duration. Generated-mode count/ports come
   * from `deploymentOptions`; compose-mode reads the source config's exposed
   * ports. Duration prefers persisted `lastUpDurationMs`, then the latest up
   * operation, else omitted. Returns undefined when no source config could be
   * read so the caller can omit the preview.
   */
  async function buildLaunchPreview(
    worktreePath: string,
    deploymentOptions:
      | import("./ui-protocol").GeneratedDeploymentOptions
      | undefined,
    state: WosState | null,
    latestOp: ReturnType<OperationRegistry["latestForSession"]>,
  ): Promise<import("./ui-protocol").LaunchPreview | undefined> {
    let serviceCount: number;
    let ports: number[];
    if (deploymentOptions) {
      serviceCount =
        deploymentOptions.appServices.length + deploymentOptions.deps.length;
      ports = deploymentOptions.ports;
    } else {
      // Compose mode (or no generated options): read exposed ports from config.
      try {
        const wts = await listWorktreesForRoot(worktreePath);
        const source = selectSourceWorktree(wts);
        const cfg = await loadConfig(source.path, worktreePath);
        if (!isComposeMode(cfg)) return undefined;
        const exposeServices = new Set<string>();
        const portSet = new Set<number>();
        for (const entry of cfg.compose.expose) {
          exposeServices.add(entry.service);
          portSet.add(entry.port);
        }
        serviceCount = exposeServices.size;
        ports = [...portSet].sort((a, b) => a - b);
      } catch {
        return undefined;
      }
    }

    let lastRunDurationMs: number | undefined;
    if (typeof state?.lastUpDurationMs === "number") {
      lastRunDurationMs = state.lastUpDurationMs;
    } else if (
      latestOp &&
      latestOp.kind === "up" &&
      latestOp.finishedAt &&
      latestOp.startedAt
    ) {
      const startedMs = Date.parse(latestOp.startedAt);
      const finishedMs = Date.parse(latestOp.finishedAt);
      if (
        Number.isFinite(startedMs) &&
        Number.isFinite(finishedMs) &&
        finishedMs >= startedMs
      ) {
        lastRunDurationMs = finishedMs - startedMs;
      }
    }

    return {
      serviceCount,
      ports,
      ...(lastRunDurationMs !== undefined ? { lastRunDurationMs } : {}),
    };
  }

  async function handleWorktreeUp(body: WorktreeUpRequest | null): Promise<Response> {
    if (!body || typeof body.path !== "string" || body.path.length === 0) {
      return errorResponse(400, "validation", "path is required");
    }
    let selection: import("@worktreeos/compose/service-selection").ServiceSelectionInput | undefined;
    let runtimeArguments: Record<string, string> | undefined;
    try {
      selection = selectionFromUpRequest(body);
      runtimeArguments = runtimeArgumentsFromUpRequest(body);
    } catch (e) {
      return errorResponse(400, "validation", (e as Error).message);
    }
    const worktreePath = resolve(body.path);
    const projectConfig = await resolveProjectConfigStatus(worktreePath);
    if (projectConfig.status === "missing") {
      const errBody: WorktreeUpConfigErrorBody = {
        error: "config-missing",
        message: projectConfig.message,
        path: projectConfig.path,
      };
      return new Response(JSON.stringify(errBody), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    if (projectConfig.status === "invalid") {
      const errBody: WorktreeUpConfigErrorBody = {
        error: "config-invalid",
        message: projectConfig.message,
        path: projectConfig.path,
      };
      return new Response(JSON.stringify(errBody), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    let ctx: SessionContext;
    try {
      ctx = await resolveSession(worktreePath);
    } catch (e) {
      return errorResponse(400, "validation", (e as Error).message);
    }
    if (selection && selection.kind !== "all" && isComposeMode(ctx.config)) {
      return errorResponse(
        400,
        "validation",
        "selective startup is supported only in generated-compose mode",
      );
    }
    if (
      runtimeArguments &&
      Object.keys(runtimeArguments).length > 0 &&
      isComposeMode(ctx.config)
    ) {
      return errorResponse(
        400,
        "validation",
        "runtime arguments are supported only in generated-compose mode",
      );
    }
    if (runtimeArguments) {
      const declared = new Set(ctx.config.arguments ?? []);
      for (const key of Object.keys(runtimeArguments)) {
        if (!declared.has(key)) {
          return errorResponse(
            400,
            "validation",
            `runtime argument "${key}" is not declared in the deploy config "arguments" list`,
          );
        }
      }
    }

    const begin = deps.registry.begin(ctx.sessionName, "up");
    if (!begin.ok) {
      publishOperationConflict(
        deps.events,
        "up",
        ctx.sessionName,
        begin.conflict.metadata,
        ctx.worktreeRoot,
      );
      const conflict: ConflictResponse = {
        error: "session-busy",
        sessionName: ctx.sessionName,
        active: begin.conflict.metadata,
      };
      return jsonResponse(409, conflict);
    }

    const record = begin.record;
    // Resolve healthcheck timing once at operation start; the up runner and the
    // monitor collectors registered during this operation share this snapshot
    // so a config change does not retroactively alter in-flight timing.
    const healthcheckDefaults = await healthcheckDefaultsLoader();
    const baseObserver = deps.registry.observerFor(record);
    const observerWithInit: DeploymentObserver = {
      emit(event) {
        baseObserver.emit(event);
        // Buffer init-channel log chunks into the session registry so the
        // worktree logs endpoint can replay them for clients selecting the
        // `init` channel after the operation has finished.
        if (event.type === "log" && event.channel === "init") {
          deps.sessions.appendInit(ctx.sessionName, event.stream, event.chunk);
        }
        // Buffer deployment-channel chunks too so the worktree logs endpoint can
        // replay and follow the live deploy tail (release-ports / compose-up /
        // status / healthcheck) while the operation is still in progress.
        if (event.type === "log" && event.channel === "deployment") {
          deps.sessions.appendDeployment(ctx.sessionName, event.stream, event.chunk);
        }
        if (event.type === "services-discovered") {
          const eventCtx = event.composeContext;
          // Service log followers are NOT spawned here — they start on demand
          // when a client subscribes to a `service:<name>` channel. Only the
          // session monitor is registered so service/healthcheck/tunnel state
          // changes can flow through the unified event bus.
          void (async () => {
            const portAssignments = await readPortAssignments(ctx.worktreeRoot);
            if (deps.monitors) {
              const collector = isShellMode(ctx.config)
                ? createShellCollector({
                    sessionName: ctx.sessionName,
                    config: ctx.config,
                    tunnels: deps.tunnels,
                    healthcheckDefaults,
                  })
                : createRuntimeCollector({
                    sessionName: ctx.sessionName,
                    composeContext: eventCtx,
                    config: ctx.config,
                    tunnels: deps.tunnels,
                    worktreeRoot: ctx.worktreeRoot,
                    portAssignments,
                    healthcheckDefaults,
                    dockerState: deps.dockerState,
                  });
              deps.monitors.start(ctx.sessionName, collector, ctx.worktreeRoot);
            }
          })();
        }
      },
    };
    const observer = wrapObserverWithUnified(
      observerWithInit,
      deps.events,
      {
        operationId: record.operationId,
        sessionName: record.sessionName,
        worktreePath: ctx.worktreeRoot,
      },
    );
    publishOperationStarted(deps.events, record, ctx.worktreeRoot);
    publishWorktreeStatusChanged(deps.events, ctx.sessionName, "pending", {
      operationId: record.operationId,
      worktreePath: ctx.worktreeRoot,
    });

    // Cancellation handle: a stop request fires this signal to interrupt the
    // healthcheck wait loop, then takes the deployment down.
    const abort = new AbortController();

    const run = (async () => {
      try {
        await clearUpFailure(upFailureFilePath(ctx.worktreeRoot));
        await deps.sessions.resetSession(ctx.sessionName);
        await deps.tunnels.reset(ctx.sessionName);
        const sink = (text: string) => {
          observer.emit({
            type: "log",
            channel: "deployment",
            stream: "stdout",
            chunk: text,
          });
        };
        const tunnelPreparer = buildTunnelPreparer(ctx, deps.tunnels);
        const progress = { composeStarted: false };
        // Capture HEAD before deploy so a successful up can record the deployed
        // commit. Best-effort: an unreadable HEAD leaves `deployCommit` unset.
        let deployCommit: string | undefined;
        try {
          const wts = await listWorktreesForRoot(ctx.worktreeRoot);
          deployCommit = wts.find(
            (w) => resolve(w.path) === ctx.worktreeRoot,
          )?.head;
        } catch {
          deployCommit = undefined;
        }
        try {
          await upRunnerFn(
            ctx,
            {
              force: body.force === true,
              noTunnel: body.noTunnel === true,
              tunnelPreparer,
              progress,
              healthcheckDefaults,
              selection,
              runtimeArguments,
              signal: abort.signal,
              ...(deployCommit ? { deployCommit } : {}),
            },
            sink,
            observer,
          );
          const reg = await registerProjectBySourcePath(ctx.source.path, {
            filePath: projectsFilePath,
          }).catch(() => null);
          if (reg) {
            if (reg.created) publishProjectAdded(deps.events, reg.project);
            else publishProjectUpdated(deps.events, reg.project);
          }
        } catch (e) {
          // Keep tunnel routes alive when `docker compose up` already
          // succeeded so the user can still reach running containers via the
          // public URL while diagnosing the post-compose-up failure.
          if (!progress.composeStarted) {
            await deps.tunnels.reset(ctx.sessionName);
          }
          throw e;
        }
        await clearUpFailure(upFailureFilePath(ctx.worktreeRoot));
        deps.registry.finish(record, "succeeded");
        publishOperationFinished(deps.events, record, ctx.worktreeRoot);
      } catch (e) {
        // A stop request aborts the operation: finish it quietly (no failure
        // marker, no scary `failed` surface) because the follow-up `down` tears
        // down whatever already started. Distinguished from a genuine failure
        // by the cancellation sentinel / the aborted signal.
        if (e instanceof DeploymentCancelledError || abort.signal.aborted) {
          observer.emit({
            type: "log",
            channel: "deployment",
            stream: "stdout",
            chunk: "deployment stopped\n",
          });
          deps.registry.finish(record, "succeeded");
          publishOperationFinished(deps.events, record, ctx.worktreeRoot);
          return;
        }
        const msg = (e as Error).message;
        observer.emit({ type: "failure", message: msg });
        // Persist a failure marker so the worktree continues to surface as
        // `failed` after a daemon restart, even when wos state was never
        // written. Cleared on the next successful `up`.
        try {
          let initialized = false;
          try {
            const existing = await readState(stateFilePath(ctx.worktreeRoot));
            initialized = existing?.initialized === true;
          } catch {
            initialized = false;
          }
          if (!initialized) {
            await writeUpFailure(upFailureFilePath(ctx.worktreeRoot), {
              failedAt: new Date().toISOString(),
              message: msg,
              operationId: record.operationId,
            });
          }
        } catch {
          /* failure marker is best-effort */
        }
        deps.registry.finish(record, "failed", msg);
        publishOperationFinished(deps.events, record, ctx.worktreeRoot);
      } finally {
        activeUpControls.delete(ctx.sessionName);
      }
    })();
    activeUpControls.set(ctx.sessionName, { abort, done: run });
    void run;

    deps.onUpSubmitted?.(ctx, record.operationId);

    return jsonResponse(202, {
      operationId: record.operationId,
      sessionName: record.sessionName,
      kind: "up",
      startedAt: record.startedAt,
    } satisfies WorktreeUpResponse);
  }

  async function handleWorktreeDown(
    body: WorktreeDownRequest | null,
  ): Promise<Response> {
    if (!body || typeof body.path !== "string" || body.path.length === 0) {
      return errorResponse(400, "validation", "path is required");
    }
    const worktreePath = resolve(body.path);
    let ctx: SessionContext;
    try {
      ctx = await resolveSession(worktreePath);
    } catch (e) {
      return errorResponse(400, "validation", (e as Error).message);
    }

    // Stop from any state: if an `up` is still in flight (e.g. stuck waiting on
    // a healthcheck for a crashed service), abort it and wait for it to unwind
    // so this `down` can take the partial deployment fully down instead of
    // bouncing off the session lock with a 409.
    await abortActiveUp(ctx.sessionName);

    const begin = deps.registry.begin(ctx.sessionName, "down");
    if (!begin.ok) {
      publishOperationConflict(
        deps.events,
        "down",
        ctx.sessionName,
        begin.conflict.metadata,
        ctx.worktreeRoot,
      );
      const conflict: ConflictResponse = {
        error: "session-busy",
        sessionName: ctx.sessionName,
        active: begin.conflict.metadata,
      };
      return jsonResponse(409, conflict);
    }

    const record = begin.record;
    const baseObserver = deps.registry.observerFor(record);
    const observer = wrapObserverWithUnified(baseObserver, deps.events, {
      operationId: record.operationId,
      sessionName: record.sessionName,
      worktreePath: ctx.worktreeRoot,
    });
    publishOperationStarted(deps.events, record, ctx.worktreeRoot);

    void (async () => {
      try {
        const outcome = await downRunnerFn(ctx);
        if (outcome.kind === "no-deployment") {
          observer.emit({
            type: "log",
            channel: "deployment",
            stream: "stdout",
            chunk:
              "no wos deployment has been initialized for the current worktree\n",
          });
        }
        await deps.tunnels.drop(ctx.sessionName);
        await deps.sessions.drop(ctx.sessionName);
        deps.monitors?.stop(ctx.sessionName);
        await clearUpFailure(upFailureFilePath(ctx.worktreeRoot));
        deps.registry.finish(record, "succeeded");
        publishOperationFinished(deps.events, record, ctx.worktreeRoot);
      } catch (e) {
        const msg = (e as Error).message;
        observer.emit({ type: "failure", message: msg });
        deps.registry.finish(record, "failed", msg);
        publishOperationFinished(deps.events, record, ctx.worktreeRoot);
      }
    })();

    return jsonResponse(202, {
      operationId: record.operationId,
      sessionName: record.sessionName,
      kind: "down",
      startedAt: record.startedAt,
    } satisfies WorktreeDownResponse);
  }

  async function handleWorktreeRemove(
    body: WorktreeRemoveRequest | null,
  ): Promise<Response> {
    if (!body || typeof body.path !== "string" || body.path.length === 0) {
      return errorResponse(400, "validation", "path is required");
    }
    const worktreePath = resolve(body.path);
    const discardChanges = body.discardChanges === true;

    let ctx: SessionContext | null = null;
    let worktreeRoot: string;
    let source: WorktreeEntry;
    let sessionName: string;
    try {
      ctx = await resolveSession(worktreePath);
      worktreeRoot = ctx.worktreeRoot;
      source = ctx.source;
      sessionName = ctx.sessionName;
    } catch (e) {
      if (!(e instanceof ConfigError)) {
        return errorResponse(400, "validation", (e as Error).message);
      }
      try {
        const wts = await listWorktreesForRoot(worktreePath);
        source = selectSourceWorktree(wts);
        worktreeRoot = worktreePath;
        sessionName = sessionNameForWorktree(worktreeRoot);
      } catch (innerErr) {
        return errorResponse(400, "validation", (innerErr as Error).message);
      }
    }

    if (isSourceWorktree(worktreeRoot, source)) {
      return errorResponse(400, "validation", SOURCE_WORKTREE_REMOVE_MESSAGE);
    }

    // Preflight dirty check before wos cleanup or operation registration.
    // When the worktree has local changes and the caller did not opt in to
    // discarding them, reject with a structured `worktree-dirty` response so
    // the client can open a confirmation modal and resubmit.
    if (!discardChanges) {
      let dirty: WorktreeDirtyStatus;
      try {
        dirty = await readWorktreeDirtyStatus(worktreeRoot, gitRunner);
      } catch (e) {
        return errorResponse(400, "git-error", (e as Error).message);
      }
      if (dirty.total > 0) {
        const dirtyBody: WorktreeDirtyErrorBody = {
          error: "worktree-dirty",
          message:
            "worktree has local Git changes; confirm discard to proceed",
          path: worktreeRoot,
          changes: dirty,
        };
        return new Response(JSON.stringify(dirtyBody), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
    }

    const begin = deps.registry.begin(sessionName, "worktree-remove");
    if (!begin.ok) {
      publishOperationConflict(
        deps.events,
        "worktree-remove",
        sessionName,
        begin.conflict.metadata,
        worktreeRoot,
      );
      const conflict: ConflictResponse = {
        error: "session-busy",
        sessionName,
        active: begin.conflict.metadata,
      };
      return jsonResponse(409, conflict);
    }

    const record = begin.record;
    const baseObserver = deps.registry.observerFor(record);
    const observer = wrapObserverWithUnified(baseObserver, deps.events, {
      operationId: record.operationId,
      sessionName: record.sessionName,
      worktreePath: worktreeRoot,
    });
    publishOperationStarted(deps.events, record, worktreeRoot);

    void (async () => {
      try {
        if (ctx && ctx.state && ctx.state.initialized) {
          try {
            await downRunnerFn(ctx);
          } catch (e) {
            observer.emit({
              type: "log",
              channel: "deployment",
              stream: "stderr",
              chunk: `wos down (during remove) failed: ${(e as Error).message}\n`,
            });
          }
        }
        await deps.tunnels.drop(sessionName);
        await deps.sessions.drop(sessionName);
        deps.monitors?.stop(sessionName);
        await removeSessionRootForWorktree(worktreeRoot);

        await removeWorktreeFromSource(
          source.path,
          worktreeRoot,
          { force: discardChanges },
          gitRunner,
        );

        try {
          const project = await findProjectBySource(source.path);
          if (project) {
            await removeWorktreeDisplayName(project.id, worktreeRoot, {
              filePath: projectsFilePath,
            });
          }
        } catch {
          // Best-effort metadata cleanup; the worktree is already removed.
        }

        deps.registry.finish(record, "succeeded");
        publishOperationFinished(deps.events, record, worktreeRoot);
        publishWorktreeRemoved(deps.events, sessionName, worktreeRoot);
      } catch (e) {
        const msg = (e as Error).message;
        observer.emit({ type: "failure", message: msg });
        deps.registry.finish(record, "failed", msg);
        publishOperationFinished(deps.events, record, worktreeRoot);
      }
    })();

    return jsonResponse(202, {
      operationId: record.operationId,
      sessionName: record.sessionName,
      kind: "worktree-remove",
      startedAt: record.startedAt,
    } satisfies WorktreeRemoveResponse);
  }

  async function handleWorktreeCreate(
    body: WorktreeCreateRequest | null,
  ): Promise<Response> {
    if (!body || typeof body.projectId !== "string" || body.projectId.length === 0) {
      return errorResponse(400, "validation", "projectId is required");
    }
    if (typeof body.name !== "string" || body.name.length === 0) {
      return errorResponse(400, "validation", "name is required");
    }
    if (body.branch !== undefined) {
      if (typeof body.branch !== "string" || body.branch.trim().length === 0) {
        return errorResponse(
          400,
          "validation",
          "branch must be a non-empty string when provided",
        );
      }
    }
    const branch = body.branch?.trim();

    const projects = await loadProjects({ filePath: projectsFilePath });
    const project = projects.find((p) => p.id === body.projectId);
    if (!project) {
      return errorResponse(404, "not-found", `project ${body.projectId} not found`);
    }
    if (!existsSync(project.sourcePath)) {
      return errorResponse(
        400,
        "validation",
        `project source path ${project.sourcePath} does not exist`,
      );
    }

    let resolution;
    try {
      resolution = resolveManagedWorktreePath({
        record: project,
        name: body.name,
      });
    } catch (e) {
      if (e instanceof ManagedWorktreePathError) {
        return errorResponse(400, "validation", e.message);
      }
      return errorResponse(500, "server-error", (e as Error).message);
    }

    if (existsSync(resolution.targetPath)) {
      return errorResponse(
        400,
        "validation",
        `target path ${resolution.targetPath} already exists`,
      );
    }

    if (branch) {
      let exists: boolean;
      try {
        exists = await branchExistsInSource(project.sourcePath, branch, gitRunner);
      } catch (e) {
        return errorResponse(400, "git-error", (e as Error).message);
      }
      if (!exists) {
        return errorResponse(
          400,
          "validation",
          `branch ${branch} does not exist in project ${project.displayName}`,
        );
      }
    }

    const sessionName = sessionNameForWorktree(resolution.targetPath);
    const begin = deps.registry.begin(sessionName, "worktree-create");
    if (!begin.ok) {
      publishOperationConflict(
        deps.events,
        "worktree-create",
        sessionName,
        begin.conflict.metadata,
        resolution.targetPath,
      );
      const conflict: ConflictResponse = {
        error: "session-busy",
        sessionName,
        active: begin.conflict.metadata,
      };
      return jsonResponse(409, conflict);
    }

    const record = begin.record;
    publishOperationStarted(deps.events, record, resolution.targetPath);

    void (async () => {
      try {
        await mkdir(dirname(resolution.targetPath), { recursive: true });
        if (branch) {
          await createBranchWorktreeFromSource(
            project.sourcePath,
            resolution.targetPath,
            branch,
            gitRunner,
          );
        } else {
          await createDetachedWorktreeFromSource(
            project.sourcePath,
            resolution.targetPath,
            gitRunner,
          );
        }
        try {
          await setWorktreeDisplayName(
            project.id,
            resolution.targetPath,
            body.name,
            { filePath: projectsFilePath },
          );
        } catch {
          // Initial display name is best-effort; sidebar falls back to
          // branch/HEAD/path when persistence is unavailable.
        }
        publishWorktreeCreated(
          deps.events,
          {
            projectId: project.id,
            sourcePath: project.sourcePath,
            worktreePath: resolution.targetPath,
            name: body.name,
            mode: branch ? "branch" : "detached",
            ...(branch ? { branch } : {}),
          },
          { sessionName, operationId: record.operationId },
        );
        deps.registry.finish(record, "succeeded");
        publishOperationFinished(deps.events, record, resolution.targetPath);
      } catch (e) {
        const msg =
          e instanceof GitError ? e.message : (e as Error).message;
        deps.registry.finish(record, "failed", msg);
        publishOperationFinished(deps.events, record, resolution.targetPath);
      }
    })();

    return jsonResponse(202, {
      operationId: record.operationId,
      sessionName,
      kind: "worktree-create",
      startedAt: record.startedAt,
      projectId: project.id,
      targetPath: resolution.targetPath,
      ...(branch ? { branch } : {}),
    } satisfies WorktreeCreateResponse);
  }

  async function handleWorktreeRename(
    body: WorktreeRenameRequest | null,
  ): Promise<Response> {
    if (!body || typeof body.path !== "string" || body.path.length === 0) {
      return errorResponse(400, "validation", "path is required");
    }
    if (typeof body.displayName !== "string") {
      return errorResponse(400, "validation", "displayName must be a string");
    }
    const worktreePath = resolve(body.path);

    // Resolve the worktree's owning project by listing the worktree's own
    // tree and selecting the source entry. This is authoritative — the path
    // must appear in a registered project's discovered worktrees.
    let sourcePath: string;
    let me: WorktreeEntry | undefined;
    try {
      const wts = await listWorktreesForRoot(worktreePath);
      sourcePath = selectSourceWorktree(wts).path;
      me = wts.find((w) => resolve(w.path) === worktreePath);
    } catch (e) {
      return errorResponse(404, "not-found", (e as Error).message);
    }
    if (!me) {
      return errorResponse(
        404,
        "not-found",
        `worktree ${worktreePath} not found in its project's git worktrees`,
      );
    }
    const project = await findProjectBySource(sourcePath);
    if (!project) {
      return errorResponse(
        404,
        "not-found",
        `no registered project owns worktree ${worktreePath}`,
      );
    }

    let updated: Awaited<ReturnType<typeof setWorktreeDisplayName>>;
    try {
      updated = await setWorktreeDisplayName(
        project.id,
        worktreePath,
        body.displayName,
        { filePath: projectsFilePath },
      );
    } catch (e) {
      if (e instanceof ProjectRegistryError) {
        return errorResponse(400, "validation", e.message);
      }
      return errorResponse(500, "server-error", (e as Error).message);
    }
    if (!updated) {
      return errorResponse(
        404,
        "not-found",
        `project ${project.id} not found`,
      );
    }

    const sessionName = sessionNameForWorktree(worktreePath);
    const activeOp = deps.registry.activeMutatingFor(sessionName);
    const worktreeSummary: WorktreeSummary = {
      path: worktreePath,
      ...(me.branch ? { branch: me.branch } : {}),
      ...(me.branchRef ? { branchRef: me.branchRef } : {}),
      ...(me.head ? { head: me.head } : {}),
      detached: me.detached,
      isSource: resolve(sourcePath) === worktreePath,
      sessionName,
      status: "unknown",
      displayName: updated.displayName,
      ...(activeOp ? { activeOperation: toMeta(activeOp) } : {}),
    };
    publishWorktreeUpdated(deps.events, {
      sessionName,
      worktreePath,
      projectId: project.id,
    });
    return jsonResponse(200, {
      worktree: worktreeSummary,
      projectId: project.id,
    } satisfies WorktreeRenameResponse);
  }

  async function handleWorktreeNote(
    body: WorktreeNoteRequest | null,
  ): Promise<Response> {
    if (!body || typeof body.path !== "string" || body.path.length === 0) {
      return errorResponse(400, "validation", "path is required");
    }
    if (body.note !== undefined && typeof body.note !== "string") {
      return errorResponse(400, "validation", "note must be a string");
    }
    const worktreePath = resolve(body.path);

    // Resolve the worktree's owning project by listing the worktree's own
    // tree and selecting the source entry, mirroring the rename endpoint.
    let sourcePath: string;
    let me: WorktreeEntry | undefined;
    try {
      const wts = await listWorktreesForRoot(worktreePath);
      sourcePath = selectSourceWorktree(wts).path;
      me = wts.find((w) => resolve(w.path) === worktreePath);
    } catch (e) {
      return errorResponse(404, "not-found", (e as Error).message);
    }
    if (!me) {
      return errorResponse(
        404,
        "not-found",
        `worktree ${worktreePath} not found in its project's git worktrees`,
      );
    }
    const project = await findProjectBySource(sourcePath);
    if (!project) {
      return errorResponse(
        404,
        "not-found",
        `no registered project owns worktree ${worktreePath}`,
      );
    }

    let updated: Awaited<ReturnType<typeof setWorktreeNote>>;
    try {
      updated = await setWorktreeNote(
        project.id,
        worktreePath,
        body.note ?? "",
        { filePath: projectsFilePath },
      );
    } catch (e) {
      if (e instanceof ProjectRegistryError) {
        return errorResponse(400, "validation", e.message);
      }
      return errorResponse(500, "server-error", (e as Error).message);
    }
    if (!updated) {
      return errorResponse(
        404,
        "not-found",
        `project ${project.id} not found`,
      );
    }

    const displayName = getWorktreeDisplayName(updated.project, worktreePath);
    const sessionName = sessionNameForWorktree(worktreePath);
    const activeOp = deps.registry.activeMutatingFor(sessionName);
    const worktreeSummary: WorktreeSummary = {
      path: worktreePath,
      ...(me.branch ? { branch: me.branch } : {}),
      ...(me.branchRef ? { branchRef: me.branchRef } : {}),
      ...(me.head ? { head: me.head } : {}),
      detached: me.detached,
      isSource: resolve(sourcePath) === worktreePath,
      sessionName,
      status: "unknown",
      ...(displayName ? { displayName } : {}),
      ...(updated.note ? { note: updated.note } : {}),
      ...(activeOp ? { activeOperation: toMeta(activeOp) } : {}),
    };
    publishWorktreeUpdated(deps.events, {
      sessionName,
      worktreePath,
      projectId: project.id,
    });
    return jsonResponse(200, {
      worktree: worktreeSummary,
      projectId: project.id,
    } satisfies WorktreeNoteResponse);
  }

  function toStatusDto(s: {
    id: string;
    name: string;
    color: string;
    order: number;
  }): WorkflowStatusDto {
    return { id: s.id, name: s.name, color: s.color, order: s.order };
  }

  /**
   * Resolve the registered project that owns a worktree path, mirroring the
   * note/rename endpoints. Returns either the project record or a ready-to-send
   * error response.
   */
  async function resolveOwningProject(
    worktreePath: string,
  ): Promise<
    { ok: true; project: ProjectRecord } | { ok: false; response: Response }
  > {
    let sourcePath: string;
    try {
      const wts = await listWorktreesForRoot(worktreePath);
      sourcePath = selectSourceWorktree(wts).path;
      const me = wts.find((w) => resolve(w.path) === worktreePath);
      if (!me) {
        return {
          ok: false,
          response: errorResponse(
            404,
            "not-found",
            `worktree ${worktreePath} not found in its project's git worktrees`,
          ),
        };
      }
    } catch (e) {
      return { ok: false, response: errorResponse(404, "not-found", (e as Error).message) };
    }
    const project = await findProjectBySource(sourcePath);
    if (!project) {
      return {
        ok: false,
        response: errorResponse(
          404,
          "not-found",
          `no registered project owns worktree ${worktreePath}`,
        ),
      };
    }
    return { ok: true, project };
  }

  function maxOrderInColumn(
    board: WorktreeBoardFile,
    statusId: string,
  ): number | undefined {
    let max: number | undefined;
    for (const a of Object.values(board.assignments)) {
      if (a.statusId !== statusId) continue;
      if (max === undefined || a.order > max) max = a.order;
    }
    return max;
  }

  async function handleStatusList(): Promise<Response> {
    const catalog = await loadStatusCatalog({ filePath: deps.statusesFilePath });
    return jsonResponse(200, {
      statuses: catalog.statuses.map(toStatusDto),
    } satisfies StatusCatalogResponse);
  }

  async function handleStatusCreate(
    body: StatusCreateRequest | null,
  ): Promise<Response> {
    if (
      !body ||
      typeof body.name !== "string" ||
      typeof body.color !== "string"
    ) {
      return errorResponse(400, "validation", "name and color are required");
    }
    let result: Awaited<ReturnType<typeof createStatus>>;
    try {
      result = await createStatus(body.name, body.color, {
        filePath: deps.statusesFilePath,
      });
    } catch (e) {
      if (e instanceof StatusCatalogError) {
        return errorResponse(400, "validation", e.message);
      }
      return errorResponse(500, "server-error", (e as Error).message);
    }
    publishStatusCatalogChanged(deps.events);
    return jsonResponse(200, {
      status: toStatusDto(result.status),
      statuses: result.catalog.statuses.map(toStatusDto),
    } satisfies StatusCreateResponse);
  }

  async function handleStatusUpdate(
    id: string,
    body: StatusUpdateRequest | null,
  ): Promise<Response> {
    if (!id) return errorResponse(400, "validation", "status id is required");
    const update: { name?: string; color?: string; order?: number } = {};
    if (body) {
      if (body.name !== undefined) update.name = body.name;
      if (body.color !== undefined) update.color = body.color;
      if (body.order !== undefined) update.order = body.order;
    }
    let result: Awaited<ReturnType<typeof updateStatus>>;
    try {
      result = await updateStatus(id, update, {
        filePath: deps.statusesFilePath,
      });
    } catch (e) {
      if (e instanceof StatusCatalogError) {
        return errorResponse(400, "validation", e.message);
      }
      return errorResponse(500, "server-error", (e as Error).message);
    }
    if (!result) return errorResponse(404, "not-found", `status ${id} not found`);
    publishStatusCatalogChanged(deps.events);
    return jsonResponse(200, {
      status: toStatusDto(result.status),
      statuses: result.catalog.statuses.map(toStatusDto),
    } satisfies StatusUpdateResponse);
  }

  async function handleStatusDelete(id: string): Promise<Response> {
    if (!id) return errorResponse(400, "validation", "status id is required");
    // Capture affected worktrees before deletion so we can announce each one's
    // new unassigned state alongside the catalog change.
    const boardBefore = await loadBoard({ filePath: deps.boardFilePath });
    const affected = Object.entries(boardBefore.assignments)
      .filter(([, a]) => a.statusId === id)
      .map(([p]) => p);
    const catalog = await deleteStatus(id, { filePath: deps.statusesFilePath });
    if (!catalog) return errorResponse(404, "not-found", `status ${id} not found`);
    await reassignStatusToUnassigned(id, { filePath: deps.boardFilePath });
    publishStatusCatalogChanged(deps.events);
    for (const p of affected) {
      publishWorktreeBoardChanged(deps.events, p, null);
    }
    return jsonResponse(200, {
      statuses: catalog.statuses.map(toStatusDto),
    } satisfies StatusDeleteResponse);
  }

  async function handleWorktreeStatus(
    body: WorktreeStatusRequest | null,
  ): Promise<Response> {
    if (!body || typeof body.path !== "string" || body.path.length === 0) {
      return errorResponse(400, "validation", "path is required");
    }
    if (body.statusId !== null && typeof body.statusId !== "string") {
      return errorResponse(400, "validation", "statusId must be a string or null");
    }
    const worktreePath = resolve(body.path);
    if (body.statusId === null) {
      await clearAssignment(worktreePath, { filePath: deps.boardFilePath });
      publishWorktreeBoardChanged(deps.events, worktreePath, null);
      return jsonResponse(200, {
        path: worktreePath,
        statusId: null,
      } satisfies WorktreeStatusResponse);
    }
    const statusId = body.statusId;
    const catalog = await loadStatusCatalog({ filePath: deps.statusesFilePath });
    if (!catalog.statuses.some((s) => s.id === statusId)) {
      return errorResponse(400, "validation", `unknown status ${statusId}`);
    }
    let order = body.order;
    if (order === undefined || typeof order !== "number" || !Number.isFinite(order)) {
      const board = await loadBoard({ filePath: deps.boardFilePath });
      order = appendOrder(maxOrderInColumn(board, statusId));
    }
    await setAssignment(worktreePath, statusId, order, {
      filePath: deps.boardFilePath,
    });
    publishWorktreeBoardChanged(deps.events, worktreePath, statusId, order);
    return jsonResponse(200, {
      path: worktreePath,
      statusId,
      order,
    } satisfies WorktreeStatusResponse);
  }

  async function handleWorktreeCommentsList(path: string): Promise<Response> {
    const worktreePath = resolve(path);
    const owner = await resolveOwningProject(worktreePath);
    if (!owner.ok) return owner.response;
    const comments = getWorktreeComments(owner.project, worktreePath);
    return jsonResponse(200, {
      path: worktreePath,
      comments,
    } satisfies WorktreeCommentsResponse);
  }

  async function handleWorktreeCommentAdd(
    body: WorktreeCommentAddRequest | null,
  ): Promise<Response> {
    if (!body || typeof body.path !== "string" || body.path.length === 0) {
      return errorResponse(400, "validation", "path is required");
    }
    if (typeof body.text !== "string") {
      return errorResponse(400, "validation", "text is required");
    }
    const worktreePath = resolve(body.path);
    const owner = await resolveOwningProject(worktreePath);
    if (!owner.ok) return owner.response;
    let result: Awaited<ReturnType<typeof addWorktreeComment>>;
    try {
      result = await addWorktreeComment(owner.project.id, worktreePath, body.text, {
        filePath: projectsFilePath,
      });
    } catch (e) {
      if (e instanceof ProjectRegistryError) {
        return errorResponse(400, "validation", e.message);
      }
      return errorResponse(500, "server-error", (e as Error).message);
    }
    if (!result) {
      return errorResponse(404, "not-found", `project ${owner.project.id} not found`);
    }
    publishWorktreeCommentChanged(deps.events, worktreePath);
    return jsonResponse(200, {
      path: worktreePath,
      comment: result.comment,
    } satisfies WorktreeCommentAddResponse);
  }

  async function handleWorktreeCommentDelete(
    body: WorktreeCommentDeleteRequest | null,
  ): Promise<Response> {
    if (!body || typeof body.path !== "string" || body.path.length === 0) {
      return errorResponse(400, "validation", "path is required");
    }
    if (typeof body.commentId !== "string" || body.commentId.length === 0) {
      return errorResponse(400, "validation", "commentId is required");
    }
    const worktreePath = resolve(body.path);
    const owner = await resolveOwningProject(worktreePath);
    if (!owner.ok) return owner.response;
    const updated = await removeWorktreeComment(
      owner.project.id,
      worktreePath,
      body.commentId,
      { filePath: projectsFilePath },
    );
    if (!updated) {
      return errorResponse(404, "not-found", `project ${owner.project.id} not found`);
    }
    publishWorktreeCommentChanged(deps.events, worktreePath);
    const comments = getWorktreeComments(updated, worktreePath);
    return jsonResponse(200, {
      path: worktreePath,
      comments,
    } satisfies WorktreeCommentsResponse);
  }

  async function handleWorktreeOpenEditor(
    body: WorktreeOpenEditorRequest | null,
  ): Promise<Response> {
    if (!body || typeof body.path !== "string" || body.path.length === 0) {
      return errorResponse(400, "validation", "path is required");
    }
    const editorCommand = await editorCommandLoader();
    if (!editorCommand || editorCommand.length === 0) {
      return errorResponse(
        400,
        "no-editor",
        "no editor configured — set editorCommand in Settings",
      );
    }
    const worktreePath = resolve(body.path);

    // Resolve the worktree path against the daemon's own git worktree list so
    // the value passed to the editor command is never raw client input.
    let me: WorktreeEntry | undefined;
    try {
      const wts = await listWorktreesForRoot(worktreePath);
      me = wts.find((w) => resolve(w.path) === worktreePath);
    } catch (e) {
      return errorResponse(404, "not-found", (e as Error).message);
    }
    if (!me) {
      return errorResponse(
        404,
        "not-found",
        `worktree ${worktreePath} not found in its project's git worktrees`,
      );
    }
    const resolvedPath = resolve(me.path);

    // Convenience `{path}` token is substituted with a shell-quoted path so a
    // path with spaces or shell metacharacters cannot break out of the command.
    // `$WOS_WORKTREE_PATH` is the recommended (injection-proof) form.
    const command = editorCommand.includes("{path}")
      ? editorCommand.replaceAll("{path}", shellQuote(resolvedPath))
      : editorCommand;

    try {
      const child = editorSpawn(command, {
        ...process.env,
        WOS_WORKTREE_PATH: resolvedPath,
      });
      child.unref();
    } catch (e) {
      return errorResponse(
        500,
        "spawn-failed",
        `failed to launch editor: ${(e as Error).message}`,
      );
    }
    return jsonResponse(200, {
      ok: true,
      worktreePath: resolvedPath,
    } satisfies WorktreeOpenEditorResponse);
  }

  function isPublicTerminalDenied(authState: {
    isPublic: boolean;
    cookieValid: boolean;
  }): boolean {
    return authState.isPublic && !publicTerminalEnabled;
  }

  function buildTerminalCtx(authState: {
    isPublic: boolean;
    cookieValid: boolean;
  }): TerminalApiContext {
    return {
      manager: deps.terminalLayer!,
      isPublicRequest: isPublicTerminalDenied(authState),
    };
  }

  async function handleServiceAction(
    kind: "service-stop" | "service-restart",
    body: WorktreeServiceRequest | null,
  ): Promise<Response> {
    if (!body || typeof body.path !== "string" || body.path.length === 0) {
      return errorResponse(400, "validation", "path is required");
    }
    if (typeof body.service !== "string" || body.service.trim().length === 0) {
      return errorResponse(400, "validation", "service is required");
    }
    if (body.service === INIT_SERVICE_NAME) {
      return errorResponse(
        400,
        "validation",
        `service ${INIT_SERVICE_NAME} is internal and cannot be controlled directly`,
      );
    }
    const worktreePath = resolve(body.path);
    let ctx: SessionContext;
    try {
      ctx = await resolveSession(worktreePath);
    } catch (e) {
      return errorResponse(400, "validation", (e as Error).message);
    }
    if (!ctx.state || !ctx.state.initialized) {
      return errorResponse(
        400,
        "validation",
        "no wos deployment has been initialized for the current worktree",
      );
    }

    const begin = deps.registry.begin(ctx.sessionName, kind);
    if (!begin.ok) {
      publishOperationConflict(
        deps.events,
        kind,
        ctx.sessionName,
        begin.conflict.metadata,
        ctx.worktreeRoot,
      );
      const conflict: ConflictResponse = {
        error: "session-busy",
        sessionName: ctx.sessionName,
        active: begin.conflict.metadata,
      };
      return jsonResponse(409, conflict);
    }

    const service = body.service;
    const record = begin.record;
    const baseObserver = deps.registry.observerFor(record);
    const observer = wrapObserverWithUnified(baseObserver, deps.events, {
      operationId: record.operationId,
      sessionName: record.sessionName,
      worktreePath: ctx.worktreeRoot,
    });
    publishOperationStarted(deps.events, record, ctx.worktreeRoot);

    void (async () => {
      try {
        if (kind === "service-stop") {
          await serviceStopRunnerFn(ctx, service);
        } else {
          await serviceRestartRunnerFn(ctx, service);
        }
        deps.registry.finish(record, "succeeded");
        publishOperationFinished(deps.events, record, ctx.worktreeRoot);
      } catch (e) {
        const msg =
          e instanceof ServiceOperationError ? e.message : (e as Error).message;
        observer.emit({ type: "failure", message: msg });
        deps.registry.finish(record, "failed", msg);
        publishOperationFinished(deps.events, record, ctx.worktreeRoot);
      }
    })();

    if (kind === "service-stop") {
      return jsonResponse(202, {
        operationId: record.operationId,
        sessionName: record.sessionName,
        kind: "service-stop",
        service,
        startedAt: record.startedAt,
      } satisfies WorktreeServiceStopResponse);
    }
    return jsonResponse(202, {
      operationId: record.operationId,
      sessionName: record.sessionName,
      kind: "service-restart",
      service,
      startedAt: record.startedAt,
    } satisfies WorktreeServiceRestartResponse);
  }

  /**
   * Create a daemon-owned terminal session that runs a Docker Compose exec
   * command inside a managed service. Trusted-local-only: public/tunnel
   * requests are denied even when the public terminal opt-in is off, since exec
   * runs arbitrary commands in the worktree's containers.
   */
  async function handleWorktreeExec(
    body: WorktreeExecRequest | null,
    authState: { isPublic: boolean; cookieValid: boolean },
  ): Promise<Response> {
    if (!deps.terminalLayer) {
      return errorResponse(
        503,
        "terminal-unavailable",
        "terminal-layer is not enabled on this daemon",
      );
    }
    if (isPublicTerminalDenied(authState)) {
      return buildTerminalForbiddenResponse();
    }
    if (!deps.terminalLayer.isAvailable()) {
      return errorResponse(
        503,
        "terminal-unavailable",
        `terminal runtime ${deps.terminalLayer.runtimeName()} is not available`,
      );
    }
    if (!body || typeof body.path !== "string" || body.path.length === 0) {
      return errorResponse(400, "validation", "path is required");
    }
    if (typeof body.service !== "string" || body.service.trim().length === 0) {
      return errorResponse(400, "validation", "service is required");
    }
    if (
      !Array.isArray(body.command) ||
      body.command.length === 0 ||
      !body.command.every((c) => typeof c === "string")
    ) {
      return errorResponse(
        400,
        "validation",
        "command must be a non-empty array of strings",
      );
    }
    const worktreePath = resolve(body.path);
    let ctx: SessionContext;
    try {
      ctx = await resolveSession(worktreePath);
    } catch (e) {
      return errorResponse(400, "validation", (e as Error).message);
    }
    if (!ctx.state || !ctx.state.initialized) {
      return errorResponse(
        400,
        "validation",
        "no wos deployment has been initialized for the current worktree",
      );
    }
    let plan: ServiceExecCommand;
    try {
      plan = await serviceExecRunnerFn(ctx, body.service, body.command);
    } catch (e) {
      if (e instanceof ServiceOperationError) {
        return errorResponse(400, "validation", e.message);
      }
      return errorResponse(500, "server-error", (e as Error).message);
    }
    try {
      const meta = await deps.terminalLayer.create({
        worktreePath: ctx.worktreeRoot,
        shell: plan.program,
        args: plan.args,
        ...(plan.env ? { env: plan.env } : {}),
        ...(typeof body.cols === "number" ? { cols: body.cols } : {}),
        ...(typeof body.rows === "number" ? { rows: body.rows } : {}),
      });
      return jsonResponse(201, {
        terminalId: meta.id,
        attachPath: `${UI_API_PREFIX}/terminal-layer/sessions/${encodeURIComponent(meta.id)}/attach`,
        session: meta,
      } satisfies WorktreeExecResponse);
    } catch (e) {
      if (e instanceof TerminalSessionManagerError) {
        if (e.code === "terminal-unavailable") {
          return errorResponse(503, "terminal-unavailable", e.message);
        }
        if (e.code === "cwd-invalid") {
          return errorResponse(400, "validation", e.message);
        }
        return errorResponse(500, "server-error", e.message);
      }
      return errorResponse(500, "server-error", (e as Error).message);
    }
  }

  function handleOperationMeta(operationId: string): Response {
    const rec = deps.registry.get(operationId);
    if (!rec) return errorResponse(404, "not-found", "operation not found");
    return jsonResponse(200, deps.registry.metadata(rec));
  }

  function handleOperationEvents(operationId: string): Response {
    const rec = deps.registry.get(operationId);
    if (!rec) return errorResponse(404, "not-found", "operation not found");
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enqueue = (env: StreamEnvelope) => {
          try {
            controller.enqueue(encoder.encode(encodeEnvelope(env)));
          } catch {
            /* controller already closed */
          }
        };
        const { history, unsubscribe } = deps.registry.subscribe(rec, (env) => {
          enqueue(env);
          if ("terminal" in env) {
            unsubscribe();
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }
        });
        for (const env of history) enqueue(env);
        if (rec.status === "succeeded" || rec.status === "failed") {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    });
  }

  function handleEventStream(req: Request, url: URL): Response {
    const bus = deps.events;
    if (!bus) {
      return errorResponse(503, "events-disabled", "event bus is not available");
    }
    const sessionName = url.searchParams.get("session") ?? undefined;
    const lastEventIdHeader = req.headers.get("Last-Event-ID");
    const sinceId = parseLastEventId(lastEventIdHeader);
    const keepaliveMs = deps.eventStreamKeepaliveMs ?? 15000;
    const encoder = new TextEncoder();
    let unsubscribe: () => void = () => {};
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
    let abortListener: (() => void) | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enqueue = (text: string) => {
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            /* controller already closed */
          }
        };
        const cleanup = () => {
          unsubscribe();
          if (keepaliveTimer) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = null;
          }
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        const subscription = bus.subscribe(
          (env) => enqueue(encodeSseFrame(env)),
          {
            sinceId,
            filter: sessionName ? { sessionNames: [sessionName] } : undefined,
          },
        );
        unsubscribe = subscription.unsubscribe;
        for (const env of subscription.history) {
          enqueue(encodeSseFrame(env));
        }
        if (keepaliveMs > 0) {
          keepaliveTimer = setInterval(() => {
            enqueue(encodeSseKeepalive());
          }, keepaliveMs);
        }
        if (req.signal) {
          if (req.signal.aborted) {
            cleanup();
          } else {
            abortListener = () => cleanup();
            req.signal.addEventListener("abort", abortListener, { once: true });
          }
        }
      },
      cancel() {
        unsubscribe();
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
        if (abortListener && req.signal) {
          req.signal.removeEventListener("abort", abortListener);
          abortListener = null;
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
        connection: "keep-alive",
      },
    });
  }

  /**
   * Mission Control snapshot fan-out. One SSE connection pushes a `snapshot`
   * frame per requested session per tick, captured at a server-clamped
   * cadence (the cadence is the artificial render delay). Captures for a tick
   * are awaited together before sleeping, so ticks never overlap; the loop and
   * its subscriptions tear down on client disconnect.
   */
  function handleSnapshotStream(req: Request, url: URL): Response {
    const manager = deps.terminalLayer!;
    const ids = (url.searchParams.get("ids") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const cadence = clampSnapshotCadenceMs(
      Number(url.searchParams.get("cadence")),
    );
    const encoder = new TextEncoder();
    let cancelled = false;
    let abortListener: (() => void) | null = null;
    const sleep = (ms: number) =>
      new Promise<void>((r) => setTimeout(r, ms));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enqueue = (text: string) => {
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            /* controller already closed */
          }
        };
        const close = () => {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        if (req.signal) {
          if (req.signal.aborted) {
            cancelled = true;
          } else {
            abortListener = () => {
              cancelled = true;
            };
            req.signal.addEventListener("abort", abortListener, { once: true });
          }
        }
        void (async () => {
          // Open the stream immediately so the client's EventSource fires
          // `open` even before the first capture lands.
          enqueue(`: snapshot-stream cadence=${cadence}\n\n`);
          while (!cancelled) {
            const tick = await Promise.all(
              ids.map(async (id) => {
                try {
                  return await manager.captureScreenSnapshot(id);
                } catch {
                  return null;
                }
              }),
            );
            if (cancelled) break;
            for (let i = 0; i < ids.length; i += 1) {
              const captured = tick[i];
              if (!captured) continue;
              const frame = { id: ids[i], ...captured };
              enqueue(`event: snapshot\ndata: ${JSON.stringify(frame)}\n\n`);
            }
            if (cancelled) break;
            await sleep(cadence);
          }
          close();
        })();
      },
      cancel() {
        cancelled = true;
        if (abortListener && req.signal) {
          req.signal.removeEventListener("abort", abortListener);
          abortListener = null;
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
        connection: "keep-alive",
      },
    });
  }

  async function handleLogStream(
    req: Request,
    sessionName: string,
    channel?: import("@worktreeos/core/events").LogChannel,
  ): Promise<Response> {
    const encoder = new TextEncoder();
    let sequence = 0;
    let unsubscribe: () => void = () => {};
    let keepalive: ReturnType<typeof setInterval> | null = null;
    let abortListener: (() => void) | null = null;
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const cleanup = () => {
          if (closed) return;
          closed = true;
          if (keepalive) {
            clearInterval(keepalive);
            keepalive = null;
          }
          if (abortListener && req.signal) {
            req.signal.removeEventListener("abort", abortListener);
            abortListener = null;
          }
          unsubscribe();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        const emit = (chunk: {
          channel: import("@worktreeos/core/events").LogChannel;
          service: string;
          stream: import("@worktreeos/core/events").LogStream;
          chunk: string;
        }) => {
          sequence += 1;
          try {
            controller.enqueue(
              encoder.encode(
                encodeSessionLogEnvelope({
                  sessionName,
                  sequence,
                  timestamp: new Date().toISOString(),
                  channel: chunk.channel,
                  service: chunk.service,
                  stream: chunk.stream,
                  chunk: chunk.chunk,
                }),
              ),
            );
          } catch {
            /* controller already closed */
          }
        };
        const subscription = deps.sessions.subscribe(
          sessionName,
          (c) => emit(c),
          channel ? { channel } : {},
        );
        unsubscribe = subscription.unsubscribe;
        for (const c of subscription.history) emit(c);

        // NDJSON heartbeat: an empty line is ignored by `splitNdjson` and
        // `splitSessionLogStream`, but it flushes the socket so the client
        // (and any intermediate proxy) sees the stream as alive. This is the
        // difference between "hangs" and "open but quiet".
        if (logStreamKeepaliveMs > 0) {
          keepalive = setInterval(() => {
            try {
              controller.enqueue(NDJSON_HEARTBEAT);
            } catch {
              /* controller already closed */
            }
          }, logStreamKeepaliveMs);
        }
        // Disconnect from the HTTP request signal also tears down the
        // request-scoped service log follower so it stops collecting from
        // Docker as soon as the client goes away.
        if (req.signal) {
          if (req.signal.aborted) {
            cleanup();
          } else {
            abortListener = () => cleanup();
            req.signal.addEventListener("abort", abortListener, { once: true });
          }
        }
      },
      cancel() {
        if (keepalive) clearInterval(keepalive);
        keepalive = null;
        if (abortListener && req.signal) {
          req.signal.removeEventListener("abort", abortListener);
          abortListener = null;
        }
        closed = true;
        unsubscribe();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    });
  }

  async function handleDiff(
    pathArg: string,
    kind: "staged" | "unstaged",
  ): Promise<Response> {
    const root = resolve(pathArg);
    try {
      const text =
        kind === "staged"
          ? await readStagedDiff(root, gitRunner)
          : await readUnstagedDiff(root, gitRunner);
      const body: DiffResponse = { diff: text, empty: text.length === 0 };
      return jsonResponse(200, body);
    } catch (e) {
      if (e instanceof GitError) {
        return errorResponse(400, "git-error", e.message);
      }
      return errorResponse(500, "server-error", (e as Error).message);
    }
  }

  async function handleReviewDiff(pathArg: string): Promise<Response> {
    const root = resolve(pathArg);
    try {
      const [stagedCollection, unstagedCollection] = await Promise.all([
        collectStagedDiffSet(root, gitRunner),
        collectUnstagedDiffSet(root, gitRunner),
      ]);
      const staged = buildDiffSet(stagedCollection);
      const unstaged = buildDiffSet(unstagedCollection);
      const distinctFilePaths = new Set<string>();
      for (const f of staged.files) {
        distinctFilePaths.add(f.newPath ?? f.oldPath ?? f.id);
      }
      for (const f of unstaged.files) {
        distinctFilePaths.add(f.newPath ?? f.oldPath ?? f.id);
      }
      const body: ReviewDiffResponse = {
        totalAdditions: staged.additions + unstaged.additions,
        totalDeletions: staged.deletions + unstaged.deletions,
        totalChangedFiles: distinctFilePaths.size,
        staged,
        unstaged,
      };
      return jsonResponse(200, body);
    } catch (e) {
      if (e instanceof GitError) {
        return errorResponse(400, "git-error", e.message);
      }
      return errorResponse(500, "server-error", (e as Error).message);
    }
  }

  // ---------- Worktree Git write + commit-message ----------

  function gitWriteError(
    status: number,
    error: GitWriteErrorBody["error"],
    message: string,
  ): Response {
    const body: GitWriteErrorBody = { error, message };
    return jsonResponse(status, body);
  }

  async function handleGitStage(
    body: WorktreeGitStageRequest | null,
    mode: "stage" | "unstage",
  ): Promise<Response> {
    if (!body || typeof body.path !== "string" || body.path.length === 0) {
      return gitWriteError(400, "validation", "path is required");
    }
    // `all` (stage everything via `git add --all`) is the one case where the
    // file list may be omitted; otherwise it must be an array of strings.
    const stageAll = mode === "stage" && body.all === true;
    if (
      !stageAll &&
      (!Array.isArray(body.files) || body.files.some((f) => typeof f !== "string"))
    ) {
      return gitWriteError(400, "validation", "files must be an array of strings");
    }
    const root = resolve(body.path);
    try {
      if (mode === "stage") {
        if (stageAll) {
          await stageAllChanges(root, gitRunner);
        } else {
          await stageFiles(root, body.files, gitRunner);
        }
      } else {
        await unstageFiles(root, body.files, gitRunner);
      }
      const out: WorktreeGitStageResponse = { ok: true };
      return jsonResponse(200, out);
    } catch (e) {
      if (e instanceof GitError) return gitWriteError(400, "git-error", e.message);
      return errorResponse(500, "server-error", (e as Error).message);
    }
  }

  /** Push, retrying with `-u origin <branch>` when the branch has no upstream. */
  async function pushWithUpstreamFallback(root: string): Promise<{ summary: string }> {
    try {
      return await gitPush(root, {}, gitRunner);
    } catch (e) {
      if (
        e instanceof GitError &&
        /has no upstream branch|set-upstream|no upstream configured/i.test(
          e.message,
        )
      ) {
        return gitPush(root, { setUpstream: true }, gitRunner);
      }
      throw e;
    }
  }

  async function handleGitCommit(
    body: WorktreeGitCommitRequest | null,
  ): Promise<Response> {
    if (!body || typeof body.path !== "string" || body.path.length === 0) {
      return gitWriteError(400, "validation", "path is required");
    }
    if (typeof body.message !== "string" || body.message.trim().length === 0) {
      return gitWriteError(400, "validation", "message is required");
    }
    const root = resolve(body.path);
    try {
      const result = await gitCommit(
        root,
        { message: body.message, amend: body.amend === true },
        gitRunner,
      );
      const out: WorktreeGitCommitResponse = {
        sha: result.sha,
        summary: result.summary,
      };
      if (body.push === true) {
        const pushResult = await pushWithUpstreamFallback(root);
        out.push = { summary: pushResult.summary };
      }
      return jsonResponse(200, out);
    } catch (e) {
      if (e instanceof NothingStagedError) {
        return gitWriteError(409, "nothing-staged", e.message);
      }
      if (e instanceof GitError) return gitWriteError(400, "git-error", e.message);
      return errorResponse(500, "server-error", (e as Error).message);
    }
  }

  /**
   * Resolve fresh ahead/behind posture for the worktree after a sync op. Reuses
   * `computeWorktreeGitStatus` so the strip and the Overview ledger share one
   * algorithm; counts are omitted for a detached HEAD or a branch with no
   * upstream (the requirement's no-upstream case).
   */
  async function freshSyncPosture(
    root: string,
  ): Promise<{ aheadCount?: number; behindCount?: number }> {
    const head = await detectHeadState(root, gitRunner);
    const status = await computeWorktreeGitStatus(
      root,
      head.branch,
      head.detached,
    );
    const out: { aheadCount?: number; behindCount?: number } = {};
    if (typeof status.aheadCount === "number") out.aheadCount = status.aheadCount;
    if (typeof status.behindCount === "number") {
      out.behindCount = status.behindCount;
    }
    return out;
  }

  async function handleGitFetch(
    body: WorktreeGitFetchRequest | null,
  ): Promise<Response> {
    if (!body || typeof body.path !== "string" || body.path.length === 0) {
      return gitWriteError(400, "validation", "path is required");
    }
    const root = resolve(body.path);
    try {
      await gitFetch(root, { prune: body.prune === true }, gitRunner);
      const out: WorktreeGitFetchResponse = {
        ok: true,
        ...(await freshSyncPosture(root)),
      };
      return jsonResponse(200, out);
    } catch (e) {
      if (e instanceof GitError) return gitWriteError(400, "git-error", e.message);
      return errorResponse(500, "server-error", (e as Error).message);
    }
  }

  async function handleGitPush(
    body: WorktreeGitPushRequest | null,
  ): Promise<Response> {
    if (!body || typeof body.path !== "string" || body.path.length === 0) {
      return gitWriteError(400, "validation", "path is required");
    }
    const root = resolve(body.path);
    try {
      const pushResult = await pushWithUpstreamFallback(root);
      const out: WorktreeGitPushResponse = {
        ok: true,
        summary: pushResult.summary,
        ...(await freshSyncPosture(root)),
      };
      return jsonResponse(200, out);
    } catch (e) {
      if (e instanceof GitError) {
        // A non-fast-forward rejection means the branch is behind its upstream;
        // without Pull in scope the client prompts the user to fetch first.
        if (/\[rejected\]|non-fast-forward|fetch first/i.test(e.message)) {
          return gitWriteError(409, "non-fast-forward", e.message);
        }
        return gitWriteError(400, "git-error", e.message);
      }
      return errorResponse(500, "server-error", (e as Error).message);
    }
  }

  async function handleGitBranch(
    body: WorktreeGitBranchRequest | null,
  ): Promise<Response> {
    if (!body || typeof body.path !== "string" || body.path.length === 0) {
      return gitWriteError(400, "validation", "path is required");
    }
    if (typeof body.name !== "string" || body.name.length === 0) {
      return gitWriteError(400, "validation", "name is required");
    }
    const root = resolve(body.path);
    try {
      const head: HeadState = await createBranchInPlace(
        root,
        body.name,
        gitRunner,
      );
      const out: WorktreeGitBranchResponse = { head };
      return jsonResponse(200, out);
    } catch (e) {
      if (e instanceof GitError) return gitWriteError(400, "git-error", e.message);
      return errorResponse(500, "server-error", (e as Error).message);
    }
  }

  async function handleGitCommitMessage(
    body: WorktreeCommitMessageRequest | null,
  ): Promise<Response> {
    if (!body || typeof body.path !== "string" || body.path.length === 0) {
      return gitWriteError(400, "validation", "path is required");
    }
    const root = resolve(body.path);
    let globalConfig: GlobalConfig;
    try {
      globalConfig = await commitMessageConfigLoader();
    } catch (e) {
      return errorResponse(500, "server-error", (e as Error).message);
    }
    const repoConfig = await loadRepoConfig(root);
    const resolved = resolveCommitMessageProvider(repoConfig, globalConfig);
    if (!resolved) {
      return gitWriteError(
        409,
        "no-provider-configured",
        "no AI provider is configured for commit-message generation",
      );
    }
    let diff: string;
    try {
      diff = await readStagedDiff(root, gitRunner);
    } catch (e) {
      if (e instanceof GitError) return gitWriteError(400, "git-error", e.message);
      return errorResponse(500, "server-error", (e as Error).message);
    }
    try {
      const message = await commitMessageGenerator({
        provider: resolved.provider,
        model: resolved.model,
        diff,
        rules: repoConfig.commit.message.instructions,
        language: repoConfig.commit.message.language,
      });
      const out: WorktreeCommitMessageResponse = { message };
      return jsonResponse(200, out);
    } catch (e) {
      if (e instanceof LlmError) {
        return gitWriteError(502, "generation-failed", e.message);
      }
      return errorResponse(500, "server-error", (e as Error).message);
    }
  }

  // ---------- Worktree file explorer ----------

  async function handleWorktreeFileTree(
    pathArg: string,
    dirArg: string,
  ): Promise<Response> {
    const worktreeReal = await resolveWorktreeRoot(pathArg);
    if (!worktreeReal.ok) return worktreeReal.response;
    const relativeDir = normalizeRelative(dirArg);
    if (relativeDir === null) {
      return fileErrorResponse(400, {
        error: "validation",
        message: "dir must be a relative path inside the worktree",
      });
    }
    const targetAbs = relativeDir === ""
      ? worktreeReal.root
      : resolve(worktreeReal.root, relativeDir);
    let targetReal: string;
    try {
      targetReal = await realpath(targetAbs);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return fileErrorResponse(404, {
          error: "not-found",
          message: `directory not found: ${relativeDir || "."}`,
        });
      }
      if (err.code === "EACCES" || err.code === "EPERM") {
        return fileErrorResponse(403, {
          error: "permission-denied",
          message: `cannot access ${relativeDir || "."}`,
        });
      }
      return fileErrorResponse(500, {
        error: "server-error",
        message: err.message,
      });
    }
    if (!isContained(worktreeReal.root, targetReal)) {
      return fileErrorResponse(400, {
        error: "validation",
        message: "dir resolves outside the worktree root",
      });
    }
    let targetStats;
    try {
      targetStats = await stat(targetReal);
    } catch (e) {
      return fileErrorResponse(500, {
        error: "server-error",
        message: (e as Error).message,
      });
    }
    if (!targetStats.isDirectory()) {
      return fileErrorResponse(400, {
        error: "not-a-directory",
        message: `not a directory: ${relativeDir || "."}`,
      });
    }
    let dirents;
    try {
      dirents = await readdir(targetReal, { withFileTypes: true });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "EACCES" || err.code === "EPERM") {
        return fileErrorResponse(403, {
          error: "permission-denied",
          message: `cannot read ${relativeDir || "."}`,
        });
      }
      return fileErrorResponse(500, {
        error: "server-error",
        message: err.message,
      });
    }
    // Best-effort whole-worktree git status: build a path→code map so file
    // entries can carry their status and directory entries a complete subtree
    // rollup (independent of which directories are expanded). A git failure
    // (e.g. not a worktree) leaves the map empty and omits all status fields.
    const gitStatusByPath = new Map<string, string>();
    try {
      const out = await gitRunner(worktreeReal.root, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]);
      for (const { path, code } of parsePorcelainEntries(out)) {
        gitStatusByPath.set(path, code);
      }
    } catch {
      // Omit git status; the listing still succeeds.
    }

    const entries: WorktreeFileEntry[] = [];
    for (const dirent of dirents) {
      // Hide `.git` from the explorer regardless of nesting depth. Other dot
      // directories remain visible because they are useful project context.
      if (relativeDir === "" && dirent.name === ".git") continue;
      const entryAbs = resolve(targetReal, dirent.name);
      let kind: "file" | "directory";
      let size: number | undefined;
      let mtimeMs: number | undefined;
      try {
        const entryStats = await stat(entryAbs);
        if (entryStats.isDirectory()) {
          kind = "directory";
        } else if (entryStats.isFile()) {
          kind = "file";
          size = entryStats.size;
        } else {
          // Skip sockets, fifos, etc.
          continue;
        }
        mtimeMs = entryStats.mtimeMs;
      } catch {
        // Broken symlink or transient race; skip silently.
        continue;
      }
      // For symlinks, verify the target stays inside the worktree before
      // exposing it as an entry.
      if (dirent.isSymbolicLink()) {
        try {
          const real = await realpath(entryAbs);
          if (!isContained(worktreeReal.root, real)) continue;
        } catch {
          continue;
        }
      }
      const entryRel = posixJoin(relativeDir, dirent.name);
      const entry: WorktreeFileEntry = {
        path: entryRel,
        name: dirent.name,
        kind,
      };
      if (typeof size === "number") entry.size = size;
      if (typeof mtimeMs === "number") entry.mtimeMs = mtimeMs;
      if (gitStatusByPath.size > 0) {
        if (kind === "file") {
          const code = gitStatusByPath.get(entryRel);
          if (code) entry.gitStatus = code;
        } else {
          // Subtree rollup: count changed paths under this directory, matching
          // on a path-segment boundary so `src` does not absorb `src-extra`.
          const prefix = `${entryRel}/`;
          let changedCount = 0;
          for (const changedPath of gitStatusByPath.keys()) {
            if (changedPath.startsWith(prefix)) changedCount += 1;
          }
          if (changedCount > 0) entry.changedCount = changedCount;
        }
      }
      entries.push(entry);
    }
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    const payload: WorktreeFileTreeResponse = {
      worktreePath: worktreeReal.root,
      dir: relativeDir,
      entries,
    };
    return jsonResponse(200, payload);
  }

  async function handleWorktreeFileRead(
    pathArg: string,
    fileArg: string,
  ): Promise<Response> {
    const resolved = await resolveWorktreeFile(pathArg, fileArg, {
      mustExist: true,
    });
    if (!resolved.ok) return resolved.response;
    const { worktreeRoot, relativeFile, absoluteFile, stats } = resolved;
    if (stats.size > WORKTREE_FILE_MAX_BYTES) {
      return fileErrorResponse(413, {
        error: "unsupported-file",
        message: `file is larger than ${WORKTREE_FILE_MAX_BYTES} bytes`,
        reason: "too-large",
        size: stats.size,
        maxBytes: WORKTREE_FILE_MAX_BYTES,
      });
    }
    let buffer: Buffer;
    try {
      buffer = await readFile(absoluteFile);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "EACCES" || err.code === "EPERM") {
        return fileErrorResponse(403, {
          error: "permission-denied",
          message: `cannot read ${relativeFile}`,
        });
      }
      return fileErrorResponse(500, {
        error: "server-error",
        message: err.message,
      });
    }
    if (looksBinary(buffer)) {
      return fileErrorResponse(415, {
        error: "unsupported-file",
        message: `file appears to be binary`,
        reason: "binary",
      });
    }
    const payload: WorktreeFileContentResponse = {
      worktreePath: worktreeRoot,
      file: relativeFile,
      content: buffer.toString("utf8"),
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      editable: true,
    };
    return jsonResponse(200, payload);
  }

  async function handleWorktreeFileWrite(
    body: WorktreeFileWriteRequest | null,
  ): Promise<Response> {
    if (!body || typeof body.path !== "string" || body.path.length === 0) {
      return fileErrorResponse(400, {
        error: "validation",
        message: "path is required",
      });
    }
    if (typeof body.file !== "string" || body.file.length === 0) {
      return fileErrorResponse(400, {
        error: "validation",
        message: "file is required",
      });
    }
    if (typeof body.content !== "string") {
      return fileErrorResponse(400, {
        error: "validation",
        message: "content must be a string",
      });
    }
    if (
      body.expectedMtimeMs !== undefined &&
      (typeof body.expectedMtimeMs !== "number" ||
        !Number.isFinite(body.expectedMtimeMs))
    ) {
      return fileErrorResponse(400, {
        error: "validation",
        message: "expectedMtimeMs must be a finite number",
      });
    }
    const resolved = await resolveWorktreeFile(body.path, body.file, {
      mustExist: true,
    });
    if (!resolved.ok) return resolved.response;
    const { worktreeRoot, relativeFile, absoluteFile, stats } = resolved;
    if (stats.size > WORKTREE_FILE_MAX_BYTES) {
      return fileErrorResponse(413, {
        error: "unsupported-file",
        message: `file is larger than ${WORKTREE_FILE_MAX_BYTES} bytes`,
        reason: "too-large",
        size: stats.size,
        maxBytes: WORKTREE_FILE_MAX_BYTES,
      });
    }
    // Conservative binary check on the existing file: never overwrite a file
    // that the explorer would refuse to read.
    try {
      const existing = await readFile(absoluteFile);
      if (looksBinary(existing)) {
        return fileErrorResponse(415, {
          error: "unsupported-file",
          message: "file appears to be binary",
          reason: "binary",
        });
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "EACCES" || err.code === "EPERM") {
        return fileErrorResponse(403, {
          error: "permission-denied",
          message: `cannot read ${relativeFile}`,
        });
      }
      return fileErrorResponse(500, {
        error: "server-error",
        message: err.message,
      });
    }
    if (
      body.expectedMtimeMs !== undefined &&
      Math.trunc(stats.mtimeMs) !== Math.trunc(body.expectedMtimeMs)
    ) {
      return fileErrorResponse(409, {
        error: "conflict",
        message: "file changed on disk since it was read",
        currentMtimeMs: stats.mtimeMs,
      });
    }
    try {
      await writeFile(absoluteFile, body.content, "utf8");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "EACCES" || err.code === "EPERM") {
        return fileErrorResponse(403, {
          error: "permission-denied",
          message: `cannot write ${relativeFile}`,
        });
      }
      return fileErrorResponse(500, {
        error: "server-error",
        message: err.message,
      });
    }
    let updated;
    try {
      updated = await stat(absoluteFile);
    } catch (e) {
      return fileErrorResponse(500, {
        error: "server-error",
        message: (e as Error).message,
      });
    }
    const payload: WorktreeFileWriteResponse = {
      worktreePath: worktreeRoot,
      file: relativeFile,
      size: updated.size,
      mtimeMs: updated.mtimeMs,
    };
    return jsonResponse(200, payload);
  }

  async function listWorktreesForRoot(root: string): Promise<WorktreeEntry[]> {
    const out = await gitRunner(root, ["worktree", "list", "--porcelain"]);
    return parseWorktreeList(out);
  }

  /**
   * Best-effort git posture for the worktree header: ahead/behind vs upstream,
   * uncommitted-changes count, and the last commit (short hash, subject, ISO
   * time). All fields are computed concurrently and individually guarded so any
   * git failure omits only its own field(s). Ahead/behind is skipped for a
   * detached HEAD or a branch with no upstream.
   */
  async function computeWorktreeGitStatus(
    worktreeRoot: string,
    branch: string | undefined,
    detached: boolean,
  ): Promise<
    Pick<
      WorktreeSummary,
      | "aheadCount"
      | "behindCount"
      | "uncommittedCount"
      | "lastCommitHash"
      | "lastCommitSubject"
      | "lastCommitTime"
    >
  > {
    const result: Pick<
      WorktreeSummary,
      | "aheadCount"
      | "behindCount"
      | "uncommittedCount"
      | "lastCommitHash"
      | "lastCommitSubject"
      | "lastCommitTime"
    > = {};

    const aheadBehind = (async () => {
      if (detached || !branch) return;
      try {
        const out = await gitRunner(worktreeRoot, [
          "rev-list",
          "--count",
          "--left-right",
          `${branch}...@{u}`,
        ]);
        const [aheadRaw, behindRaw] = out.trim().split(/\s+/);
        const ahead = Number.parseInt(aheadRaw ?? "", 10);
        const behind = Number.parseInt(behindRaw ?? "", 10);
        if (Number.isFinite(ahead) && Number.isFinite(behind)) {
          result.aheadCount = ahead;
          result.behindCount = behind;
        }
      } catch {
        // No upstream or git failure: omit ahead/behind.
      }
    })();

    const dirty = (async () => {
      try {
        const status = await readWorktreeDirtyStatus(worktreeRoot, gitRunner);
        result.uncommittedCount = status.total;
      } catch {
        // Omit uncommitted count on failure.
      }
    })();

    const lastCommit = (async () => {
      try {
        const out = await gitRunner(worktreeRoot, [
          "log",
          "-1",
          "--format=%h|%s|%cI",
          "HEAD",
        ]);
        const line = out.split("\n")[0] ?? "";
        const sep1 = line.indexOf("|");
        const sep2 = line.lastIndexOf("|");
        if (sep1 > 0 && sep2 > sep1) {
          result.lastCommitHash = line.slice(0, sep1);
          result.lastCommitSubject = line.slice(sep1 + 1, sep2);
          result.lastCommitTime = line.slice(sep2 + 1);
        }
      } catch {
        // Omit last-commit fields on failure.
      }
    })();

    await Promise.all([aheadBehind, dirty, lastCommit]);
    return result;
  }

  /**
   * Best-effort deploy freshness for an initialized worktree: last-deploy time,
   * deploy duration (from the latest up operation), the deployed commit, and a
   * commits-since-deploy count. Each field is omitted when unavailable; a git
   * failure while counting commits omits only that field. Returns `undefined`
   * when no freshness fact could be derived.
   */
  async function computeDeployFreshness(
    worktreeRoot: string,
    state: WosState | null,
    latestOp: ReturnType<OperationRegistry["latestForSession"]>,
    head: string | undefined,
  ): Promise<DeployFreshness | undefined> {
    const freshness: DeployFreshness = {};
    if (state?.lastUp) freshness.lastUpAt = state.lastUp;
    if (state?.lastUpCommit) freshness.lastUpCommit = state.lastUpCommit;

    if (
      latestOp &&
      latestOp.kind === "up" &&
      latestOp.finishedAt &&
      latestOp.startedAt
    ) {
      const startedMs = Date.parse(latestOp.startedAt);
      const finishedMs = Date.parse(latestOp.finishedAt);
      if (
        Number.isFinite(startedMs) &&
        Number.isFinite(finishedMs) &&
        finishedMs >= startedMs
      ) {
        freshness.deployDurationMs = finishedMs - startedMs;
      }
    }

    const deployedCommit = state?.lastUpCommit;
    if (deployedCommit && head) {
      if (head === deployedCommit) {
        freshness.commitsSinceDeploy = 0;
      } else {
        try {
          const out = await gitRunner(worktreeRoot, [
            "rev-list",
            "--count",
            `${deployedCommit}..HEAD`,
          ]);
          const count = Number.parseInt(out.trim(), 10);
          if (Number.isFinite(count)) freshness.commitsSinceDeploy = count;
        } catch {
          // git failure omits only this field
        }
      }
    }

    return Object.keys(freshness).length > 0 ? freshness : undefined;
  }

  async function findProjectBySource(
    sourcePath: string,
  ): Promise<ProjectRecord | undefined> {
    const list = await loadProjects({ filePath: projectsFilePath });
    const normalized = resolve(sourcePath);
    return list.find((p) => p.sourcePath === normalized);
  }

  async function buildProjectSummary(
    record: ProjectRecord,
    knownWorktrees?: WorktreeEntry[],
  ): Promise<ProjectSummary> {
    let worktrees: WorktreeEntry[] = [];
    let stale = false;
    let error: string | undefined;
    try {
      worktrees =
        knownWorktrees ?? (await listWorktreesForRoot(record.sourcePath));
    } catch (e) {
      stale = true;
      error = (e as Error).message;
    }
    let sourceEntry: WorktreeEntry | null = null;
    try {
      sourceEntry = worktrees.length > 0 ? selectSourceWorktree(worktrees) : null;
    } catch {
      sourceEntry = null;
    }
    const candidates = worktrees.filter((wt) => !wt.bare);
    const board = await loadBoard({ filePath: deps.boardFilePath });
    const summaries = await Promise.all(
      candidates.map(async (wt): Promise<WorktreeSummary> => {
        const path = resolve(wt.path);
        const displayName = getWorktreeDisplayName(record, path);
        const note = getWorktreeNote(record, path);
        const assignment = getAssignment(board, path);
        const sessionName = sessionNameForWorktree(path);
        let state: WosState | null = null;
        try {
          state = await readState(stateFilePath(path));
        } catch {
          state = null;
        }
        const activeOp = deps.registry.activeMutatingFor(sessionName);
        const latestOp = deps.registry.latestForSession(sessionName);

        let services: Array<{ state: string }> | undefined;
        // Per-worktree aggregate usage for the rail; only set for Docker-backed
        // sessions where the cache supplied stats.
        let resourceUsage: WorktreeResourceUsage | undefined;
        if (state?.initialized && stateBackend(state) === "shell") {
          // Shell sessions report counts from persisted process metadata.
          services = state.shell
            ? shellServiceStatuses(state).map((s) => ({ state: s.state }))
            : [];
        } else if (state?.initialized) {
          // Prefer the Docker state cache; once synced it is authoritative for
          // managed service counts (init excluded, compose mode already scoped
          // to `compose.expose`). Fall back to `docker compose ps` only before
          // the cache has synced or when no cache is available.
          const cached = cachedSessionServicesOrNull(deps.dockerState, sessionName);
          if (cached !== undefined) {
            services = cached.map((s) => ({ state: s.state }));
            resourceUsage = aggregateResourceUsage(cached);
          } else if (state.composeFile && state.projectName) {
            try {
              const out = await composePs(
                { projectName: state.projectName, composeFile: state.composeFile },
                dockerRunner,
              );
              services = parseComposePs(out)
                .filter((s) => s.service !== INIT_SERVICE_NAME)
                .map((s) => ({ state: s.state }));
            } catch {
              services = undefined;
            }
          }
        }

        const hasStateForSummary = state !== null && state.initialized === true;
        let upFailureSummary: UpFailureRecord | null = null;
        if (!hasStateForSummary) {
          try {
            upFailureSummary = await readUpFailure(upFailureFilePath(path));
          } catch {
            upFailureSummary = null;
          }
        }
        const classification = classifyForUi({
          hasState: hasStateForSummary,
          activeOp,
          latestOp,
          services,
          hasPersistedUpFailure: upFailureSummary !== null,
        });
        return {
          path,
          branch: wt.branch,
          branchRef: wt.branchRef,
          head: wt.head,
          detached: wt.detached,
          isSource: sourceEntry !== null && resolve(sourceEntry.path) === path,
          sessionName,
          status: classification.status,
          ...(displayName ? { displayName } : {}),
          ...(note ? { note } : {}),
          ...(assignment
            ? {
                workflowStatusId: assignment.statusId,
                workflowOrder: assignment.order,
              }
            : {}),
          ...(classification.summary
            ? { serviceSummary: classification.summary }
            : {}),
          ...(resourceUsage ? { resourceUsage } : {}),
          ...(activeOp ? { activeOperation: toMeta(activeOp) } : {}),
        };
      }),
    );
    return {
      id: record.id,
      displayName: record.displayName,
      sourcePath: record.sourcePath,
      createdAt: record.createdAt,
      lastSeenAt: record.lastSeenAt,
      ...(record.lastError ? { error: record.lastError } : {}),
      ...(error ? { error } : {}),
      stale,
      worktrees: summaries,
    };
  }
}

/**
 * Thin adapter that wires daemon-side registry/operation metadata into the
 * shared deployment status classifier. Returns both status and summary so
 * callers can attach `serviceSummary` to UI responses.
 */
function classifyForUi(input: {
  hasState: boolean;
  activeOp: ReturnType<OperationRegistry["activeMutatingFor"]>;
  latestOp: ReturnType<OperationRegistry["latestForSession"]>;
  /** Optional service status from a fresh `docker compose ps` call. */
  services?: ReadonlyArray<{ state: string }>;
  /** Optional healthcheck results (web/api ports). */
  healthchecks?: ReadonlyArray<{ state: import("@worktreeos/core/unified-events").HealthcheckEventState }>;
  /** Whether snapshots were collected during the up healthcheck phase. */
  isHealthcheckPhase?: boolean;
  /** On-disk marker that a previous `up` failed before initialization. */
  hasPersistedUpFailure?: boolean;
}): { status: ReturnType<typeof classifyDeploymentStatus>["status"]; summary?: ServiceSummary } {
  let collection: ServiceCollectionState;
  if (input.services === undefined) {
    collection = input.hasState
      ? { kind: "uncollected" }
      : { kind: "not_initialized" };
  } else if (input.services.length === 0) {
    collection = { kind: "no_services" };
  } else {
    collection = {
      kind: "ok",
      services: input.services,
      healthchecks: input.healthchecks,
    };
  }
  return classifyDeploymentStatus({
    initialized: input.hasState,
    activeOperation: input.activeOp
      ? { kind: input.activeOp.kind, status: input.activeOp.status }
      : null,
    latestOperation: input.latestOp ? { status: input.latestOp.status } : null,
    isHealthcheckPhase: input.isHealthcheckPhase,
    hasPersistedUpFailure: input.hasPersistedUpFailure,
    collection,
  });
}

/**
 * Sum per-service resource usage over running services into a per-worktree
 * aggregate. Returns `undefined` when no running service reported any usage so
 * the field is omitted (shell mode, stats-less, or stopped deployments) rather
 * than emitting an empty/zeroed object.
 */
function aggregateResourceUsage(
  services: ReadonlyArray<import("@worktreeos/compose/ps").ServiceStatus>,
): WorktreeResourceUsage | undefined {
  let cpuPercent: number | undefined;
  let memUsedBytes: number | undefined;
  for (const svc of services) {
    if (svc.state !== "running") continue;
    const u = svc.resourceUsage;
    if (!u) continue;
    if (typeof u.cpuPercent === "number") {
      cpuPercent = (cpuPercent ?? 0) + u.cpuPercent;
    }
    if (typeof u.memUsedBytes === "number") {
      memUsedBytes = (memUsedBytes ?? 0) + u.memUsedBytes;
    }
  }
  if (cpuPercent === undefined && memUsedBytes === undefined) return undefined;
  return {
    ...(cpuPercent !== undefined ? { cpuPercent } : {}),
    ...(memUsedBytes !== undefined ? { memUsedBytes } : {}),
  };
}

function toMeta(rec: NonNullable<ReturnType<OperationRegistry["activeMutatingFor"]>>): OperationMetadata {
  return {
    operationId: rec.operationId,
    kind: rec.kind,
    sessionName: rec.sessionName,
    status: rec.status,
    startedAt: rec.startedAt,
    ...(rec.finishedAt ? { finishedAt: rec.finishedAt } : {}),
    ...(rec.failureMessage ? { failureMessage: rec.failureMessage } : {}),
  };
}

/** Maximum number of trailing log lines captured into the failure context. */
const FAILURE_LOG_TAIL_LIMIT = 10;

/**
 * Derive the trailing log lines for a failed step from the operation's frozen
 * envelope history. Concatenates `log` chunks on the matching channel, splits
 * into lines, and returns the last N. Captured from the per-operation history
 * so it stays stable across later detail re-fetches. Returns `undefined` when
 * no buffered output exists on that channel (best-effort).
 */
function deriveFailureLogTail(
  rec: NonNullable<ReturnType<OperationRegistry["latestForSession"]>>,
  channel: import("@worktreeos/core/events").LogChannel,
  limit = FAILURE_LOG_TAIL_LIMIT,
): string[] | undefined {
  let text = "";
  for (const env of rec.history) {
    if (!("event" in env) || !env.event) continue;
    const event = env.event;
    if (event.type === "log" && event.channel === channel) {
      text += event.chunk;
    }
  }
  if (text.length === 0) return undefined;
  const lines = text.split("\n");
  // Drop a trailing empty line produced by output that ends with a newline.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return undefined;
  return lines.slice(-limit);
}

/**
 * Best-effort failure context for a failed operation record. Scans the bounded
 * envelope history for the last failed `step` event so the UI can highlight
 * the relevant diagnostic channel after a refresh, and captures a short tail
 * of that step's output from the same frozen history.
 */
export function buildFailureContext(
  rec: NonNullable<ReturnType<OperationRegistry["latestForSession"]>>,
): WorktreeFailureContext | undefined {
  if (rec.status !== "failed") return undefined;
  let step: import("@worktreeos/core/events").DeploymentStepId | undefined;
  for (let i = rec.history.length - 1; i >= 0; i -= 1) {
    const env = rec.history[i];
    if (!env || !("event" in env) || !env.event) continue;
    const event = env.event;
    if (event.type === "step" && event.state === "failed") {
      step = event.id;
      break;
    }
  }
  let channel: import("@worktreeos/core/events").LogChannel | undefined;
  if (step === "first-run-setup" || step === "init-script") {
    channel = "init";
  }
  // Init/first-run output lands on the `init` channel; everything else
  // (compose-up/status/healthcheck) lands on the internal `deployment`
  // channel that clients can't query — capturing the tail server-side covers
  // both. Service-stream output is not part of the operation history, so it is
  // not captured here (best-effort).
  const tailChannel = channel ?? "deployment";
  const logTail = deriveFailureLogTail(rec, tailChannel);
  const ctx: WorktreeFailureContext = {
    operationId: rec.operationId,
    kind: rec.kind,
  };
  if (rec.failureMessage) ctx.message = rec.failureMessage;
  if (channel) ctx.channel = channel;
  if (step) ctx.step = step;
  if (logTail) ctx.logTail = logTail;
  if (!ctx.message && !ctx.channel && !ctx.step && !ctx.logTail) {
    // Provide minimal context so consumers still know an operation failed,
    // even when nothing more specific is available.
    return { operationId: rec.operationId, kind: rec.kind };
  }
  return ctx;
}

async function composeEnvForCtxSafe(
  ctx: SessionContext,
  assignments?: import("@worktreeos/core/state").PortAssignments,
  tunnelHostnames?: Record<string, Record<string, string>>,
): Promise<Record<string, string> | undefined> {
  if (!isComposeMode(ctx.config)) return undefined;
  try {
    return await buildComposeCommandEnvironment({
      config: ctx.config.compose,
      worktreeRoot: ctx.worktreeRoot,
      assignments,
      tunnelHostnames,
    });
  } catch {
    return undefined;
  }
}

async function readPortAssignments(
  worktreeRoot: string,
): Promise<import("@worktreeos/core/state").PortAssignments | undefined> {
  try {
    const state = await readState(stateFilePath(worktreeRoot));
    return state?.portAssignments;
  } catch {
    return undefined;
  }
}

function buildTunnelPreparer(ctx: SessionContext, tunnels: TunnelRegistry): TunnelPreparer {
  const sessionName = ctx.sessionName;
  return {
    async prepare(assignments) {
      await tunnels.reset(sessionName);
      if (!tunnels.getServer()) return emptyTunnelResolution();
      if (isComposeMode(ctx.config)) {
        for (const entry of ctx.config.compose.expose) {
          const hostPort = assignments[entry.service]?.[String(entry.port)];
          if (typeof hostPort !== "number") continue;
          await tunnels.open(sessionName, {
            worktreeRoot: ctx.worktreeRoot,
            service: entry.service,
            containerPort: entry.port,
            hostPort,
          });
        }
      } else {
        for (const [serviceName, svc] of Object.entries(ctx.config.app.services)) {
          for (const portSpec of svc.ports) {
            const hostPort = assignments[serviceName]?.[String(portSpec.containerPort)];
            if (typeof hostPort !== "number") continue;
            await tunnels.open(sessionName, {
              worktreeRoot: ctx.worktreeRoot,
              service: serviceName,
              containerPort: portSpec.containerPort,
              hostPort,
            });
          }
        }
      }
      return {
        hostnames: tunnels.hostnameMap(sessionName),
        urls: tunnels.urlMap(sessionName),
      };
    },
    async skip() {
      await tunnels.reset(sessionName);
    },
  };
}

async function safeJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fileErrorResponse(
  status: number,
  body: import("./ui-protocol").WorktreeFileErrorBody,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type WorktreeRootResolution =
  | { ok: true; root: string }
  | { ok: false; response: Response };

async function resolveWorktreeRoot(
  pathArg: string,
): Promise<WorktreeRootResolution> {
  if (typeof pathArg !== "string" || pathArg.length === 0) {
    return {
      ok: false,
      response: fileErrorResponse(400, {
        error: "validation",
        message: "path is required",
      }),
    };
  }
  if (!isAbsolute(pathArg)) {
    return {
      ok: false,
      response: fileErrorResponse(400, {
        error: "validation",
        message: "path must be absolute",
      }),
    };
  }
  let root: string;
  try {
    root = await realpath(resolve(pathArg));
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return {
        ok: false,
        response: fileErrorResponse(404, {
          error: "not-found",
          message: `worktree path not found: ${pathArg}`,
        }),
      };
    }
    return {
      ok: false,
      response: fileErrorResponse(500, {
        error: "server-error",
        message: err.message,
      }),
    };
  }
  let rootStats;
  try {
    rootStats = await stat(root);
  } catch (e) {
    return {
      ok: false,
      response: fileErrorResponse(500, {
        error: "server-error",
        message: (e as Error).message,
      }),
    };
  }
  if (!rootStats.isDirectory()) {
    return {
      ok: false,
      response: fileErrorResponse(400, {
        error: "not-a-directory",
        message: "worktree path is not a directory",
      }),
    };
  }
  return { ok: true, root };
}

/**
 * Validate that `raw` is a safe relative path inside a worktree. Returns
 * `null` when the value is unsafe (absolute, escaping, contains NUL bytes),
 * the empty string when the value resolves to the root, or a normalized
 * POSIX-style relative path otherwise.
 */
function normalizeRelative(raw: string): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0) return "";
  if (raw.includes("\0")) return null;
  if (isAbsolute(raw)) return null;
  // Use the platform separator to validate, but always return POSIX form.
  const normalized = raw
    .replaceAll("\\", "/")
    .split("/")
    .filter((seg) => seg.length > 0 && seg !== ".");
  if (normalized.length === 0) return "";
  for (const seg of normalized) {
    if (seg === "..") return null;
  }
  return normalized.join("/");
}

function posixJoin(prefix: string, name: string): string {
  if (prefix.length === 0) return name;
  return `${prefix}/${name}`;
}

function isContained(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const rel = relativePath(root, candidate);
  if (rel.length === 0) return true;
  if (rel.startsWith("..")) return false;
  if (isAbsolute(rel)) return false;
  // Guard against unexpected leading separator.
  if (rel.startsWith(pathSep) || rel.startsWith("/")) return false;
  return true;
}

interface ResolvedWorktreeFile {
  ok: true;
  worktreeRoot: string;
  relativeFile: string;
  absoluteFile: string;
  stats: import("node:fs").Stats;
}

async function resolveWorktreeFile(
  pathArg: string,
  fileArg: string,
  opts: { mustExist: true },
): Promise<ResolvedWorktreeFile | { ok: false; response: Response }> {
  const rootRes = await resolveWorktreeRoot(pathArg);
  if (!rootRes.ok) return rootRes;
  const rel = normalizeRelative(fileArg);
  if (rel === null || rel === "") {
    return {
      ok: false,
      response: fileErrorResponse(400, {
        error: "validation",
        message: "file must be a relative path inside the worktree",
      }),
    };
  }
  const candidateAbs = resolve(rootRes.root, rel);
  let realFile: string;
  try {
    realFile = await realpath(candidateAbs);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      if (opts.mustExist) {
        return {
          ok: false,
          response: fileErrorResponse(404, {
            error: "not-found",
            message: `file not found: ${rel}`,
          }),
        };
      }
      // Fall back to the resolved (non-real) path for create flows.
      realFile = candidateAbs;
    } else if (err.code === "EACCES" || err.code === "EPERM") {
      return {
        ok: false,
        response: fileErrorResponse(403, {
          error: "permission-denied",
          message: `cannot access ${rel}`,
        }),
      };
    } else {
      return {
        ok: false,
        response: fileErrorResponse(500, {
          error: "server-error",
          message: err.message,
        }),
      };
    }
  }
  if (!isContained(rootRes.root, realFile)) {
    return {
      ok: false,
      response: fileErrorResponse(400, {
        error: "validation",
        message: "file resolves outside the worktree root",
      }),
    };
  }
  let stats;
  try {
    stats = await stat(realFile);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return {
        ok: false,
        response: fileErrorResponse(404, {
          error: "not-found",
          message: `file not found: ${rel}`,
        }),
      };
    }
    return {
      ok: false,
      response: fileErrorResponse(500, {
        error: "server-error",
        message: err.message,
      }),
    };
  }
  if (stats.isDirectory()) {
    return {
      ok: false,
      response: fileErrorResponse(400, {
        error: "not-a-file",
        message: `path is a directory: ${rel}`,
      }),
    };
  }
  if (!stats.isFile()) {
    return {
      ok: false,
      response: fileErrorResponse(400, {
        error: "not-a-file",
        message: `path is not a regular file: ${rel}`,
      }),
    };
  }
  return {
    ok: true,
    worktreeRoot: rootRes.root,
    relativeFile: rel,
    absoluteFile: realFile,
    stats,
  };
}

/**
 * POSIX single-quote a value so it survives `shell: true` substitution intact,
 * even with spaces or shell metacharacters. Used for the `{path}` token in the
 * editor command.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Heuristic binary detection: scan the first 8 KiB for NUL bytes. Matches the
 * approach used by git diff and a handful of other tools and is good enough to
 * keep large binaries out of the Monaco editor.
 */
function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === 0) return true;
  }
  return false;
}

/**
 * Validate a `channel` query value for the worktree logs endpoint. Only
 * `init` and `service:<name>` are accepted — `deployment` does not flow
 * through the session log buffers.
 */
function validateChannel(
  raw: string,
): { ok: true; channel: import("@worktreeos/core/events").LogChannel } | { ok: false; message: string } {
  if (raw === "init") return { ok: true, channel: "init" };
  if (raw === "deployment") return { ok: true, channel: "deployment" };
  if (raw.startsWith("service:") && raw.length > "service:".length) {
    return { ok: true, channel: raw as import("@worktreeos/core/events").LogChannel };
  }
  return {
    ok: false,
    message: "channel must be 'deployment', 'init' or 'service:<name>'",
  };
}

export { UI_API_PREFIX };
