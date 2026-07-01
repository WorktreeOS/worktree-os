import type { AppPortHealthcheckResult } from "@worktreeos/runtime/healthchecks";
import type { ServiceStatus } from "@worktreeos/compose/ps";
import type { WosState } from "@worktreeos/core/state";
import type { TunnelSnapshot } from "@worktreeos/runtime/tunnel-registry";
import type { LogChannel, LogStream } from "@worktreeos/core/events";
import type { OperationMetadata } from "./daemon-protocol";
import type { TerminalSessionMetadata } from "./terminal-layer/types";

/**
 * Best-effort context about a failed worktree operation. The daemon populates
 * this when the latest known operation is failed; it lets UI clients render a
 * useful failure summary after a refresh without scraping raw logs.
 */
export interface WorktreeFailureContext {
  /** Operation id the failure belongs to, when known. */
  operationId?: string;
  /** Operation kind (e.g. `up`, `service-restart`). */
  kind?: import("./daemon-protocol").OperationKind;
  /** Human-readable failure message captured by the operation. */
  message?: string;
  /**
   * Log channel that most likely contains the failure output. `init` for
   * first-run setup or init-script failures, `service:<name>` for service
   * failures.
   */
  channel?: LogChannel;
  /** Deployment step that failed, when the daemon can infer one. */
  step?: import("@worktreeos/core/events").DeploymentStepId;
  /**
   * Last few lines (bounded, ~10) of the failed step's captured output, taken
   * from the operation log history at failure time. Best-effort: omitted when
   * no buffered output is available for the failed step.
   */
  logTail?: string[];
}

export const UI_API_VERSION = "1";

/**
 * Response body of `GET /ui/v1/health` for local (non-public) clients. Public
 * tunnel requests receive only the `ok`/`version` readiness fields.
 */
export interface UiHealthResponse {
  ok: boolean;
  /** UI API version. */
  version: string;
  /** Daemon protocol version (`DAEMON_PROTOCOL_VERSION`). */
  protocol?: string;
  /** Daemon process id. */
  pid?: number;
  /** Fresh identifier generated per daemon startup. */
  daemonId?: string;
  /** ISO timestamp of daemon startup. */
  startedAt?: string;
  /** Configured bind host of the web listener (e.g. `127.0.0.1` or `0.0.0.0`). */
  webHost?: string;
  /** Bound port of the web listener. */
  webPort?: number;
  /** Listener scheme. */
  webScheme?: "http" | "https";
}

/**
 * Response body returned by `POST /ui/v1/daemon/stop` when shutdown work has
 * been scheduled. The daemon returns this before the process exits.
 */
export interface DaemonStopResponse {
  status: "scheduled";
  /** ISO timestamp when the request was accepted. */
  scheduledAt: string;
}

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

/**
 * Per-worktree aggregate resource usage summed across running services. Fields
 * are optional and present only when at least one running service reported the
 * corresponding metric. Omitted entirely in shell mode or when no stats exist.
 */
export interface WorktreeResourceUsage {
  /** Total CPU percentage across running services. */
  cpuPercent?: number;
  /** Summed resident memory used (bytes) across running services. */
  memUsedBytes?: number;
}

