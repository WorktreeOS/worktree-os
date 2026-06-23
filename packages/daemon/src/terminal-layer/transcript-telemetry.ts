/**
 * Claude Code JSONL transcript telemetry reader.
 *
 * Binds transcript files to terminal sessions ("hook gives the key, JSONL
 * gives the data"): the `SessionStart` hook event carries `transcriptPath`
 * and `source`, and this reader tails the bound file, deriving per-session
 * model/token/context telemetry published on session metadata, plus the
 * session's AI-generated title (`ai-title` records) applied as the
 * agent-sourced terminal title.
 *
 * Reading is tolerant by contract: unknown record types and fields are
 * ignored, lines that fail JSON parsing are retried from the same offset on
 * the next read, and a missing or unreadable file degrades to "no telemetry"
 * — never to a session error. The reader is strictly read-only over
 * transcript files.
 */

import { watch, type FSWatcher } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  type AgentTelemetry,
  contextWindowForModel,
} from "@worktreeos/core/agent-activity";

import type { TerminalSessionManager } from "./manager";
import type { DaemonLogger, ModuleLogger } from "../logger";
import {
  MAX_TERMINAL_TITLE_LENGTH,
  normalizeTerminalTitle,
} from "./title";

/** Fallback poll interval covering fs.watch gaps. */
const DEFAULT_POLL_INTERVAL_MS = 2_000;
/** Minimum interval between published telemetry updates per session. */
const DEFAULT_DEBOUNCE_MS = 1_000;

/** Agent family of a bound transcript, selecting its parser. */
export type TranscriptAgent = "claude" | "codex" | "pi";

/** Per-binding agent + fallback model carried from the `session_start` event. */
export interface BindOptions {
  agent?: TranscriptAgent;
  /** Codex fallback model (from `detail.model`) until `session_meta` is read. */
  model?: string;
  /**
   * Exact context window the agent reports for the active model (pi supplies it
   * via `detail.contextWindow`). Preferred over the static per-model lookup.
   */
  contextWindow?: number;
}

/** Cumulative usage tally for one transcript file. */
interface FileTail {
  path: string;
  /** Byte offset of the next unread position. */
  offset: number;
  /**
   * Claude: accumulated output + cache-creation tokens across assistant
   * records (per-record summation). Codex: the latest cumulative main-token
   * total (output + reasoning), overwritten rather than summed.
   */
  spentTokens: number;
}

interface TranscriptBinding {
  terminalSessionId: string;
  agentSessionId: string;
  /** Originating agent; selects the Claude vs Codex parser. */
  agent: TranscriptAgent;
  main: FileTail;
  /** Subagent transcript tails keyed by file path. */
  subagents: Map<string, FileTail>;
  /** Spent tokens carried over from pre-compact transcripts. */
  mainCarry: number;
  subagentCarry: number;
  /** Latest derived state. */
  model?: string;
  contextUsed: number;
  /**
   * Codex: the context window the rollout reports for the model
   * (`token_count.info.model_context_window`). Preferred over the static
   * per-model lookup when present; absent for Claude and providers that omit it.
   */
  contextWindow?: number;
  /** Latest AI-generated session title from `ai-title` records. */
  aiTitle?: string;
  /** Last aiTitle pushed to the manager, to avoid redundant writes. */
  appliedAiTitle?: string;
  watcher: FSWatcher | null;
  /** Last time telemetry was published (ms epoch); 0 = never. */
  lastPublishedAt: number;
  /** Pending debounce timer for a publish. */
  publishTimer: ReturnType<typeof setTimeout> | null;
  /** Serializes reads per binding. */
  reading: boolean;
  /** A read was requested while one was running. */
  rereadRequested: boolean;
}

export interface TranscriptTelemetryOptions {
  terminalLayer: TerminalSessionManager;
  pollIntervalMs?: number;
  debounceMs?: number;
  now?: () => number;
  debugLog?: (message: string) => void;
  /** Daemon file logger; drives `transcript` ai-title diagnostics. */
  logger?: DaemonLogger;
}

