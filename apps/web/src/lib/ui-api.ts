// Web-local UI API client. Mirrors the daemon's `ui-protocol` types as
// hand-maintained shapes so the web bundle does not need to import the
// node-side daemon package.

export type DeploymentStatus =
  | "not_started"
  | "pending"
  | "checking"
  | "running"
  | "running_partial"
  | "failed"
  | "stopped"
  | "stopping"
  | "unknown";

export interface ServiceSummary {
  total: number;
  running: number;
  stopped: number;
  failed: number;
  checking: number;
}

export type OperationKind =
  | "up"
  | "down"
  | "status"
  | "service-stop"
  | "service-restart"
  | "worktree-remove"
  | "worktree-create";

export interface OperationMetadata {
  operationId: string;
  kind: OperationKind;
  sessionName: string;
  status: "queued" | "running" | "succeeded" | "failed" | "conflict";
  startedAt: string;
  finishedAt?: string;
  failureMessage?: string;
}

export interface WorktreeSummary {
  path: string;
  branch?: string;
  branchRef?: string;
  head?: string;
  detached: boolean;
  isSource: boolean;
  sessionName: string;
  status: DeploymentStatus;
  /** Persisted human-readable label preferred over branch/HEAD/path. */
  displayName?: string;
  /** Persisted free-form note; omitted when no note is set. */
  note?: string;
  /** Assigned workflow status id (Kanban column); omitted when unassigned. */
  workflowStatusId?: string;
  /** Within-status fractional order on the board; omitted when unassigned. */
  workflowOrder?: number;
  serviceSummary?: ServiceSummary;
  /** Per-worktree aggregate resource usage; omitted when unavailable. */
  resourceUsage?: WorktreeResourceUsage;
  activeOperation?: OperationMetadata;
  /** Commits ahead of upstream; omitted when detached/no upstream. */
  aheadCount?: number;
  /** Commits behind upstream; omitted when detached/no upstream. */
  behindCount?: number;
  /** Count of uncommitted changes (staged + unstaged + untracked). */
  uncommittedCount?: number;
  /** Short hash of the last commit on HEAD. */
  lastCommitHash?: string;
  /** Subject line of the last commit on HEAD. */
  lastCommitSubject?: string;
  /** ISO timestamp of the last commit on HEAD. */
  lastCommitTime?: string;
}

/** Per-worktree aggregate resource usage summed over running services. */
export interface WorktreeResourceUsage {
  cpuPercent?: number;
  memUsedBytes?: number;
}

export interface ProjectSummary {
  id: string;
  displayName: string;
  sourcePath: string;
  createdAt: string;
  lastSeenAt: string;
  error?: string;
  stale: boolean;
  worktrees: WorktreeSummary[];
}

export interface ProjectListResponse {
  projects: ProjectSummary[];
}

// ---------- Workflow status catalog / board / comments ----------

export interface WorkflowStatusDto {
  id: string;
  name: string;
  color: string;
  order: number;
}

export interface StatusCatalogResponse {
  statuses: WorkflowStatusDto[];
}

export interface StatusCreateResponse {
  status: WorkflowStatusDto;
  statuses: WorkflowStatusDto[];
}

export interface StatusUpdateResponse {
  status: WorkflowStatusDto;
  statuses: WorkflowStatusDto[];
}

export interface StatusDeleteResponse {
  statuses: WorkflowStatusDto[];
}

export interface WorktreeStatusResponse {
  path: string;
  statusId: string | null;
  order?: number;
}

export interface WorktreeCommentDto {
  id: string;
  text: string;
  createdAt: string;
}

export interface WorktreeCommentsResponse {
  path: string;
  comments: WorktreeCommentDto[];
}

export interface WorktreeCommentAddResponse {
  path: string;
  comment: WorktreeCommentDto;
}

export interface ProjectAddRequest {
  path: string;
}

export interface ProjectAddResponse {
  project: ProjectSummary;
  created: boolean;
}

export interface PortMapping {
  hostIp: string;
  hostPort?: number;
  containerPort: number;
  protocol: string;
}

/** Instantaneous per-service resource usage; all fields best-effort. */
export interface ResourceUsage {
  cpuPercent?: number;
  memUsedBytes?: number;
  memLimitBytes?: number;
  diskBytes?: number;
}

export interface ServiceStatus {
  service: string;
  state: string;
  status?: string;
  ports: PortMapping[];
  startedAt?: string;
  restartCount?: number;
  resourceUsage?: ResourceUsage;
}

export type AppPortHealthcheckState =
  | "healthy"
  | "failed"
  | "failed-allowed"
  | "disabled"
  | "waiting";

export interface AppPortHealthcheckResult {
  service: string;
  containerPort: number;
  state: AppPortHealthcheckState;
  url?: string;
  message?: string;
}

export type TunnelSnapshot =
  | {
      service: string;
      containerPort: number;
      hostPort: number;
      state: "active";
      url: string;
      hostname: string;
    }
  | {
      service: string;
      containerPort: number;
      hostPort: number;
      state: "failed";
      message?: string;
      url?: string;
    };

export interface WosState {
  initialized: boolean;
  projectName: string;
  composeFile: string;
  lastUp?: string;
}

export type DeploymentStepId =
  | "prepare"
  | "release-ports"
  | "first-run-setup"
  | "init-script"
  | "compose-up"
  | "status"
  | "healthcheck";

export interface WorktreeFailureContext {
  operationId?: string;
  kind?: OperationKind;
  message?: string;
  channel?: LogChannel;
  step?: DeploymentStepId;
  /** Last few lines of the failed step's output, captured at failure time. */
  logTail?: string[];
}

export interface GeneratedDeploymentOptions {
  targets: Record<string, string[]>;
  appServices: string[];
  deps: string[];
  /** Declared runtime argument names accepted by the project. */
  arguments: string[];
  /** Configured container ports, de-duplicated and sorted ascending. */
  ports: number[];
}

export type ProjectConfigStatus =
  | {
      status: "valid";
      path: string;
      mode: "generated" | "compose" | "shell";
    }
  | {
      status: "missing";
      path: string;
      message: string;
    }
  | {
      status: "invalid";
      path: string;
      message: string;
    }
  | {
      status: "unknown";
      message?: string;
    };

export interface WorktreeDetailResponse {
  worktree: WorktreeSummary;
  projectId: string;
  projectName: string;
  state: WosState | null;
  services: ServiceStatus[];
  serviceSummary?: ServiceSummary;
  appPortHealthchecks: AppPortHealthcheckResult[];
  tunnels: TunnelSnapshot[];
  activeOperation?: OperationMetadata;
  latestOperation?: OperationMetadata;
  failureContext?: WorktreeFailureContext;
  statusError?: string;
  deploymentOptions?: GeneratedDeploymentOptions;
  projectConfig: ProjectConfigStatus;
  deployFreshness?: DeployFreshness;
  /** Pre-deploy launch preview for a not-started worktree. */
  launchPreview?: LaunchPreview;
}

