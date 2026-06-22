/**
 * Terminal session actor.
 *
 * Each terminal session is owned by exactly one actor instance. The actor:
 * - Owns the PTY-backed process via the runtime port.
 * - Owns the bounded byte journal (sequence-numbered output history).
 * - Owns the attachment hub (many readers, one controller).
 * - Drives the lifecycle state machine: creating → running → terminating →
 *   exiting → exited (with `failed` and `disposed` as side states).
 *
 * Every public mutator enqueues a command rather than touching state directly.
 * Commands are processed in order on the next microtask so concurrent input,
 * resize, attach, detach, control transfers, and exit handling cannot race.
 */

import {
  TerminalRuntimeUnavailableError,
  type TerminalProcess,
  type TerminalRuntime,
  type TerminalSpawnOptions,
} from "./runtime";
import type {
  TerminalBackendAdapter,
  TerminalBackendSession,
  TerminalBackendTransport,
  TerminalScreenSnapshotResult,
  TerminalTranscriptBinding,
} from "./backend";
import type {
  AgentActivityBlock,
  AgentTelemetry,
} from "@worktreeos/core/agent-activity";
import { ByteJournal, type JournalChunk } from "./byte-journal";
import { TerminalModeTracker } from "./mode-tracker";
import {
  encodeTerminalServerFrame,
  TERMINAL_PROTOCOL_VERSION,
  type TerminalControlMode,
  type TerminalServerErrorCode,
  type TerminalServerFrame,
} from "./protocol";
import type {
  TerminalActiveCommand,
  TerminalAttachmentSummary,
  TerminalControlOwnership,
  TerminalSessionExit,
  TerminalSessionMetadata,
  TerminalSessionStatus,
  TerminalTitleSource,
} from "./types";
import type { ModuleLogger } from "../logger";

const DEFAULT_QUEUE_BUDGET_BYTES = 1 * 1024 * 1024; // 1 MiB per attachment

// The protocol carries PTY output in the `data: string` field. PTY data is
// raw bytes that may split a multi-byte UTF-8 sequence (e.g. Cyrillic, CJK)
// across chunk boundaries. We decode in stream mode so a dangling tail byte
// is buffered and joined with the next chunk's leading byte instead of being
// replaced with U+FFFD. The live decoder is owned per-actor (PTY bytes form
// one stream); replay paths use a fresh decoder per invocation.
function createUtf8StreamDecoder(): TextDecoder {
  return new TextDecoder("utf-8", { fatal: false });
}

export interface AttachmentSink {
  /** Deliver an encoded frame. Implementations MUST NOT throw. */
  send(frame: TerminalServerFrame): void;
  /** Force the WebSocket closed with an optional code/reason. */
  close(code?: number, reason?: string): void;
  /** Optional: report the underlying transport's buffered bytes. */
  bufferedAmount?(): number;
}

export interface AttachmentOptions {
  attachmentId: string;
  clientId?: string;
  cols: number;
  rows: number;
  lastSeenOutputSeq?: number;
  desiredControl: TerminalControlMode;
  sink: AttachmentSink;
}

interface AttachmentState {
  id: string;
  clientId?: string;
  cols: number;
  rows: number;
  isController: boolean;
  lastAckSeq: number;
  joinedAt: string;
  sink: AttachmentSink;
}

export interface TerminalSessionActorOptions {
  id: string;
  worktreePath: string;
  runtime: TerminalRuntime;
  spawn: TerminalSpawnOptions;
  now?: () => Date;
  historyCapacityBytes?: number;
  perAttachmentQueueBytes?: number;
  onLifecycle?: (event: TerminalLifecycleEvent) => void;
  activeCommandResolver?: (rootPid: number | undefined) => TerminalActiveCommand | undefined;
  /**
   * Optional backend adapter and session handle. When provided, daemon
   * shutdown and user-initiated terminate route through the backend
   * (`onDaemonShutdown`, `terminateSession`) instead of calling
   * `TerminalProcess.kill` directly. Default-backend actors omit these and
   * keep the legacy direct-kill semantics.
   */
  backend?: TerminalBackendAdapter;
  backendSession?: TerminalBackendSession;
  /**
   * Pre-created backend transport. When provided, the actor skips
   * `runtime.spawn` during start and adopts the supplied transport as the
   * live PTY process. Used by tmux restore and any path that creates the
   * transport before constructing the actor.
   */
  transport?: TerminalBackendTransport;
  /**
   * `terminal` module logger. Best-effort persistence failures are recorded
   * here (instead of the discarded process console) when present.
   */
  logger?: ModuleLogger;
}