export class TranscriptTelemetryReader {
  private readonly opts: TranscriptTelemetryOptions;
  private readonly bindings = new Map<string, TranscriptBinding>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** `transcript` module logger. */
  private readonly log: ModuleLogger | undefined;

  constructor(opts: TranscriptTelemetryOptions) {
    this.opts = opts;
    this.log = opts.logger?.module("transcript");
  }

  /**
   * Bind (or rebind) a terminal session to a transcript file. Latest bind
   * wins. A `compact` rebind carries the previous binding's spent totals
   * forward; any other source starts totals from the new file alone. The
   * restore path passes `seedCarry` to seed the compact-carry totals from a
   * persisted record on a fresh reader (no `previous` in memory).
   *
   * After establishing the binding it is persisted through the manager so it
   * survives a daemon restart; the same-path early-return leaves the existing
   * persisted record untouched.
   */
  bind(
    terminalSessionId: string,
    transcriptPath: string,
    agentSessionId: string,
    source?: string,
    seedCarry?: { mainCarry: number; subagentCarry: number },
    options?: BindOptions,
  ): void {
    const previous = this.bindings.get(terminalSessionId);
    if (previous && previous.main.path === transcriptPath) {
      // Same file: a later event may carry the model's window now that it was
      // absent at the first bind (pi's `ctx.model` is unset until the model is
      // selected). Refresh it so the meter stops showing the lookup default.
      if (
        options?.contextWindow &&
        options.contextWindow !== previous.contextWindow
      ) {
        previous.contextWindow = options.contextWindow;
        this.schedulePublish(previous);
      }
      void this.read(previous);
      return;
    }
    const agent = options?.agent ?? "claude";
    let mainCarry = seedCarry?.mainCarry ?? 0;
    let subagentCarry = seedCarry?.subagentCarry ?? 0;
    if (previous) {
      if (source === "compact") {
        mainCarry = previous.mainCarry + previous.main.spentTokens;
        subagentCarry =
          previous.subagentCarry + subagentTotal(previous.subagents);
      }
      this.dispose(previous);
    }
    const binding: TranscriptBinding = {
      terminalSessionId,
      agentSessionId,
      agent,
      main: { path: transcriptPath, offset: 0, spentTokens: 0 },
      subagents: new Map(),
      mainCarry,
      subagentCarry,
      // Codex reports the model from session_meta; until then fall back to the
      // model carried on the session_start event.
      ...(options?.model ? { model: options.model } : {}),
      // pi reports the exact window per model; preferred over the lookup.
      ...(options?.contextWindow ? { contextWindow: options.contextWindow } : {}),
      contextUsed: 0,
      watcher: null,
      lastPublishedAt: 0,
      publishTimer: null,
      reading: false,
      rereadRequested: false,
    };
    this.bindings.set(terminalSessionId, binding);
    this.persistBinding(binding);
    // A rebind to a different transcript (new session, /clear, compact) must
    // replace the previously published telemetry immediately — the new file
    // has no assistant records yet, so no read-driven publish would fire. A
    // fresh codex bind that already knows its model (seeded from the
    // session_start event) publishes too, so the telemetry block — model +
    // context window — appears even when the rollout never yields token usage
    // (some Codex providers report `token_count` with no usage payload).
    if (previous || binding.model) this.publish(binding);
    binding.watcher = this.tryWatch(binding);
    this.ensurePolling();
    void this.read(binding);
  }

  /** Remove a session's binding and clear its telemetry block. */
  unbind(terminalSessionId: string): void {
    const binding = this.bindings.get(terminalSessionId);
    if (!binding) return;
    this.dispose(binding);
    this.bindings.delete(terminalSessionId);
    this.opts.terminalLayer.persistTranscriptBinding(terminalSessionId, undefined);
    this.opts.terminalLayer.applyAgentTelemetry(terminalSessionId, undefined);
    if (this.bindings.size === 0) this.stopPolling();
  }

