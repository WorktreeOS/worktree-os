/**
 * Terminal backend adapter boundary.
 *
 * Backends own backend-specific lifecycle semantics for terminal sessions:
 *
 * - `createSession` spawns or attaches to a backend session and opens an
 *   initial transport. The transport is the runtime-neutral PTY-like port the
 *   actor uses to read output, write input, and resize.
 * - `restoreSessions` returns backend sessions that survived a daemon restart
 *   (e.g. tmux sessions still owned by tmux). Default backends MAY omit this.
 * - `openTransport` reopens a transport for an already-existing backend
 *   session (e.g. after restoration). Default backends MAY omit this.
 * - `onDaemonShutdown` runs when the daemon stops while the session is still
 *   alive; the default backend kills the process tree, while tmux only
 *   detaches the daemon's attachment client.
 * - `terminateSession` runs when a user explicitly terminates the terminal;
 *   default kills the process tree, tmux kills the underlying tmux session.
 *
 * The manager and actor route every lifecycle decision through this boundary
 * instead of branching on backend id, so adding new backends does not require
 * editing the manager.
 */

import type { TerminalProcess } from "./runtime";
import type { TerminalTitleSource } from "./types";
import type { TerminalBackendId } from "@worktreeos/core/global-config";

export type { TerminalBackendId } from "@worktreeos/core/global-config";

export interface TerminalBackendAvailability {
  available: boolean;
  /** Human-readable reason. Required when `available` is false. */
  reason?: string;
}

export interface TerminalBackendCreateOptions {
  /** Stable wos terminal session id assigned by the manager. */
  id: string;
  worktreePath: string;
  cwd: string;
  shell: string;
  args?: string[];
  env: Record<string, string | undefined>;
  /**
   * Session-specific variables that MUST reach the spawned shell even on
   * backends that do not inherit `env` (tmux panes inherit the tmux server
   * environment, not the daemon's). Already merged into `env`; backends that
   * honor `env` fully can ignore this field.
   */
  extraEnv?: Record<string, string>;
  /**
   * Run the shell in login mode so the user's dotfiles (`.zprofile`/`.zshrc`
   * and the macOS `path_helper`) rebuild `PATH` and user/product variables on
   * every terminal. Set by the manager for the default interactive shell;
   * unset for an explicit program (`docker compose exec`), which is spawned
   * as-is. POSIX-only — backends ignore it on Windows shells.
   */
  login?: boolean;
  cols: number;
  rows: number;
  createdAt: string;
}

/** Logical wos terminal session owned by the backend. */
export interface TerminalBackendSession {
  id: string;
  backend: TerminalBackendId;
  worktreePath: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  createdAt: string;
  /**
   * Display title, when one is set. Backends that can restore sessions
   * across a daemon restart (e.g. tmux) persist this alongside their other
   * metadata so the title survives with the session.
   */
  title?: string;
  /**
   * Provenance of `title`. Restored sessions whose persisted record predates
   * provenance tracking omit this; callers treat that as `user` so a restored
   * title is never clobbered by agent activity.
   */
  titleSource?: TerminalTitleSource;
  /**
   * Unread marker (ISO timestamp). Backends that can restore sessions across
   * a daemon restart persist this alongside the title so unseen agent output
   * stays discoverable after a restart.
   */
  unreadSince?: string;
  /**
   * PID the backend considers the root of the user's shell process tree.
   * For the default backend this is the spawned PTY process. For tmux this
   * is the pane PID (the shell inside the tmux session), which differs from
   * the daemon-owned attach-client transport. Used for active-command
   * detection and as the session's authoritative `processId` snapshot.
   */
  processId?: number;
  /** Backend-specific opaque state preserved across the manager/actor boundary. */
  meta?: Record<string, unknown>;
}

/**
 * Runtime-neutral PTY-like transport used by the actor. The default backend
 * reuses the same `TerminalProcess` as both session and transport; the tmux
 * backend uses a separate attach-client PTY each time `openTransport` is called.
 */
export type TerminalBackendTransport = TerminalProcess;

export interface TerminalBackendOpenTransportOptions {
  cols: number;
  rows: number;
}

/**
 * A captured terminal screen: the current visible grid as flat SGR-colored
 * rows (color/attribute escapes only — never cursor-addressing or
 * alternate-screen control sequences) plus the geometry it was captured at.
 * Consumers render this directly; the backend's own emulator has already
 * flattened any full-screen TUI into these lines.
 */
export interface TerminalScreenSnapshot {
  /** Visible rows, top to bottom; each carries SGR escapes only. */
  lines: string[];
  /** Captured geometry — pane width in columns. */
  cols: number;
  /** Captured geometry — pane height in rows. */
  rows: number;
}

/**
 * Outcome of a screen-snapshot capture. `available: false` means the backend
 * maintains no screen grid for the session (e.g. the default PTY backend) or
 * the capture failed; the caller renders a non-live fallback rather than a
 * broken view.
 */
export type TerminalScreenSnapshotResult =
  | { available: true; snapshot: TerminalScreenSnapshot }
  | { available: false; reason?: string };

export interface TerminalBackendCreateResult {
  session: TerminalBackendSession;
  transport: TerminalBackendTransport;
}

