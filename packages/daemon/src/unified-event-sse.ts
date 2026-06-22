import type { UnifiedEventEnvelope } from "@worktreeos/core/unified-events";

/**
 * Serialize a unified event envelope as an SSE frame. SSE clients use the
 * frame's `id:` field to track `Last-Event-ID` for reconnect replay; the
 * envelope itself is JSON-encoded in the `data:` field.
 */
export function encodeSseFrame(envelope: UnifiedEventEnvelope): string {
  const data = JSON.stringify(envelope);
  return `id: ${envelope.id}\nevent: ${envelope.type}\ndata: ${data}\n\n`;
}

/** Encode an SSE keepalive comment. */
export function encodeSseKeepalive(now: Date = new Date()): string {
  return `: keepalive ${now.toISOString()}\n\n`;
}

/**
 * Parse the `Last-Event-ID` header into a numeric event id. Returns
 * `undefined` when the header is missing, empty, or unparseable.
 */
export function parseLastEventId(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const id = Number(trimmed);
  if (!Number.isFinite(id) || !Number.isInteger(id) || id < 0) return undefined;
  return id;
}

export interface ParsedSseFrame {
  id?: number;
  event?: string;
  data: string;
}

/**
 * Parse one SSE frame. Used by tests and CLI clients. Returns `null` when the
 * frame contains no `data:` field.
 */
export function decodeSseFrame(frame: string): ParsedSseFrame | null {
  let id: number | undefined;
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0) continue;
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    let value = line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && Number.isInteger(parsed)) id = parsed;
    } else if (field === "event") {
      event = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }
  if (dataLines.length === 0) return null;
  return { id, event, data: dataLines.join("\n") };
}

/**
 * Split a streamed SSE buffer into complete frames + leftover partial buffer.
 * Frames are delimited by `\n\n`.
 */
export function splitSseStream(buffer: string): {
  frames: string[];
  rest: string;
} {
  const frames: string[] = [];
  let start = 0;
  while (true) {
    const idx = buffer.indexOf("\n\n", start);
    if (idx === -1) break;
    frames.push(buffer.slice(start, idx));
    start = idx + 2;
  }
  return { frames, rest: buffer.slice(start) };
}
