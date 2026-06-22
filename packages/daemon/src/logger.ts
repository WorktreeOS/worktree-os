/**
 * Opt-in, leveled, file-based daemon logger.
 *
 * The daemon detaches with `stdout`/`stderr` ignored, so `console.*` is lost in
 * normal operation. This logger writes JSON-lines records to a file instead,
 * gated entirely by `<wos-home>/config.json` `logging`. It is disabled by
 * default: when `cfg.enabled` is false `createDaemonLogger` returns a no-op
 * whose methods return immediately and whose `span()` simply awaits its
 * callback — no file handle is opened and the hot path stays allocation-free.
 *
 * Records are append-only and best-effort: a write failure (or a failure to
 * open the sink) never propagates to the daemon or to agents.
 */

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  type LogLevel,
  type LoggingConfig,
} from "@worktreeos/core/global-config";
import { wosHome } from "@worktreeos/core/paths";

/** Numeric ordering for threshold comparisons. `off` silences everything. */
const LEVEL_ORDER: Record<LogLevel, number> = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};

/** Emittable levels (everything except `off`). */
type EmitLevel = Exclude<LogLevel, "off">;

export type LogFields = Record<string, unknown>;

/**
 * Free-text user-content field keys redacted by default. Their values are
 * dropped and replaced by a non-identifying `<key>.len` length marker so debug
 * logging never writes prompt text to disk.
 */
const REDACT_KEYS = ["prompt", "query", "lastQuery", "summary", "title"];

/** Fallback slow threshold when neither the op nor `default` is configured. */
const FALLBACK_SLOW_MS = 1000;

export interface SpanOptions {
  /** Terminal session id, when the operation is session-scoped. */
  sid?: string;
  /** Working directory, when relevant. */
  cwd?: string;
  /** Per-call slow threshold override (ms); defaults to the configured map. */
  slowMs?: number;
  /** Extra structured fields merged into the span record. */
  fields?: LogFields;
}

export interface ModuleLogger {
  error(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  trace(msg: string, fields?: LogFields): void;
  /**
   * Time an async operation: records `durationMs`, `ok`, and `slow` on
   * completion (at `warn` when slow, else `debug`), and arms a stuck-span
   * watchdog that emits `span.stuck` if the operation exceeds its threshold
   * before settling. Degrades to a plain `await fn()` when perf logging is off.
   */
  span<T>(
    op: string,
    label: string,
    fn: () => Promise<T>,
    opts?: SpanOptions,
  ): Promise<T>;
  /**
   * Synchronous counterpart to {@link span} for hot, synchronous operations
   * (e.g. process detection). Records `durationMs`/`ok`/`slow` with no
   * watchdog. Degrades to a plain `fn()` when perf logging is off.
   */
  spanSync<T>(op: string, label: string, fn: () => T, opts?: SpanOptions): T;
  /** True when this module would emit at the given level (hot-path guard). */
  isEnabled(level: LogLevel): boolean;
}

export interface DaemonLogger {
  module(name: string): ModuleLogger;
  /** Whether file logging is active. */
  readonly enabled: boolean;
  /** Resolved log file path when enabled, else undefined. */
  readonly file: string | undefined;
  /** Flush and close the sink (daemon shutdown). No-op when disabled. */
  close(): Promise<void>;
}

export interface DaemonLoggerOptions {
  /**
   * Override the line sink (tests). Receives each serialized JSON record
   * (without a trailing newline). When provided, no file stream is opened.
   */
  sink?: (line: string) => void;
  /** Override the clock (tests). */
  now?: () => number;
}

/** Resolve the effective log file path from config + wos home. */
export function resolveLogFilePath(
  cfg: LoggingConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (cfg.file && cfg.file.trim().length > 0) return resolve(cfg.file);
  return resolve(wosHome(env), "logs", "daemon.log");
}

/**
 * Create the daemon logger from parsed `logging` config. Returns a no-op logger
 * when `cfg.enabled` is false (or when the sink cannot be opened).
 */
export function createDaemonLogger(
  cfg: LoggingConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: DaemonLoggerOptions = {},
): DaemonLogger {
  // Tolerate a config that omits `logging` (e.g. a partial test stub): treat a
  // missing or disabled block as off.
  if (!cfg?.enabled) return noopLogger();

  const now = options.now ?? Date.now;
  let file: string | undefined;
  let stream: WriteStream | undefined;
  let write: (line: string) => void;

  if (options.sink) {
    const sink = options.sink;
    write = (line) => {
      try {
        sink(line);
      } catch {
        /* a sink failure must never affect the daemon */
      }
    };
  } else {
    file = resolveLogFilePath(cfg, env);
    try {
      mkdirSync(dirname(file), { recursive: true });
      const s = createWriteStream(file, { flags: "a" });
      // A stream error (unwritable file, disk full) must never crash the
      // daemon; swallow it so the failure is silent rather than fatal.
      s.on("error", () => {});
      stream = s;
      write = (line) => {
        try {
          s.write(line + "\n");
        } catch {
          /* best-effort */
        }
      };
    } catch {
      // Could not open the sink at all — degrade to a no-op logger so logging
      // never blocks daemon startup.
      return noopLogger();
    }
  }

  const ctx: LoggerContext = {
    cfg,
    now,
    write,
    resolveThreshold: (moduleName) =>
      LEVEL_ORDER[cfg.modules[moduleName] ?? cfg.level],
  };

  const modules = new Map<string, ModuleLogger>();
  return {
    enabled: true,
    file,
    module(name) {
      let existing = modules.get(name);
      if (!existing) {
        existing = new ActiveModuleLogger(name, ctx);
        modules.set(name, existing);
      }
      return existing;
    },
    async close() {
      if (!stream) return;
      await new Promise<void>((res) => stream!.end(() => res()));
    },
  };
}

interface LoggerContext {
  cfg: LoggingConfig;
  now: () => number;
  write: (line: string) => void;
  /** Effective numeric level threshold for a module. */
  resolveThreshold: (moduleName: string) => number;
}

class ActiveModuleLogger implements ModuleLogger {
  constructor(
    private readonly name: string,
    private readonly ctx: LoggerContext,
  ) {}

