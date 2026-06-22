/**
 * Versioned terminal data-plane WebSocket protocol.
 *
 * The protocol is split into client→server and server→client message frames.
 * Each message has a `type` discriminator and a `v` protocol version. Output
 * frames carry a monotonic `seq` number so reconnected clients can request
 * replay from the last seen sequence.
 *
 * JSON encoding is used throughout the first version. Binary output frames
 * are reserved for a future revision behind the same `seq` semantics.
 */

import type {
  TerminalAttachmentSummary,
  TerminalControlOwnership,
  TerminalReplayBoundary,
  TerminalSessionExit,
  TerminalSessionMetadata,
  TerminalSessionStatus,
} from "./types";

/**
 * Highest protocol version this daemon understands. Older clients SHOULD
 * receive a downgraded greeting; clients sending a strictly higher version
 * SHALL receive a `version-unsupported` error and be disconnected.
 */
export const TERMINAL_PROTOCOL_VERSION = 1 as const;

export type TerminalProtocolVersion = typeof TERMINAL_PROTOCOL_VERSION;

/** Control mode requested by an attaching client. */
export type TerminalControlMode = "controller" | "viewer";

// ---------- Client → Server frames ----------

/**
 * Opening handshake. Required first frame after the WebSocket opens.
 * The daemon SHALL respond with a `hello-ack` (or `error`) before any other
 * server-side frame.
 */
export interface TerminalClientHelloFrame {
  type: "hello";
  v: number;
  /** Stable client-supplied identifier for diagnostics and reconnect. */
  clientId: string;
  /** Initial viewport size in cells. */
  cols: number;
  rows: number;
  /** Last output sequence the client has rendered, when reattaching. */
  lastSeenOutputSeq?: number;
  /** Whether the client wants to assume the controller role on attach. */
  desiredControl: TerminalControlMode;
}

/** Raw keyboard/paste input from the current controller. */
export interface TerminalClientInputFrame {
  type: "input";
  v: number;
  data: string;
}

/** Viewport resize from the current controller. */
export interface TerminalClientResizeFrame {
  type: "resize";
  v: number;
  cols: number;
  rows: number;
}

/** Acknowledgement of the highest processed output sequence number. */
export interface TerminalClientAckFrame {
  type: "ack";
  v: number;
  ackSeq: number;
}

/** Request, release, or revoke terminal control. */
export interface TerminalClientControlFrame {
  type: "control";
  v: number;
  action: "request" | "release" | "revoke";
}

export type TerminalClientFrame =
  | TerminalClientHelloFrame
  | TerminalClientInputFrame
  | TerminalClientResizeFrame
  | TerminalClientAckFrame
  | TerminalClientControlFrame;

// ---------- Server → Client frames ----------

/**
 * Handshake acknowledgement. Sent in response to `hello`. Carries authoritative
 * session metadata, current replay boundaries, control ownership, and whether
 * a server-side checkpoint will follow before live output begins.
 */
export interface TerminalServerHelloAckFrame {
  type: "hello-ack";
  v: TerminalProtocolVersion;
  /** Stable attachment id assigned to this WebSocket. */
  attachmentId: string;
  session: TerminalSessionMetadata;
  replay: TerminalReplayBoundary;
  control: TerminalControlOwnership;
  /** True if replay frames will be delivered before live output. */
  willReplay: boolean;
}

/**
 * PTY output. Sequence numbers are monotonic per session. During replay,
 * frames are marked with `replay: true` so the client can mark the viewport
 * boundary between historical and live output.
 */
export interface TerminalServerOutputFrame {
  type: "output";
  v: TerminalProtocolVersion;
  seq: number;
  data: string;
  /** True when this frame is part of replay before live output begins. */
  replay?: boolean;
}

/** Marker between replay and live output. */
export interface TerminalServerReplayDoneFrame {
  type: "replay-done";
  v: TerminalProtocolVersion;
  /** Last sequence delivered during replay. */
  upToSeq: number;
}

/** Lifecycle status change for the session. */
export interface TerminalServerStatusFrame {
  type: "status";
  v: TerminalProtocolVersion;
  status: TerminalSessionStatus;
  session: TerminalSessionMetadata;
}

/** Control ownership change for this or other attachments. */
export interface TerminalServerControlFrame {
  type: "control";
  v: TerminalProtocolVersion;
  control: TerminalControlOwnership;
  /** Convenience flag: true if THIS attachment now owns control. */
  isController: boolean;
}

/** Attachment list change (connect/disconnect). */
export interface TerminalServerAttachmentsFrame {
  type: "attachments";
  v: TerminalProtocolVersion;
  attachments: TerminalAttachmentSummary[];
}

/** Final exit frame. Server SHOULD close the WebSocket shortly after. */
export interface TerminalServerExitFrame {
  type: "exit";
  v: TerminalProtocolVersion;
  exit: TerminalSessionExit;
}

/** Typed error frames. Severity decides whether the attachment is closed. */
export type TerminalServerErrorCode =
  | "not-found"
  | "session-exited"
  | "invalid-message"
  | "version-unsupported"
  | "control-denied"
  | "replay-gap"
  | "backpressure"
  | "forbidden"
  | "terminal-unavailable"
  | "internal";

export interface TerminalServerErrorFrame {
  type: "error";
  v: TerminalProtocolVersion;
  code: TerminalServerErrorCode;
  message: string;
  /** When true, the server will close the attachment after sending. */
  fatal?: boolean;
}

export type TerminalServerFrame =
  | TerminalServerHelloAckFrame
  | TerminalServerOutputFrame
  | TerminalServerReplayDoneFrame
  | TerminalServerStatusFrame
  | TerminalServerControlFrame
  | TerminalServerAttachmentsFrame
  | TerminalServerExitFrame
  | TerminalServerErrorFrame;

// ---------- Encoders ----------

/** Encode a server frame into its wire JSON form. */
export function encodeTerminalServerFrame(frame: TerminalServerFrame): string {
  return JSON.stringify(frame);
}

/** Encode a client frame into its wire JSON form. */
export function encodeTerminalClientFrame(frame: TerminalClientFrame): string {
  return JSON.stringify(frame);
}
