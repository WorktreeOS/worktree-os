/**
 * Ingest pipeline for agent activity events reported by agent-side plugins
 * (packages/plugin-claude, packages/plugin-opencode).
 *
 * Plugins POST `AgentActivityEvent` payloads to `/ui/v1/agent-events`,
 * authenticated with a per-daemon-run bearer token that the daemon injects
 * into every spawned PTY as `WOS_AGENT_TOKEN` (alongside `WOS_DAEMON_URL`
 * and `WOS_TERMINAL_SESSION_ID`).
 *
 * The pipeline validates, dedups on `eventId`, resolves the event to a
 * terminal session (env binding) or a worktree (cwd fallback), applies the
 * derived state machine, and publishes `agent.activity.changed`. Events that
 * cannot be attributed are accepted and dropped — a plugin must never see an
 * agent-visible error for a daemon-side attribution miss.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  AGENT_ACTIVITY_PROTOCOL_VERSION,
  type AgentActivityEvent,
  DEFAULT_AGENT_ACTIVITY_TTL_MS,
  isAgentActivityStale,
  reduceAgentActivity,
  STALE_DEMOTION_EVENT,
  validateAgentActivityEvent,
} from "@worktreeos/core/agent-activity";
import { wosHome } from "@worktreeos/core/paths";

import type { DaemonEventBus } from "./event-bus";
import type { DaemonLogger, ModuleLogger } from "./logger";
import type { TerminalSessionManager } from "./terminal-layer/manager";
import type {
  TranscriptAgent,
  TranscriptTelemetryReader,
} from "./terminal-layer/transcript-telemetry";
import { normalizeTerminalTitle } from "./terminal-layer/title";

export const AGENT_TOKEN_FILENAME = "agent-token";

/**
 * pi config directory for binding-path derivation. Defaults to `~/.pi`; honors
 * `PI_CONFIG_DIR` (parallel to the install-path resolution in
 * `agent-plugin-install.ts`) so tests and custom installs can redirect it.
 */
function piConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CONFIG_DIR
    ? resolve(env.PI_CONFIG_DIR)
    : resolve(homedir(), ".pi");
}

/**
 * Deterministic pi sessions directory for a cwd. pi encodes the project path by
 * joining its non-empty path segments with `-` and wrapping the result in
 * `--…--` under `<pi-config>/agent/sessions/` — e.g.
 * `/Users/x/.wos/proj` → `--Users-x-.wos-proj--` (note: the leading separator
 * is dropped, so it is a segment join, not a literal `/`→`-` replace).
 */
export function piSessionsDirForCwd(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const encoded = `--${cwd.split(/[\\/]/).filter(Boolean).join("-")}--`;
  return resolve(piConfigDir(env), "agent", "sessions", encoded);
}

/**
 * Resolve a pi session's JSONL by its session id. pi names session files
 * `<timestamp>_<sessionId>.jsonl`, so the id maps to exactly one file. Returns
 * undefined when the directory is missing/unreadable or no file matches (e.g.
 * pi has not written its lazily-created file yet). The D3 fallback used when a
 * pi `session_start` event carries no `transcriptPath`; keyed by id rather than
 * "newest file" so it can never latch onto an unrelated session.
 */
export async function findPiSessionFileById(
  cwd: string,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (!sessionId) return undefined;
  const dir = piSessionsDirForCwd(cwd, env);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  const suffix = `_${sessionId}.jsonl`;
  const match = names.find((name) => name.endsWith(suffix));
  return match ? join(dir, match) : undefined;
}

/** Path of the persisted agent token inside the wos home directory. */
export function agentTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(wosHome(env), AGENT_TOKEN_FILENAME);
}

/**
 * Return the persisted agent token, generating and persisting a fresh one
 * (with owner-only permissions) only when none exists yet. Reusing the token
 * across daemon runs keeps `WOS_AGENT_TOKEN` valid in PTY sessions that
 * outlive a daemon restart.
 */
export function createAndPersistAgentToken(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path = agentTokenPath(env);
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) return existing;
  } catch {
    // No persisted token yet — generate one below.
  }
  const token = randomBytes(32).toString("hex");
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, token + "\n", { mode: 0o600 });
  // writeFileSync mode is ignored when the file already exists.
  chmodSync(path, 0o600);
  return token;
}

const DEDUP_CAPACITY = 512;

/** How often the staleness sweep runs. */
export const STALENESS_SWEEP_INTERVAL_MS = 15_000;

