/**
 * Terminal session manager.
 *
 * Owns the set of live terminal session actors for a daemon process. Routes
 * worktree-scoped lifecycle, attach, list, inspect, and terminate requests to
 * the right actor. Forwards lifecycle events to an optional sink for unified
 * event publication and snapshot reconciliation.
 *
 * The manager validates worktree paths up front: a session cwd MUST resolve
 * to the selected worktree root or an allowed descendant. Path escapes via
 * `..`, symlinks, or absolute-path injection are rejected before spawning.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  AGENT_ACTIVITY_PROTOCOL_VERSION,
  type AgentActivityBlock,
  type AgentTelemetry,
  type AgentActivityEvent,
  reduceAgentActivity,
} from "@worktreeos/core/agent-activity";
import {
  TerminalSessionActor,
  type AttachmentOptions,
  type TerminalLifecycleEvent,
} from "./actor";
import type {
  TerminalBackendAdapter,
  TerminalBackendRestoreResult,
  TerminalScreenSnapshotResult,
  TerminalTranscriptBinding,
} from "./backend";
import {
  defaultShell as bunDefaultShell,
} from "./bun-terminal-runtime";
import { getAgentPluginStatus } from "../agent-plugin-install";
import { createDefaultTerminalBackend } from "./default-backend";
import { detectActiveTerminalCommand } from "./process-detection";
import { TerminalRuntimeUnavailableError, type TerminalRuntime } from "./runtime";
import { selectSessionEnv } from "./session-env";
import {
  normalizeTerminalTitle,
  TerminalTitleValidationError,
} from "./title";
import type { DaemonLogger, ModuleLogger } from "../logger";
import type {
  TerminalActiveCommand,
  TerminalAttachmentSummary,
  TerminalSessionMetadata,
} from "./types";

export const DEFAULT_TERMINAL_COLS = 80;
export const DEFAULT_TERMINAL_ROWS = 24;
export const DEFAULT_HISTORY_CAPACITY_BYTES = 256 * 1024;

export interface CreateTerminalOptions {
  worktreePath: string;
  cols?: number;
  rows?: number;
  shell?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  /** Working directory inside the worktree; defaults to the worktree root. */
  cwd?: string;
}

export interface TerminalSessionManagerOptions {
  /**
   * Selected terminal backend adapter. Most call sites should construct an
   * adapter (default or tmux) and pass it directly. `runtime` is preserved
   * as a shorthand for "use the default adapter wrapping this PTY runtime"
   * so existing call sites and tests stay terse.
   */
  backend?: TerminalBackendAdapter;
  runtime?: TerminalRuntime;
  historyCapacityBytes?: number;
  perAttachmentQueueBytes?: number;
  now?: () => Date;
  newId?: () => string;
  shellSelector?: (env: NodeJS.ProcessEnv) => string;
  activeCommandResolver?: (rootPid: number | undefined) => TerminalActiveCommand | undefined;
  onLifecycle?: (event: TerminalLifecycleEvent) => void;
  /**
   * Extra environment merged into every spawned PTY, keyed by the session id
   * assigned at create time. Used to bind agent-side plugins to the daemon
   * (`WOS_DAEMON_URL`, `WOS_TERMINAL_SESSION_ID`, `WOS_AGENT_TOKEN`).
   */
  agentEnv?: (sessionId: string) => Record<string, string>;
  /**
   * Daemon file logger. Drives status-transition / unread diagnostics under the
   * `terminal` module and `attach` / `process-detect` perf spans; a no-op when
   * logging is disabled.
   */
  logger?: DaemonLogger;
}

/**
 * One restored terminal session: its metadata snapshot plus the persisted
 * transcript binding when the record carried one (so the daemon can re-bind
 * and recompute telemetry on restart).
 */
export interface TerminalRestoreResult {
  metadata: TerminalSessionMetadata;
  transcript?: TerminalTranscriptBinding;
}

export class TerminalSessionManagerError extends Error {
  readonly code:
    | "not-found"
    | "cwd-invalid"
    | "terminal-unavailable"
    | "validation"
    | "persistence"
    | "internal";
  constructor(
    code: TerminalSessionManagerError["code"],
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "TerminalSessionManagerError";
  }
}