export type TerminalLifecycleEvent =
  | { type: "created"; metadata: TerminalSessionMetadata }
  | { type: "running"; metadata: TerminalSessionMetadata }
  | { type: "attached"; metadata: TerminalSessionMetadata; attachment: TerminalAttachmentSummary }
  | { type: "detached"; metadata: TerminalSessionMetadata; attachmentId: string }
  | { type: "control-changed"; metadata: TerminalSessionMetadata; control: TerminalControlOwnership }
  | { type: "updated"; metadata: TerminalSessionMetadata; changedAt: string }
  | { type: "exited"; metadata: TerminalSessionMetadata }
  | { type: "removed"; metadata: TerminalSessionMetadata };

export class TerminalSessionActor {
  private readonly opts: TerminalSessionActorOptions;
  private readonly journal: ByteJournal;
  private readonly attachments = new Map<string, AttachmentState>();
  private readonly now: () => Date;
  private readonly perAttachmentQueueBytes: number;
  private readonly liveDecoder = createUtf8StreamDecoder();
  private readonly modeTracker = new TerminalModeTracker();
  private process: TerminalProcess | null = null;
  private status: TerminalSessionStatus = "creating";
  private title?: string;
  private titleSource?: TerminalTitleSource;
  private agentActivity?: AgentActivityBlock;
  private agentTelemetry?: AgentTelemetry;
  /**
   * Whether a client has been attached at any point during the agent's current
   * `working` stretch. Seeded from the live attachment count whenever the block
   * (re)enters `working`, and set true on any attach while `working`. The
   * staleness sweep consults it: a `working` block that was never attended is
   * almost certainly still working (an Esc-interrupt — the sweep's only reason
   * to exist — needs a human at the keyboard), so it is not demoted.
   */
  private attachedDuringWorking = false;
  private unreadSince?: string;
  private exit?: TerminalSessionExit;
  private control: TerminalControlOwnership;
  private cols: number;
  private rows: number;
  private disposeProcess: (() => void) | null = null;
  private readonly commandQueue: Array<() => Promise<void> | void> = [];
  private commandRunning = false;
  private exitFinalized = false;

  constructor(opts: TerminalSessionActorOptions) {
    this.opts = opts;
    this.journal = new ByteJournal({
      capacityBytes: opts.historyCapacityBytes,
    });
    this.now = opts.now ?? (() => new Date());
    this.perAttachmentQueueBytes =
      opts.perAttachmentQueueBytes ?? DEFAULT_QUEUE_BUDGET_BYTES;
    this.cols = opts.spawn.cols;
    this.rows = opts.spawn.rows;
    // Prefer the backend session's creation time so restored sessions (e.g.
    // tmux reattach after a daemon restart) keep their original age instead of
    // resetting to "now". Fresh sessions have no backend createdAt mismatch:
    // both backends echo the create-time stamp back on the session.
    this.createdAt = opts.backendSession?.createdAt ?? this.now().toISOString();
    // Adopt any title the backend restored with the session (e.g. tmux reattach
    // after a daemon restart) so the name survives where the session survives.
    // Missing provenance defaults to "user" so a restored title is never
    // clobbered by agent activity.
    this.title = opts.backendSession?.title;
    this.titleSource = this.title
      ? (opts.backendSession?.titleSource ?? "user")
      : undefined;
    // Adopt a restored unread marker (tmux reattach after a daemon restart)
    // so unseen agent output stays discoverable across restarts.
    this.unreadSince = opts.backendSession?.unreadSince;
    this.control = {
      controllerAttachmentId: null,
      changedAt: this.now().toISOString(),
    };
  }

  get id(): string {
    return this.opts.id;
  }

  get worktreePath(): string {
    return this.opts.worktreePath;
  }

  /** Current authoritative metadata snapshot (defensive copy). */
  snapshot(): TerminalSessionMetadata {
    return this.buildMetadata();
  }

  /**
   * Capture the session's current visible screen through the backend (Mission
   * Control wall). Returns `{ available: false }` when the backend keeps no
   * screen grid or exposes no capture capability, so the caller renders a
   * metadata-only fallback rather than a broken view.
   */
  async captureScreenSnapshot(): Promise<TerminalScreenSnapshotResult> {
    const backend = this.opts.backend;
    const session = this.opts.backendSession;
    if (!backend?.captureScreenSnapshot || !session) {
      return { available: false, reason: "backend has no screen snapshot capability" };
    }
    return backend.captureScreenSnapshot(session);
  }