export interface AgentActivityIngestOptions {
  /** Bearer token required on every request. */
  token: string;
  /** Terminal-layer manager; absent when terminal sessions are disabled. */
  terminalLayer?: TerminalSessionManager;
  /** Unified event bus for `agent.activity.changed`. */
  events?: DaemonEventBus;
  /**
   * Resolve a cwd to a managed worktree path for events that carry no
   * terminal session binding. Return null when the cwd is not inside a
   * managed worktree.
   */
  resolveWorktreePath?: (cwd: string) => Promise<string | null>;
  /**
   * Daemon file logger. Drives event-ingest, attribution, title, and
   * staleness-sweep diagnostics; a no-op when logging is disabled.
   */
  logger?: DaemonLogger;
  /** Transcript telemetry reader; bound on session_start events. */
  transcriptTelemetry?: TranscriptTelemetryReader;
}

export class AgentActivityIngest {
  private readonly opts: AgentActivityIngestOptions;
  /** Insertion-ordered set of recently seen eventIds (bounded LRU). */
  private readonly seenEventIds = new Set<string>();
  /**
   * Per-worktree activity for events attributed via the cwd fallback. Not
   * session-bound; published on the bus but never written to a session.
   */
  private readonly worktreeActivity = new Map<
    string,
    ReturnType<typeof reduceAgentActivity>
  >();
  /** Periodic staleness-sweep timer; null when the sweep is not running. */
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** `agent-activity` module logger for ingest / attribution / title. */
  private readonly log: ModuleLogger | undefined;
  /** `staleness-sweep` module logger for demote / skip diagnostics. */
  private readonly sweepLog: ModuleLogger | undefined;

  constructor(opts: AgentActivityIngestOptions) {
    this.opts = opts;
    this.log = opts.logger?.module("agent-activity");
    this.sweepLog = opts.logger?.module("staleness-sweep");
  }