  /** Stop all watchers and timers (daemon shutdown). */
  stop(): void {
    for (const binding of this.bindings.values()) this.dispose(binding);
    this.bindings.clear();
    this.stopPolling();
  }

  /**
   * Latest AI-generated title seen in the session's transcript, if any.
   * The ingest pipeline consults this so hook-derived titles defer to it.
   */
  aiTitle(terminalSessionId: string): string | undefined {
    return this.bindings.get(terminalSessionId)?.aiTitle;
  }

  /** Trigger reads on all bindings (poll fallback; exposed for tests). */
  async pollOnce(): Promise<void> {
    for (const binding of [...this.bindings.values()]) {
      // Drop bindings whose terminal session is gone.
      if (!this.opts.terminalLayer.get(binding.terminalSessionId)) {
        this.unbind(binding.terminalSessionId);
        continue;
      }
      await this.read(binding);
    }
  }

  // ---------- internals ----------

  /**
   * Persist the binding key + compact-carry totals through the manager so a
   * daemon restart can re-bind and recompute telemetry. Best-effort: the
   * manager swallows and logs write failures.
   */
  private persistBinding(binding: TranscriptBinding): void {
    this.opts.terminalLayer.persistTranscriptBinding(
      binding.terminalSessionId,
      {
        path: binding.main.path,
        agentSessionId: binding.agentSessionId,
        mainCarry: binding.mainCarry,
        subagentCarry: binding.subagentCarry,
        agent: binding.agent,
      },
    );
  }

  private dispose(binding: TranscriptBinding): void {
    binding.watcher?.close();
    binding.watcher = null;
    if (binding.publishTimer) {
      clearTimeout(binding.publishTimer);
      binding.publishTimer = null;
    }
  }

  private tryWatch(binding: TranscriptBinding): FSWatcher | null {
    try {
      const watcher = watch(binding.main.path, () => {
        void this.read(binding);
      });
      watcher.unref?.();
      return watcher;
    } catch {
      return null; // file may not exist yet; the poll covers it
    }
  }

  private ensurePolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, this.opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  private stopPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async read(binding: TranscriptBinding): Promise<void> {
    if (binding.reading) {
      binding.rereadRequested = true;
      return;
    }
    binding.reading = true;
    try {
      do {
        binding.rereadRequested = false;
        const changed = await this.readOnce(binding);
        if (changed) this.schedulePublish(binding);
      } while (binding.rereadRequested);
    } finally {
      binding.reading = false;
    }
  }

  /** One read pass, dispatched to the agent's parser. */
  private async readOnce(binding: TranscriptBinding): Promise<boolean> {
    if (binding.agent === "codex") return this.readCodexOnce(binding);
    if (binding.agent === "pi") return this.readPiOnce(binding);
    return this.readClaudeOnce(binding);
  }

  /**
   * One read pass over a Codex rollout JSONL. Tokens are cumulative per session,
   * so the reader takes the **latest** `token_count` total (overwrite, not sum)
   * — the inverse of the Claude per-record accumulation. Model comes from a
   * `session_meta` record, falling back to the `session_start` model already
   * seeded on the binding. Codex has no subagent transcripts in scope and no
   * `ai-title` records. Tolerant: unknown records/shapes are ignored.
   */
  private async readCodexOnce(binding: TranscriptBinding): Promise<boolean> {
    let changed = false;
    let appended = false;
    if (!binding.watcher) binding.watcher = this.tryWatch(binding);

    for (const line of await readAppendedLines(binding.main)) {
      appended = true;
      const model = parseCodexModel(line);
      if (model && model !== binding.model) {
        binding.model = model;
        changed = true;
      }
      const usage = parseCodexTokenCount(line);
      if (usage) {
        // Cumulative "latest wins": overwrite with the newest totals.
        if (usage.mainTokens !== binding.main.spentTokens) {
          binding.main.spentTokens = usage.mainTokens;
          changed = true;
        }
        if (usage.contextUsed !== binding.contextUsed) {
          binding.contextUsed = usage.contextUsed;
          changed = true;
        }
        // The rollout carries the model's real context window; prefer it over
        // the static per-model lookup.
        if (usage.contextWindow && usage.contextWindow !== binding.contextWindow) {
          binding.contextWindow = usage.contextWindow;
          changed = true;
        }
      }
    }
    if (appended) {
      this.opts.terminalLayer.refreshAgentActivity(
        binding.terminalSessionId,
        new Date((this.opts.now ?? Date.now)()).toISOString(),
      );
    }
    return changed;
  }

