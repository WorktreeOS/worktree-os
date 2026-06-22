import type { LogChannel, LogStream } from "@worktreeos/core/events";

export type LogSource = "wos" | "compose" | "init" | "service";
export type LogSeverity = "info" | "warn" | "error" | "success";

export interface LogDisplay {
  source: LogSource;
  serviceName?: string;
  stream: LogStream;
  severity: LogSeverity;
}

export function classifyChannel(channel: LogChannel, stream: LogStream): LogDisplay {
  if (channel === "init") {
    return {
      source: "init",
      stream,
      severity: stream === "stderr" ? "error" : "info",
    };
  }
  if (channel === "deployment") {
    return {
      source: "compose",
      stream,
      severity: stream === "stderr" ? "error" : "info",
    };
  }
  // service:<name>
  const name = channel.startsWith("service:") ? channel.slice("service:".length) : channel;
  return {
    source: "service",
    serviceName: name,
    stream,
    severity: stream === "stderr" ? "error" : "info",
  };
}

export function prefixFor(display: LogDisplay): string {
  switch (display.source) {
    case "wos":
      return labelForSeverity(display.severity);
    case "compose":
      return display.stream === "stderr" ? "[compose err]" : "[compose]";
    case "init":
      return display.stream === "stderr" ? "[init err]" : "[init]";
    case "service":
      return display.stream === "stderr"
        ? `[${display.serviceName ?? "svc"} err]`
        : `[${display.serviceName ?? "svc"}]`;
  }
}

function labelForSeverity(sev: LogSeverity): string {
  switch (sev) {
    case "info":
      return "[deploy]";
    case "warn":
      return "[warn]";
    case "error":
      return "[fail]";
    case "success":
      return "[ok]";
  }
}

export function wosPrefix(severity: LogSeverity): string {
  return labelForSeverity(severity);
}

/**
 * Compose a single labeled log line, normalizing trailing newline.
 * Returns text WITHOUT a trailing newline; caller adds one when appending.
 */
export function composeLine(prefix: string, text: string): string {
  return `${prefix} ${text}`.replace(/\s+$/u, "");
}

/**
 * Split a raw chunk into complete-and-partial lines and prefix each.
 * Returns an array of chunks (each ending with \n where the source had \n,
 * the last one without \n if the source had a trailing partial line).
 */
export function prefixChunk(prefix: string, chunk: string): string[] {
  if (chunk.length === 0) return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < chunk.length; i += 1) {
    if (chunk.charCodeAt(i) === 10 /* \n */) {
      const line = chunk.slice(start, i);
      out.push(`${prefix} ${line}\n`);
      start = i + 1;
    }
  }
  if (start < chunk.length) {
    out.push(`${prefix} ${chunk.slice(start)}`);
  }
  return out;
}

/** Format an absolute duration in ms into a compact string like "1.2s" / "45s" / "1m23s" / "1h05m". */
export function formatDuration(ms: number): string {
  const totalMs = Math.max(0, Math.floor(ms));
  if (totalMs < 1000) return `${totalMs}ms`;
  const totalSec = Math.floor(totalMs / 1000);
  if (totalSec < 10) {
    const tenths = Math.floor((totalMs % 1000) / 100);
    return tenths === 0 ? `${totalSec}s` : `${totalSec}.${tenths}s`;
  }
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h${String(mins).padStart(2, "0")}m`;
}

/** Live elapsed display like "0:39", "1:23", "10:05", "1:00:23". */
export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 3600) {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
