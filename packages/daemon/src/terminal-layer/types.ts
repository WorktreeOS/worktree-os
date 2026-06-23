/**
 * Shared terminal-layer types. These cover daemon-owned terminal session
 * metadata, lifecycle status, attachment summaries, control ownership,
 * replay boundaries, and exit information.
 *
 * Both the daemon backend and the API/WebSocket transport layer depend on
 * these types — they are intentionally runtime-neutral and do not import
 * any PTY-implementation-specific types.
 */

import type {
  AgentActivityBlock,
  AgentTelemetry,
} from "@worktreeos/core/agent-activity";

/**
 * Lifecycle states a terminal session moves through:
 *
 *   creating -> running -> terminating -> exiting -> exited
 *                                      \-> failed
 *                                      \-> disposed
 *
 * - `creating`     – PTY process is being spawned.
 * - `running`      – process is alive and accepting input/output.
 * - `terminating`  – termination requested; signal in flight.
 * - `exiting`      – process has exited but output is still draining.
 * - `exited`       – process exited; exit info recorded.
 * - `failed`       – session failed to start or terminated with an unrecoverable error.
 * - `disposed`     – session has been removed from the manager.
 */
export type TerminalSessionStatus =
  | "creating"
  | "running"
  | "terminating"
  | "exiting"
  | "exited"
  | "failed"
  | "disposed";

/** Exit information recorded once the PTY process terminates. */
export interface TerminalSessionExit {
  /** ISO timestamp when the PTY process exited. */
  exitedAt: string;
  /** Numeric exit code when available. */
  exitCode?: number;
  /** Signal number when the process was killed by a signal. */
  signal?: number;
}

/** Bounded replay metadata advertised to attaching clients. */
export interface TerminalReplayBoundary {
  /**
   * Oldest output sequence number that is still retained in the byte journal.
   * Clients with `lastSeenOutputSeq < firstRetainedSeq` cannot get a full
   * byte-level replay and SHOULD rely on the latest checkpoint when present.
   */
  firstRetainedSeq: number;
  /** Highest output sequence number that has been produced so far. */
  latestSeq: number;
  /** Total bytes retained in the journal (best-effort approximation). */
  retainedBytes: number;
  /** Sequence number associated with the latest available checkpoint, if any. */
  checkpointSeq?: number;
}

/** Attachment-level summary returned in snapshots and lifecycle events. */
export interface TerminalAttachmentSummary {
  /** Stable attachment id assigned by the daemon at attach time. */
  attachmentId: string;
  /** Opaque client identifier reported by the attaching client. */
  clientId?: string;
  /** True when this attachment owns terminal control. */
  isController: boolean;
  /** ISO timestamp when the attachment connected. */
  attachedAt: string;
  /** Last acknowledged output sequence (for diagnostics/backpressure). */
  lastAckSeq?: number;
}

/** Snapshot of control-ownership for a terminal session. */
export interface TerminalControlOwnership {
  /** Attachment id that currently owns control, if any. */
  controllerAttachmentId: string | null;
  /** Timestamp control was last granted, transferred, or released. */
  changedAt: string;
}

/**
 * Provenance of a terminal session title: set by the user through the rename
 * endpoint, or applied automatically from agent activity. Agent-sourced
 * titles never replace user-sourced ones.
 */
export type TerminalTitleSource = "user" | "agent";

/** Known agent command families recognized inside terminal sessions. */
export type TerminalKnownAgent = "claude" | "opencode" | "codex" | "pi";

/** Best-effort snapshot of the current foreground command in the PTY. */
export interface TerminalActiveCommand {
  /** Process id of the command selected as foreground/active. */
  pid: number;
  /** Parent process id when available. */
  ppid?: number;
  /** Process group id when available. */
  pgid?: number;
  /** Executable path or process command reported by the host. */
  command: string;
  /** Full command arguments reported by the host process table. */
  args: string;
  /** Recognized agent family, if the command matches a known agent. */
  agent?: TerminalKnownAgent;
  /**
   * Whether the wos activity plugin for the detected agent is installed.
   * Present only for agents that have a wos plugin (claude, opencode).
   */
  pluginInstalled?: boolean;
  /**
   * Whether the installed wos plugin is older than the bundled one. Present
   * only for claude (the versioned Claude Code plugin).
   */
  pluginOutdated?: boolean;
}

/** Authoritative snapshot of a terminal session at a point in time. */
export interface TerminalSessionMetadata {
  /** Stable terminal session id (daemon-local). */
  id: string;
  /** Worktree root the session was created for. */
  worktreePath: string;
  /**
   * Optional display title. Set through the rename control-plane endpoint or
   * applied from agent activity; omitted when the session uses automatic
   * labeling. Normalized and length-bounded by the daemon before it reaches
   * a snapshot.
   */
  title?: string;
  /** Provenance of `title`; present whenever `title` is present. */
  titleSource?: TerminalTitleSource;
  /** Current lifecycle status. */
  status: TerminalSessionStatus;
  /** Shell command that was spawned. */
  shell: string;
  /** Root PTY process id when the runtime exposes one. */
  processId?: number;
  /** Best-effort active foreground command in the PTY process tree. */
  activeCommand?: TerminalActiveCommand;
  /**
   * Derived agent activity reported by agent-side plugins. Present only
   * while a reporting agent is active in the session; cleared when the
   * agent process exits.
   */
  agentActivity?: AgentActivityBlock;
  /**
   * Derived token/model telemetry read from the agent's transcript. Present
   * only while a transcript is bound to the session and telemetry has been
   * derived; removed when the binding is removed.
   */
  agentTelemetry?: AgentTelemetry;
  /** Working directory of the PTY process. */
  cwd: string;
  /** Current terminal columns (follows the controller's viewport). */
  cols: number;
  /** Current terminal rows. */
  rows: number;
  /** ISO timestamp the session was created. */
  createdAt: string;
  /** ISO timestamp of the last attachment connect, if any. */
  lastAttachedAt?: string;
  /**
   * ISO timestamp since the session has unseen agent output. Set when agent
   * activity transitions into `idle` or `awaiting-input` with no attachments;
   * cleared when any client attaches. Absent = read.
   */
  unreadSince?: string;
  /** Exit info when status is `exited` or `failed`. */
  exit?: TerminalSessionExit;
  /** Replay boundary metadata for the session journal. */
  replay?: TerminalReplayBoundary;
  /** Control ownership snapshot for current attachments. */
  control?: TerminalControlOwnership;
  /** Attachment summaries for currently-connected clients. */
  attachments?: TerminalAttachmentSummary[];
}

/** Reasons a session can fail. */
export type TerminalFailureReason =
  | "runtime-unavailable"
  | "spawn-failed"
  | "cwd-invalid"
  | "internal";

/** A failure event recorded on the session for diagnostics. */
export interface TerminalSessionFailure {
  reason: TerminalFailureReason;
  message: string;
  at: string;
}