  /** Replace or clear the derived agent activity block. */
  setAgentActivity(block: AgentActivityBlock | undefined): void {
    const enteringWorking =
      block?.state === "working" && this.agentActivity?.state !== "working";
    this.agentActivity = block;
    // (Re)entering `working` opens a fresh stretch: seed the attachment-history
    // flag from whoever is attached right now. A later attach while `working`
    // flips it true (see `doAttach`); leaving `working` leaves it untouched
    // since the sweep only consults it for `working` blocks.
    if (enteringWorking) {
      this.attachedDuringWorking = this.attachments.size > 0;
    }
  }

  /**
   * Whether a client was attached at some point during the current `working`
   * stretch. The staleness sweep gates synthetic demotion on this.
   */
  wasAttachedDuringWorking(): boolean {
    return this.attachedDuringWorking;
  }

  /**
   * Emit an `updated` lifecycle so clients refetch after an out-of-band agent
   * activity transition that did not flow through the ingest publish path
   * (e.g. a transcript-growth resurrection of a soft staleness idle).
   */
  emitActivityUpdated(changedAt: string): void {
    this.emit({
      type: "updated",
      metadata: this.buildMetadata(),
      changedAt,
    });
  }

  /**
   * Replace or clear the derived transcript telemetry block, emitting an
   * `updated` lifecycle event so clients refresh the snapshot. Callers are
   * expected to debounce updates.
   */
  setAgentTelemetry(telemetry: AgentTelemetry | undefined): void {
    if (this.agentTelemetry === telemetry) return;
    this.agentTelemetry = telemetry;
    this.emit({
      type: "updated",
      metadata: this.buildMetadata(),
      changedAt: this.now().toISOString(),
    });
  }

  /** Current derived transcript telemetry block, if any. */
  getAgentTelemetry(): AgentTelemetry | undefined {
    return this.agentTelemetry;
  }

  /**
   * Persist the session's transcript-telemetry binding through the backend so
   * it survives a daemon restart. `binding === undefined` clears it. Persisted
   * best-effort: a write failure is logged and never fails the in-memory
   * telemetry state (mirrors `persistUnread`).
   */
  persistTranscriptBinding(binding: TerminalTranscriptBinding | undefined): void {
    const backend = this.opts.backend;
    const session = this.opts.backendSession;
    if (!backend?.persistTranscriptBinding || !session) return;
    void backend.persistTranscriptBinding(session, binding).catch((e) => {
      const msg = `failed to persist transcript binding: ${(e as Error).message}`;
      if (this.opts.logger) this.opts.logger.error(msg, { sid: this.opts.id });
      else console.error(`terminal ${this.opts.id}: ${msg}`);
    });
  }

  /** Current derived agent activity block, if any. */
  getAgentActivity(): AgentActivityBlock | undefined {
    return this.agentActivity;
  }

  /** Number of currently connected attachments. */
  attachmentCount(): number {
    return this.attachments.size;
  }

  /** Current unread marker, if any. */
  getUnreadSince(): string | undefined {
    return this.unreadSince;
  }

  /**
   * Mark the session unread as of `at`. No-op when already unread (the
   * original timestamp is kept). Persisted best-effort through the backend;
   * a write failure is logged and leaves the in-memory marker intact.
   */
  markUnread(at: string): void {
    if (this.unreadSince) return;
    this.unreadSince = at;
    this.persistUnread(at);
  }

  private clearUnread(): void {
    if (!this.unreadSince) return;
    this.unreadSince = undefined;
    this.persistUnread(undefined);
  }

  private persistUnread(unreadSince: string | undefined): void {
    const backend = this.opts.backend;
    const session = this.opts.backendSession;
    if (!backend?.persistUnread || !session) return;
    session.unreadSince = unreadSince;
    void backend.persistUnread(session, unreadSince).catch((e) => {
      const msg = `failed to persist unread marker: ${(e as Error).message}`;
      if (this.opts.logger) this.opts.logger.error(msg, { sid: this.opts.id });
      else console.error(`terminal ${this.opts.id}: ${msg}`);
    });
  }

