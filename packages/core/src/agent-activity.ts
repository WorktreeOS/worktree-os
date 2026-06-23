/**
 * Agent activity contract shared between agent-side plugins
 * (packages/plugin-claude, packages/plugin-opencode), the daemon ingest
 * endpoint, and UI consumers.
 *
 * Plugins are dumb translators: they map host-specific hooks/events onto
 * `AgentActivityEvent` and POST it to the daemon. The daemon owns the
 * interpretation (the derived `AgentActivityBlock` state machine).
 *
 * Validation is hand-rolled and deliberately tolerant: unknown `agent`
 * values and unknown extra fields are accepted so newer plugins keep
 * working against older daemons and vice versa.
 */

/** Protocol version this revision of the schema describes. */
export const AGENT_ACTIVITY_PROTOCOL_VERSION = 1;

/** Maximum length for human-readable summary fields. */
export const AGENT_ACTIVITY_SUMMARY_MAX = 200;

/** Maximum length for the proposed terminal session title. */
export const AGENT_ACTIVITY_TITLE_MAX = 80;

/** Agent families with first-party plugins. Unknown values are accepted. */
export type KnownActivityAgent = "claude" | "opencode";

/** Event kinds that drive the derived state machine. */
export const AGENT_ACTIVITY_EVENT_KINDS = [
  "session_start",
  "prompt_submit",
  "stop",
  "question_asked",
  "permission_request",
  "permission_replied",
  "heartbeat",
] as const;

/**
 * Default staleness TTL: a `working` block with no event for this long is
 * demoted to `idle`. Overridable via `WOS_AGENT_ACTIVITY_TTL_MS`.
 */
export const DEFAULT_AGENT_ACTIVITY_TTL_MS = 180_000;

/**
 * Internal event kind the daemon's staleness sweep stamps on its synthetic
 * demotion. The reducer maps it to a soft, resurrectable `stale` idle (never
 * marks a session unread), distinct from a hook-driven `stop` (a hard, sticky
 * idle). Real plugins never emit it; it is sweep-internal and is never
 * validated or sent on the wire.
 */
export const STALE_DEMOTION_EVENT = "stale_stop";

export type AgentActivityEventKind =
  (typeof AGENT_ACTIVITY_EVENT_KINDS)[number];

export type AgentActivitySeverity = "info" | "needs-attention";

/** Optional structured detail accompanying an event. */
export interface AgentActivityDetail {
  /** Truncated user query (prompt_submit / stop). */
  query?: string;
  /** Tool involved in the event (question_asked / permission_request). */
  toolName?: string;
  /** Session transcript path for telemetry binding (claude / codex / pi). */
  transcriptPath?: string;
  /**
   * Exact context window the agent reports for the active model, in tokens.
   * Preferred over the static per-model lookup. pi supplies it from
   * `ctx.model.contextWindow` / `ctx.getContextUsage()` (it is multi-provider,
   * so the lookup cannot cover every model).
   */
  contextWindow?: number;
  /** Additional adapter-specific fields are preserved as-is. */
  [key: string]: unknown;
}

/** One activity event emitted by an agent-side plugin. */
export interface AgentActivityEvent {
  /** Protocol version. */
  v: number;
  /** Unique per emission; the daemon dedups on it. */
  eventId: string;
  /** Agent family, e.g. "claude" / "opencode". Unknown values allowed. */
  agent: string;
  /** Event kind. Unknown kinds are accepted but do not affect state. */
  event: string;
  /** The agent's own session id. */
  agentSessionId: string;
  /** Daemon terminal session id from WOS_TERMINAL_SESSION_ID, when known. */
  terminalSessionId?: string;
  /** Working directory of the agent process. */
  cwd: string;
  /** ISO timestamp of the emission. */
  at: string;
  /** Coarse class so generic consumers can filter without agent knowledge. */
  severity: AgentActivitySeverity;
  /** Human-readable summary, pre-truncated to AGENT_ACTIVITY_SUMMARY_MAX. */
  summary?: string;
  /**
   * Proposed display title for the bound terminal session, pre-truncated to
   * AGENT_ACTIVITY_TITLE_MAX. The daemon applies it under agent-title
   * precedence rules (never over a user-set title).
   */
  title?: string;
  detail?: AgentActivityDetail;
  /** Unknown extra fields are preserved for forward compatibility. */
  [key: string]: unknown;
}

