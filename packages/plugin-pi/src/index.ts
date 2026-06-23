/**
 * WorktreeOS pi extension.
 *
 * Subscribes to pi lifecycle hooks and reports agent activity to the wos daemon
 * as AgentActivityEvent payloads (see packages/core/src/agent-activity.ts).
 * Delivery is fire-and-forget. The extension emits NO `permission_request` /
 * `question_asked` events (deferred scope): pi auto-runs its tools, so a pi
 * session reports working/idle but never `awaiting-input` through this plugin.
 *
 * The structural types below mirror only the parts of pi's `ExtensionAPI` /
 * `ExtensionContext` this plugin touches, so the package carries no external
 * dependency. The default export is the factory pi loads:
 *   export default (pi) => { pi.on(<event>, handler) }
 *
 * pi's `SessionStartEvent` does NOT carry the current session file (only a
 * `reason` and the *previous* session file), so the session JSONL path — needed
 * to bind transcript telemetry — is read from
 * `ctx.sessionManager.getSessionFile()` instead, alongside `getSessionId()` and
 * `ctx.cwd`. pi assigns the path up front, so these getters return a value from
 * `session_start` onward (the file itself is written lazily, after the first
 * assistant reply). The getters are real methods that read `this`, so they are
 * invoked bound to the session manager; every accessor is guarded so an API
 * shape change degrades to less telemetry and never throws or alters pi.
 */

import type { AgentActivityEvent } from "@worktreeos/core/agent-activity";
import { buildActivityEvent } from "./payload";
import { sendActivityEvent } from "./send";

/** Structural subset of pi's `ReadonlySessionManager` we read. */
interface PiSessionManager {
  getSessionFile?: () => string | undefined;
  getSessionId?: () => string | undefined;
  getCwd?: () => string | undefined;
}

/** Structural subset of pi's `ExtensionAPI` we register against. */
export interface PiExtensionApi {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): unknown;
}

type Bag = Record<string, unknown>;

