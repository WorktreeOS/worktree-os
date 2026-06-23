/**
 * Frontend mirror of the daemon's terminal-layer WebSocket protocol.
 *
 * These types intentionally mirror the daemon-side definitions in
 * `packages/daemon/src/terminal-layer/protocol.ts`. Keeping a local copy lets
 * the web bundle stay independent of `@worktreeos/daemon` and avoid pulling Bun-
 * specific imports into the browser. If a field changes on the wire, update
 * both files in lockstep.
 */

export const TERMINAL_PROTOCOL_VERSION = 1 as const;

export type TerminalSessionStatus =
  | "creating"
  | "running"
  | "terminating"
  | "exiting"
  | "exited"
  | "failed"
  | "disposed";

export type TerminalControlMode = "controller" | "viewer";

export interface TerminalSessionExit {
  exitedAt: string;
  exitCode?: number;
  signal?: number;
}

export interface TerminalReplayBoundary {
  firstRetainedSeq: number;
  latestSeq: number;
  retainedBytes: number;
  checkpointSeq?: number;
}

export interface TerminalAttachmentSummary {
  attachmentId: string;
  clientId?: string;
  isController: boolean;
  attachedAt: string;
  lastAckSeq?: number;
}

export interface TerminalControlOwnership {
  controllerAttachmentId: string | null;
  changedAt: string;
}

export type TerminalKnownAgent = "claude" | "opencode" | "codex" | "pi";

export interface TerminalActiveCommand {
  pid: number;
  ppid?: number;
  pgid?: number;
  command: string;
  args: string;
  agent?: TerminalKnownAgent;
  /** Whether the wos activity plugin for the detected agent is installed. */
  pluginInstalled?: boolean;
  /** Whether the installed wos plugin is older than the bundled one (claude only). */
  pluginOutdated?: boolean;
}

export type AgentActivityState = "working" | "idle" | "awaiting-input";

/** Derived agent activity reported by agent-side plugins (mirrors core). */
export interface AgentActivityBlock {
  state: AgentActivityState;
  agent: string;
  lastEvent: string;
  question?: { summary: string; askedAt: string };
  lastQuery?: string;
  at: string;
}

/** Derived transcript telemetry read by the daemon (mirrors core). */
export interface AgentTelemetry {
  /** Model id of the latest assistant turn. */
  model?: string;
  /** Cumulative output + cache-creation tokens of the main agent. */
  mainTokens: number;
  /** Cumulative tokens across subagent transcripts. */
  subagentTokens: number;
  /** Context usage of the latest assistant turn. */
  contextUsed: number;
  /** Assumed context window size in tokens. */
  contextWindow: number;
  updatedAt: string;
}

export interface TerminalSessionMetadata {
  id: string;
  worktreePath: string;
  /** Optional display title; omitted when auto-labeled. */
  title?: string;
  /** Provenance of `title`: set by the user or applied from agent activity. */
  titleSource?: "user" | "agent";
  status: TerminalSessionStatus;
  shell: string;
  processId?: number;
  activeCommand?: TerminalActiveCommand;
  agentActivity?: AgentActivityBlock;
  /** Derived transcript telemetry; present only while a transcript is bound. */
  agentTelemetry?: AgentTelemetry;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: string;
  lastAttachedAt?: string;
  /** Unseen agent output since this ISO timestamp; absent = read. */
  unreadSince?: string;
  exit?: TerminalSessionExit;
  replay?: TerminalReplayBoundary;
  control?: TerminalControlOwnership;
  attachments?: TerminalAttachmentSummary[];
}

/**
 * A captured terminal screen for the Mission Control wall: the current visible
 * grid as flat SGR-colored rows (color/attribute escapes only) plus the
 * geometry it was captured at. Mirrors the daemon's `TerminalScreenSnapshot`.
 */
export interface TerminalScreenSnapshot {
  lines: string[];
  cols: number;
  rows: number;
}

/** Capture outcome; `available: false` means the backend keeps no screen grid. */
export type TerminalScreenSnapshotResult =
  | { available: true; snapshot: TerminalScreenSnapshot }
  | { available: false; reason?: string };

/** Response of the one-shot snapshot endpoint / one snapshot-stream frame. */
export interface TerminalSnapshotResponse {
  session: TerminalSessionMetadata;
  snapshot: TerminalScreenSnapshotResult;
}

// ---------- Client → Server ----------

export interface TerminalClientHelloFrame {
  type: "hello";
  v: number;
  clientId: string;
  cols: number;
  rows: number;
  lastSeenOutputSeq?: number;
  desiredControl: TerminalControlMode;
}

export interface TerminalClientInputFrame {
  type: "input";
  v: number;
  data: string;
}

export interface TerminalClientResizeFrame {
  type: "resize";
  v: number;
  cols: number;
  rows: number;
}

export interface TerminalClientAckFrame {
  type: "ack";
  v: number;
  ackSeq: number;
}

export interface TerminalClientControlFrame {
  type: "control";
  v: number;
  action: "request" | "release" | "revoke";
}

export type TerminalClientFrame =
  | TerminalClientHelloFrame
  | TerminalClientInputFrame
  | TerminalClientResizeFrame
  | TerminalClientAckFrame
  | TerminalClientControlFrame;

// ---------- Server → Client ----------

export interface TerminalServerHelloAckFrame {
  type: "hello-ack";
  v: number;
  attachmentId: string;
  session: TerminalSessionMetadata;
  replay: TerminalReplayBoundary;
  control: TerminalControlOwnership;
  willReplay: boolean;
}

export interface TerminalServerOutputFrame {
  type: "output";
  v: number;
  seq: number;
  data: string;
  replay?: boolean;
}

export interface TerminalServerReplayDoneFrame {
  type: "replay-done";
  v: number;
  upToSeq: number;
}

export interface TerminalServerStatusFrame {
  type: "status";
  v: number;
  status: TerminalSessionStatus;
  session: TerminalSessionMetadata;
}

export interface TerminalServerControlFrame {
  type: "control";
  v: number;
  control: TerminalControlOwnership;
  isController: boolean;
}

export interface TerminalServerAttachmentsFrame {
  type: "attachments";
  v: number;
  attachments: TerminalAttachmentSummary[];
}

export interface TerminalServerExitFrame {
  type: "exit";
  v: number;
  exit: TerminalSessionExit;
}

export type TerminalServerErrorCode =
  | "not-found"
  | "session-exited"
  | "invalid-message"
  | "version-unsupported"
  | "control-denied"
  | "replay-gap"
  | "backpressure"
  | "forbidden"
  | "terminal-unavailable"
  | "internal";

export interface TerminalServerErrorFrame {
  type: "error";
  v: number;
  code: TerminalServerErrorCode;
  message: string;
  fatal?: boolean;
}

export type TerminalServerFrame =
  | TerminalServerHelloAckFrame
  | TerminalServerOutputFrame
  | TerminalServerReplayDoneFrame
  | TerminalServerStatusFrame
  | TerminalServerControlFrame
  | TerminalServerAttachmentsFrame
  | TerminalServerExitFrame
  | TerminalServerErrorFrame;