export class TerminalSessionManager {
  private readonly actors = new Map<string, TerminalSessionActor>();
  private readonly opts: TerminalSessionManagerOptions;
  private readonly backend: TerminalBackendAdapter;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly shellSelector: (env: NodeJS.ProcessEnv) => string;
  private readonly activeCommandResolver: (rootPid: number | undefined) => TerminalActiveCommand | undefined;
  /** `terminal` module logger for transition / unread diagnostics. */
  private readonly log: ModuleLogger | undefined;
  /** `perf` module logger for attach / process-detect spans. */
  private readonly perfLog: ModuleLogger | undefined;

  constructor(opts: TerminalSessionManagerOptions) {
    this.opts = opts;
    this.log = opts.logger?.module("terminal");
    this.perfLog = opts.logger?.module("perf");
    if (opts.backend) {
      this.backend = opts.backend;
    } else if (opts.runtime) {
      this.backend = createDefaultTerminalBackend({ runtime: opts.runtime });
    } else {
      throw new Error(
        "TerminalSessionManager requires either a `backend` adapter or a `runtime`",
      );
    }
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? (() => crypto.randomUUID());
    this.shellSelector = opts.shellSelector ?? bunDefaultShell;
    this.activeCommandResolver =
      opts.activeCommandResolver ??
      ((rootPid) => {
        const detect = () => {
          const command = detectActiveTerminalCommand(rootPid);
          if (
            command?.agent === "claude" ||
            command?.agent === "opencode" ||
            command?.agent === "codex"
          ) {
            const status = getAgentPluginStatus(command.agent);
            command.pluginInstalled = status.installed;
            // claude always carries a version; codex only when the listing
            // surfaces a semver (a local install reports no comparable version,
            // so `outdated` stays undefined and no update is offered).
            if (command.agent === "claude" || command.agent === "codex") {
              if (status.outdated !== undefined) {
                command.pluginOutdated = status.outdated;
              }
            }
          }
          return command;
        };
        return this.perfLog
          ? this.perfLog.spanSync("process-detect", String(rootPid ?? ""), detect)
          : detect();
      });
  }

  /** True when terminal sessions can be created on this host. */
  isAvailable(): boolean {
    return this.backend.isAvailable().available;
  }

  /** Stable diagnostic name for the selected backend. */
  runtimeName(): string {
    return this.backend.id;
  }

  backendId(): TerminalBackendAdapter["id"] {
    return this.backend.id;
  }