  /** One read pass over the Claude main file and subagent files. */
  private async readClaudeOnce(binding: TranscriptBinding): Promise<boolean> {
    let changed = false;
    let appended = false;
    // A watcher may have failed at bind time (file not created yet) — retry.
    if (!binding.watcher) binding.watcher = this.tryWatch(binding);

    for (const line of await readAppendedLines(binding.main)) {
      appended = true;
      const aiTitle = parseAiTitleRecord(line);
      if (aiTitle && aiTitle !== binding.aiTitle) {
        binding.aiTitle = aiTitle;
        changed = true;
      }
      const record = parseAssistantRecord(line);
      if (!record) continue;
      binding.main.spentTokens += record.spent;
      if (!record.isSidechain) {
        if (record.model) binding.model = record.model;
        // Synthetic records (interrupts, errors) carry an all-zero usage
        // block — never let them clobber the real context size.
        if (record.contextUsed > 0) binding.contextUsed = record.contextUsed;
      }
      changed = true;
    }

    for (const tail of await this.discoverSubagents(binding)) {
      for (const line of await readAppendedLines(tail)) {
        appended = true;
        const record = parseAssistantRecord(line);
        if (!record) continue;
        tail.spentTokens += record.spent;
        changed = true;
      }
    }
    // Any transcript growth (including subagent transcripts and non-assistant
    // records) proves the agent is alive: it refreshes a live `working` block's
    // freshness (preventing a staleness demotion during long generation
    // stretches with no hook events) and resurrects a soft staleness `idle`
    // back to `working` — the signal that un-sticks a session falsely demoted
    // while the main agent waited on a subagent. A hard hook-`stop` idle and an
    // `awaiting-input` block are left untouched by `refreshAgentActivity`.
    if (appended) {
      this.opts.terminalLayer.refreshAgentActivity(
        binding.terminalSessionId,
        new Date((this.opts.now ?? Date.now)()).toISOString(),
      );
    }
    return changed;
  }

  /**
   * One read pass over a pi JSONL session file. pi records per-assistant-message
   * usage (like Claude, unlike Codex's cumulative "latest wins"), so `spent`
   * (`output + cacheWrite`) is **summed** into `main.spentTokens`, while
   * `contextUsed` (`input + cacheRead + cacheWrite`) is taken from the **latest**
   * assistant record. pi branches within a single file (no separate subagent
   * transcripts), so `subagentTokens` stays 0. Tolerant: unknown records/shapes
   * are ignored.
   */
  private async readPiOnce(binding: TranscriptBinding): Promise<boolean> {
    let changed = false;
    let appended = false;
    if (!binding.watcher) binding.watcher = this.tryWatch(binding);

    for (const line of await readAppendedLines(binding.main)) {
      appended = true;
      const record = parsePiAssistantRecord(line);
      if (!record) continue;
      binding.main.spentTokens += record.spent;
      if (record.model) binding.model = record.model;
      // Context tracks the latest assistant record (not a sum across records).
      binding.contextUsed = record.contextUsed;
      changed = true;
    }
    if (appended) {
      this.opts.terminalLayer.refreshAgentActivity(
        binding.terminalSessionId,
        new Date((this.opts.now ?? Date.now)()).toISOString(),
      );
    }
    return changed;
  }