  private buildMetadata(): TerminalSessionMetadata {
    const attachments: TerminalAttachmentSummary[] = [];
    for (const att of this.attachments.values()) {
      attachments.push({
        attachmentId: att.id,
        ...(att.clientId !== undefined ? { clientId: att.clientId } : {}),
        isController: att.isController,
        attachedAt: att.joinedAt,
        lastAckSeq: att.lastAckSeq,
      });
    }
    // When the backend owns the session (e.g. tmux), `backendSession.processId`
    // points at the user-visible shell PID (tmux pane PID) instead of the
    // daemon-owned transport PID. Use it for both the snapshot's `processId`
    // field and the active-command resolver so process detection walks the
    // real shell tree.
    const backendProcessId = this.opts.backendSession?.processId;
    const processId =
      typeof backendProcessId === "number" ? backendProcessId : this.process?.pid;
    let activeCommand: TerminalActiveCommand | undefined;
    if (this.status === "running" && this.opts.activeCommandResolver) {
      try {
        activeCommand = this.opts.activeCommandResolver(processId);
      } catch {
        activeCommand = undefined;
      }
    }
    return {
      id: this.opts.id,
      worktreePath: this.opts.worktreePath,
      ...(this.title && this.titleSource
        ? { title: this.title, titleSource: this.titleSource }
        : {}),
      status: this.status,
      shell: this.opts.spawn.shell,
      ...(typeof processId === "number" ? { processId } : {}),
      ...(activeCommand ? { activeCommand } : {}),
      // The activity block is only meaningful while the reporting agent is
      // the session's foreground command; once the agent exits (or the PTY
      // stops running) the snapshot omits it.
      ...(this.agentActivity &&
      this.status === "running" &&
      activeCommand?.agent
        ? { agentActivity: this.agentActivity }
        : {}),
      // Same rule for telemetry: once the agent is no longer the foreground
      // command, the stale model/context numbers must not linger on the row.
      ...(this.agentTelemetry &&
      this.status === "running" &&
      activeCommand?.agent
        ? { agentTelemetry: this.agentTelemetry }
        : {}),
      cwd: this.opts.spawn.cwd,
      cols: this.cols,
      rows: this.rows,
      createdAt: this.createdAt,
      ...(this.lastAttachedAt ? { lastAttachedAt: this.lastAttachedAt } : {}),
      ...(this.unreadSince ? { unreadSince: this.unreadSince } : {}),
      ...(this.exit ? { exit: this.exit } : {}),
      replay: this.journal.boundary(),
      control: { ...this.control },
      attachments,
    };
  }

  private readonly createdAt: string;
  private lastAttachedAt?: string;

  // ---------- Lifecycle ----------

  async start(): Promise<void> {
    if (this.status !== "creating") return;
    return this.enqueue(() => this.doStart());
  }

  private doStart(): void {
    try {
      if (this.opts.transport) {
        this.process = this.opts.transport;
      } else {
        if (!this.opts.runtime.isAvailable()) {
          throw new TerminalRuntimeUnavailableError(
            `terminal runtime ${this.opts.runtime.name} is not available`,
          );
        }
        this.process = this.opts.runtime.spawn(this.opts.spawn);
      }
    } catch (e) {
      this.status = "failed";
      this.exit = {
        exitedAt: this.now().toISOString(),
      };
      this.emit({ type: "exited", metadata: this.buildMetadata() });
      throw e;
    }
    const dataOff = this.process.onData((bytes) => this.onPtyData(bytes));
    const exitOff = this.process.onExit((info) => {
      this.enqueue(() => this.onPtyExit(info)).catch(() => {});
    });
    this.disposeProcess = () => {
      try {
        dataOff();
      } catch {
        /* ignore */
      }
      try {
        exitOff();
      } catch {
        /* ignore */
      }
    };
    this.status = "running";
    this.emit({ type: "created", metadata: this.buildMetadata() });
    this.emit({ type: "running", metadata: this.buildMetadata() });
  }

  // ---------- Attachment hub ----------

  async attach(opts: AttachmentOptions): Promise<TerminalAttachmentSummary> {
    return new Promise<TerminalAttachmentSummary>((resolve, reject) => {
      this.enqueue(() => {
        try {
          const summary = this.doAttach(opts);
          resolve(summary);
        } catch (e) {
          reject(e);
        }
      }).catch((e) => reject(e));
    });
  }