  async create(opts: CreateTerminalOptions): Promise<TerminalSessionMetadata> {
    const availability = this.backend.isAvailable();
    if (!availability.available) {
      throw new TerminalSessionManagerError(
        "terminal-unavailable",
        availability.reason ??
          `terminal backend ${this.backend.id} is not available on this host`,
      );
    }
    const worktreeRoot = this.resolveExistingDir(opts.worktreePath, "worktreePath");
    const cwd = opts.cwd
      ? this.resolveWithinWorktree(worktreeRoot, opts.cwd)
      : worktreeRoot;
    const cols = clampDim(opts.cols, DEFAULT_TERMINAL_COLS);
    const rows = clampDim(opts.rows, DEFAULT_TERMINAL_ROWS);
    const env = opts.env ?? process.env;
    const shell = opts.shell ?? this.shellSelector(env);
    // An explicit program (args provided, e.g. `docker compose exec`) brings
    // its own complete replacement environment and is spawned as-is. The
    // default interactive shell instead runs as a login shell that rebuilds
    // PATH and user/product vars from dotfiles, so the daemon contributes only
    // a narrow session allowlist — never its full, frozen, possibly-poisoned
    // env (no WOS_HOME, no stale PATH, no resurrected vars).
    const explicitProgram = opts.args !== undefined;
    const envBag: Record<string, string | undefined> = explicitProgram
      ? collectEnv(env)
      : selectSessionEnv(env);
    const login = !explicitProgram;

    const id = this.newId();
    const agentEnv = this.opts.agentEnv?.(id);
    if (agentEnv) {
      for (const [k, v] of Object.entries(agentEnv)) {
        envBag[k] = v;
      }
    }
    const createdAt = this.now().toISOString();
    let created;
    try {
      created = await this.backend.createSession({
        id,
        worktreePath: worktreeRoot,
        cwd,
        shell,
        ...(opts.args ? { args: opts.args } : {}),
        env: envBag,
        ...(agentEnv ? { extraEnv: agentEnv } : {}),
        login,
        cols,
        rows,
        createdAt,
      });
    } catch (e) {
      if (e instanceof TerminalRuntimeUnavailableError) {
        throw new TerminalSessionManagerError("terminal-unavailable", e.message);
      }
      throw new TerminalSessionManagerError(
        "internal",
        `failed to create terminal session: ${(e as Error).message}`,
      );
    }
    const actor = new TerminalSessionActor({
      id,
      worktreePath: worktreeRoot,
      runtime: noopRuntime(this.backend.id),
      spawn: {
        shell,
        ...(opts.args ? { args: opts.args } : {}),
        cwd,
        env: envBag,
        cols,
        rows,
      },
      backend: this.backend,
      backendSession: created.session,
      transport: created.transport,
      ...(typeof this.opts.historyCapacityBytes === "number"
        ? { historyCapacityBytes: this.opts.historyCapacityBytes }
        : {}),
      ...(typeof this.opts.perAttachmentQueueBytes === "number"
        ? { perAttachmentQueueBytes: this.opts.perAttachmentQueueBytes }
        : {}),
      now: this.now,
      activeCommandResolver: this.activeCommandResolver,
      onLifecycle: (event) => this.forwardLifecycle(event),
      ...(this.log ? { logger: this.log } : {}),
    });
    try {
      await actor.start();
    } catch (e) {
      if (e instanceof TerminalRuntimeUnavailableError) {
        throw new TerminalSessionManagerError("terminal-unavailable", e.message);
      }
      throw new TerminalSessionManagerError(
        "internal",
        `failed to spawn terminal: ${(e as Error).message}`,
      );
    }
    this.actors.set(id, actor);
    return actor.snapshot();
  }

  /**
   * Restore backend-owned sessions on daemon startup. Backends that do not
   * persist state (e.g. the default backend) return no sessions and this is
   * a no-op. The tmux backend implements this to bring previously-saved
   * sessions back as snapshots so clients can reattach. Failures are
   * surfaced through `onError` so the daemon can warn to stderr without
   * breaking startup.
   */
  async restore(opts: {
    onError?: (error: Error) => void;
  } = {}): Promise<TerminalRestoreResult[]> {
    if (!this.backend.restoreSessions) return [];
    let results: TerminalBackendRestoreResult[];
    try {
      results = await this.backend.restoreSessions();
    } catch (e) {
      opts.onError?.(e as Error);
      return [];
    }
    const out: TerminalRestoreResult[] = [];
    for (const result of results) {
      const session = result.session;
      let transport;
      if (this.backend.openTransport) {
        try {
          transport = await this.backend.openTransport(session, {
            cols: session.cols,
            rows: session.rows,
          });
        } catch (e) {
          opts.onError?.(e as Error);
          continue;
        }
      } else {
        opts.onError?.(
          new Error(
            `backend ${this.backend.id} returned restored sessions without an openTransport implementation`,
          ),
        );
        continue;
      }
      const actor = new TerminalSessionActor({
        id: session.id,
        worktreePath: session.worktreePath,
        runtime: noopRuntime(this.backend.id),
        spawn: {
          shell: session.shell,
          cwd: session.cwd,
          env: {},
          cols: session.cols,
          rows: session.rows,
        },
        backend: this.backend,
        backendSession: session,
        transport,
        ...(typeof this.opts.historyCapacityBytes === "number"
          ? { historyCapacityBytes: this.opts.historyCapacityBytes }
          : {}),
        ...(typeof this.opts.perAttachmentQueueBytes === "number"
          ? { perAttachmentQueueBytes: this.opts.perAttachmentQueueBytes }
          : {}),
        now: this.now,
        activeCommandResolver: this.activeCommandResolver,
        onLifecycle: (event) => this.forwardLifecycle(event),
        ...(this.log ? { logger: this.log } : {}),
      });
      try {
        await actor.start();
      } catch (e) {
        opts.onError?.(e as Error);
        continue;
      }
      this.actors.set(session.id, actor);
      out.push({
        metadata: actor.snapshot(),
        ...(result.transcript ? { transcript: result.transcript } : {}),
      });
    }
    return out;
  }