/** Best-effort deploy freshness facts mirrored from the daemon protocol. */
export interface DeployFreshness {
  lastUpAt?: string;
  deployDurationMs?: number;
  lastUpCommit?: string;
  commitsSinceDeploy?: number;
}

/** Pre-deploy launch preview mirrored from the daemon protocol. */
export interface LaunchPreview {
  serviceCount: number;
  ports: number[];
  lastRunDurationMs?: number;
}

export interface WorktreeUpResponse {
  operationId: string;
  sessionName: string;
  kind: "up";
  startedAt: string;
}

export interface WorktreeDownResponse {
  operationId: string;
  sessionName: string;
  kind: "down";
  startedAt: string;
}

export interface WorktreeRemoveResponse {
  operationId: string;
  sessionName: string;
  kind: "worktree-remove";
  startedAt: string;
}

export interface WorktreeCreateRequest {
  projectId: string;
  name: string;
  branch?: string;
}

export interface WorktreeCreateResponse {
  operationId: string;
  sessionName: string;
  kind: "worktree-create";
  startedAt: string;
  projectId: string;
  targetPath: string;
  branch?: string;
}

export interface WorktreeRenameRequest {
  /** Absolute path of the worktree whose display name should be updated. */
  path: string;
  /** New display name. */
  displayName: string;
}

export interface WorktreeRenameResponse {
  worktree: WorktreeSummary;
  projectId: string;
}

export interface WorktreeNoteRequest {
  /** Absolute path of the worktree whose note should be updated. */
  path: string;
  /** New note. Empty/omitted clears the note. */
  note?: string;
}

export interface WorktreeNoteResponse {
  worktree: WorktreeSummary;
  projectId: string;
}

export interface WorktreeOpenEditorResponse {
  ok: true;
  worktreePath: string;
}

export interface WorktreeServiceStopResponse {
  operationId: string;
  sessionName: string;
  kind: "service-stop";
  service: string;
  startedAt: string;
}

export interface WorktreeServiceRestartResponse {
  operationId: string;
  sessionName: string;
  kind: "service-restart";
  service: string;
  startedAt: string;
}

export interface DiffResponse {
  diff: string;
  empty: boolean;
}

/**
 * Directory suggestion returned by the add-project autocomplete endpoint.
 * Mirrors the daemon's `DirectorySuggestion` shape.
 */
export interface DirectorySuggestion {
  path: string;
  name: string;
  isGitWorktree: boolean;
}

export interface DirectoryListResponse {
  path: string;
  entries: DirectorySuggestion[];
}

export type DirectoryErrorCode =
  | "validation"
  | "not-found"
  | "not-directory"
  | "permission-denied"
  | "forbidden";

export interface ProjectPathValidateResponse {
  valid: boolean;
  inputPath?: string;
  sourcePath?: string;
  message?: string;
  warning?: {
    code: "missing-config";
    message: string;
  };
}

/**
 * Maximum size (bytes) of a worktree file that the editor will request from
 * the daemon. Mirrors `WORKTREE_FILE_MAX_BYTES` on the daemon side.
 */
export const WORKTREE_FILE_MAX_BYTES = 1024 * 1024;

export interface WorktreeFileEntry {
  path: string;
  name: string;
  kind: "file" | "directory";
  size?: number;
  mtimeMs?: number;
  /** Two-character git status XY code for changed files (e.g. ` M`, `??`). */
  gitStatus?: string;
  /** Count of changed files within a directory's whole subtree. */
  changedCount?: number;
}

export interface WorktreeFileTreeResponse {
  worktreePath: string;
  dir: string;
  entries: WorktreeFileEntry[];
}

export interface WorktreeFileContentResponse {
  worktreePath: string;
  file: string;
  content: string;
  size: number;
  mtimeMs: number;
  editable: true;
}

export interface WorktreeFileWriteResponse {
  worktreePath: string;
  file: string;
  size: number;
  mtimeMs: number;
}

export type WorktreeFileErrorCode =
  | "validation"
  | "not-found"
  | "not-a-file"
  | "not-a-directory"
  | "unsupported-file"
  | "conflict"
  | "permission-denied"
  | "server-error";

export interface WorktreeFileErrorBody {
  error: WorktreeFileErrorCode;
  message: string;
  reason?: "binary" | "too-large";
  size?: number;
  maxBytes?: number;
  currentMtimeMs?: number;
}

export type DiffFileStatus =
  | "added"
  | "deleted"
  | "modified"
  | "renamed"
  | "copied"
  | "type-changed"
  | "unknown";

export type DiffLineKind = "context" | "add" | "delete" | "no-newline";

export interface DiffLine {
  id: string;
  kind: DiffLineKind;
  oldLine?: number;
  newLine?: number;
  content: string;
}

export interface DiffHunk {
  id: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header?: string;
  lines: DiffLine[];
}

export interface DiffFile {
  id: string;
  status: DiffFileStatus;
  oldPath?: string;
  newPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
  isText: boolean;
  hunks: DiffHunk[];
}

export interface DiffSet {
  raw: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: DiffFile[];
}

export interface ReviewDiffResponse {
  totalAdditions: number;
  totalDeletions: number;
  totalChangedFiles: number;
  staged: DiffSet;
  unstaged: DiffSet;
}

// ---------- Worktree Git write + commit-message ----------

export interface WorktreeGitStageRequest {
  path: string;
  files: string[];
  /** Stage every change (`git add --all`); `files` may be empty. Stage only. */
  all?: boolean;
}

export interface WorktreeGitStageResponse {
  ok: true;
}

export interface WorktreeGitCommitRequest {
  path: string;
  message: string;
  push?: boolean;
  amend?: boolean;
}

export interface WorktreeHeadState {
  detached: boolean;
  branch?: string;
  head: string;
}

export interface WorktreeGitCommitResponse {
  sha: string;
  summary: string;
  push?: { summary: string };
}

export interface WorktreeGitBranchRequest {
  path: string;
  name: string;
}

export interface WorktreeGitBranchResponse {
  head: WorktreeHeadState;
}

export interface WorktreeGitFetchRequest {
  path: string;
  prune?: boolean;
}

export interface WorktreeGitFetchResponse {
  ok: true;
  /** Commits ahead of upstream after the fetch; omitted when detached/no upstream. */
  aheadCount?: number;
  /** Commits behind upstream after the fetch; omitted when detached/no upstream. */
  behindCount?: number;
}

export interface WorktreeGitPushRequest {
  path: string;
}

export interface WorktreeGitPushResponse {
  ok: true;
  summary: string;
  /** Commits ahead of upstream after the push; omitted when detached/no upstream. */
  aheadCount?: number;
  /** Commits behind upstream after the push; omitted when detached/no upstream. */
  behindCount?: number;
}

export interface WorktreeCommitMessageRequest {
  path: string;
  files?: string[];
}

export interface WorktreeCommitMessageResponse {
  message: string;
}

export type GitWriteErrorCode =
  | "git-error"
  | "nothing-staged"
  | "no-provider-configured"
  | "generation-failed"
  | "validation"
  | "not-a-worktree"
  | "non-fast-forward";

export interface GitWriteErrorBody {
  error: GitWriteErrorCode;
  message: string;
}