  private doAttach(opts: AttachmentOptions): TerminalAttachmentSummary {
    if (this.status === "disposed") {
      throw new Error("terminal session is disposed");
    }
    if (this.attachments.has(opts.attachmentId)) {
      throw new Error(`attachment ${opts.attachmentId} already exists`);
    }
    const isController =
      opts.desiredControl === "controller" &&
      this.control.controllerAttachmentId === null;
    const att: AttachmentState = {
      id: opts.attachmentId,
      ...(opts.clientId !== undefined ? { clientId: opts.clientId } : {}),
      cols: opts.cols,
      rows: opts.rows,
      isController,
      lastAckSeq: opts.lastSeenOutputSeq ?? 0,
      joinedAt: this.now().toISOString(),
      sink: opts.sink,
    };
    this.attachments.set(att.id, att);
    this.lastAttachedAt = att.joinedAt;
    // Attaching while the agent is `working` records that this stretch was
    // attended, so the staleness sweep may later recover an Esc-interrupt on it
    // even if the client subsequently detaches.
    if (this.agentActivity?.state === "working") {
      this.attachedDuringWorking = true;
    }
    // Any attachment marks the session read; detach never re-sets it.
    this.clearUnread();
    if (isController) {
      this.control = {
        controllerAttachmentId: att.id,
        changedAt: att.joinedAt,
      };
      this.applyControllerDimensions(att);
    }

    // hello-ack — authoritative session metadata, replay boundary, control.
    const replay = this.journal.boundary();
    const plan = this.journal.planReplay(att.lastAckSeq);
    const willReplay = plan.chunks.length > 0;
    this.safeSend(att, {
      type: "hello-ack",
      v: TERMINAL_PROTOCOL_VERSION,
      attachmentId: att.id,
      session: this.buildMetadata(),
      replay,
      control: { ...this.control },
      willReplay,
    });
    if (plan.gap && this.status !== "exited") {
      this.safeSend(att, {
        type: "error",
        v: TERMINAL_PROTOCOL_VERSION,
        code: "replay-gap",
        message: `requested sequence ${att.lastAckSeq} is older than retained history`,
      });
      // The client missed bytes it can never recover (possibly including an
      // alternate-screen enter sequence) — ask the backend to re-emit the
      // full screen state so the client converges. Best-effort; backends
      // without redrawable screen state (default backend) omit the hook.
      const backend = this.opts.backend;
      const backendSession = this.opts.backendSession;
      if (backend?.refreshScreenState && backendSession) {
        backend.refreshScreenState(backendSession);
      }
    }
    // Stream replay chunks then a replay-done marker. A fresh stream decoder
    // walks the retained chunks in order so a multi-byte UTF-8 sequence
    // straddling two chunks is emitted intact across consecutive frames.
    // We intentionally do not flush at the end: any dangling tail byte is
    // dropped from replay and will be resolved by the live decoder in the
    // next output frame for this attachment.
    const replayDecoder = createUtf8StreamDecoder();
    // On a gap the dropped bytes may have carried mode-setting sequences
    // (alternate screen, mouse tracking, bracketed paste). Prepend the
    // tracked-mode restore prefix to the first replay frame so the client's
    // emulator converges on the live state before rendering the tail.
    let replayPrefix = plan.gap ? this.modeTracker.restoreSequence() : "";
    for (const chunk of plan.chunks) {
      this.safeSend(att, {
        type: "output",
        v: TERMINAL_PROTOCOL_VERSION,
        seq: chunk.seq,
        data: replayPrefix + replayDecoder.decode(chunk.bytes, { stream: true }),
        replay: true,
      });
      replayPrefix = "";
    }
    if (willReplay) {
      this.safeSend(att, {
        type: "replay-done",
        v: TERMINAL_PROTOCOL_VERSION,
        upToSeq: plan.upToSeq,
      });
    }
    // Already-exited session: deliver the exit frame so the client can render
    // the right closing state, then close the attachment.
    if (this.status === "exited" && this.exit) {
      this.safeSend(att, {
        type: "exit",
        v: TERMINAL_PROTOCOL_VERSION,
        exit: this.exit,
      });
      try {
        att.sink.close(1000, "terminal exited");
      } catch {
        /* ignore */
      }
      this.attachments.delete(att.id);
      this.broadcastAttachmentList();
      return this.summary(att);
    }

    const summary = this.summary(att);
    this.broadcastAttachmentList();
    this.emit({
      type: "attached",
      metadata: this.buildMetadata(),
      attachment: summary,
    });
    return summary;
  }

  async detach(attachmentId: string, reason?: string): Promise<void> {
    return this.enqueue(() => this.doDetach(attachmentId, reason));
  }