  list(worktreePath?: string): TerminalSessionMetadata[] {
    const target = worktreePath ? this.safeResolve(worktreePath) : undefined;
    const out: TerminalSessionMetadata[] = [];
    for (const actor of this.actors.values()) {
      const meta = actor.snapshot();
      if (target && meta.worktreePath !== target) continue;
      out.push(meta);
    }
    return out;
  }

  get(id: string): TerminalSessionMetadata | null {
    const actor = this.actors.get(id);
    return actor ? actor.snapshot() : null;
  }

  /**
   * Capture the current visible screen of a session for the Mission Control
   * wall, bundled with the session metadata so the caller has the agent
   * identity (`activeCommand.agent`, derived by process-detection — never the
   * tmux `pane_current_command`) alongside the rows. Returns `null` for an
   * unknown session; the snapshot result itself reports `available: false`
   * when the backend keeps no screen grid (default backend → fallback pane).
   */
  async captureScreenSnapshot(
    id: string,
  ): Promise<{ session: TerminalSessionMetadata; snapshot: TerminalScreenSnapshotResult } | null> {
    const actor = this.actors.get(id);
    if (!actor) return null;
    const snapshot = await actor.captureScreenSnapshot();
    return { session: actor.snapshot(), snapshot };
  }

  /**
   * Whether any session currently has a live WebSocket attachment.
   *
   * This counts ONLY interactive attachments (created via `attach`). The
   * Mission Control snapshot stream is passive — it captures screens through
   * `captureScreenSnapshot` and never calls `attach`, so it adds no attachment
   * here. Notification delivery no longer gates on terminal attachment (it gates
   * on focused-client presence), so this is now a plain attachment accessor.
   */
  hasActiveAttachments(): boolean {
    for (const actor of this.actors.values()) {
      if (actor.attachmentCount() > 0) return true;
    }
    return false;
  }

  /**
   * Apply one agent activity event to the session's derived block. Returns
   * the new block and the worktree path, `{ activity: null }` when the event
   * kind produced no transition, or `null` when the session is unknown.
   * Deliberately independent of the snapshot's process-detection gating so a
   * transition publishes even before the agent process is detected.
   */
  applyAgentActivity(
    id: string,
    event: AgentActivityEvent,
  ): { worktreePath: string; activity: AgentActivityBlock | null } | null {
    const actor = this.actors.get(id);
    if (!actor) return null;
    const previous = actor.getAgentActivity() ?? null;
    const next = reduceAgentActivity(previous, event);
    const worktreePath = actor.worktreePath;
    if (next === previous) {
      // Non-transition: only at trace, and explain a same-state repeat on a
      // detached, already-qualifying session (why unread isn't re-marked).
      if (this.log?.isEnabled("trace")) {
        this.log.trace("transition.none", {
          sid: id,
          state: activityLabel(previous),
          event: event.event,
          eventId: event.eventId,
        });
      }
      if (
        previous &&
        isUnreadQualifying(previous) &&
        actor.attachmentCount() === 0
      ) {
        this.log?.debug("unread.skip", { sid: id, reason: "same-state" });
      }
      return { worktreePath, activity: null };
    }
    actor.setAgentActivity(next ?? undefined);
    // The reducer can return a fresh block whose observable label is unchanged
    // (e.g. a repeat `stop`). Only a real label change is a `transition` at
    // `info`; an identical-label refresh is a `transition.none` at `trace`.
    const fromLabel = activityLabel(previous);
    const toLabel = activityLabel(next);
    if (fromLabel !== toLabel) {
      this.log?.info("transition", {
        sid: id,
        from: fromLabel,
        to: toLabel,
        event: event.event,
        eventId: event.eventId,
      });
    } else if (this.log?.isEnabled("trace")) {
      this.log.trace("transition.none", {
        sid: id,
        state: toLabel,
        event: event.event,
        eventId: event.eventId,
      });
    }
    // Unread marker: a transition into a "result is waiting" state while
    // nobody has the terminal open makes the session unread. Only a genuine
    // hook-driven idle (a real `stop`, `idleKind === "stop"`) or
    // `awaiting-input` qualifies — the staleness sweep's soft `stale` idle is a
    // guess, not a notification. Attached transitions and same-state repeats
    // never set or refresh it.
    const stateChanged = next?.state !== previous?.state;
    const qualifies = !!next && stateChanged && isUnreadQualifying(next);
    const attachments = actor.attachmentCount();
    if (qualifies && attachments === 0) {
      actor.markUnread(this.now().toISOString());
      this.log?.info("unread.mark", {
        sid: id,
        state: next.state === "idle" ? "idle/stop" : "awaiting-input",
      });
    } else if (qualifies) {
      this.log?.debug("unread.skip", { sid: id, reason: "attached", attachments });
    } else if (next && next.state === "idle" && next.idleKind === "stale") {
      this.log?.debug("unread.skip", { sid: id, reason: "stale-idle" });
    } else if (next && !stateChanged) {
      this.log?.debug("unread.skip", { sid: id, reason: "same-state" });
    }
    return { worktreePath, activity: next };
  }

