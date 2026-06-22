import type { DeploymentEvent, LogChannel, LogStream } from "@worktreeos/core/events";
import type { AppPortHealthcheckResult } from "@worktreeos/runtime/healthchecks";
import type { ServiceStatus } from "@worktreeos/compose/ps";
import type { WosState } from "@worktreeos/core/state";
import type { TunnelSnapshot } from "@worktreeos/runtime/tunnel-registry";

/**
 * Protocol version emitted by the daemon and required by clients. Bumped to
 * `"3"` when the Unix socket control plane was removed in favor of the
 * mandatory HTTP listener, so socket-era clients and HTTP-era daemons reject
 * each other with an actionable error instead of misbehaving.
 */
export const DAEMON_PROTOCOL_VERSION = "3";

export type OperationKind =
  | "up"
  | "down"
  | "status"
  | "service-stop"
  | "service-restart"
  | "worktree-remove"
  | "worktree-create";
export type OperationStatus = "queued" | "running" | "succeeded" | "failed" | "conflict";

// ---------- Health ----------

export interface HealthResponse {
  ok: true;
  protocol: string;
  pid: number;
  startedAt: string;
}

// ---------- Session resolution ----------

export interface ResolveSessionRequest {
  cwd: string;
}

export interface ResolveSessionResponse {
  worktreeRoot: string;
  sessionName: string;
  sessionRoot: string;
  projectName: string;
  state: WosState | null;
}

// ---------- Operation submission ----------

export interface SubmitUpRequest {
  cwd: string;
  force?: boolean;
  /** Skip tunnel route registration even when global tunneling is enabled. */
  noTunnel?: boolean;
  /**
   * Generated-mode explicit service selection. Mutually exclusive with
   * `target`. Empty array is rejected. Unsupported in compose mode.
   */
  services?: string[];
  /**
   * Generated-mode startup target name. Mutually exclusive with `services`.
   * Empty string is rejected. Unsupported in compose mode.
   */
  target?: string;
  /**
   * Submitted runtime argument values keyed by declared argument name. Keys
   * must be declared by the resolved generated-compose config; unknown keys
   * fail before Docker Compose startup. Unsupported in compose mode.
   */
  arguments?: Record<string, string>;
}

export interface SubmitDownRequest {
  cwd: string;
}

export interface SubmitStatusRequest {
  cwd: string;
}

export interface OperationAccepted {
  ok: true;
  operationId: string;
  kind: OperationKind;
  sessionName: string;
  startedAt: string;
}

export interface OperationMetadata {
  operationId: string;
  kind: OperationKind;
  sessionName: string;
  status: OperationStatus;
  startedAt: string;
  finishedAt?: string;
  failureMessage?: string;
}

// ---------- Status response ----------

export interface StatusResponse {
  kind: "no-deployment" | "ok";
  services?: ServiceStatus[];
  state?: WosState;
  /**
   * Healthcheck results for configured app-service ports. Present (possibly
   * empty) on `ok`, absent on `no-deployment`.
   */
  appPortHealthchecks?: AppPortHealthcheckResult[];
  /**
   * App-port tunnel snapshots (active or failed). Present (possibly empty) on
   * `ok`, absent on `no-deployment`.
   */
  tunnels?: TunnelSnapshot[];
}

// ---------- Conflict ----------

export interface ConflictResponse {
  error: "session-busy";
  sessionName: string;
  active: OperationMetadata;
}

// ---------- Generic errors ----------