/** Derived per-session activity state maintained by the daemon. */
export type AgentActivityState = "working" | "idle" | "awaiting-input";

/**
 * Provenance of an `idle` block. A `stop` idle is produced by a real hook
 * `stop` event and is hard/sticky (only a new `prompt_submit` resumes it,
 * and it marks the session unread when detached). A `stale` idle is produced
 * by the staleness sweep's synthetic demotion and is soft/resurrectable (any
 * liveness signal resumes `working`, and it never marks the session unread).
 * Undefined for non-idle blocks.
 */
export type AgentActivityIdleKind = "stop" | "stale";

/** Pending question/permission recorded while a session awaits input. */
export interface AgentActivityQuestion {
  summary: string;
  askedAt: string;
}

/**
 * Derived activity block stored on terminal session metadata while an agent
 * with an activity-reporting plugin is active in the session.
 */
export interface AgentActivityBlock {
  state: AgentActivityState;
  /**
   * Provenance of an `idle` state: `stop` (hard, hook-driven) vs `stale`
   * (soft, staleness-sweep-driven). Absent for `working` / `awaiting-input`
   * and cleared whenever the block (re)enters `working`.
   */
  idleKind?: AgentActivityIdleKind;
  /** Agent family that produced the latest event. */
  agent: string;
  /** Kind of the event that caused the latest transition. */
  lastEvent: string;
  /** Pending question/permission while state is `awaiting-input`. */
  question?: AgentActivityQuestion;
  /** Last submitted user query, when reported. */
  lastQuery?: string;
  /** ISO timestamp of the latest state transition. */
  at: string;
  /**
   * ISO timestamp of the latest event of any kind (including `heartbeat`)
   * that touched this block. Drives staleness demotion; refreshed even when
   * no state transition occurs.
   */
  lastEventAt: string;
}

export interface AgentActivityValidationOk {
  ok: true;
  event: AgentActivityEvent;
}

export interface AgentActivityValidationError {
  ok: false;
  error: string;
}

export type AgentActivityValidationResult =
  | AgentActivityValidationOk
  | AgentActivityValidationError;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Validate an incoming payload as an `AgentActivityEvent`.
 *
 * Tolerant by design: unknown `agent` / `event` values and extra fields
 * pass through. Only structurally required fields are enforced.
 */
export function validateAgentActivityEvent(
  input: unknown,
): AgentActivityValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "payload must be a JSON object" };
  }
  const obj = input as Record<string, unknown>;

  if (typeof obj.v !== "number" || !Number.isInteger(obj.v) || obj.v < 1) {
    return { ok: false, error: "`v` must be a positive integer" };
  }
  for (const field of ["eventId", "agent", "event", "agentSessionId", "at"]) {
    if (!isNonEmptyString(obj[field])) {
      return { ok: false, error: `\`${field}\` must be a non-empty string` };
    }
  }
  if (typeof obj.cwd !== "string") {
    return { ok: false, error: "`cwd` must be a string" };
  }
  if (obj.severity !== "info" && obj.severity !== "needs-attention") {
    return {
      ok: false,
      error: '`severity` must be "info" or "needs-attention"',
    };
  }
  if (obj.terminalSessionId !== undefined && typeof obj.terminalSessionId !== "string") {
    return { ok: false, error: "`terminalSessionId` must be a string" };
  }
  if (obj.summary !== undefined && typeof obj.summary !== "string") {
    return { ok: false, error: "`summary` must be a string" };
  }
  if (obj.title !== undefined && typeof obj.title !== "string") {
    return { ok: false, error: "`title` must be a string" };
  }
  if (
    obj.detail !== undefined &&
    (typeof obj.detail !== "object" ||
      obj.detail === null ||
      Array.isArray(obj.detail))
  ) {
    return { ok: false, error: "`detail` must be an object" };
  }

  const event = obj as AgentActivityEvent;
  if (event.summary && event.summary.length > AGENT_ACTIVITY_SUMMARY_MAX) {
    event.summary = event.summary.slice(0, AGENT_ACTIVITY_SUMMARY_MAX);
  }
  if (event.title && event.title.length > AGENT_ACTIVITY_TITLE_MAX) {
    event.title = event.title.slice(0, AGENT_ACTIVITY_TITLE_MAX);
  }
  return { ok: true, event };
}