  /**
   * Whether a session was attached at some point during its current `working`
   * stretch. The staleness sweep consults this to gate synthetic demotion: a
   * purely-detached `working` block is almost certainly still working and is
   * left alone. Unknown sessions read as never-attached.
   */
  attachedDuringWorking(id: string): boolean {
    return this.actors.get(id)?.wasAttachedDuringWorking() ?? false;
  }

  /**
   * Feed a transcript-growth liveness signal into a session's activity block
   * (the agent keeps appending to its main or a subagent transcript while
   * thinking or streaming long output, even when no hook events fire):
   * - a `working` block has its freshness timestamp refreshed in place (no
   *   transition, no publish);
   * - a soft `stale` idle (the staleness sweep's guess) is resurrected back to
   *   `working` through the reducer, publishing the transition via an `updated`
   *   lifecycle event so clients refetch;
   * - a hard hook-`stop` idle and an `awaiting-input` block are left untouched
   *   (trailing summary/title records after a real stop must not resume it, and
   *   the pending question itself is written to the transcript).
   */
  refreshAgentActivity(id: string, at: string): void {
    const actor = this.actors.get(id);
    const block = actor?.getAgentActivity();
    if (!actor || !block) return;
    if (block.state === "working") {
      block.lastEventAt = at;
      return;
    }
    if (block.state === "idle" && block.idleKind === "stale") {
      const next = reduceAgentActivity(block, this.livenessEvent(block.agent, at));
      if (next && next !== block) {
        actor.setAgentActivity(next);
        actor.emitActivityUpdated(at);
        this.log?.debug("transcript.resurrect", {
          sid: id,
          from: activityLabel(block),
          to: activityLabel(next),
        });
      }
    }
  }

  /** Synthetic `heartbeat` event used to resurrect a soft staleness idle. */
  private livenessEvent(agent: string, at: string): AgentActivityEvent {
    return {
      v: AGENT_ACTIVITY_PROTOCOL_VERSION,
      eventId: "",
      agent,
      event: "heartbeat",
      agentSessionId: "",
      cwd: "",
      at,
      severity: "info",
    };
  }

  /**
   * Replace or clear a session's derived transcript telemetry block. Returns
   * false when the session is unknown (callers use this to drop bindings).
   */
  applyAgentTelemetry(id: string, telemetry: AgentTelemetry | undefined): boolean {
    const actor = this.actors.get(id);
    if (!actor) return false;
    actor.setAgentTelemetry(telemetry);
    return true;
  }