export interface UiOperationEnvelope {
  operationId: string;
  sessionName: string;
  sequence: number;
  timestamp: string;
  event?: import("./events").DeploymentEvent;
  terminal?: { status: "succeeded" | "failed"; failureMessage?: string };
}

export type LogChannel = "deployment" | "init" | `service:${string}`;

export interface SessionLogEnvelope {
  sessionName: string;
  sequence: number;
  timestamp: string;
  /** Full log channel (`deployment`, `init` or `service:<name>`). */
  channel: LogChannel;
  service: string;
  stream: "stdout" | "stderr";
  chunk: string;
}

import type { UnifiedEventEnvelope } from "./unified-events";

export type { UnifiedEventEnvelope } from "./unified-events";

export class UiApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
  }
}

export class UiSessionBusyError extends UiApiError {}
export class UiUnauthorizedError extends UiApiError {
  constructor(body?: unknown) {
    super("unauthorized", 401, body);
  }
}
export class UiForbiddenError extends UiApiError {
  constructor(body?: unknown) {
    super("forbidden", 403, body);
  }
}
export class UiValidationError extends UiApiError {
  constructor(
    message: string,
    body?: unknown,
    public readonly fieldErrors: SettingsValidationFieldError[] = [],
  ) {
    super(message, 400, body);
  }
}

/**
 * Thrown by the Git write + commit-message methods when the daemon returns a
 * structured `GitWriteErrorBody`. `code` lets the composer distinguish
 * `nothing-staged` / `no-provider-configured` from a real Git/provider failure.
 */
export class UiGitWriteError extends UiApiError {
  constructor(
    message: string,
    public readonly code: GitWriteErrorCode,
    status: number,
    body?: unknown,
  ) {
    super(message, status, body);
  }
}

export interface SettingsValidationFieldError {
  field: string;
  message: string;
}

export interface SettingsHealthcheckDraft {
  timeout?: number | string;
  start_period?: number | string;
  interval?: number | string;
  request_timeout?: number | string;
  retries?: number;
}

export interface SettingsTunnelWebUiDraft {
  enabled?: boolean;
  subdomain?: string;
  secret?: string;
  terminalEnabled?: boolean;
  whitelistIps?: string[];
}

export interface SettingsServiceTunnelsDraft {
  enabled?: boolean;
  whitelistIps?: string[];
}

export type SettingsSslCertificateSource = "files" | "self-signed" | "letsencrypt";
export type SettingsLetsEncryptDirectory = "staging" | "production";

export type SettingsLetsEncryptChallengeProvider = "hook" | "cloudflare";

export interface SettingsLetsEncryptHookChallengeDraft {
  type?: "dns-01";
  provider?: "hook";
  createCommand?: string;
  deleteCommand?: string;
  propagationSeconds?: number;
}

export interface SettingsLetsEncryptCloudflareChallengeDraft {
  type?: "dns-01";
  provider?: "cloudflare";
  apiTokenEnv?: string;
  apiToken?: string;
  zoneId?: string;
  propagationSeconds?: number;
}

export type SettingsLetsEncryptChallengeDraft =
  | SettingsLetsEncryptHookChallengeDraft
  | SettingsLetsEncryptCloudflareChallengeDraft;

export interface SettingsLetsEncryptDraft {
  email?: string;
  acceptTerms?: boolean;
  directory?: SettingsLetsEncryptDirectory;
  challenge?: SettingsLetsEncryptChallengeDraft;
}

export interface SettingsSslDraft {
  enabled?: boolean;
  source?: SettingsSslCertificateSource;
  cert?: string;
  key?: string;
  letsencrypt?: SettingsLetsEncryptDraft;
}

export interface SettingsTunnelDraft {
  enabled?: boolean;
  port?: number;
  publicPort?: number;
  domain?: string;
  ssl?: SettingsSslDraft;
  webUi?: SettingsTunnelWebUiDraft;
  serviceTunnels?: SettingsServiceTunnelsDraft;
}

export type SettingsTerminalBackend = "default" | "tmux";

export type SettingsAiProviderType =
  | "openai"
  | "anthropic"
  | "openrouter"
  | "openai-like"
  | "anthropic-like";

export interface SettingsAiProviderDraft {
  type?: SettingsAiProviderType;
  apiKey?: string;
  name?: string;
  baseUrl?: string;
  models?: string[];
}

/** Default provider/model for AI commit-message generation. */
export interface SettingsCommitMessagesDraft {
  provider?: string;
  model?: string;
}

/** Global install status of the wos agent activity plugins. */
export interface AgentPluginsResponse {
  claude: { installed: boolean; outdated: boolean };
  opencode: { installed: boolean };
  codex: { installed: boolean; outdated: boolean };
  /** pi has no version to repair: installed-only, never `outdated`. */
  pi: { installed: boolean };
}

export interface AgentPluginsInstallResponse {
  claude: { installed: boolean; outdated: boolean; migratedLegacyHooks: boolean };
  opencode: { installed: boolean; changed: boolean };
  /**
   * Codex install is best-effort: `error` / `message` carry a typed failure
   * (e.g. `codex-cli-not-found`) without failing the whole install request.
   */
  codex: {
    installed: boolean;
    outdated: boolean;
    error?: string;
    message?: string;
  };
  /** pi extension drop-file install (installed-only, like opencode). */
  pi: { installed: boolean; changed: boolean };
}

/** Result of a claude-only plugin reinstall (uninstall → update → install). */
export interface AgentPluginsReinstallResponse {
  claude: { installed: boolean; outdated: boolean; migratedLegacyHooks: boolean };
}

export interface SettingsConfigDraft {
  web?: {
    port?: number;
    host?: string;
    ssl?: SettingsSslDraft;
  };
  tunnel?: SettingsTunnelDraft;
  healthcheck?: SettingsHealthcheckDraft;
  terminalBackend?: SettingsTerminalBackend;
  editorCommand?: string;
  serviceBind?: string;
  aiProviders?: SettingsAiProviderDraft[];
  commitMessages?: SettingsCommitMessagesDraft;
  autoInjectAgentPlugins?: boolean;
}

export interface SettingsEffectiveAiProvider {
  type: SettingsAiProviderType;
  apiKey: string;
  name?: string;
  baseUrl?: string;
  models?: string[];
}

export type SettingsEffectiveLetsEncryptChallenge =
  | {
      type: "dns-01";
      provider: "hook";
      createCommand: string;
      deleteCommand: string;
      propagationSeconds: number;
    }
  | {
      type: "dns-01";
      provider: "cloudflare";
      apiTokenEnv?: string;
      apiToken?: string;
      zoneId?: string;
      propagationSeconds: number;
    };

export type SettingsEffectiveSsl =
  | { enabled: false }
  | { enabled: true; source: "files"; cert: string; key: string }
  | { enabled: true; source: "self-signed" }
  | {
      enabled: true;
      source: "letsencrypt";
      letsencrypt: {
        email: string;
        acceptTerms: true;
        directory: SettingsLetsEncryptDirectory;
        challenge: SettingsEffectiveLetsEncryptChallenge;
      };
    };