function bag(value: unknown): Bag | undefined {
  return typeof value === "object" && value !== null ? (value as Bag) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/**
 * Invoke a named zero-arg getter ON its receiver, preserving `this`, returning a
 * non-empty string or undefined. pi's `ReadonlySessionManager` getters read
 * `this.sessionFile` / `this.sessionId` / `this.cwd` internally, so they MUST be
 * called as methods — a detached `fn()` would throw on `this` being undefined.
 * Any throw (missing/renamed accessor included) degrades to undefined.
 */
function callGetter(
  sm: PiSessionManager | undefined,
  name: "getSessionFile" | "getSessionId" | "getCwd",
): string | undefined {
  const fn = sm?.[name];
  if (typeof fn !== "function") return undefined;
  try {
    return str(fn.call(sm));
  } catch {
    return undefined;
  }
}

function sessionManagerOf(ctx: unknown): PiSessionManager | undefined {
  return bag(bag(ctx)?.sessionManager) as PiSessionManager | undefined;
}

/** Current session JSONL path (`ctx.sessionManager.getSessionFile()`). */
function transcriptPathOf(ctx: unknown): string | undefined {
  return callGetter(sessionManagerOf(ctx), "getSessionFile");
}

/** Current agent session id (`ctx.sessionManager.getSessionId()`). */
function sessionIdOf(ctx: unknown): string | undefined {
  return callGetter(sessionManagerOf(ctx), "getSessionId");
}

/** Working directory: `ctx.cwd`, then the session manager, then a fallback. */
function cwdOf(ctx: unknown, fallback?: string): string {
  return (
    str(bag(ctx)?.cwd) ??
    callGetter(sessionManagerOf(ctx), "getCwd") ??
    fallback ??
    process.cwd()
  );
}

/**
 * Exact context window (tokens) pi reports for the active model. pi is
 * multi-provider, so the daemon's static per-model lookup cannot cover every
 * model; the model object carries the real window (`ctx.model.contextWindow`),
 * with `ctx.getContextUsage().contextWindow` as a fallback. undefined when
 * neither is available (the daemon then falls back to its lookup).
 */
function contextWindowOf(ctx: unknown): number | undefined {
  const c = bag(ctx);
  const fromModel = num(bag(c?.model)?.contextWindow);
  if (fromModel) return fromModel;
  const usageFn = c?.getContextUsage;
  if (typeof usageFn !== "function") return undefined;
  try {
    return num(bag((usageFn as () => unknown).call(ctx))?.contextWindow);
  } catch {
    return undefined;
  }
}

export interface WosPiHandlersDeps {
  /** Delivery override (tests). Defaults to the fire-and-forget sender. */
  send?: (event: AgentActivityEvent) => void;
  /** Fallback cwd when neither ctx nor the session manager carry one. */
  cwd?: string;
}

/**
 * Build the pi hook handlers. Exported separately so tests can inject a `send`
 * spy and drive each handler without a network. Every handler is wrapped so a
 * malformed event/ctx degrades to less telemetry and never throws.
 */
export function createPiHandlers(deps: WosPiHandlersDeps = {}) {
  const send = deps.send ?? sendActivityEvent;

  /**
   * Report an event, always carrying the current session JSONL path when the
   * session manager exposes one. pi assigns the session file path up front (so
   * `getSessionFile()` returns it immediately) but writes the file lazily, only
   * after the first assistant reply. Carrying the path on every event lets the
   * daemon bind it right away — the reader waits for the file to appear — and
   * rebind when pi switches sessions (`/new`, `/fork`, `/resume`) mid-run.
   */
  function report(
    kind: string,
    ctx: unknown,
    extraDetail?: Record<string, unknown>,
    options?: Omit<NonNullable<Parameters<typeof buildActivityEvent>[3]>, "detail">,
  ): void {
    const transcriptPath = transcriptPathOf(ctx);
    const contextWindow = contextWindowOf(ctx);
    const detail: Record<string, unknown> = { ...extraDetail };
    if (transcriptPath) detail.transcriptPath = transcriptPath;
    if (contextWindow) detail.contextWindow = contextWindow;
    send(
      buildActivityEvent(kind, sessionIdOf(ctx), cwdOf(ctx, deps.cwd), {
        ...options,
        ...(Object.keys(detail).length > 0 ? { detail } : {}),
      }),
    );
  }

  function safe(fn: () => void): void {
    try {
      fn();
    } catch {
      // best-effort by contract: never throw, block pi, or alter pi behavior.
    }
  }

  return {
    /** pi `session_start` → `session_start` (binds the transcript). */
    session_start(event?: unknown, ctx?: unknown): void {
      safe(() => {
        const source = str(bag(event)?.reason);
        report("session_start", ctx, source ? { source } : undefined);
      });
    },

    /** pi `before_agent_start` → `prompt_submit` (working; rebinds the file). */
    before_agent_start(event?: unknown, ctx?: unknown): void {
      safe(() => {
        const prompt = str(bag(event)?.prompt);
        if (!prompt) return;
        report("prompt_submit", ctx, { query: prompt }, { summary: prompt });
      });
    },

    /** pi `agent_end` → `stop` (idle; rebinds the now-written file). */
    agent_end(_event?: unknown, ctx?: unknown): void {
      safe(() => report("stop", ctx));
    },

    /** pi `tool_execution_end` / `turn_end` → `heartbeat` (working liveness). */
    heartbeat(_event?: unknown, ctx?: unknown): void {
      safe(() => report("heartbeat", ctx));
    },
  };
}

/** Plugin entry point loaded by pi. */
export default function register(pi: PiExtensionApi): void {
  const handlers = createPiHandlers();
  pi.on("session_start", (event, ctx) => handlers.session_start(event, ctx));
  pi.on("before_agent_start", (event, ctx) =>
    handlers.before_agent_start(event, ctx),
  );
  pi.on("agent_end", (event, ctx) => handlers.agent_end(event, ctx));
  // Working-liveness: `tool_execution_end` is preferred, with `turn_end` as a
  // fallback for pi builds that do not emit it. Both map to `heartbeat`;
  // duplicate heartbeats only refresh liveness, so registering both is safe.
  pi.on("tool_execution_end", (event, ctx) => handlers.heartbeat(event, ctx));
  pi.on("turn_end", (event, ctx) => handlers.heartbeat(event, ctx));
}