  /**
   * Start the periodic staleness sweep that demotes interrupted `working`
   * blocks to `idle`. Idempotent. The timer is `unref`'d so it never keeps
   * the process alive on its own.
   */
  startStalenessSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      this.sweepStaleActivity();
    }, STALENESS_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  /** Stop the periodic staleness sweep (daemon shutdown). */
  stopStalenessSweep(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** Resolved staleness TTL: `WOS_AGENT_ACTIVITY_TTL_MS` or the default. */
  private staleTtlMs(): number {
    const raw = process.env.WOS_AGENT_ACTIVITY_TTL_MS;
    const parsed = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_AGENT_ACTIVITY_TTL_MS;
  }

  /**
   * Demote stale `working` blocks to a soft `stale` idle, publishing
   * `agent.activity.changed` for each. Recovers a turn interrupted with no
   * `stop` event (e.g. Esc in Claude Code) — but only on a session that was
   * attended (attached) during this `working` stretch, since Esc needs a human
   * at the keyboard. A purely-detached `working` block is almost certainly
   * still working (thinking, a long tool, or waiting on a subagent) and is left
   * alone. The synthetic demotion is soft: any later liveness signal resurrects
   * it, and it never marks the session unread. `awaiting-input` and `idle` are
   * untouched. Exposed (with an injectable clock) so tests can drive it
   * deterministically.
   */
  sweepStaleActivity(now: number = Date.now()): void {
    const ttl = this.staleTtlMs();

    // Session-bound activity lives on the terminal-layer actors; route a
    // synthetic staleness demotion through the manager so the same reducer
    // produces the soft idle block, then publish with the session's real
    // attribution.
    const manager = this.opts.terminalLayer;
    if (manager) {
      for (const meta of manager.list()) {
        if (!isAgentActivityStale(meta.agentActivity, now, ttl)) continue;
        // Attachment-gate: never demote a stretch that was never attended.
        if (!manager.attachedDuringWorking(meta.id)) {
          this.sweepLog?.debug("skip", { sid: meta.id, reason: "never-attended" });
          continue;
        }
        const synthetic = this.staleDemotionEvent(meta.agentActivity!.agent, meta.id, now);
        const applied = manager.applyAgentActivity(meta.id, synthetic);
        if (applied?.activity) {
          this.sweepLog?.debug("demote", {
            sid: meta.id,
            to: applied.activity.state,
          });
          this.publish(synthetic, applied.worktreePath, meta.id, applied.activity);
        }
      }
    }

    // Worktree-fallback activity carries no terminal session and therefore no
    // attachment history — it can never have been attended, so under the same
    // attachment-gating model it is treated as never-attached and is never
    // demoted by staleness. It clears only on a real `stop` event, a new
    // `prompt_submit`, or a daemon restart.
  }

  /**
   * Synthetic staleness-demotion event used to demote a stale `working` block
   * via the reducer. Distinct from a hook `stop`: the reducer maps it to a
   * soft, resurrectable `stale` idle that never marks the session unread.
   */
  private staleDemotionEvent(
    agent: string,
    key: string,
    now: number,
  ): AgentActivityEvent {
    const at = new Date(now).toISOString();
    return {
      v: AGENT_ACTIVITY_PROTOCOL_VERSION,
      eventId: `stale-${key}-${now}`,
      agent,
      event: STALE_DEMOTION_EVENT,
      agentSessionId: "",
      cwd: "",
      at,
      severity: "info",
    };
  }

  /** Handle `POST /ui/v1/agent-events`. */
  async handle(req: Request): Promise<Response> {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${this.opts.token}`) {
      return json(401, { error: "unauthorized" });
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "body must be JSON" });
    }
    const result = validateAgentActivityEvent(body);
    if (!result.ok) {
      return json(400, { error: result.error });
    }
    const event = result.event;

    if (this.seenEventIds.has(event.eventId)) {
      return json(200, { ok: true, deduplicated: true });
    }
    this.rememberEventId(event.eventId);

    await this.apply(event);
    return json(200, { ok: true });
  }

  private async apply(event: AgentActivityEvent): Promise<void> {
    // Heartbeats are high-frequency and uninteresting unless chasing a problem,
    // so all their diagnostics drop to `trace`; every other event logs at
    // `debug`.
    const level: "trace" | "debug" =
      event.event === "heartbeat" ? "trace" : "debug";
    this.log?.[level]("ingest", {
      agent: event.agent,
      event: event.event,
      eventId: event.eventId,
      ...(event.terminalSessionId ? { sid: event.terminalSessionId } : {}),
      cwd: event.cwd,
    });

    // Primary binding: terminal session id injected at PTY spawn.
    if (event.terminalSessionId && this.opts.terminalLayer) {
      await this.bindTranscript(event);
      await this.applyTitle(event);
      const applied = this.opts.terminalLayer.applyAgentActivity(
        event.terminalSessionId,
        event,
      );
      if (applied) {
        this.log?.[level]("attribution", {
          eventId: event.eventId,
          target: "session",
          sid: event.terminalSessionId,
        });
        if (applied.activity) {
          this.publish(
            event,
            applied.worktreePath,
            event.terminalSessionId,
            applied.activity,
          );
        }
        return; // session known; no transition → nothing to publish
      }
    }

    // Fallback: attribute to the worktree containing the cwd; never claims
    // a specific terminal session.
    const worktreePath = await this.resolveWorktree(event.cwd);
    if (!worktreePath) {
      this.log?.[level]("attribution", {
        eventId: event.eventId,
        target: "dropped",
        reason: "no-worktree",
        cwd: event.cwd,
      });
      return;
    }
    this.log?.[level]("attribution", {
      eventId: event.eventId,
      target: "worktree",
      worktreePath,
    });
    const previous = this.worktreeActivity.get(worktreePath) ?? null;
    const next = reduceAgentActivity(previous, event);
    if (next === previous) return;
    this.worktreeActivity.set(worktreePath, next);
    if (next) this.publish(event, worktreePath, undefined, next);
  }

  /**
   * Bind (or rebind) the session's transcript for telemetry. The reader's
   * `bind()` is idempotent for the same path and rebinds on a different one, so
   * latest-path wins and `/clear`, `/resume`, `/compact` rebind automatically.
   *
   * claude/codex carry the transcript path on their `session_start` hook, so
   * they bind only there. pi creates its session file lazily (after the first
   * assistant reply), so the path is absent at `session_start`; the pi extension
   * therefore reports `getSessionFile()` on every event, and pi (re)binds
   * whenever an event carries a `transcriptPath` — correcting a startup bind
   * that fell back to the cwd directory scan (design D3) onto a stale file.
   */
  private async bindTranscript(event: AgentActivityEvent): Promise<void> {
    const reader = this.opts.transcriptTelemetry;
    if (!reader || !event.terminalSessionId) return;
    // Tag the binding with the originating agent so the reader selects the
    // right parser (codex rollout / pi JSONL / claude transcript).
    const agent: TranscriptAgent =
      event.agent === "codex"
        ? "codex"
        : event.agent === "pi"
          ? "pi"
          : "claude";
    const detail = event.detail as Record<string, unknown> | undefined;
    const source = typeof detail?.source === "string" ? detail.source : undefined;
    const detailPath =
      typeof detail?.transcriptPath === "string" && detail.transcriptPath !== ""
        ? detail.transcriptPath
        : undefined;
    // Exact context window the agent reports for the model (pi), preferred over
    // the static per-model lookup.
    const contextWindow =
      typeof detail?.contextWindow === "number" && detail.contextWindow > 0
        ? detail.contextWindow
        : undefined;

    if (agent === "pi") {
      // The pi extension reports `getSessionFile()` on every event, so bind on
      // ANY pi event that carries a path (not just session_start) — pi rebinds
      // on `/new`, `/fork`, `/resume` mid-run, and latest-path wins.
      let transcriptPath = detailPath;
      // Last resort (no path on the event): resolve the session's own file by
      // its id (`<ts>_<sessionId>.jsonl`). Only attempted at session_start — a
      // heartbeat with no path must not scan every few seconds. Keyed by id, so
      // it binds the right file or nothing, never an unrelated session.
      if (!transcriptPath && event.event === "session_start") {
        transcriptPath = await findPiSessionFileById(
          event.cwd,
          event.agentSessionId,
        );
      }
      if (!transcriptPath) return;
      reader.bind(
        event.terminalSessionId,
        transcriptPath,
        event.agentSessionId,
        source,
        undefined,
        { agent, ...(contextWindow ? { contextWindow } : {}) },
      );
      this.log?.debug("transcript.bind", {
        sid: event.terminalSessionId,
        source: source ?? event.event,
        agent,
        path: basename(transcriptPath),
      });
      return;
    }

    // claude / codex: bind only on session_start carrying a path.
    if (event.event !== "session_start" || !detailPath) return;
    const model = typeof detail?.model === "string" ? detail.model : undefined;
    reader.bind(
      event.terminalSessionId,
      detailPath,
      event.agentSessionId,
      source,
      undefined,
      { agent, ...(model ? { model } : {}) },
    );
    this.log?.debug("transcript.bind", {
      sid: event.terminalSessionId,
      source: source ?? "session_start",
      agent,
      path: basename(detailPath),
    });
  }

  /**
   * Auto-title policy (hybrid): a `prompt_submit` title names only an
   * untitled session; a `stop` title (the agent's transcript summary) also
   * upgrades an existing agent-sourced title; a user-sourced title is never
   * replaced; `session_start` clears a stale agent-sourced title so a fresh
   * agent run starts unnamed. When the transcript reader has seen an
   * AI-generated title (`ai-title` record) for the session, hook-derived
   * titles defer to it entirely. Invalid titles are dropped silently —
   * titles are best-effort and must never fail event ingestion.
   */
  private async applyTitle(event: AgentActivityEvent): Promise<void> {
    const manager = this.opts.terminalLayer;
    const sessionId = event.terminalSessionId;
    if (!manager || !sessionId) return;
    const current = manager.get(sessionId);
    if (!current) return;

    if (event.event === "session_start") {
      if (current.title && current.titleSource === "agent") {
        await manager.setAgentTitle(sessionId, undefined);
      }
      return;
    }
    if (event.event !== "prompt_submit" && event.event !== "stop") return;
    if (!event.title) return;
    if (this.opts.transcriptTelemetry?.aiTitle(sessionId)) {
      this.log?.debug("title.skip", { sid: sessionId, reason: "ai-title" });
      return;
    }
    let normalized: string | undefined;
    try {
      normalized = normalizeTerminalTitle(event.title);
    } catch {
      this.log?.debug("title.skip", { sid: sessionId, reason: "invalid" });
      return;
    }
    if (!normalized) return;
    if (current.title) {
      if (current.titleSource !== "agent") {
        this.log?.debug("title.skip", { sid: sessionId, reason: "user-sourced" });
        return;
      }
      if (event.event === "prompt_submit") {
        this.log?.debug("title.skip", { sid: sessionId, reason: "prompt-submit-existing" });
        return;
      }
    }
    await manager.setAgentTitle(sessionId, normalized);
    this.log?.debug("title.apply", { sid: sessionId, event: event.event });
  }

  private publish(
    event: AgentActivityEvent,
    worktreePath: string,
    terminalSessionId: string | undefined,
    activity: NonNullable<ReturnType<typeof reduceAgentActivity>>,
  ): void {
    this.opts.events?.publish(
      {
        type: "agent.activity.changed",
        ...(terminalSessionId ? { terminalSessionId } : {}),
        worktreePath,
        activity,
        source: {
          eventId: event.eventId,
          agent: event.agent,
          event: event.event,
          severity: event.severity,
          ...(event.summary ? { summary: event.summary } : {}),
        },
      },
      { worktreePath },
    );
  }

  private async resolveWorktree(cwd: string): Promise<string | null> {
    if (!cwd || !this.opts.resolveWorktreePath) return null;
    try {
      return await this.opts.resolveWorktreePath(cwd);
    } catch {
      return null;
    }
  }

  private rememberEventId(eventId: string): void {
    this.seenEventIds.add(eventId);
    if (this.seenEventIds.size > DEDUP_CAPACITY) {
      const oldest = this.seenEventIds.values().next().value;
      if (oldest !== undefined) this.seenEventIds.delete(oldest);
    }
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