export type SettingsEffectiveTunnelWebUi =
  | { enabled: false }
  | {
      enabled: true;
      hostname: string;
      secret: string;
      terminalEnabled: boolean;
      whitelistIps: string[];
    };

export interface SettingsEffectiveServiceTunnels {
  enabled: boolean;
  whitelistIps: string[];
}

export interface SettingsEffectiveConfig {
  web: {
    port: number;
    host: string;
    ssl: SettingsEffectiveSsl;
  };
  tunnel:
    | {
        enabled: false;
        port: number;
        publicPort?: number;
        ssl: SettingsEffectiveSsl;
        webUi: SettingsEffectiveTunnelWebUi;
        serviceTunnels: SettingsEffectiveServiceTunnels;
      }
    | {
        enabled: true;
        port: number;
        publicPort?: number;
        domain: string;
        ssl: SettingsEffectiveSsl;
        webUi: SettingsEffectiveTunnelWebUi;
        serviceTunnels: SettingsEffectiveServiceTunnels;
      };
  healthcheck: {
    timeoutMs?: number;
    startPeriodMs?: number;
    intervalMs?: number;
    retries?: number;
    requestTimeoutMs?: number;
  };
  terminalBackend: SettingsTerminalBackend;
  editorCommand?: string;
  serviceBind?: string;
  aiProviders: SettingsEffectiveAiProvider[];
  commitMessages: SettingsCommitMessagesDraft;
  autoInjectAgentPlugins: boolean;
}

export interface SettingsEffectiveSslSource {
  source: SettingsSslCertificateSource | "disabled";
}

export interface SettingsCertificateStatus {
  listenerKind: "web" | "tunnel";
  source: SettingsSslCertificateSource | "disabled";
  challengeProvider?: SettingsLetsEncryptChallengeProvider;
  state: "disabled" | "issuing" | "active" | "renewing" | "failed" | "stale";
  hostnames: string[];
  notBefore?: string;
  notAfter?: string;
  lastSuccessAt?: string;
  lastAttemptAt?: string;
  lastError?: { phase: string; message: string; at: string };
  active: boolean;
}

export interface SettingsConfigSnapshot {
  path: string;
  exists: boolean;
  raw: SettingsConfigDraft | null;
  effective: SettingsEffectiveConfig;
  effectiveSsl?: {
    web: SettingsEffectiveSslSource;
    tunnel: SettingsEffectiveSslSource;
  };
}

export interface SettingsConfigResponse {
  config: SettingsConfigSnapshot;
  restartRequired?: boolean;
  certificateStatus?: {
    web?: SettingsCertificateStatus;
    tunnel?: SettingsCertificateStatus;
  };
}

// ---- Notifications (mirrors @worktreeos/core/notifications) ----

export type NotificationKindId = "agent.done" | "agent.question";

/** Telegram delivery mode (mirrors `@worktreeos/core/notifications`). */
export type TelegramDeliveryMode = "always" | "when-away";

export interface NotificationRuleView {
  enabled: boolean;
  channels: { telegram: boolean; webpush: boolean };
}

export interface NotificationsConfigView {
  rules: Record<string, NotificationRuleView>;
  channels: {
    telegram: {
      enabled: boolean;
      botToken: string;
      chatId: string;
      mode: TelegramDeliveryMode;
    };
    webpush: { enabled: boolean };
  };
  pushSubscriptions: unknown[];
}

export interface NotificationsResponse {
  config: NotificationsConfigView;
  /** VAPID application server public key (base64url) for Web Push. */
  vapidPublicKey: string;
}

export interface NotificationsUpdateInput {
  rules?: Record<string, NotificationRuleView>;
  channels?: {
    telegram?: {
      enabled?: boolean;
      botToken?: string;
      chatId?: string;
      mode?: TelegramDeliveryMode;
    };
    webpush?: { enabled?: boolean };
  };
}

/** Browser push subscription shape POSTed to the daemon. */
export interface StoredPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
}

export interface TestNotificationResult {
  ok: boolean;
  error?: string;
}

/** Availability of the tmux terminal backend multiplexer, freshly probed. */
export interface TerminalBackendAvailability {
  available: boolean;
  reason?: string;
  binary: string;
  platform: string;
}

/** Response body returned by `GET /ui/v1/settings/terminal-backend/availability`. */
export interface TerminalBackendAvailabilityResponse {
  tmux: TerminalBackendAvailability;
}

export interface SetupStatusResponse {
  setupRequired: boolean;
  globalConfig: SettingsConfigSnapshot;
  projectCount: number;
}

/** Response body returned by `POST /ui/v1/daemon/restart`. */
export interface DaemonRestartResponse {
  status: "scheduled";
  scheduledAt: string;
}

export type WorktreeUpConfigErrorCode = "config-missing" | "config-invalid";

export interface WorktreeUpConfigErrorBody {
  error: WorktreeUpConfigErrorCode;
  message: string;
  path?: string;
}

export class UiWorktreeConfigError extends UiApiError {
  constructor(
    message: string,
    public readonly code: WorktreeUpConfigErrorCode,
    public readonly configPath: string | undefined,
    body?: unknown,
  ) {
    super(message, 400, body);
  }
}

/**
 * Aggregate counts of dirty Git entries surfaced by the daemon when a
 * worktree removal is rejected for unconfirmed local changes.
 */
export interface WorktreeDirtyChangeCounts {
  total: number;
  staged: number;
  unstaged: number;
  untracked: number;
  unmerged: number;
}

export interface WorktreeDirtyErrorBody {
  error: "worktree-dirty";
  message: string;
  path: string;
  changes: WorktreeDirtyChangeCounts;
}

/**
 * Thrown by `submitWorktreeRemove` when the daemon rejects clean-by-default
 * removal because the target worktree has local Git changes. Clients should
 * open a confirmation modal and resubmit with `discardChanges: true`.
 */
export class UiWorktreeDirtyError extends UiApiError {
  constructor(
    message: string,
    public readonly worktreePath: string,
    public readonly changes: WorktreeDirtyChangeCounts,
    body?: unknown,
  ) {
    super(message, 409, body);
  }
}

export interface AuthSessionResponse {
  authenticated: boolean;
  /**
   * True when this request reached the daemon through the public hostname and
   * the daemon has a configured shared secret. The web UI uses this to decide
   * whether to render the public login state.
   */
  requiresAuth: boolean;
  /**
   * Epoch ms timestamp the daemon process was started. Changes across daemon
   * restart; the Settings page uses this to detect when a restart has fully
   * completed.
   */
  daemonStartedAt?: number;
}

export interface CreateUiApiOptions {
  /** Called whenever a non-auth request returns `401`. */
  onUnauthorized?: () => void;
}

async function readJsonSafe(res: Response): Promise<unknown> {
  try {
    return await res.clone().json();
  } catch {
    return undefined;
  }
}

async function jsonOk<T>(res: Response): Promise<T> {
  if (res.status === 409) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    throw new UiSessionBusyError("session is busy", 409, body);
  }
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const message =
      (body as { message?: string })?.message ??
      `request failed (${res.status})`;
    throw new UiApiError(message, res.status, body);
  }
  return (await res.json()) as T;
}