  error(msg: string, fields?: LogFields): void {
    this.emit("error", msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.emit("warn", msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.emit("info", msg, fields);
  }
  debug(msg: string, fields?: LogFields): void {
    this.emit("debug", msg, fields);
  }
  trace(msg: string, fields?: LogFields): void {
    this.emit("trace", msg, fields);
  }

  isEnabled(level: LogLevel): boolean {
    if (level === "off") return false;
    return LEVEL_ORDER[level] <= this.ctx.resolveThreshold(this.name);
  }

  async span<T>(
    op: string,
    label: string,
    fn: () => Promise<T>,
    opts: SpanOptions = {},
  ): Promise<T> {
    if (!this.ctx.cfg.perf.enabled) return fn();
    const slowMs = this.resolveSlowMs(op, opts.slowMs);
    const start = this.ctx.now();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    if (this.ctx.cfg.perf.stuckWatchdog && slowMs > 0) {
      watchdog = setTimeout(() => {
        this.emit("warn", "span.stuck", {
          op,
          label,
          elapsedMs: slowMs,
          ...this.spanFields(opts),
        });
      }, slowMs);
      watchdog.unref?.();
    }
    let ok = true;
    try {
      return await fn();
    } catch (e) {
      ok = false;
      throw e;
    } finally {
      if (watchdog) clearTimeout(watchdog);
      this.endSpan(op, label, this.ctx.now() - start, ok, slowMs, opts);
    }
  }

  spanSync<T>(op: string, label: string, fn: () => T, opts: SpanOptions = {}): T {
    if (!this.ctx.cfg.perf.enabled) return fn();
    const slowMs = this.resolveSlowMs(op, opts.slowMs);
    const start = this.ctx.now();
    let ok = true;
    try {
      return fn();
    } catch (e) {
      ok = false;
      throw e;
    } finally {
      this.endSpan(op, label, this.ctx.now() - start, ok, slowMs, opts);
    }
  }

  private endSpan(
    op: string,
    label: string,
    durationMs: number,
    ok: boolean,
    slowMs: number,
    opts: SpanOptions,
  ): void {
    const slow = slowMs > 0 && durationMs >= slowMs;
    this.emit(slow ? "warn" : "debug", "span.end", {
      op,
      label,
      durationMs,
      ok,
      ...(slow ? { slow: true } : {}),
      ...this.spanFields(opts),
    });
  }

  private resolveSlowMs(op: string, override: number | undefined): number {
    if (typeof override === "number") return override;
    const map = this.ctx.cfg.perf.slowMs;
    return map[op] ?? map.default ?? FALLBACK_SLOW_MS;
  }

  private spanFields(opts: SpanOptions): LogFields {
    return {
      ...(opts.sid ? { sid: opts.sid } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.fields ?? {}),
    };
  }

  private emit(level: EmitLevel, msg: string, fields?: LogFields): void {
    if (!this.isEnabled(level)) return;
    const record: Record<string, unknown> = {
      ts: new Date(this.ctx.now()).toISOString(),
      level,
      module: this.name,
      msg,
    };
    if (fields) {
      const redacted = this.ctx.cfg.redactPrompts
        ? redactFields(fields)
        : fields;
      for (const [k, v] of Object.entries(redacted)) {
        if (v === undefined) continue;
        record[k] = v;
      }
    }
    this.ctx.write(JSON.stringify(record));
  }
}

/**
 * Strip free-text user content from a fields object, replacing each redacted
 * key with a `<key>.len` marker (for strings) so the record stays useful for
 * debugging without disclosing prompt text. Returns a new object; the input is
 * never mutated.
 */
function redactFields(fields: LogFields): LogFields {
  let out: LogFields | undefined;
  for (const key of REDACT_KEYS) {
    if (!(key in fields)) continue;
    if (!out) out = { ...fields };
    const value = out[key];
    delete out[key];
    if (typeof value === "string") out[`${key}.len`] = value.length;
  }
  return out ?? fields;
}

function noopLogger(): DaemonLogger {
  const mod: ModuleLogger = {
    error() {},
    warn() {},
    info() {},
    debug() {},
    trace() {},
    span: (_op, _label, fn) => fn(),
    spanSync: (_op, _label, fn) => fn(),
    isEnabled: () => false,
  };
  return {
    enabled: false,
    file: undefined,
    module: () => mod,
    close: async () => {},
  };
}