  /**
   * Persist (or clear) a session's transcript-telemetry binding through the
   * backend so it survives a daemon restart. No-op for an unknown session or a
   * backend without cross-restart persistence. Failures are swallowed and
   * logged, never failing the in-memory telemetry state (mirrors `persistTitle`
   * / `persistUnread`).
   */
  persistTranscriptBinding(
    id: string,
    binding: TerminalTranscriptBinding | undefined,
  ): void {
    const actor = this.actors.get(id);
    if (!actor) return;
    actor.persistTranscriptBinding(binding);
  }

  async attach(id: string, options: AttachmentOptions): Promise<TerminalAttachmentSummary> {
    const actor = this.actors.get(id);
    if (!actor) {
      throw new TerminalSessionManagerError("not-found", `terminal session ${id} not found`);
    }
    if (!this.perfLog) return actor.attach(options);
    return this.perfLog.span("attach", id, () => actor.attach(options), {
      sid: id,
    });
  }

  async detach(id: string, attachmentId: string, reason?: string): Promise<void> {
    const actor = this.actors.get(id);
    if (!actor) return;
    await actor.detach(attachmentId, reason);
  }

  async input(id: string, attachmentId: string, data: string): Promise<void> {
    const actor = this.actors.get(id);
    if (!actor) {
      throw new TerminalSessionManagerError("not-found", `terminal session ${id} not found`);
    }
    await actor.input(attachmentId, data);
  }

  async resize(id: string, attachmentId: string, cols: number, rows: number): Promise<void> {
    const actor = this.actors.get(id);
    if (!actor) {
      throw new TerminalSessionManagerError("not-found", `terminal session ${id} not found`);
    }
    await actor.resize(attachmentId, cols, rows);
  }

  async ack(id: string, attachmentId: string, seq: number): Promise<void> {
    const actor = this.actors.get(id);
    if (!actor) return;
    await actor.ack(attachmentId, seq);
  }

  async requestControl(id: string, attachmentId: string): Promise<void> {
    const actor = this.actors.get(id);
    if (!actor) return;
    await actor.requestControl(attachmentId);
  }

  async releaseControl(id: string, attachmentId: string): Promise<void> {
    const actor = this.actors.get(id);
    if (!actor) return;
    await actor.releaseControl(attachmentId);
  }

  async terminate(id: string, signal?: string): Promise<void> {
    const actor = this.actors.get(id);
    if (!actor) {
      throw new TerminalSessionManagerError("not-found", `terminal session ${id} not found`);
    }
    await actor.terminate(signal);
  }

  /**
   * Set or clear a session's user title. `title` is normalized and validated
   * (trim, control-character + length checks); `null` / empty clears it. The
   * session's lifecycle, attachments, replay, and control ownership are
   * untouched. Returns the authoritative snapshot after the change.
   *
   * Throws `validation` for an invalid title, `not-found` for an unknown id,
   * and `persistence` when a restorable backend fails to persist the title
   * (in which case the previous title is preserved).
   */
  async rename(id: string, title: string | null): Promise<TerminalSessionMetadata> {
    const actor = this.actors.get(id);
    if (!actor) {
      throw new TerminalSessionManagerError("not-found", `terminal session ${id} not found`);
    }
    let normalized: string | undefined;
    try {
      normalized = normalizeTerminalTitle(title);
    } catch (e) {
      if (e instanceof TerminalTitleValidationError) {
        throw new TerminalSessionManagerError("validation", e.message);
      }
      throw e;
    }
    try {
      await actor.setTitle(normalized);
    } catch (e) {
      throw new TerminalSessionManagerError(
        "persistence",
        `failed to persist terminal title: ${(e as Error).message}`,
      );
    }
    return actor.snapshot();
  }

  /**
   * Set or clear an agent-sourced title. Used by the agent-activity ingest
   * pipeline, which owns the precedence policy (it never calls this over a
   * user-sourced title). `title` must already be normalized. Best-effort:
   * persistence failures and unknown ids are swallowed — an auto-title must
   * never surface an error to a plugin.
   */
  async setAgentTitle(id: string, title: string | undefined): Promise<void> {
    const actor = this.actors.get(id);
    if (!actor) return;
    try {
      await actor.setTitle(title, "agent");
    } catch {
      /* best-effort */
    }
  }