/** Truncate a summary-like string to the protocol limit. */
export function truncateActivitySummary(
  text: string,
  max: number = AGENT_ACTIVITY_SUMMARY_MAX,
): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Apply one event to the previous derived block, returning the next block.
 * Unknown event kinds return the previous block unchanged (or null when no
 * block exists yet). The caller is responsible for clearing the block when
 * the agent process exits.
 */
export function reduceAgentActivity(
  previous: AgentActivityBlock | null,
  event: AgentActivityEvent,
): AgentActivityBlock | null {
  const base = {
    agent: event.agent,
    lastEvent: event.event,
    at: event.at,
    lastEventAt: event.at,
    lastQuery: previous?.lastQuery,
  };
  // Synthetic staleness demotion (sweep-internal): only a `working` block is
  // demoted, to a soft `stale` idle that any later liveness signal can
  // resurrect. It never carries the `stop` provenance, so it never marks a
  // session unread downstream.
  if (event.event === STALE_DEMOTION_EVENT) {
    if (!previous || previous.state !== "working") return previous;
    return { ...base, state: "idle", idleKind: "stale" };
  }
  switch (event.event as AgentActivityEventKind) {
    case "session_start":
      return { ...base, state: previous?.state ?? "idle" };
    case "prompt_submit":
      return {
        ...base,
        state: "working",
        lastQuery: event.detail?.query ?? event.summary ?? previous?.lastQuery,
      };
    case "stop":
      // A real hook `stop` is a hard idle: sticky, and unread-eligible.
      return { ...base, state: "idle", idleKind: "stop" };
    case "question_asked":
    case "permission_request":
      return {
        ...base,
        state: "awaiting-input",
        question: {
          summary: event.summary ?? "Agent is waiting for your input",
          askedAt: event.at,
        },
      };
    case "permission_replied":
      return { ...base, state: "working" };
    case "heartbeat":
      // A heartbeat means the agent just executed a tool, so it is actively
      // working — not blocked waiting for input.
      if (!previous) {
        // No prior block (e.g. the in-memory block was lost to a daemon
        // restart while the agent kept working): bootstrap a fresh `working`
        // block. A `heartbeat` maps to a `post-tool-use` (or subagent-stop)
        // hook, which fires only while a tool is actually executing, so it is
        // unambiguous evidence the agent is working — safe to (re)establish
        // `working` from nothing. This is the only liveness path that may
        // create a block from null: transcript-growth refresh stays gated on an
        // existing block in the daemon, because trailing summary/title records
        // are appended after a real `stop` and would falsely resurrect it.
        return { ...base, state: "working" };
      }
      if (previous.state === "awaiting-input") {
        // While awaiting-input the agent runs no tools, so the first tool
        // execution after the user answered is the resume signal: return to
        // `working`, clearing the pending question (via `base`) and publishing
        // the transition.
        return { ...base, state: "working" };
      }
      if (previous.state === "idle" && previous.idleKind === "stale") {
        // A soft staleness idle was a guess; any real liveness signal
        // resurrects it back to `working` (publish the transition, clearing
        // the stale provenance via `base`).
        return { ...base, state: "working" };
      }
      // Otherwise liveness only (a `working` block, or a hard hook-`stop` idle
      // that stays sticky): refresh freshness on the existing block in place
      // and return the SAME reference so callers treat it as a non-transition
      // (no publish). State and last query are untouched.
      previous.lastEventAt = event.at;
      return previous;
    default:
      return previous;
  }
}