export interface WorktreeSummary {
  /** Absolute path to the worktree root. */
  path: string;
  /** Short branch name when available. */
  branch?: string;
  /** Full branch ref when available. */
  branchRef?: string;
  /** HEAD commit SHA when available. */
  head?: string;
  /** True for detached HEAD. */
  detached: boolean;
  /** True when this worktree is the project's primary/source worktree. */
  isSource: boolean;
  /** Stable daemon session name derived from path. */
  sessionName: string;
  /** Current high-level deployment status. */
  status: DeploymentStatus;
  /**
   * Persisted display name used as the preferred human-readable label.
   * Omitted when no display name has been set for this worktree.
   */
  displayName?: string;
  /**
   * Persisted free-form note for this worktree. Omitted when no note has been
   * set.
   */
  note?: string;
  /**
   * Assigned workflow status id (the Kanban column this worktree sits in).
   * Independent of `status` (the derived deployment status). Omitted when the
   * worktree is unassigned ("no status").
   */
  workflowStatusId?: string;
  /** Within-status fractional order on the board. Omitted when unassigned. */
  workflowOrder?: number;
  /** Aggregate managed service counts when known. */
  serviceSummary?: ServiceSummary;
  /**
   * Per-worktree aggregate resource usage. Present only when the runtime can
   * supply stats for running managed containers; omitted in shell mode and
   * when no stats are available.
   */
  resourceUsage?: WorktreeResourceUsage;
  /** Active operation metadata when status reflects an ongoing operation. */
  activeOperation?: OperationMetadata;
  /** Commits ahead of the branch's upstream. Omitted when detached/no upstream. */
  aheadCount?: number;
  /** Commits behind the branch's upstream. Omitted when detached/no upstream. */
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

export interface ProjectSummary {
  id: string;
  displayName: string;
  /** Absolute path to the primary/source worktree. */
  sourcePath: string;
  createdAt: string;
  lastSeenAt: string;
  /** Identity-color palette slot in [0, PROJECT_PALETTE_SIZE). */
  colorSlot: number;
  /** Display order across projects; dense 0..n-1, lowest renders first. */
  order: number;
  /** Last validation/error message (e.g. stale path). */
  error?: string;
  /** True when the source path no longer resolves as a git worktree. */
  stale: boolean;
  /** Discovered worktrees; empty when project is stale. */
  worktrees: WorktreeSummary[];
}

export interface ProjectListResponse {
  projects: ProjectSummary[];
}

export interface ProjectAddRequest {
  /** Absolute path to a Git worktree. */
  path: string;
}

export interface ProjectAddResponse {
  project: ProjectSummary;
  /** True when a new project was created; false when a duplicate was updated. */
  created: boolean;
}

export interface ProjectAddErrorBody {
  error: "validation" | "git-error" | "server-error";
  message: string;
}

export interface ProjectUpdateRequest {
  /** New display name. */
  displayName?: string;
  /** New identity-color palette slot in [0, PROJECT_PALETTE_SIZE). */
  colorSlot?: number;
  /** Target display-order position (0-based); the project is moved there. */
  order?: number;
}

export interface ProjectUpdateResponse {
  /** The updated project. */
  project: ProjectSummary;
  /** The full project list after the update (orders may have shifted). */
  projects: ProjectSummary[];
}

export interface ProjectDeleteResponse {
  /** The project list after removal. */
  projects: ProjectSummary[];
}

export interface WorktreeDetailRequest {
  /** Absolute path of the worktree to inspect. */
  path: string;
}

/**
 * Generated-compose deployment options exposed to UI clients. Used by the
 * worktree launch/restart modal to present targets and service choices before
 * a deployment exists. Omitted or empty for compose-mode configs.
 */
export interface GeneratedDeploymentOptions {
  targets: Record<string, string[]>;
  appServices: string[];
  deps: string[];
  /**
   * Declared runtime argument names accepted by the project. Empty list when
   * the source config does not declare any runtime arguments.
   */
  arguments: string[];
  /**
   * Configured container ports across app services and deps, de-duplicated and
   * sorted ascending. Surfaced so the not-started launch preview can show what
   * ports a deploy would expose before any deployment exists.
   */
  ports: number[];
}

/**
 * Status of the worktree's effective project deploy config (`.wos/deploy.yaml`
 * for the source worktree, `.wos/deploy.worktree.yaml` for secondary
 * worktrees). Surfaced on every worktree detail response so the UI can render
 * config availability and gate the launch action.
 */
export type ProjectConfigStatus =
  | {
      status: "valid";
      /** Absolute path to the resolved effective deploy config file. */
      path: string;
      /** Resolved deployment mode (`generated`, `compose`, or `shell`). */
      mode: "generated" | "compose" | "shell";
    }
  | {
      status: "missing";
      /** Expected absolute path of the effective deploy config file. */
      path: string;
      /** User-displayable explanation. */
      message: string;
    }
  | {
      status: "invalid";
      /** Absolute path of the offending deploy config file. */
      path: string;
      /** Validation message from the config loader. */
      message: string;
    }
  | {
      status: "unknown";
      /** Diagnostic message for the resolution failure, when available. */
      message?: string;
    };

export interface WorktreeDetailResponse {
  worktree: WorktreeSummary;
  /** Project id this worktree belongs to. */
  projectId: string;
  /** Docker compose project name; suitable for UI titles. */
  projectName: string;
  /** Persisted wos state for the worktree (null when not initialized). */
  state: WosState | null;
  /** Service rows when initialized; empty otherwise. */
  services: ServiceStatus[];
  /** Aggregate managed service counts when known. */
  serviceSummary?: ServiceSummary;
  /** App-port healthcheck results when initialized; empty otherwise. */
  appPortHealthchecks: AppPortHealthcheckResult[];
  /** Tunnel snapshots when initialized; empty otherwise. */
  tunnels: TunnelSnapshot[];
  /** Active operation when present. */
  activeOperation?: OperationMetadata;
  /**
   * Most recently known operation for this worktree session, regardless of
   * status. Independent of `activeOperation` so the UI can describe the latest
   * outcome even when no mutating operation is currently running. Omitted when
   * the daemon has no in-memory operation history (for example after restart).
   */
  latestOperation?: OperationMetadata;
  /**
   * Best-effort failure context for the latest known failed operation. Present
   * only when `latestOperation` reports a failed status and the daemon could
   * resolve at least a failure message. Omitted otherwise.
   */
  failureContext?: WorktreeFailureContext;
  /** Optional error message when status collection failed. */
  statusError?: string;
  /**
   * Generated-compose deployment options for the worktree. Present only when
   * the source config uses generated-compose mode. Omitted (or empty) for
   * compose-mode configs.
   */
  deploymentOptions?: GeneratedDeploymentOptions;
  /** Effective project deploy config status used by the UI gate and config section. */
  projectConfig: ProjectConfigStatus;
  /**
   * Best-effort deploy freshness for an initialized worktree. Each field is
   * present only when its source data is available; the whole object is omitted
   * when no freshness data could be derived.
   */
  deployFreshness?: DeployFreshness;
  /**
   * Launch preview for a not-started worktree: what a deploy would do (service
   * count, configured ports) and a best-effort last-run duration. Present only
   * for not-started worktrees whose source config could be read; omitted
   * otherwise.
   */
  launchPreview?: LaunchPreview;
}

/**
 * Pre-deploy preview shown on the NotStarted screen. Each field is best-effort:
 * `lastRunDurationMs` is omitted when no duration is recorded or derivable.
 */
export interface LaunchPreview {
  /** Number of services that would start on the next up. */
  serviceCount: number;
  /**
   * Configured ports a deploy would expose (container ports in generated mode,
   * exposed ports in compose mode), de-duplicated and sorted ascending.
   */
  ports: number[];
  /**
   * Duration of the last successful up in milliseconds: the persisted state
   * value when present, otherwise derived from the latest up operation.
   * Omitted when neither is available.
   */
  lastRunDurationMs?: number;
}

/**
 * Deploy freshness facts for the worktree detail. All fields are optional and
 * best-effort: a missing/underivable value simply omits the field.
 */
export interface DeployFreshness {
  /** ISO timestamp of the last successful up (mirrors persisted `lastUp`). */
  lastUpAt?: string;
  /**
   * Duration of the latest up operation in milliseconds, derived from the
   * operation's start and finish times. Omitted when not derivable.
   */
  deployDurationMs?: number;
  /** Commit (HEAD) recorded at the last successful up. */
  lastUpCommit?: string;
  /**
   * Best-effort count of commits made since deploy (current HEAD vs the
   * deployed commit). Omitted when no deployed commit is recorded or the git
   * count fails; zero when HEAD equals the deployed commit.
   */
  commitsSinceDeploy?: number;
}

export interface WorktreeUpRequest {
  /** Absolute path of the worktree. */
  path: string;
  /** Whether to pass `--force` to up. */
  force?: boolean;
  /** Skip tunnel route registration even when global tunneling is enabled. */
  noTunnel?: boolean;
  /**
   * Generated-mode explicit service selection. Mutually exclusive with
   * `target`. Empty array is rejected. Unsupported in compose mode.
   */
  services?: string[];
  /**
   * Generated-mode startup target name. Mutually exclusive with `services`.
   * Empty string is rejected. Unsupported in compose mode.
   */
  target?: string;
  /**
   * Submitted runtime argument values keyed by declared argument name. Keys
   * must be declared by the resolved generated-compose config; unknown keys
   * fail before Docker Compose startup. Unsupported in compose mode.
   */
  arguments?: Record<string, string>;
}

export interface WorktreeUpResponse {
  operationId: string;
  sessionName: string;
  kind: "up";
  startedAt: string;
}

export interface WorktreeDownRequest {
  /** Absolute path of the worktree. */
  path: string;
}

export interface WorktreeDownResponse {
  operationId: string;
  sessionName: string;
  kind: "down";
  startedAt: string;
}

export interface WorktreeRemoveRequest {
  /** Absolute path of the worktree to remove. */
  path: string;
  /**
   * Explicit confirmation that local Git changes in the target worktree may be
   * discarded. When `true`, the daemon proceeds even if the worktree has
   * staged, unstaged, untracked, or unmerged changes (internally translated to
   * `git worktree remove --force`). When omitted/false, the daemon rejects
   * removal with a `worktree-dirty` response if any such changes are detected.
   */
  discardChanges?: boolean;
}

export interface WorktreeRemoveResponse {
  operationId: string;
  sessionName: string;
  kind: "worktree-remove";
  startedAt: string;
}

/**
 * Structured rejection body returned by `/ui/v1/worktrees/remove` when the
 * target worktree has local Git changes and the caller did not opt in to
 * discarding them. Clients use this to switch to a confirmation flow and
 * resubmit with `discardChanges: true`.
 */
export interface WorktreeDirtyErrorBody {
  error: "worktree-dirty";
  message: string;
  /** Absolute path of the worktree whose removal was rejected. */
  path: string;
  /** Aggregate counts of dirty entries reported by Git. */
  changes: {
    total: number;
    staged: number;
    unstaged: number;
    untracked: number;
    unmerged: number;
  };
}

export interface WorktreeRenameRequest {
  /** Absolute path of the worktree whose display name should be updated. */
  path: string;
  /** New display name. Trimmed, non-empty, bounded, no control characters. */
  displayName: string;
}

export interface WorktreeRenameResponse {
  /** Updated worktree summary with the new `displayName` applied. */
  worktree: WorktreeSummary;
  /** Project id that owns the worktree. */
  projectId: string;
}

export interface WorktreeNoteRequest {
  /** Absolute path of the worktree whose note should be updated. */
  path: string;
  /** New note. Trimmed and bounded; empty/omitted clears the note. */
  note?: string;
}

export interface WorktreeNoteResponse {
  /** Updated worktree summary with the new `note` applied (or cleared). */
  worktree: WorktreeSummary;
  /** Project id that owns the worktree. */
  projectId: string;
}

// ---------- Workflow status catalog / board / comments ----------

/** A single workflow status in the global catalog. */
export interface WorkflowStatusDto {
  id: string;
  name: string;
  /** Hex color (`#rgb` or `#rrggbb`). */
  color: string;
  order: number;
}

export interface StatusCatalogResponse {
  /** Catalog statuses in column order. */
  statuses: WorkflowStatusDto[];
}

export interface StatusCreateRequest {
  name: string;
  color: string;
}

export interface StatusCreateResponse {
  status: WorkflowStatusDto;
  statuses: WorkflowStatusDto[];
}

export interface StatusUpdateRequest {
  name?: string;
  color?: string;
  /** Desired column index; the status is moved to this position. */
  order?: number;
}

export interface StatusUpdateResponse {
  status: WorkflowStatusDto;
  statuses: WorkflowStatusDto[];
}

export interface StatusDeleteResponse {
  statuses: WorkflowStatusDto[];
}

export interface WorktreeStatusRequest {
  /** Absolute worktree path. */
  path: string;
  /** Status id to assign, or null to move the worktree to "no status". */
  statusId: string | null;
  /**
   * Within-status fractional order. When omitted for an assignment, the daemon
   * appends the worktree to the end of the target column.
   */
  order?: number;
}

export interface WorktreeStatusResponse {
  path: string;
  /** Assigned status id, or null when unassigned. */
  statusId: string | null;
  /** Within-status order; omitted when unassigned. */
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

export interface WorktreeCommentAddRequest {
  /** Absolute worktree path. */
  path: string;
  /** Comment text. Trimmed, non-empty, bounded. */
  text: string;
}

export interface WorktreeCommentAddResponse {
  path: string;
  comment: WorktreeCommentDto;
}

export interface WorktreeCommentDeleteRequest {
  /** Absolute worktree path. */
  path: string;
  /** Id of the comment to remove. */
  commentId: string;
}

export interface WorktreeCreateRequest {
  /** Project id the worktree should belong to. */
  projectId: string;
  /** New worktree directory name (single safe path segment). */
  name: string;
  /**
   * When provided, the daemon attaches the created worktree to this existing
   * branch. When omitted, the worktree is created in detached mode from the
   * source worktree's current `HEAD`.
   */
  branch?: string;
}

export interface WorktreeCreateResponse {
  operationId: string;
  /** Target session name derived from the resolved worktree path. */
  sessionName: string;
  kind: "worktree-create";
  startedAt: string;
  projectId: string;
  /** Resolved absolute target path under `$WOS_HOME/worktrees`. */
  targetPath: string;
  /** Echoed branch when branch mode is used. */
  branch?: string;
}

export interface WorktreeServiceRequest {
  /** Absolute path of the worktree. */
  path: string;
  /** Managed service name. */
  service: string;
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

export interface WorktreeExecRequest {
  /** Absolute path of the worktree. */
  path: string;
  /** Managed service name to run the command inside. */
  service: string;
  /** Command argv to run inside the service container, preserved verbatim. */
  command: string[];
  /** Optional initial terminal width in columns. */
  cols?: number;
  /** Optional initial terminal height in rows. */
  rows?: number;
}

export interface WorktreeExecResponse {
  /** Terminal-layer session id created for the exec command. */
  terminalId: string;
  /** Terminal WebSocket attach path under the daemon web listener. */
  attachPath: string;
  /** Terminal session metadata captured at creation time. */
  session: TerminalSessionMetadata;
}

export interface DiffResponse {
  /** Diff text from git; empty string when clean. */
  diff: string;
  /** True when diff is empty (clean state). */
  empty: boolean;
}

/**
 * Lightweight metadata for a single directory suggestion returned by the
 * add-project autocomplete endpoint. Only directories are listed; files are
 * excluded server-side.
 */
export interface DirectorySuggestion {
  /** Absolute path to the directory entry. */
  path: string;
  /** Basename suitable for display. */
  name: string;
  /**
   * True when the directory is a Git worktree/repository root, detected by a
   * `.git` entry. The autocomplete never spawns git, so this is the only Git
   * metadata surfaced for suggestions.
   */
  isGitWorktree: boolean;
}

export interface DirectoryListRequest {
  /** Absolute path whose immediate child directories should be listed. */
  path: string;
}

export interface DirectoryListResponse {
  /** Normalized absolute path that was listed. */
  path: string;
  /** Directory entries directly under `path`. Empty when no readable children. */
  entries: DirectorySuggestion[];
}

/** Validation/error codes for filesystem autocomplete and validation. */
export type DirectoryErrorCode =
  | "validation"
  | "not-found"
  | "not-directory"
  | "permission-denied"
  | "forbidden";

export interface ProjectPathValidateRequest {
  /** Absolute path to validate as a project root. */
  path: string;
}

export interface ProjectPathValidateResponse {
  /** True when the path resolves as a Git worktree. */
  valid: boolean;
  /** Normalized absolute input path. */
  inputPath?: string;
  /** Resolved primary/source worktree path when valid. */
  sourcePath?: string;
  /** Validation message when invalid. */
  message?: string;
  /**
   * Non-blocking warning. Used to report a missing project deploy config
   * (`.wos/deploy.yaml` and/or `.wos/deploy.worktree.yaml`) in the resolved
   * primary/source worktree.
   */
  warning?: {
    code: "missing-config";
    message: string;
  };
}

export interface DiffErrorBody {
  error: "git-error" | "not-a-worktree" | "validation";
  message: string;
}

// ---------- Worktree Git write + commit-message ----------

export interface WorktreeGitStageRequest {
  /** Worktree root path. */
  path: string;
  /** Changed file paths to stage / unstage. Ignored when `all` is set. */
  files: string[];
  /** Stage every change (`git add --all`); `files` may be empty. Stage only. */
  all?: boolean;
}

export interface WorktreeGitStageResponse {
  ok: true;
}

export interface WorktreeGitCommitRequest {
  /** Worktree root path. */
  path: string;
  /** Non-empty commit message. */
  message: string;
  /** Push after a successful commit. */
  push?: boolean;
  /** Fold the staged changes into the latest commit. */
  amend?: boolean;
}

export interface WorktreeHeadState {
  detached: boolean;
  branch?: string;
  head: string;
}

export interface WorktreeGitCommitResponse {
  /** Short SHA of the resulting commit. */
  sha: string;
  /** Short human summary printed by `git commit`. */
  summary: string;
  /** Present when `push` was requested and succeeded. */
  push?: { summary: string };
}

export interface WorktreeGitFetchRequest {
  /** Worktree root path. */
  path: string;
  /** Prune remote-tracking refs that no longer exist on the remote. */
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
  /** Worktree root path. */
  path: string;
}

export interface WorktreeGitPushResponse {
  ok: true;
  /** Short human summary printed by `git push`. */
  summary: string;
  /** Commits ahead of upstream after the push; omitted when detached/no upstream. */
  aheadCount?: number;
  /** Commits behind upstream after the push; omitted when detached/no upstream. */
  behindCount?: number;
}

export interface WorktreeGitBranchRequest {
  /** Worktree root path. */
  path: string;
  /** New branch name. */
  name: string;
}

export interface WorktreeGitBranchResponse {
  /** Resulting head state after creating + switching to the branch. */
  head: WorktreeHeadState;
}

export interface WorktreeCommitMessageRequest {
  /** Worktree root path. */
  path: string;
  /** Optional staged file subset (reserved; the diff is read from the index). */
  files?: string[];
}

export interface WorktreeCommitMessageResponse {
  /** Generated commit message text. */
  message: string;
}

/**
 * Structured error body for the Git write + commit-message endpoints.
 * `nothing-staged` and `no-provider-configured` are distinguishable from a Git
 * or provider execution failure (`git-error` / `generation-failed`).
 */
export interface GitWriteErrorBody {
  error:
    | "git-error"
    | "nothing-staged"
    | "no-provider-configured"
    | "generation-failed"
    | "validation"
    | "not-a-worktree"
    | "non-fast-forward";
  message: string;
}

/**
 * Maximum size (bytes) of a file that the worktree file explorer will return
 * for editing. Files above this limit are rejected with an `unsupported-file`
 * error and the client surfaces an oversized-file state.
 */
export const WORKTREE_FILE_MAX_BYTES = 1024 * 1024;

/**
 * Direct child entry in the worktree file tree. The daemon returns one of
 * these per direct child of a requested directory.
 */
export interface WorktreeFileEntry {
  /** Relative POSIX-style path from the worktree root. */
  path: string;
  /** Display name (basename). */
  name: string;
  /** Entry kind. */
  kind: "file" | "directory";
  /** File size in bytes; omitted for directories. */
  size?: number;
  /** Modification time in milliseconds since the epoch; omitted when unknown. */
  mtimeMs?: number;
  /**
   * Two-character git status XY code for changed files (e.g. ` M`, `A `,
   * `??`). Omitted for unchanged files and when git status is unavailable.
   */
  gitStatus?: string;
  /**
   * For directory entries: count of changed files within the directory's whole
   * subtree. Omitted (or zero) when the subtree has no changes or git status is
   * unavailable.
   */
  changedCount?: number;
}

/**
 * Response for `GET /ui/v1/worktrees/files/tree`. Lists direct children of
 * the requested directory inside the worktree root.
 */
export interface WorktreeFileTreeResponse {
  /** Absolute worktree root that was listed. */
  worktreePath: string;
  /** Relative directory path under the worktree root. Empty string for root. */
  dir: string;
  entries: WorktreeFileEntry[];
}

/**
 * Response for `GET /ui/v1/worktrees/files/content`. Returns UTF-8 text and
 * metadata for the requested file when it is editable.
 */
export interface WorktreeFileContentResponse {
  /** Absolute worktree root. */
  worktreePath: string;
  /** Relative file path under the worktree root. */
  file: string;
  /** UTF-8 text content. */
  content: string;
  /** Current file size in bytes. */
  size: number;
  /** Current file modification time in milliseconds since the epoch. */
  mtimeMs: number;
  /** Always `true` for successful reads; reserved for future read modes. */
  editable: true;
}

/**
 * Request body for `PUT /ui/v1/worktrees/files/content`. Writes new UTF-8
 * content to an existing editable file inside the worktree.
 */
export interface WorktreeFileWriteRequest {
  /** Absolute worktree root path. */
  path: string;
  /** Relative file path under the worktree root. */
  file: string;
  /** New UTF-8 content. */
  content: string;
  /**
   * Last-known modification time (ms) the client read from the file. When
   * present the daemon rejects the write if the current mtime no longer
   * matches.
   */
  expectedMtimeMs?: number;
}

/**
 * Response for `PUT /ui/v1/worktrees/files/content`. Returns updated file
 * metadata so the client can refresh its mtime guard after a successful save.
 */
export interface WorktreeFileWriteResponse {
  worktreePath: string;
  file: string;
  size: number;
  mtimeMs: number;
}

/**
 * Structured error body returned by worktree file explorer endpoints. All
 * file API failures use this shape so the client can surface specific
 * unsupported-file / conflict / not-found states.
 */
export interface WorktreeFileErrorBody {
  error:
    | "validation"
    | "not-found"
    | "not-a-file"
    | "not-a-directory"
    | "unsupported-file"
    | "conflict"
    | "permission-denied"
    | "server-error";
  message: string;
  /**
   * Reason details for unsupported-file rejections. `binary` is set when the
   * file appears to contain non-text data; `too-large` is set when the file
   * exceeds `WORKTREE_FILE_MAX_BYTES`.
   */
  reason?: "binary" | "too-large";
  /** Current size when the file is too large. */
  size?: number;
  /** Maximum allowed size when the file is too large. */
  maxBytes?: number;
  /**
   * Current mtime on disk when a conflict is reported, so the UI can decide
   * whether to refresh.
   */
  currentMtimeMs?: number;
}

/**
 * Request body for `POST /ui/v1/worktrees/open-editor`. Launches the
 * configured `editorCommand` on the worktree directory. Local-only.
 */
export interface WorktreeOpenEditorRequest {
  /** Absolute worktree root path. */
  path: string;
}

/**
 * Response for a successful `POST /ui/v1/worktrees/open-editor`.
 */
export interface WorktreeOpenEditorResponse {
  ok: true;
  /** Absolute worktree path the editor was launched on. */
  worktreePath: string;
}

export type {
  DiffFile,
  DiffFileStatus,
  DiffHunk,
  DiffLine,
  DiffLineKind,
  DiffSet,
  ReviewDiffResponse,
} from "@worktreeos/core/diff-types";

export interface UiLogEnvelope {
  sessionName: string;
  sequence: number;
  timestamp: string;
  service: string;
  stream: LogStream;
  chunk: string;
}

export interface UiOperationEnvelope {
  operationId: string;
  sessionName: string;
  sequence: number;
  timestamp: string;
  event?: import("@worktreeos/core/events").DeploymentEvent;
  terminal?: {
    status: "succeeded" | "failed";
    failureMessage?: string;
  };
}

export interface UiErrorResponse {
  error: string;
  message: string;
}

/**
 * First-run setup snapshot. The web UI calls this immediately after auth to
 * decide whether to render the setup flow. The endpoint is local-only and
 * returns the same management snapshot exposed by `/ui/v1/settings/config`.
 */
export interface SetupStatusResponse {
  /**
   * `true` when first-run onboarding has not been completed. Derived from the
   * `firstRunCompleted` marker with back-compat: an existing `config.json` or
   * any registered project counts as already onboarded.
   */
  setupRequired: boolean;
  /** Snapshot of `<wos-home>/config.json` and effective defaults. */
  globalConfig: import("@worktreeos/core/global-config").GlobalConfigManagementSnapshot;
  /** Total number of records in the project registry. */
  projectCount: number;
  /** First-run completion marker timestamp, or `null` when not yet completed. */
  firstRunCompleted: string | null;
}

/**
 * Environment probe for the first-run onboarding checklist. Local-only; returns
 * Docker / Docker Compose v2 availability and the tmux/psmux availability plus
 * (when unavailable) the detected host package manager and install command hint.
 */
export interface SetupEnvironmentResponse {
  docker: { installed: boolean };
  dockerCompose: { installed: boolean };
  tmux: {
    available: boolean;
    /** Diagnostic reason when unavailable. */
    reason?: string;
    /** The probed multiplexer binary (e.g. `tmux` / `psmux`). */
    binary: string;
    /** Host platform (`process.platform`). */
    platform: string;
    /**
     * Detected host package manager + ready-to-run install command, or `null`
     * when tmux is available or no supported manager was found.
     */
    packageManager:
      | { manager: string; command: string; requiresElevation: boolean }
      | null;
  };
}

/**
 * Result of `POST /ui/v1/setup/install-tmux`. `status` distinguishes a
 * successful server-side install (`ok`), a sudo package manager that must be run
 * by the user (`manual-required`, carrying the exact `command`), and a failure
 * (`error`, carrying a `message`).
 */
export interface SetupInstallTmuxResponse {
  status: "ok" | "manual-required" | "error";
  /** Whether tmux/psmux is available after the attempt. */
  available: boolean;
  /** The effective terminal backend after the attempt. */
  terminalBackend: "default" | "tmux";
  /** Detected package manager id, when any. */
  manager?: string;
  /** The exact install command (guidance / audit). */
  command?: string;
  /** Human-readable detail for guidance / failure. */
  message?: string;
}

/** Result of `POST /ui/v1/setup/complete` — stamps the first-run marker. */
export interface SetupCompleteResponse {
  ok: true;
  /** The persisted completion marker timestamp. */
  firstRunCompleted: string;
}

/**
 * Structured error body returned by `/ui/v1/worktrees/up` when the resolved
 * effective project deploy config is missing or invalid. The web UI uses this
 * to refresh project config status and surface a corrective message.
 */
export interface WorktreeUpConfigErrorBody {
  error: "config-missing" | "config-invalid";
  message: string;
  /** Expected/observed absolute config path when known. */
  path?: string;
}

/**
 * Request body for `POST /ui/v1/daemon/restart`. Currently empty; reserved for
 * future restart options.
 */
export interface DaemonRestartRequest {
  // no fields yet
}

/**
 * Response body returned by `POST /ui/v1/daemon/restart` when restart work has
 * been scheduled. The daemon returns this before the current process exits.
 */
export interface DaemonRestartResponse {
  /** Always `scheduled` for now. */
  status: "scheduled";
  /** ISO timestamp when the request was accepted. */
  scheduledAt: string;
}