  private doDetach(attachmentId: string, reason?: string): void {
    const att = this.attachments.get(attachmentId);
    if (!att) return;
    this.attachments.delete(attachmentId);
    const wasController = att.isController;
    try {
      att.sink.close(reason ? 1000 : 1000, reason ?? "detached");
    } catch {
      /* ignore */
    }
    if (wasController) {
      this.control = {
        controllerAttachmentId: null,
        changedAt: this.now().toISOString(),
      };
      this.broadcastControl();
      this.emit({
        type: "control-changed",
        metadata: this.buildMetadata(),
        control: { ...this.control },
      });
    }
    this.broadcastAttachmentList();
    this.emit({
      type: "detached",
      metadata: this.buildMetadata(),
      attachmentId,
    });
  }

  // ---------- Input / Resize / Control ----------

  async input(attachmentId: string, data: string): Promise<void> {
    return this.enqueue(() => this.doInput(attachmentId, data));
  }

  private doInput(attachmentId: string, data: string): void {
    const att = this.attachments.get(attachmentId);
    if (!att) return;
    if (!att.isController) {
      this.safeSend(att, {
        type: "error",
        v: TERMINAL_PROTOCOL_VERSION,
        code: "control-denied",
        message: "input is only accepted from the controlling attachment",
      });
      return;
    }
    if (this.status !== "running" || !this.process) return;
    try {
      this.process.write(data);
    } catch {
      /* exit listener will reconcile */
    }
  }

  async resize(attachmentId: string, cols: number, rows: number): Promise<void> {
    return this.enqueue(() => this.doResize(attachmentId, cols, rows));
  }

  private doResize(attachmentId: string, cols: number, rows: number): void {
    const att = this.attachments.get(attachmentId);
    if (!att) return;
    if (!att.isController) {
      this.safeSend(att, {
        type: "error",
        v: TERMINAL_PROTOCOL_VERSION,
        code: "control-denied",
        message: "resize is only accepted from the controlling attachment",
      });
      return;
    }
    if (this.status !== "running" || !this.process) return;
    if (cols === this.cols && rows === this.rows) return;
    try {
      this.process.resize(cols, rows);
    } catch {
      return;
    }
    this.cols = cols;
    this.rows = rows;
    att.cols = cols;
    att.rows = rows;
    // Broadcast a status frame so viewers can adjust their viewport state.
    const meta = this.buildMetadata();
    for (const other of this.attachments.values()) {
      this.safeSend(other, {
        type: "status",
        v: TERMINAL_PROTOCOL_VERSION,
        status: meta.status,
        session: meta,
      });
    }
  }

  async ack(attachmentId: string, seq: number): Promise<void> {
    return this.enqueue(() => {
      const att = this.attachments.get(attachmentId);
      if (!att) return;
      if (seq > att.lastAckSeq) att.lastAckSeq = seq;
    });
  }

  async requestControl(attachmentId: string): Promise<void> {
    return this.enqueue(() => this.doRequestControl(attachmentId));
  }

  private doRequestControl(attachmentId: string): void {
    const att = this.attachments.get(attachmentId);
    if (!att) return;
    if (att.isController) {
      this.safeSend(att, {
        type: "control",
        v: TERMINAL_PROTOCOL_VERSION,
        control: { ...this.control },
        isController: true,
      });
      return;
    }
    // Takeover: transfer control from the current controller (if any) to the
    // requester. This is intentionally permissive — controller takeover is
    // expected to be common across browser tabs.
    const previous = this.control.controllerAttachmentId
      ? this.attachments.get(this.control.controllerAttachmentId)
      : null;
    if (previous) previous.isController = false;
    att.isController = true;
    this.control = {
      controllerAttachmentId: att.id,
      changedAt: this.now().toISOString(),
    };
    this.applyControllerDimensions(att);
    this.broadcastControl();
    this.emit({
      type: "control-changed",
      metadata: this.buildMetadata(),
      control: { ...this.control },
    });
  }

  async releaseControl(attachmentId: string): Promise<void> {
    return this.enqueue(() => this.doReleaseControl(attachmentId));
  }

  private doReleaseControl(attachmentId: string): void {
    const att = this.attachments.get(attachmentId);
    if (!att) return;
    if (!att.isController) return;
    att.isController = false;
    this.control = {
      controllerAttachmentId: null,
      changedAt: this.now().toISOString(),
    };
    this.broadcastControl();
    this.emit({
      type: "control-changed",
      metadata: this.buildMetadata(),
      control: { ...this.control },
    });
  }