  /** Stop every session and clear state. Used by daemon shutdown. */
  async shutdown(): Promise<void> {
    const actors = Array.from(this.actors.values());
    this.actors.clear();
    await Promise.all(
      actors.map(async (actor) => {
        try {
          await actor.shutdown();
        } catch {
          /* swallow — shutdown is best-effort */
        }
      }),
    );
  }

  /** Remove an exited session from the registry. */
  remove(id: string): void {
    this.actors.delete(id);
  }

  private forwardLifecycle(event: TerminalLifecycleEvent): void {
    if (event.type === "exited" || event.type === "removed") {
      // Keep exited sessions visible briefly so clients can fetch final state.
      // The current snapshot API contract treats `exited` as a transient state
      // that should still appear in listings; the manager keeps the actor in
      // the map and lets external callers `remove()` when appropriate.
    }
    if (this.opts.onLifecycle) {
      try {
        this.opts.onLifecycle(event);
      } catch {
        /* ignore */
      }
    }
  }

  private resolveExistingDir(input: string, field: string): string {
    const resolved = this.safeResolve(input);
    if (!existsSync(resolved)) {
      throw new TerminalSessionManagerError(
        "cwd-invalid",
        `${field} ${resolved} does not exist`,
      );
    }
    try {
      const stat = statSync(resolved);
      if (!stat.isDirectory()) {
        throw new TerminalSessionManagerError(
          "cwd-invalid",
          `${field} ${resolved} is not a directory`,
        );
      }
    } catch (e) {
      if (e instanceof TerminalSessionManagerError) throw e;
      throw new TerminalSessionManagerError(
        "cwd-invalid",
        `${field} ${resolved} could not be stat'd: ${(e as Error).message}`,
      );
    }
    return resolved;
  }

  private resolveWithinWorktree(worktreeRoot: string, cwd: string): string {
    const candidate = this.resolveExistingDir(cwd, "cwd");
    const root = this.realpathOrSame(worktreeRoot);
    const child = this.realpathOrSame(candidate);
    if (!isPathInside(root, child) && root !== child) {
      throw new TerminalSessionManagerError(
        "cwd-invalid",
        `cwd ${cwd} escapes worktree ${worktreeRoot}`,
      );
    }
    return candidate;
  }

  private realpathOrSame(p: string): string {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  }

  private safeResolve(p: string): string {
    return resolve(p);
  }
}

/**
 * Placeholder PTY runtime for actors that adopt a pre-created backend
 * transport. The actor never calls `spawn` on this when a transport is
 * supplied; the no-op runtime keeps the actor's existing option shape
 * (which requires a `runtime` reference) without forcing every backend
 * adapter to expose a low-level `TerminalRuntime`.
 */
function noopRuntime(name: string): TerminalRuntime {
  return {
    name: `${name}-noop`,
    isAvailable() {
      return true;
    },
    spawn() {
      throw new TerminalRuntimeUnavailableError(
        `terminal backend ${name} cannot spawn through the runtime port; backend.createSession owns transport creation`,
      );
    },
  };
}

/**
 * Copy every string-valued entry of a base environment verbatim. Used for the
 * explicit-program path (`docker compose exec`), which supplies a complete
 * replacement environment that must reach the spawned process unchanged.
 */
function collectEnv(base: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(base)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function clampDim(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const v = Math.floor(value);
  if (v <= 0) return fallback;
  if (v > 1000) return 1000;
  return v;
}

function isPathInside(root: string, child: string): boolean {
  if (root === child) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return child.startsWith(prefix);
}

/** `state` plus its idle provenance, e.g. `idle/stop`, for transition logs. */
function activityLabel(block: AgentActivityBlock | null | undefined): string {
  if (!block) return "none";
  return block.idleKind ? `${block.state}/${block.idleKind}` : block.state;
}

/**
 * Whether a block is in a "result is waiting" state that marks a detached
 * session unread: a genuine hook-driven `stop` idle or `awaiting-input`. The
 * staleness sweep's soft `stale` idle does not qualify.
 */
function isUnreadQualifying(block: AgentActivityBlock): boolean {
  return (
    (block.state === "idle" && block.idleKind === "stop") ||
    block.state === "awaiting-input"
  );
}