  /**
   * Subagent transcripts live under `<dir>/<agent-session-id>/subagents/`
   * next to the main transcript. Missing directory means no subagents.
   */
  private async discoverSubagents(
    binding: TranscriptBinding,
  ): Promise<FileTail[]> {
    const sessionDirName =
      binding.agentSessionId || basename(binding.main.path, ".jsonl");
    const dir = join(dirname(binding.main.path), sessionDirName, "subagents");
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [...binding.subagents.values()];
    }
    for (const name of names) {
      if (!name.startsWith("agent-") || !name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      if (!binding.subagents.has(path)) {
        binding.subagents.set(path, { path, offset: 0, spentTokens: 0 });
      }
    }
    return [...binding.subagents.values()];
  }

  private schedulePublish(binding: TranscriptBinding): void {
    if (binding.publishTimer) return;
    const now = this.opts.now ?? Date.now;
    const debounce = this.opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const wait = Math.max(0, binding.lastPublishedAt + debounce - now());
    binding.publishTimer = setTimeout(() => {
      binding.publishTimer = null;
      binding.lastPublishedAt = now();
      this.publish(binding);
    }, wait);
    binding.publishTimer.unref?.();
  }

  private publish(binding: TranscriptBinding): void {
    const telemetry: AgentTelemetry = {
      ...(binding.model ? { model: binding.model } : {}),
      mainTokens: binding.mainCarry + binding.main.spentTokens,
      subagentTokens: binding.subagentCarry + subagentTotal(binding.subagents),
      contextUsed: binding.contextUsed,
      contextWindow: binding.contextWindow ?? contextWindowForModel(binding.model),
      updatedAt: new Date((this.opts.now ?? Date.now)()).toISOString(),
    };
    const applied = this.opts.terminalLayer.applyAgentTelemetry(
      binding.terminalSessionId,
      telemetry,
    );
    if (!applied) {
      this.unbind(binding.terminalSessionId);
      return;
    }
    this.applyAiTitle(binding);
  }

  /**
   * Push the latest transcript-derived title to the manager as an
   * agent-sourced title. A user-sourced title is never replaced; invalid
   * titles are dropped silently (titles are best-effort).
   */
  private applyAiTitle(binding: TranscriptBinding): void {
    const title = binding.aiTitle;
    if (!title || title === binding.appliedAiTitle) return;
    const current = this.opts.terminalLayer.get(binding.terminalSessionId);
    if (!current) return;
    if (current.title && current.titleSource !== "agent") return;
    let normalized: string | undefined;
    try {
      normalized = normalizeTerminalTitle(
        title.slice(0, MAX_TERMINAL_TITLE_LENGTH),
      );
    } catch {
      return;
    }
    if (!normalized) return;
    binding.appliedAiTitle = title;
    this.log?.debug("ai-title", {
      sid: binding.terminalSessionId,
      title: normalized,
    });
    void this.opts.terminalLayer.setAgentTitle(
      binding.terminalSessionId,
      normalized,
    );
  }
}

function subagentTotal(subagents: Map<string, FileTail>): number {
  let total = 0;
  for (const tail of subagents.values()) total += tail.spentTokens;
  return total;
}

/**
 * Read complete appended lines from `tail.path` starting at `tail.offset`,
 * advancing the offset past consumed lines only. A trailing partial line is
 * left unconsumed so the next read retries it. Errors yield no lines.
 */
async function readAppendedLines(tail: FileTail): Promise<string[]> {
  let size: number;
  try {
    size = (await stat(tail.path)).size;
  } catch {
    return [];
  }
  // Truncated/replaced file (e.g. recreated transcript): start over.
  if (size < tail.offset) {
    tail.offset = 0;
    tail.spentTokens = 0;
  }
  if (size === tail.offset) return [];
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(tail.path, "r");
  } catch {
    return [];
  }
  try {
    const length = size - tail.offset;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, tail.offset);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline === -1) return []; // only a partial line so far
    // Advance by the byte length of the consumed prefix (not its UTF-16
    // string length) so multi-byte characters do not skew the offset.
    const consumed = text.slice(0, lastNewline + 1);
    tail.offset += Buffer.byteLength(consumed, "utf8");
    return consumed.split("\n").filter((line) => line.trim() !== "");
  } catch {
    return [];
  } finally {
    await handle.close();
  }
}