  /**
   * Set or clear the title. `title === undefined` clears it (along with its
   * provenance). Persistence is routed through the backend first (when it can
   * persist); if that throws, the in-memory title is left unchanged and the
   * error propagates so the authoritative snapshot keeps the previous title.
   * The PTY transport, replay, attachments, control ownership, and lifecycle
   * status are untouched.
   */
  async setTitle(
    title: string | undefined,
    source: TerminalTitleSource = "user",
  ): Promise<void> {
    return this.enqueue(async () => {
      const nextSource = title === undefined ? undefined : source;
      const backend = this.opts.backend;
      const session = this.opts.backendSession;
      if (backend?.persistTitle && session) {
        await backend.persistTitle(session, title, nextSource);
        session.title = title;
        session.titleSource = nextSource;
      }
      this.title = title;
      this.titleSource = nextSource;
      this.emit({
        type: "updated",
        metadata: this.buildMetadata(),
        changedAt: this.now().toISOString(),
      });
    });
  }

  async terminate(signal?: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.status !== "running") return;
      this.status = "terminating";
      const backend = this.opts.backend;
      const session = this.opts.backendSession;
      if (backend && session) {
        try {
          await backend.terminateSession(session, this.process, signal);
        } catch {
          /* exit listener will reconcile */
        }
        return;
      }
      try {
        this.process?.kill(signal);
      } catch {
        /* exit listener will reconcile */
      }
    });
  }

  async shutdown(): Promise<void> {
    return this.enqueue(() => this.doShutdown());
  }

  private async doShutdown(): Promise<void> {
    if (this.status === "disposed") return;
    if (this.process && this.status === "running") {
      const backend = this.opts.backend;
      const session = this.opts.backendSession;
      if (backend && session) {
        try {
          await backend.onDaemonShutdown(session, this.process);
        } catch {
          /* ignore */
        }
      } else {
        try {
          this.process.kill();
        } catch {
          /* ignore */
        }
      }
    }
    for (const att of this.attachments.values()) {
      try {
        att.sink.close(1001, "daemon shutdown");
      } catch {
        /* ignore */
      }
    }
    this.attachments.clear();
    if (this.disposeProcess) {
      try {
        this.disposeProcess();
      } catch {
        /* ignore */
      }
      this.disposeProcess = null;
    }
    try {
      this.process?.dispose();
    } catch {
      /* ignore */
    }
    this.process = null;
    this.status = "disposed";
    this.emit({ type: "removed", metadata: this.buildMetadata() });
  }

  // ---------- PTY callbacks ----------

  private onPtyData(bytes: Uint8Array): void {
    this.modeTracker.feed(bytes);
    const chunk = this.journal.append(bytes);
    if (chunk.bytes.byteLength === 0) return;
    const wire = this.liveDecoder.decode(chunk.bytes, { stream: true });
    for (const att of this.attachments.values()) {
      this.deliverOutput(att, chunk, wire);
    }
  }

  private onPtyExit(info: { exitCode?: number; signal?: number }): void {
    if (this.exitFinalized) return;
    this.exitFinalized = true;
    this.status = "exited";
    this.exit = {
      exitedAt: this.now().toISOString(),
      ...(typeof info.exitCode === "number" ? { exitCode: info.exitCode } : {}),
      ...(typeof info.signal === "number" ? { signal: info.signal } : {}),
    };
    const meta = this.buildMetadata();
    for (const att of this.attachments.values()) {
      this.safeSend(att, {
        type: "status",
        v: TERMINAL_PROTOCOL_VERSION,
        status: "exited",
        session: meta,
      });
      this.safeSend(att, {
        type: "exit",
        v: TERMINAL_PROTOCOL_VERSION,
        exit: this.exit,
      });
      try {
        att.sink.close(1000, "terminal exited");
      } catch {
        /* ignore */
      }
    }
    this.attachments.clear();
    if (this.disposeProcess) {
      try {
        this.disposeProcess();
      } catch {
        /* ignore */
      }
      this.disposeProcess = null;
    }
    this.emit({ type: "exited", metadata: meta });
  }

  // ---------- Helpers ----------

  private summary(att: AttachmentState): TerminalAttachmentSummary {
    return {
      attachmentId: att.id,
      ...(att.clientId !== undefined ? { clientId: att.clientId } : {}),
      isController: att.isController,
      attachedAt: att.joinedAt,
      lastAckSeq: att.lastAckSeq,
    };
  }

  private applyControllerDimensions(att: AttachmentState): void {
    if (this.status !== "running" || !this.process) return;
    if (att.cols === this.cols && att.rows === this.rows) return;
    try {
      this.process.resize(att.cols, att.rows);
      this.cols = att.cols;
      this.rows = att.rows;
    } catch {
      /* ignore */
    }
  }

  private deliverOutput(att: AttachmentState, chunk: JournalChunk, wire: string): void {
    this.safeSend(att, {
      type: "output",
      v: TERMINAL_PROTOCOL_VERSION,
      seq: chunk.seq,
      data: wire,
    });
    this.maybeBackpressure(att);
  }

  private maybeBackpressure(att: AttachmentState): void {
    const buffered = att.sink.bufferedAmount?.();
    if (typeof buffered !== "number") return;
    if (buffered <= this.perAttachmentQueueBytes) return;
    // Slow client exceeded its budget. Send a typed error and close the
    // attachment WITHOUT touching the session — other viewers and the
    // controller continue normally.
    this.safeSend(att, {
      type: "error",
      v: TERMINAL_PROTOCOL_VERSION,
      code: "backpressure",
      message: `attachment queue exceeded ${this.perAttachmentQueueBytes} bytes`,
      fatal: true,
    });
    this.attachments.delete(att.id);
    try {
      att.sink.close(1013, "backpressure");
    } catch {
      /* ignore */
    }
    if (att.isController) {
      this.control = {
        controllerAttachmentId: null,
        changedAt: this.now().toISOString(),
      };
      this.broadcastControl();
      this.emit({
        type: "control-changed",
        metadata: this.buildMetadata(),
        control: { ...this.control },
      });
    }
    this.broadcastAttachmentList();
    this.emit({
      type: "detached",
      metadata: this.buildMetadata(),
      attachmentId: att.id,
    });
  }

  private broadcastControl(): void {
    for (const att of this.attachments.values()) {
      this.safeSend(att, {
        type: "control",
        v: TERMINAL_PROTOCOL_VERSION,
        control: { ...this.control },
        isController: att.isController,
      });
    }
  }

  private broadcastAttachmentList(): void {
    const summaries: TerminalAttachmentSummary[] = [];
    for (const att of this.attachments.values()) summaries.push(this.summary(att));
    for (const att of this.attachments.values()) {
      this.safeSend(att, {
        type: "attachments",
        v: TERMINAL_PROTOCOL_VERSION,
        attachments: summaries,
      });
    }
  }

  private safeSend(att: AttachmentState, frame: TerminalServerFrame): void {
    try {
      att.sink.send(frame);
    } catch {
      /* swallow — the attachment's `close` will fire and clean up */
    }
  }

  emitErrorTo(attachmentId: string, code: TerminalServerErrorCode, message: string, fatal = false): void {
    const att = this.attachments.get(attachmentId);
    if (!att) return;
    this.safeSend(att, {
      type: "error",
      v: TERMINAL_PROTOCOL_VERSION,
      code,
      message,
      ...(fatal ? { fatal: true } : {}),
    });
    if (fatal) {
      this.attachments.delete(attachmentId);
      try {
        att.sink.close(1011, code);
      } catch {
        /* ignore */
      }
      this.broadcastAttachmentList();
    }
  }

  private emit(event: TerminalLifecycleEvent): void {
    if (!this.opts.onLifecycle) return;
    try {
      this.opts.onLifecycle(event);
    } catch {
      /* swallow listener errors */
    }
  }

  private enqueue(task: () => Promise<void> | void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.commandQueue.push(async () => {
        try {
          await task();
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      this.scheduleRun();
    });
  }

  private scheduleRun(): void {
    if (this.commandRunning) return;
    this.commandRunning = true;
    queueMicrotask(() => this.runCommands());
  }

  private async runCommands(): Promise<void> {
    try {
      while (this.commandQueue.length > 0) {
        const cmd = this.commandQueue.shift()!;
        try {
          await cmd();
        } catch {
          /* per-command errors are surfaced via their own reject */
        }
      }
    } finally {
      this.commandRunning = false;
    }
  }
}

/** Convenience: encode a frame for sinks that prefer string payloads. */
export function encodeFrameForSink(frame: TerminalServerFrame): string {
  return encodeTerminalServerFrame(frame);
}