export interface ErrorResponse {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

export function isConflictResponse(r: unknown): r is ConflictResponse {
  return Boolean(r && typeof r === "object" && (r as ConflictResponse).error === "session-busy");
}

// ---------- Event envelope ----------

/**
 * Envelope wrapping every `DeploymentEvent` streamed by the daemon. Each
 * envelope is one newline-delimited JSON object. `sequence` is a strictly
 * increasing integer per operation so clients can detect drops/reorder.
 */
export interface OperationEventEnvelope {
  operationId: string;
  sessionName: string;
  sequence: number;
  timestamp: string;
  event: DeploymentEvent;
}

/** A terminal stream marker emitted right before the daemon closes the stream. */
export interface OperationTerminalEnvelope {
  operationId: string;
  sessionName: string;
  sequence: number;
  timestamp: string;
  terminal: {
    status: Extract<OperationStatus, "succeeded" | "failed">;
    failureMessage?: string;
  };
}

export type StreamEnvelope = OperationEventEnvelope | OperationTerminalEnvelope;

export function isTerminalEnvelope(e: StreamEnvelope): e is OperationTerminalEnvelope {
  return "terminal" in e;
}

// ---------- JSON serialization helpers ----------

/** Serialize a stream envelope as one NDJSON line (with trailing newline). */
export function encodeEnvelope(envelope: StreamEnvelope): string {
  return JSON.stringify(envelope) + "\n";
}

/** Parse a single NDJSON envelope line. */
export function decodeEnvelope(line: string): StreamEnvelope {
  const trimmed = line.trim();
  if (trimmed.length === 0) throw new Error("empty envelope line");
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("envelope is not an object");
  }
  if (!("operationId" in parsed) || typeof parsed.operationId !== "string") {
    throw new Error("envelope missing operationId");
  }
  if (!("sequence" in parsed) || typeof parsed.sequence !== "number") {
    throw new Error("envelope missing sequence");
  }
  return parsed as StreamEnvelope;
}

/** Split a buffer of NDJSON into complete envelopes + leftover partial line. */
export function splitEnvelopeStream(buffer: string): {
  envelopes: StreamEnvelope[];
  rest: string;
} {
  const envelopes: StreamEnvelope[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer.charCodeAt(i) === 10 /* \n */) {
      const line = buffer.slice(start, i);
      if (line.trim().length > 0) envelopes.push(decodeEnvelope(line));
      start = i + 1;
    }
  }
  return { envelopes, rest: buffer.slice(start) };
}

// ---------- Session log envelope ----------

/**
 * NDJSON envelope emitted by the session log stream
 * (`GET /v1/sessions/:sessionName/logs`). Carries a single log chunk with
 * monotonically increasing sequence per stream so clients can detect
 * drops/reorder. `channel` is the full log channel (`init` or
 * `service:<name>`); `service` carries the plain service name for service
 * channels (or the literal channel label for init).
 */
export interface SessionLogEnvelope {
  sessionName: string;
  sequence: number;
  timestamp: string;
  channel: LogChannel;
  service: string;
  stream: LogStream;
  chunk: string;
}

export function encodeSessionLogEnvelope(env: SessionLogEnvelope): string {
  return JSON.stringify(env) + "\n";
}

export function decodeSessionLogEnvelope(line: string): SessionLogEnvelope {
  const trimmed = line.trim();
  if (trimmed.length === 0) throw new Error("empty session-log envelope");
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("session-log envelope is not an object");
  }
  if (typeof parsed.sessionName !== "string") {
    throw new Error("session-log envelope missing sessionName");
  }
  if (typeof parsed.sequence !== "number") {
    throw new Error("session-log envelope missing sequence");
  }
  if (typeof parsed.service !== "string") {
    throw new Error("session-log envelope missing service");
  }
  if (typeof parsed.channel !== "string") {
    // Derive a channel for legacy envelopes that predate the field.
    parsed.channel = `service:${parsed.service}`;
  }
  if (parsed.stream !== "stdout" && parsed.stream !== "stderr") {
    throw new Error("session-log envelope has invalid stream");
  }
  if (typeof parsed.chunk !== "string") {
    throw new Error("session-log envelope missing chunk");
  }
  if (typeof parsed.timestamp !== "string") {
    throw new Error("session-log envelope missing timestamp");
  }
  return parsed as SessionLogEnvelope;
}

export function splitSessionLogStream(buffer: string): {
  envelopes: SessionLogEnvelope[];
  rest: string;
} {
  const envelopes: SessionLogEnvelope[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer.charCodeAt(i) === 10 /* \n */) {
      const line = buffer.slice(start, i);
      if (line.trim().length > 0) envelopes.push(decodeSessionLogEnvelope(line));
      start = i + 1;
    }
  }
  return { envelopes, rest: buffer.slice(start) };
}