/**
 * Resolve a Git write / commit-message response, mapping a structured
 * `GitWriteErrorBody` onto `UiGitWriteError` so callers can branch on `code`.
 */
async function gitWriteOk<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const code = (body as { error?: GitWriteErrorCode })?.error;
    const message =
      (body as { message?: string })?.message ??
      `request failed (${res.status})`;
    if (code) {
      throw new UiGitWriteError(message, code, res.status, body);
    }
    throw new UiApiError(message, res.status, body);
  }
  return (await res.json()) as T;
}

function buildUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

function splitNdjson<T>(buffer: string): { items: T[]; rest: string } {
  const items: T[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer.charCodeAt(i) === 10) {
      const line = buffer.slice(start, i).trim();
      if (line.length > 0) items.push(JSON.parse(line) as T);
      start = i + 1;
    }
  }
  return { items, rest: buffer.slice(start) };
}

function splitSseFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  let start = 0;
  while (true) {
    const idx = buffer.indexOf("\n\n", start);
    if (idx === -1) break;
    frames.push(buffer.slice(start, idx));
    start = idx + 2;
  }
  return { frames, rest: buffer.slice(start) };
}

function parseSseFrame(
  frame: string,
): { id?: number; data: string } | null {
  let id: number | undefined;
  const dataLines: string[] = [];
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0) continue;
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    let value = line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && Number.isInteger(parsed)) id = parsed;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }
  if (dataLines.length === 0) return null;
  return { id, data: dataLines.join("\n") };
}