/**
 * Parse one transcript line into its AI-generated session title, or null for
 * any other record type or shape. Cheap substring pre-check avoids a JSON
 * parse on the (vast) majority of lines.
 */
function parseAiTitleRecord(line: string): string | null {
  if (!line.includes('"ai-title"')) return null;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof record !== "object" || record === null) return null;
  const r = record as Record<string, unknown>;
  if (r.type !== "ai-title") return null;
  return typeof r.aiTitle === "string" && r.aiTitle.trim() !== ""
    ? r.aiTitle
    : null;
}

interface AssistantUsageRecord {
  model?: string;
  isSidechain: boolean;
  /** output + cache-creation tokens of this record. */
  spent: number;
  /** input + cache-read + cache-creation tokens of this record. */
  contextUsed: number;
}

/**
 * Parse one transcript line into an assistant usage record. Returns null for
 * non-assistant records, records without usage, malformed JSON, and any
 * unexpected shape — unknown content is never an error.
 */
function parseAssistantRecord(line: string): AssistantUsageRecord | null {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof record !== "object" || record === null) return null;
  const r = record as Record<string, unknown>;
  if (r.type !== "assistant") return null;
  const message = r.message as Record<string, unknown> | undefined;
  if (typeof message !== "object" || message === null) return null;
  const usage = message.usage as Record<string, unknown> | undefined;
  if (typeof usage !== "object" || usage === null) return null;
  const num = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  const rawModel = message.model;
  const model =
    typeof rawModel === "string" && rawModel !== "" && rawModel !== "<synthetic>"
      ? rawModel
      : undefined;
  return {
    ...(model ? { model } : {}),
    isSidechain: r.isSidechain === true,
    spent: num(usage.output_tokens) + num(usage.cache_creation_input_tokens),
    contextUsed:
      num(usage.input_tokens) +
      num(usage.cache_read_input_tokens) +
      num(usage.cache_creation_input_tokens),
  };
}

/** Usage derived from one pi assistant record. */
export interface PiAssistantUsage {
  model?: string;
  /** output + cacheWrite tokens of this record. */
  spent: number;
  /** input + cacheRead + cacheWrite tokens of this record. */
  contextUsed: number;
}

/**
 * Parse one pi JSONL line into an assistant usage record, or null for any other
 * record type / shape. pi writes one record per entry as
 * `{ type: "message", message: { role, model, usage: { input, output, cacheRead,
 * cacheWrite } } }`; only `role: "assistant"` records carry usage. Any missing
 * usage sub-field counts as 0; malformed JSON, non-message records, user
 * messages, and unknown shapes degrade to null — never an error.
 */
export function parsePiAssistantRecord(line: string): PiAssistantUsage | null {
  if (!line.includes('"assistant"')) return null;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof record !== "object" || record === null) return null;
  const r = record as Record<string, unknown>;
  if (r.type !== "message") return null;
  const message =
    typeof r.message === "object" && r.message !== null
      ? (r.message as Record<string, unknown>)
      : undefined;
  if (!message || message.role !== "assistant") return null;
  const usageRaw = message.usage as Record<string, unknown> | undefined;
  if (typeof usageRaw !== "object" || usageRaw === null) return null;
  const n = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  const rawModel = message.model;
  const model =
    typeof rawModel === "string" && rawModel !== "" ? rawModel : undefined;
  return {
    ...(model ? { model } : {}),
    spent: n(usageRaw.output) + n(usageRaw.cacheWrite),
    contextUsed: n(usageRaw.input) + n(usageRaw.cacheRead) + n(usageRaw.cacheWrite),
  };
}