/**
 * Persisted transcript-telemetry binding key for a terminal session. Only the
 * binding key plus the non-recomputable compact-carry token totals are stored;
 * derived telemetry (`model` / token / context figures) is always re-derived
 * from the transcript JSONL on restart, never persisted.
 */
export interface TerminalTranscriptBinding {
  /** Bound transcript file path. */
  path: string;
  agentSessionId: string;
  /** Spent tokens carried over from pre-compact transcripts. */
  mainCarry: number;
  subagentCarry: number;
  /**
   * Originating agent, selecting the transcript parser on restart-rebind.
   * Absent on records written before codex support — treated as `claude`.
   */
  agent?: "claude" | "codex" | "pi";
}

export interface TerminalBackendRestoreResult {
  session: TerminalBackendSession;
  /**
   * Persisted transcript binding, when the restored record carries one.
   * Backends without cross-restart persistence (e.g. the default backend)
   * omit this; the daemon then performs no re-bind for that session.
   */
  transcript?: TerminalTranscriptBinding;
}

export interface TerminalBackendAdapter {
  readonly id: TerminalBackendId;
  readonly label: string;
  isAvailable(): TerminalBackendAvailability;
  createSession(
    opts: TerminalBackendCreateOptions,
  ): Promise<TerminalBackendCreateResult>;
  /**
   * Reopen a transport for an existing backend session. Backends that cannot
   * restore (e.g. the default backend after daemon restart) MAY omit this.
   */
  openTransport?(
    session: TerminalBackendSession,
    opts: TerminalBackendOpenTransportOptions,
  ): Promise<TerminalBackendTransport>;
  /**
   * Restore backend sessions that survived a daemon restart. Implementations
   * that own no persistent state MAY omit this entirely.
   */
  restoreSessions?(): Promise<TerminalBackendRestoreResult[]>;
  /**
   * Apply backend-specific shutdown semantics for a still-running session
   * during daemon shutdown. The default backend kills the process tree; tmux
   * detaches the client and leaves the tmux session alive.
   */
  onDaemonShutdown(
    session: TerminalBackendSession,
    transport: TerminalBackendTransport | null,
  ): Promise<void>;
  /**
   * Apply backend-specific termination semantics when a user terminates the
   * session. The default backend kills the process tree; tmux kills the
   * tmux session and removes persisted metadata.
   */
  terminateSession(
    session: TerminalBackendSession,
    transport: TerminalBackendTransport | null,
    signal?: string,
  ): Promise<void>;
  /**
   * Persist a title change for a backend session that can be restored after
   * daemon restart. `title === undefined` clears the stored title; the
   * provenance is persisted alongside it. Backends with no cross-restart
   * persistence (e.g. the default backend) MAY omit this; their titles then
   * live only in daemon-owned session metadata. Rejecting (throwing) leaves
   * the authoritative title unchanged.
   */
  persistTitle?(
    session: TerminalBackendSession,
    title: string | undefined,
    titleSource?: TerminalTitleSource,
  ): Promise<void>;
  /**
   * Persist an unread-marker change for a backend session that can be
   * restored after daemon restart. `unreadSince === undefined` clears it.
   * Backends with no cross-restart persistence MAY omit this. Failures are
   * best-effort: the caller logs and keeps the in-memory marker.
   */
  persistUnread?(
    session: TerminalBackendSession,
    unreadSince: string | undefined,
  ): Promise<void>;
  /**
   * Persist a transcript-binding change for a backend session that can be
   * restored after daemon restart. `binding === undefined` clears the stored
   * binding. Backends with no cross-restart persistence (e.g. the default
   * backend) MAY omit this; their telemetry then lives only for the lifetime
   * of the daemon process. Failures are best-effort: the caller logs and
   * keeps the in-memory telemetry state.
   */
  persistTranscriptBinding?(
    session: TerminalBackendSession,
    binding: TerminalTranscriptBinding | undefined,
  ): Promise<void>;
  /**
   * Ask the backend to re-emit the full screen state for a live session,
   * e.g. after a byte-journal replay gap left a freshly attached client with
   * an incomplete picture (missing the alternate-screen enter sequence).
   * tmux implements this as `refresh-client`. Best-effort: failures are
   * swallowed and MUST NOT affect the attachment. Backends with no notion
   * of redrawable screen state (e.g. the default backend) MAY omit this.
   */
  refreshScreenState?(session: TerminalBackendSession): void;
  /**
   * Capture the current visible screen of a session as flat SGR-colored rows
   * plus geometry (see `TerminalScreenSnapshot`). Drives the Mission Control
   * wall, which renders snapshots without mounting a terminal emulator.
   *
   * MUST be non-blocking — capture runs on a sub-second cadence across many
   * panes, so a synchronous `spawnSync` would stall the daemon event loop.
   * Backends without a screen grid (the default PTY backend) return
   * `{ available: false }` so the caller renders a metadata-only fallback.
   * Backends with no notion of a capturable screen MAY omit this entirely.
   */
  captureScreenSnapshot?(
    session: TerminalBackendSession,
  ): Promise<TerminalScreenSnapshotResult>;
}