export function createUiApi(
  baseUrl: string = "",
  opts: CreateUiApiOptions = {},
) {
  const onUnauthorized = opts.onUnauthorized;
  // Wrap `fetch` so that any 401 on a protected request notifies the auth
  // layer. Auth endpoints (login/session/logout) are exempt — those naturally
  // return 401 for invalid input and should not flip the UI.
  const apiFetch = async (
    input: RequestInfo,
    init?: RequestInit,
  ): Promise<Response> => {
    const res = await fetch(input, init);
    if (res.status === 401 && onUnauthorized) {
      const url =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : String(input);
      if (!url.includes("/ui/v1/auth/")) {
        try {
          onUnauthorized();
        } catch {
          /* swallow */
        }
      }
    }
    return res;
  };

  return {
    async getAuthSession(): Promise<AuthSessionResponse> {
      const res = await apiFetch(buildUrl(baseUrl, "/ui/v1/auth/session"));
      if (!res.ok) {
        throw new UiApiError(`auth session failed (${res.status})`, res.status);
      }
      return (await res.json()) as AuthSessionResponse;
    },
    async login(secret: string): Promise<void> {
      const res = await apiFetch(buildUrl(baseUrl, "/ui/v1/auth/login"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret }),
      });
      if (res.status === 401) throw new UiUnauthorizedError();
      if (!res.ok) {
        throw new UiApiError(`login failed (${res.status})`, res.status);
      }
    },
    async logout(): Promise<void> {
      await apiFetch(buildUrl(baseUrl, "/ui/v1/auth/logout"), { method: "POST" });
    },
    async listProjects(): Promise<ProjectListResponse> {
      return jsonOk(await apiFetch(buildUrl(baseUrl, "/ui/v1/projects")));
    },
    async addProject(req: ProjectAddRequest): Promise<ProjectAddResponse> {
      return jsonOk(
        await apiFetch(buildUrl(baseUrl, "/ui/v1/projects"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(req),
        }),
      );
    },
    async listDirectories(path: string): Promise<DirectoryListResponse> {
      return jsonOk(
        await apiFetch(
          buildUrl(
            baseUrl,
            `/ui/v1/filesystem/directories?path=${encodeURIComponent(path)}`,
          ),
        ),
      );
    },
    async validateProjectPath(
      path: string,
    ): Promise<ProjectPathValidateResponse> {
      return jsonOk(
        await apiFetch(
          buildUrl(
            baseUrl,
            `/ui/v1/projects/validate?path=${encodeURIComponent(path)}`,
          ),
        ),
      );
    },
    async getSettingsConfig(): Promise<SettingsConfigResponse> {
      const res = await apiFetch(buildUrl(baseUrl, "/ui/v1/settings/config"));
      if (res.status === 401) throw new UiUnauthorizedError();
      if (res.status === 403) {
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          body = undefined;
        }
        throw new UiForbiddenError(body);
      }
      return jsonOk(res);
    },
    async getTerminalBackendAvailability(): Promise<TerminalBackendAvailabilityResponse> {
      const res = await apiFetch(
        buildUrl(baseUrl, "/ui/v1/settings/terminal-backend/availability"),
      );
      if (res.status === 401) throw new UiUnauthorizedError();
      if (res.status === 403) {
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          body = undefined;
        }
        throw new UiForbiddenError(body);
      }
      return jsonOk(res);
    },
    async saveSettingsConfig(
      draft: SettingsConfigDraft,
    ): Promise<SettingsConfigResponse> {
      const res = await apiFetch(buildUrl(baseUrl, "/ui/v1/settings/config"), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (res.status === 401) throw new UiUnauthorizedError();
      if (res.status === 403) {
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          body = undefined;
        }
        throw new UiForbiddenError(body);
      }
      if (res.status === 400) {
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          body = undefined;
        }
        const message =
          (body as { message?: string })?.message ?? "invalid settings";
        const fieldErrors =
          (body as { errors?: SettingsValidationFieldError[] })?.errors ?? [];
        throw new UiValidationError(message, body, fieldErrors);
      }
      return jsonOk(res);
    },
    async getNotifications(): Promise<NotificationsResponse> {
      const res = await apiFetch(
        buildUrl(baseUrl, "/ui/v1/settings/notifications"),
      );
      if (res.status === 401) throw new UiUnauthorizedError();
      if (res.status === 403) {
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          body = undefined;
        }
        throw new UiForbiddenError(body);
      }
      return jsonOk(res);
    },
    async saveNotifications(
      update: NotificationsUpdateInput,
    ): Promise<{ config: NotificationsConfigView }> {
      const res = await apiFetch(
        buildUrl(baseUrl, "/ui/v1/settings/notifications"),
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(update),
        },
      );
      if (res.status === 401) throw new UiUnauthorizedError();
      if (res.status === 403) {
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          body = undefined;
        }
        throw new UiForbiddenError(body);
      }
      return jsonOk(res);
    },
    async registerPushSubscription(
      subscription: StoredPushSubscription,
    ): Promise<{ ok: boolean }> {
      const res = await apiFetch(
        buildUrl(baseUrl, "/ui/v1/settings/notifications/subscribe"),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(subscription),
        },
      );
      if (res.status === 401) throw new UiUnauthorizedError();
      return jsonOk(res);
    },
    async sendTestNotification(
      channel: string,
      kind?: NotificationKindId,
    ): Promise<TestNotificationResult> {
      const res = await apiFetch(
        buildUrl(baseUrl, "/ui/v1/settings/notifications/test"),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channel, ...(kind ? { kind } : {}) }),
        },
      );
      if (res.status === 401) throw new UiUnauthorizedError();
      // 502 carries a structured { ok:false, error } outcome — return it.
      try {
        return (await res.json()) as TestNotificationResult;
      } catch {
        return { ok: false, error: `request failed (${res.status})` };
      }
    },
    /**
     * Report this client's window focus state to the daemon presence registry
     * (focus/blur/visibility transitions and the focused heartbeat). Best-effort
     * — a failed report is recovered by the next heartbeat or the daemon TTL.
     * `keepalive` lets a report survive an in-flight navigation.
     */
    async postPresence(
      clientId: string,
      state: "focused" | "away",
    ): Promise<void> {
      try {
        await apiFetch(buildUrl(baseUrl, "/ui/v1/presence"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientId, state }),
          keepalive: true,
        });
      } catch {
        // Presence is best-effort; the TTL is the backstop.
      }
    },
    /**
     * Best-effort `away` report on page hide / unload via `navigator.sendBeacon`,
     * which survives a dying page where `fetch` would be cancelled. The daemon
     * TTL is the backstop if the beacon is dropped.
     */
    sendPresenceBeacon(clientId: string, state: "focused" | "away"): void {
      if (
        typeof navigator === "undefined" ||
        typeof navigator.sendBeacon !== "function"
      ) {
        return;
      }
      try {
        const blob = new Blob([JSON.stringify({ clientId, state })], {
          type: "application/json",
        });
        navigator.sendBeacon(buildUrl(baseUrl, "/ui/v1/presence"), blob);
      } catch {
        // Best-effort; the TTL is the backstop.
      }
    },
    async restartDaemon(): Promise<DaemonRestartResponse> {
      const res = await apiFetch(buildUrl(baseUrl, "/ui/v1/daemon/restart"), {
        method: "POST",
      });
      if (res.status === 401) throw new UiUnauthorizedError();
      if (res.status === 403) {
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          body = undefined;
        }
        throw new UiForbiddenError(body);
      }
      return jsonOk<DaemonRestartResponse>(res);
    },
    async getWorktreeDetail(path: string): Promise<WorktreeDetailResponse> {
      return jsonOk(
        await apiFetch(
          buildUrl(
            baseUrl,
            `/ui/v1/worktrees?path=${encodeURIComponent(path)}`,
          ),
        ),
      );
    },
    async submitUp(
      path: string,
      force = false,
      options: {
        services?: string[];
        target?: string;
        arguments?: Record<string, string>;
      } = {},
    ): Promise<WorktreeUpResponse> {
      const payload: Record<string, unknown> = { path, force };
      if (options.services !== undefined) payload.services = options.services;
      if (options.target !== undefined) payload.target = options.target;
      if (options.arguments !== undefined) payload.arguments = options.arguments;
      const res = await apiFetch(buildUrl(baseUrl, "/ui/v1/worktrees/up"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.status === 400) {
        // Peek at the body once and decide whether this is the structured
        // config-gate rejection. If not, fall through to the standard error
        // path with the parsed body so downstream UI text stays intact.
        let body: unknown;
        try {
          body = await res.clone().json();
        } catch {
          body = undefined;
        }
        const errCode = (body as { error?: string })?.error;
        if (errCode === "config-missing" || errCode === "config-invalid") {
          const message =
            (body as { message?: string })?.message ??
            "a project deploy config is required to start";
          const cfgPath = (body as { path?: string })?.path;
          throw new UiWorktreeConfigError(message, errCode, cfgPath, body);
        }
      }
      return jsonOk(res);
    },
    async getSetupStatus(): Promise<SetupStatusResponse> {
      const res = await apiFetch(buildUrl(baseUrl, "/ui/v1/setup/status"));
      if (res.status === 401) throw new UiUnauthorizedError();
      if (res.status === 403) {
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          body = undefined;
        }
        throw new UiForbiddenError(body);
      }
      return jsonOk(res);
    },
    async submitDown(path: string): Promise<WorktreeDownResponse> {
      return jsonOk(
        await apiFetch(buildUrl(baseUrl, "/ui/v1/worktrees/down"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path }),
        }),
      );
    },
    async submitWorktreeRemove(
      path: string,
      discardChanges = false,
    ): Promise<WorktreeRemoveResponse> {
      const res = await apiFetch(buildUrl(baseUrl, "/ui/v1/worktrees/remove"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, discardChanges }),
      });
      if (res.status === 409) {
        let body: unknown;
        try {
          body = await res.clone().json();
        } catch {
          body = undefined;
        }
        if ((body as { error?: string })?.error === "worktree-dirty") {
          const dirty = body as WorktreeDirtyErrorBody;
          throw new UiWorktreeDirtyError(
            dirty.message,
            dirty.path,
            dirty.changes,
            body,
          );
        }
      }
      return jsonOk(res);
    },
    async submitWorktreeCreate(
      req: WorktreeCreateRequest,
    ): Promise<WorktreeCreateResponse> {
      return jsonOk(
        await apiFetch(buildUrl(baseUrl, "/ui/v1/worktrees/create"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(req),
        }),
      );
    },
    async submitWorktreeRename(
      req: WorktreeRenameRequest,
    ): Promise<WorktreeRenameResponse> {
      const res = await apiFetch(buildUrl(baseUrl, "/ui/v1/worktrees/name"), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
      if (res.status === 400) {
        let body: unknown;
        try {
          body = await res.clone().json();
        } catch {
          body = undefined;
        }
        const message =
          (body as { message?: string })?.message ?? "invalid display name";
        throw new UiValidationError(message, body, []);
      }
      return jsonOk(res);
    },
    async submitWorktreeNote(
      req: WorktreeNoteRequest,
    ): Promise<WorktreeNoteResponse> {
      const res = await apiFetch(buildUrl(baseUrl, "/ui/v1/worktrees/note"), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
      if (res.status === 400) {
        let body: unknown;
        try {
          body = await res.clone().json();
        } catch {
          body = undefined;
        }
        const message =
          (body as { message?: string })?.message ?? "invalid note";
        throw new UiValidationError(message, body, []);
      }
      return jsonOk(res);
    },
    async submitOpenEditor(path: string): Promise<WorktreeOpenEditorResponse> {
      return jsonOk(
        await apiFetch(buildUrl(baseUrl, "/ui/v1/worktrees/open-editor"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path }),
        }),
      );
    },
    async listStatuses(): Promise<StatusCatalogResponse> {
      return jsonOk(await apiFetch(buildUrl(baseUrl, "/ui/v1/statuses")));
    },
    async createStatus(
      name: string,
      color: string,
    ): Promise<StatusCreateResponse> {
      const res = await apiFetch(buildUrl(baseUrl, "/ui/v1/statuses"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, color }),
      });
      if (res.status === 400) {
        const body = await readJsonSafe(res);
        throw new UiValidationError(
          (body as { message?: string })?.message ?? "invalid status",
          body,
          [],
        );
      }
      return jsonOk(res);
    },
    async updateStatus(
      id: string,
      update: { name?: string; color?: string; order?: number },
    ): Promise<StatusUpdateResponse> {
      const res = await apiFetch(
        buildUrl(baseUrl, `/ui/v1/statuses/${encodeURIComponent(id)}`),
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(update),
        },
      );
      if (res.status === 400) {
        const body = await readJsonSafe(res);
        throw new UiValidationError(
          (body as { message?: string })?.message ?? "invalid status",
          body,
          [],
        );
      }
      return jsonOk(res);
    },
    async deleteStatus(id: string): Promise<StatusDeleteResponse> {
      return jsonOk(
        await apiFetch(
          buildUrl(baseUrl, `/ui/v1/statuses/${encodeURIComponent(id)}`),
          { method: "DELETE" },
        ),
      );
    },
    async setWorktreeStatus(
      path: string,
      statusId: string | null,
      order?: number,
    ): Promise<WorktreeStatusResponse> {
      const res = await apiFetch(buildUrl(baseUrl, "/ui/v1/worktrees/status"), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path,
          statusId,
          ...(order !== undefined ? { order } : {}),
        }),
      });
      if (res.status === 400) {
        const body = await readJsonSafe(res);
        throw new UiValidationError(
          (body as { message?: string })?.message ?? "invalid status",
          body,
          [],
        );
      }
      return jsonOk(res);
    },
    async listWorktreeComments(
      path: string,
    ): Promise<WorktreeCommentsResponse> {
      return jsonOk(
        await apiFetch(
          buildUrl(
            baseUrl,
            `/ui/v1/worktrees/comments?path=${encodeURIComponent(path)}`,
          ),
        ),
      );
    },
    async addWorktreeComment(
      path: string,
      text: string,
    ): Promise<WorktreeCommentAddResponse> {
      const res = await apiFetch(buildUrl(baseUrl, "/ui/v1/worktrees/comments"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, text }),
      });
      if (res.status === 400) {
        const body = await readJsonSafe(res);
        throw new UiValidationError(
          (body as { message?: string })?.message ?? "invalid comment",
          body,
          [],
        );
      }
      return jsonOk(res);
    },
    async deleteWorktreeComment(
      path: string,
      commentId: string,
    ): Promise<WorktreeCommentsResponse> {
      return jsonOk(
        await apiFetch(buildUrl(baseUrl, "/ui/v1/worktrees/comments"), {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, commentId }),
        }),
      );
    },
    async getAgentPlugins(): Promise<AgentPluginsResponse> {
      return jsonOk(await apiFetch(buildUrl(baseUrl, "/ui/v1/agent-plugins")));
    },
    async installAgentPlugins(): Promise<AgentPluginsInstallResponse> {
      return jsonOk(
        await apiFetch(buildUrl(baseUrl, "/ui/v1/agent-plugins/install"), {
          method: "POST",
        }),
      );
    },
    async reinstallAgentPlugins(): Promise<AgentPluginsReinstallResponse> {
      return jsonOk(
        await apiFetch(buildUrl(baseUrl, "/ui/v1/agent-plugins/reinstall"), {
          method: "POST",
        }),
      );
    },
    async listTerminalLayerSessions(
      worktreePath?: string,
    ): Promise<{ sessions: import("./terminal-protocol").TerminalSessionMetadata[] }> {
      const query = worktreePath
        ? `?path=${encodeURIComponent(worktreePath)}`
        : "";
      return jsonOk(
        await apiFetch(buildUrl(baseUrl, `/ui/v1/terminal-layer/sessions${query}`)),
      );
    },
    async createTerminalLayerSession(req: {
      worktreePath: string;
      cols?: number;
      rows?: number;
      shell?: string;
      cwd?: string;
    }): Promise<{ session: import("./terminal-protocol").TerminalSessionMetadata }> {
      return jsonOk(
        await apiFetch(buildUrl(baseUrl, "/ui/v1/terminal-layer/sessions"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(req),
        }),
      );
    },
    async getTerminalLayerSession(
      id: string,
    ): Promise<{ session: import("./terminal-protocol").TerminalSessionMetadata }> {
      return jsonOk(
        await apiFetch(
          buildUrl(
            baseUrl,
            `/ui/v1/terminal-layer/sessions/${encodeURIComponent(id)}`,
          ),
        ),
      );
    },
    async terminateTerminalLayerSession(
      id: string,
    ): Promise<{ session: import("./terminal-protocol").TerminalSessionMetadata }> {
      return jsonOk(
        await apiFetch(
          buildUrl(
            baseUrl,
            `/ui/v1/terminal-layer/sessions/${encodeURIComponent(id)}/terminate`,
          ),
          { method: "POST" },
        ),
      );
    },
    /** Set a terminal session title, or pass `null` to clear it. */
    async renameTerminalLayerSession(
      id: string,
      title: string | null,
    ): Promise<{ session: import("./terminal-protocol").TerminalSessionMetadata }> {
      return jsonOk(
        await apiFetch(
          buildUrl(
            baseUrl,
            `/ui/v1/terminal-layer/sessions/${encodeURIComponent(id)}`,
          ),
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title }),
          },
        ),
      );
    },
    terminalLayerAttachUrl(id: string, attachmentId?: string): string {
      const query = attachmentId
        ? `?attachmentId=${encodeURIComponent(attachmentId)}`
        : "";
      const path = `/ui/v1/terminal-layer/sessions/${encodeURIComponent(id)}/attach${query}`;
      if (baseUrl.length === 0) {
        const loc =
          typeof window !== "undefined" && window.location
            ? window.location
            : null;
        if (!loc) return path;
        const proto = loc.protocol === "https:" ? "wss:" : "ws:";
        return `${proto}//${loc.host}${path}`;
      }
      return baseUrl.replace(/^http/, "ws") + path;
    },
    /** One-shot current-screen snapshot for a single session (pane seeding). */
    async getTerminalSnapshot(
      id: string,
    ): Promise<import("./terminal-protocol").TerminalSnapshotResponse> {
      return jsonOk(
        await apiFetch(
          buildUrl(
            baseUrl,
            `/ui/v1/terminal-layer/sessions/${encodeURIComponent(id)}/snapshot`,
          ),
        ),
      );
    },
    /**
     * URL of the Mission Control snapshot-stream SSE endpoint for a set of
     * session ids at a given cadence (ms). Consumed by the lib snapshot client
     * via a single `EventSource`.
     */
    terminalSnapshotStreamUrl(ids: string[], cadenceMs: number): string {
      const params = new URLSearchParams({
        ids: ids.join(","),
        cadence: String(cadenceMs),
      });
      return buildUrl(baseUrl, `/ui/v1/terminal-layer/snapshots?${params.toString()}`);
    },
    async submitServiceStop(
      path: string,
      service: string,
    ): Promise<WorktreeServiceStopResponse> {
      return jsonOk(
        await apiFetch(buildUrl(baseUrl, "/ui/v1/worktrees/services/stop"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, service }),
        }),
      );
    },
    async submitServiceRestart(
      path: string,
      service: string,
    ): Promise<WorktreeServiceRestartResponse> {
      return jsonOk(
        await apiFetch(buildUrl(baseUrl, "/ui/v1/worktrees/services/restart"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, service }),
        }),
      );
    },
    async getStagedDiff(path: string): Promise<DiffResponse> {
      return jsonOk(
        await apiFetch(
          buildUrl(
            baseUrl,
            `/ui/v1/worktrees/diff/staged?path=${encodeURIComponent(path)}`,
          ),
        ),
      );
    },
    async getUnstagedDiff(path: string): Promise<DiffResponse> {
      return jsonOk(
        await apiFetch(
          buildUrl(
            baseUrl,
            `/ui/v1/worktrees/diff/unstaged?path=${encodeURIComponent(path)}`,
          ),
        ),
      );
    },
    async getReviewDiff(path: string): Promise<ReviewDiffResponse> {
      return jsonOk(
        await apiFetch(
          buildUrl(
            baseUrl,
            `/ui/v1/worktrees/diff/review?path=${encodeURIComponent(path)}`,
          ),
        ),
      );
    },
    async gitStage(
      req: WorktreeGitStageRequest,
    ): Promise<WorktreeGitStageResponse> {
      return gitWriteOk(
        await apiFetch(buildUrl(baseUrl, "/ui/v1/worktrees/git/stage"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(req),
        }),
      );
    },
    async gitUnstage(
      req: WorktreeGitStageRequest,
    ): Promise<WorktreeGitStageResponse> {
      return gitWriteOk(
        await apiFetch(buildUrl(baseUrl, "/ui/v1/worktrees/git/unstage"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(req),
        }),
      );
    },
    async gitCommit(
      req: WorktreeGitCommitRequest,
    ): Promise<WorktreeGitCommitResponse> {
      return gitWriteOk(
        await apiFetch(buildUrl(baseUrl, "/ui/v1/worktrees/git/commit"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(req),
        }),
      );
    },
    async gitBranch(
      req: WorktreeGitBranchRequest,
    ): Promise<WorktreeGitBranchResponse> {
      return gitWriteOk(
        await apiFetch(buildUrl(baseUrl, "/ui/v1/worktrees/git/branch"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(req),
        }),
      );
    },
    async gitFetch(
      req: WorktreeGitFetchRequest,
    ): Promise<WorktreeGitFetchResponse> {
      return gitWriteOk(
        await apiFetch(buildUrl(baseUrl, "/ui/v1/worktrees/git/fetch"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(req),
        }),
      );
    },
    async gitPush(
      req: WorktreeGitPushRequest,
    ): Promise<WorktreeGitPushResponse> {
      return gitWriteOk(
        await apiFetch(buildUrl(baseUrl, "/ui/v1/worktrees/git/push"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(req),
        }),
      );
    },
    async gitCommitMessage(
      req: WorktreeCommitMessageRequest,
    ): Promise<WorktreeCommitMessageResponse> {
      return gitWriteOk(
        await apiFetch(buildUrl(baseUrl, "/ui/v1/worktrees/git/commit-message"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(req),
        }),
      );
    },
    async getWorktreeFileTree(
      path: string,
      dir: string = "",
    ): Promise<WorktreeFileTreeResponse> {
      const params = new URLSearchParams({ path });
      if (dir.length > 0) params.set("dir", dir);
      return jsonOk(
        await apiFetch(
          buildUrl(baseUrl, `/ui/v1/worktrees/files/tree?${params.toString()}`),
        ),
      );
    },
    async getWorktreeFileContent(
      path: string,
      file: string,
    ): Promise<WorktreeFileContentResponse> {
      const params = new URLSearchParams({ path, file });
      return jsonOk(
        await apiFetch(
          buildUrl(
            baseUrl,
            `/ui/v1/worktrees/files/content?${params.toString()}`,
          ),
        ),
      );
    },
    async saveWorktreeFileContent(req: {
      path: string;
      file: string;
      content: string;
      expectedMtimeMs?: number;
    }): Promise<WorktreeFileWriteResponse> {
      return jsonOk(
        await apiFetch(buildUrl(baseUrl, "/ui/v1/worktrees/files/content"), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(req),
        }),
      );
    },
    async *streamOperationEvents(
      operationId: string,
      opts: { signal?: AbortSignal } = {},
    ): AsyncGenerator<UiOperationEnvelope, void, void> {
      const res = await apiFetch(
        buildUrl(
          baseUrl,
          `/ui/v1/operations/${encodeURIComponent(operationId)}/events`,
        ),
        { signal: opts.signal },
      );
      if (!res.ok || !res.body) {
        throw new UiApiError(`event stream failed (${res.status})`, res.status);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch {
            break;
          }
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const { items, rest } = splitNdjson<UiOperationEnvelope>(buffer);
          buffer = rest;
          for (const e of items) yield e;
        }
        buffer += decoder.decode();
        const { items } = splitNdjson<UiOperationEnvelope>(buffer);
        for (const e of items) yield e;
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* already released */
        }
      }
    },
    async *streamUnifiedEvents(
      opts: {
        signal?: AbortSignal;
        session?: string;
        lastEventId?: number;
      } = {},
    ): AsyncGenerator<UnifiedEventEnvelope, void, void> {
      const query = opts.session
        ? `?session=${encodeURIComponent(opts.session)}`
        : "";
      const headers: Record<string, string> = {};
      if (typeof opts.lastEventId === "number") {
        headers["Last-Event-ID"] = String(opts.lastEventId);
      }
      const res = await apiFetch(buildUrl(baseUrl, `/ui/v1/events${query}`), {
        signal: opts.signal,
        headers,
      });
      if (!res.ok || !res.body) {
        throw new UiApiError(
          `event stream failed (${res.status})`,
          res.status,
        );
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch {
            break;
          }
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const { frames, rest } = splitSseFrames(buffer);
          buffer = rest;
          for (const frame of frames) {
            const parsed = parseSseFrame(frame);
            if (!parsed) continue;
            try {
              yield JSON.parse(parsed.data) as UnifiedEventEnvelope;
            } catch {
              // Ignore non-JSON frames.
            }
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* already released */
        }
      }
    },
    async *streamWorktreeLogs(
      sessionName: string,
      opts: { signal?: AbortSignal; channel?: LogChannel } = {},
    ): AsyncGenerator<SessionLogEnvelope, void, void> {
      const params = new URLSearchParams({ session: sessionName });
      if (opts.channel) params.set("channel", opts.channel);
      const res = await apiFetch(
        buildUrl(baseUrl, `/ui/v1/worktrees/logs?${params.toString()}`),
        { signal: opts.signal },
      );
      if (!res.ok || !res.body) {
        throw new UiApiError(`log stream failed (${res.status})`, res.status);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch {
            break;
          }
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const { items, rest } = splitNdjson<SessionLogEnvelope>(buffer);
          buffer = rest;
          for (const e of items) yield e;
        }
        buffer += decoder.decode();
        const { items } = splitNdjson<SessionLogEnvelope>(buffer);
        for (const e of items) yield e;
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* already released */
        }
      }
    },
  };
}

export type UiApi = ReturnType<typeof createUiApi>;