/** Token totals derived from one Codex `token_count` record. */
export interface CodexTokenUsage {
  /**
   * Main-agent "spent" tokens, mirroring Claude (output + cache-creation):
   * cumulative `output_tokens` (reasoning already included) plus the uncached
   * input (`input_tokens` − `cached_input_tokens`). Cached input is the cheap
   * cache-read equivalent and is excluded.
   */
  mainTokens: number;
  /**
   * Current context-window occupancy: `last_token_usage.total_tokens` (input,
   * which already includes `cached_input_tokens`, plus output of the last turn).
   * The cumulative `total_token_usage` must NOT be used — its input grows every
   * turn and quickly exceeds the window.
   */
  contextUsed: number;
  /** Model context window (`model_context_window`) when the record carries it. */
  contextWindow?: number;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Parse one Codex rollout line (`{timestamp,type,payload}`) into its
 * `token_count` totals, or null for any other record / shape. Recognizes
 * `type:"event_msg"` with `payload.type:"token_count"`. Reads two distinct
 * usages, each tolerant to either nesting (`payload.*` or `payload.info.*`):
 *
 * - `total_token_usage` — cumulative session totals (grow monotonically across
 *   turns) → the "spent" counter.
 * - `last_token_usage` — the latest turn only → current context-window
 *   occupancy. Using the cumulative total here is wrong: its `input_tokens`
 *   accumulates every turn and quickly dwarfs the window (e.g. a session showing
 *   839k "used" against a 353k window).
 *
 * The context window comes from `model_context_window` on whichever object
 * carries it. Missing sub-fields count as 0. The Codex rollout format is
 * documented as unstable, so any unexpected shape degrades to null rather than
 * erroring. (Some providers emit `token_count` with a null `info`/no totals —
 * that yields null here, so the session reports no token telemetry.)
 */
export function parseCodexTokenCount(line: string): CodexTokenUsage | null {
  if (!line.includes('"token_count"')) return null;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof record !== "object" || record === null) return null;
  const r = record as Record<string, unknown>;
  if (r.type !== "event_msg") return null;
  const payload = r.payload as Record<string, unknown> | undefined;
  if (typeof payload !== "object" || payload === null) return null;
  if (payload.type !== "token_count") return null;
  const info = payload.info as Record<string, unknown> | undefined;
  const obj = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  const totals = obj(payload.total_token_usage) ?? obj(info?.total_token_usage);
  const last = obj(payload.last_token_usage) ?? obj(info?.last_token_usage);
  if (!totals && !last) return null;
  const contextWindow =
    num(info?.model_context_window) || num(payload.model_context_window);
  return {
    // Mirror Claude's "spent" (output + cache-creation): generated output plus
    // the *uncached* input the model had to process. `output_tokens` already
    // includes `reasoning_output_tokens`; `cached_input_tokens` ⊆ `input_tokens`
    // is the cheap cache-read equivalent and is excluded.
    mainTokens:
      num(totals?.output_tokens) +
      Math.max(0, num(totals?.input_tokens) - num(totals?.cached_input_tokens)),
    // `total_tokens` = input (incl. cached) + output of the last turn. Never sum
    // `input_tokens` + `cached_input_tokens`: the latter is a subset of the
    // former.
    contextUsed: num(last?.total_tokens),
    ...(contextWindow > 0 ? { contextWindow } : {}),
  };
}

/**
 * Parse one Codex rollout line into its model id, or null for any other
 * record / shape. Real Codex (0.141.0) records the model on `turn_context`
 * records (`payload.model`); its `session_meta` carries only `model_provider`,
 * not the model. Both record types are accepted for tolerance across versions.
 */
export function parseCodexModel(line: string): string | null {
  if (!line.includes('"turn_context"') && !line.includes('"session_meta"')) {
    return null;
  }
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof record !== "object" || record === null) return null;
  const r = record as Record<string, unknown>;
  if (r.type !== "turn_context" && r.type !== "session_meta") return null;
  const payload = r.payload as Record<string, unknown> | undefined;
  if (typeof payload !== "object" || payload === null) return null;
  const model = payload.model;
  return typeof model === "string" && model.length > 0 ? model : null;
}