/**
 * Whether a `working` block has gone stale: no event (of any kind, including
 * `heartbeat`) has refreshed it within `ttlMs`. Only `working` expires —
 * `idle` and `awaiting-input` never do.
 */
export function isAgentActivityStale(
  block: AgentActivityBlock | null | undefined,
  nowMs: number,
  ttlMs: number,
): boolean {
  if (!block || block.state !== "working") return false;
  const last = Date.parse(block.lastEventAt);
  return Number.isFinite(last) && nowMs - last > ttlMs;
}

/**
 * Default / Claude context window in tokens. Claude Code transcripts do not
 * record the window and the model id carries no `[1m]` marker, so the daemon
 * reports a flat 1M window for Claude (see the claude-jsonl-telemetry design).
 * Also the safe default for any model not in {@link contextWindowForModel}.
 */
export const AGENT_TELEMETRY_CONTEXT_WINDOW = 1_048_576;

/**
 * Per-model context window lookup, expressed as data (an ordered list of
 * `[pattern, window]`) rather than control flow so a new model id is a one-line
 * addition. The first matching pattern wins; an unmatched model falls back to
 * {@link AGENT_TELEMETRY_CONTEXT_WINDOW}. Claude reports the flat 1M window;
 * Codex/GPT models report their own windows.
 */
const MODEL_CONTEXT_WINDOWS: ReadonlyArray<readonly [RegExp, number]> = [
  [/claude/i, AGENT_TELEMETRY_CONTEXT_WINDOW],
  // GPT-5 family (incl. gpt-5-codex) — 400k token context window.
  [/gpt-5|codex/i, 400_000],
  // GPT-4.1 family — 1,047,576 token context window.
  [/gpt-4\.1/i, 1_047_576],
  // No speculative non-Anthropic/non-OpenAI guesses here: pi is multi-provider
  // and reports the *exact* window per model (`ctx.model.contextWindow` /
  // `ctx.getContextUsage().contextWindow`), threaded onto the binding via
  // `detail.contextWindow`, which the readers prefer over this lookup. Anything
  // unmatched falls back to the safe 1M default below — an honest approximation
  // rather than a wrong specific number (e.g. deepseek-v4-pro is 1M, not 128k).
];

/**
 * Context window for `model`, defaulting to the safe 1M window for an unknown
 * or absent model. Keyed by the session's model id (carried on every Codex
 * event and read from the Claude transcript), this is the single source of the
 * reported `contextWindow` for both readers.
 */
export function contextWindowForModel(model: string | undefined): number {
  if (!model) return AGENT_TELEMETRY_CONTEXT_WINDOW;
  for (const [pattern, window] of MODEL_CONTEXT_WINDOWS) {
    if (pattern.test(model)) return window;
  }
  return AGENT_TELEMETRY_CONTEXT_WINDOW;
}

/**
 * Derived token/model telemetry for an agent session, read by the daemon
 * from the agent's transcript (Claude Code JSONL). Carried as the optional
 * `agentTelemetry` block on terminal session metadata while a transcript is
 * bound to the session.
 */
export interface AgentTelemetry {
  /** Model id of the latest non-sidechain assistant record. */
  model?: string;
  /** Cumulative output + cache-creation tokens of the main agent. */
  mainTokens: number;
  /** Cumulative output + cache-creation tokens across subagent transcripts. */
  subagentTokens: number;
  /** Context usage of the latest main-transcript assistant record. */
  contextUsed: number;
  /** Assumed context window size in tokens. */
  contextWindow: number;
  /** ISO timestamp telemetry was last derived. */
  updatedAt: string;
}
