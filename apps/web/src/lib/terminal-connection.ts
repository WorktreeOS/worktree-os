/**
 * Browser-side terminal-layer protocol client.
 *
 * Owns the WebSocket lifecycle, the hello handshake, replay vs. live state,
 * acknowledgement bookkeeping, reconnect with `lastAckSeq`, and error
 * surfacing. PTY output is forwarded through `onOutput` callbacks so the
 * caller can write directly into the xterm.js instance — React never holds
 * raw terminal bytes.
 */

import {
  TERMINAL_PROTOCOL_VERSION,
  type TerminalControlOwnership,
  type TerminalServerErrorCode,
  type TerminalServerFrame,
  type TerminalSessionMetadata,
  type TerminalSessionStatus,
} from "./terminal-protocol";

export type TerminalConnectionState =
  | "connecting"
  | "handshake"
  | "replaying"
  | "live"
  | "disconnected"
  | "exited"
  | "failed";

export interface TerminalConnectionListener {
  onState?(state: TerminalConnectionState): void;
  onOutput?(data: string, replay: boolean): void;
  onSession?(session: TerminalSessionMetadata): void;
  onControl?(control: TerminalControlOwnership, isController: boolean): void;
  onReplayDone?(upToSeq: number): void;
  onReplayGap?(): void;
  onExit?(exit: TerminalSessionMetadata["exit"]): void;
  onError?(code: TerminalServerErrorCode, message: string, fatal: boolean): void;
}

export interface TerminalConnectionOptions {
  url: string;
  clientId: string;
  cols: number;
  rows: number;
  desiredControl: "controller" | "viewer";
  /** Resume from this output sequence when reconnecting. */
  lastSeenOutputSeq?: number;
  listener: TerminalConnectionListener;
}

const DEFAULT_RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000];

export class TerminalConnection {
  private ws: WebSocket | null = null;
  private state: TerminalConnectionState = "connecting";
  private cols: number;
  private rows: number;
  private lastAckSeq = 0;
  private latestSeq = 0;
  private exiting = false;
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private readonly opts: TerminalConnectionOptions;

  constructor(opts: TerminalConnectionOptions) {
    this.opts = opts;
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.lastAckSeq = opts.lastSeenOutputSeq ?? 0;
    this.open();
  }

  /** Final sequence number we have received. */
  get lastSequence(): number {
    return this.latestSeq;
  }

  /** Cleanly close the WebSocket and stop reconnect attempts. */
  dispose(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      // Closing a CONNECTING socket synthesises an abnormal close (1006)
      // and logs "WebSocket is closed before the connection is established"
      // in DevTools. Defer the close until `open` (which now checks
      // `this.closed` and closes cleanly) or the socket's own error/close
      // path so we never call close() in the CONNECTING state.
      if (this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.close(1000, "client disposed");
        } catch {
          /* ignore */
        }
      }
      this.ws = null;
    }
  }

  /** Send raw input bytes — caller MUST already be the controller. */
  sendInput(data: string): void {
    this.sendFrame({ type: "input", v: TERMINAL_PROTOCOL_VERSION, data });
  }

  /** Push a resize — applies to the PTY only when the caller controls it. */
  sendResize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.sendFrame({ type: "resize", v: TERMINAL_PROTOCOL_VERSION, cols, rows });
  }

  /** Request controller ownership for this attachment. */
  requestControl(): void {
    this.sendFrame({
      type: "control",
      v: TERMINAL_PROTOCOL_VERSION,
      action: "request",
    });
  }

  /** Relinquish controller ownership. */
  releaseControl(): void {
    this.sendFrame({
      type: "control",
      v: TERMINAL_PROTOCOL_VERSION,
      action: "release",
    });
  }

  /** Acknowledge processed output up to `seq`. */
  ack(seq: number): void {
    if (seq <= this.lastAckSeq) return;
    this.lastAckSeq = seq;
    this.sendFrame({ type: "ack", v: TERMINAL_PROTOCOL_VERSION, ackSeq: seq });
  }

  private open(): void {
    this.setState("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch (e) {
      this.failWith((e as Error).message);
      return;
    }
    this.ws = ws;
    ws.addEventListener("open", () => {
      // If the consumer disposed us while the WebSocket was still in
      // CONNECTING state, finish the connect quickly and close cleanly so
      // the browser does NOT log "WebSocket is closed before the connection
      // is established".
      if (this.closed) {
        try {
          ws.close(1000, "client disposed");
        } catch {
          /* ignore */
        }
        return;
      }
      this.onOpen();
    });
    ws.addEventListener("message", (ev) => this.onMessage(ev.data));
    ws.addEventListener("close", (ev) => this.onClose(ev.code, ev.reason));
    ws.addEventListener("error", () => this.onError());
  }

  private onOpen(): void {
    if (this.closed) return;
    this.setState("handshake");
    this.sendFrame({
      type: "hello",
      v: TERMINAL_PROTOCOL_VERSION,
      clientId: this.opts.clientId,
      cols: this.cols,
      rows: this.rows,
      desiredControl: this.opts.desiredControl,
      ...(this.lastAckSeq > 0
        ? { lastSeenOutputSeq: this.lastAckSeq }
        : {}),
    });
  }

  private onMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let frame: TerminalServerFrame;
    try {
      frame = JSON.parse(raw) as TerminalServerFrame;
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object" || typeof frame.type !== "string") return;
    this.handleFrame(frame);
  }

  private handleFrame(frame: TerminalServerFrame): void {
    switch (frame.type) {
      case "hello-ack":
        this.opts.listener.onSession?.(frame.session);
        this.opts.listener.onControl?.(frame.control, frame.control.controllerAttachmentId === frame.attachmentId);
        if (frame.willReplay) {
          this.setState("replaying");
        } else {
          this.setState("live");
        }
        return;
      case "output":
        this.latestSeq = frame.seq;
        this.opts.listener.onOutput?.(frame.data, frame.replay === true);
        // Auto-ack every live frame; replay frames are not acked.
        if (!frame.replay) this.ack(frame.seq);
        return;
      case "replay-done":
        this.setState("live");
        this.opts.listener.onReplayDone?.(frame.upToSeq);
        return;
      case "status":
        this.opts.listener.onSession?.(frame.session);
        this.reflectStatus(frame.status);
        return;
      case "control":
        this.opts.listener.onControl?.(frame.control, frame.isController);
        return;
      case "attachments":
        // Attachments frame is informational only; consumers reconcile via
        // snapshots when they need full attachment metadata.
        return;
      case "exit":
        this.exiting = true;
        this.opts.listener.onExit?.(frame.exit);
        this.setState("exited");
        return;
      case "error":
        if (frame.code === "replay-gap") this.opts.listener.onReplayGap?.();
        this.opts.listener.onError?.(frame.code, frame.message, frame.fatal === true);
        if (frame.fatal) {
          this.closed = true;
          this.setState("failed");
        }
        return;
    }
  }

  private reflectStatus(status: TerminalSessionStatus): void {
    if (status === "exited") {
      this.exiting = true;
      this.setState("exited");
    }
  }

  private onClose(code: number, _reason: string): void {
    this.ws = null;
    if (this.closed) return;
    if (this.exiting) {
      this.setState("exited");
      return;
    }
    if (code === 1000 || code === 1005) {
      this.setState("disconnected");
      return;
    }
    this.setState("disconnected");
    this.scheduleReconnect();
  }

  private onError(): void {
    // Mirror onClose for transient WS errors. The browser will fire `close`
    // shortly after with the actual code.
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay =
      DEFAULT_RECONNECT_DELAYS_MS[
        Math.min(this.reconnectAttempt, DEFAULT_RECONNECT_DELAYS_MS.length - 1)
      ] ?? 5000;
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      this.open();
    }, delay);
  }

  private sendFrame(frame: import("./terminal-protocol").TerminalClientFrame): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(frame));
    } catch {
      /* ignore */
    }
  }

  private setState(state: TerminalConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.opts.listener.onState?.(state);
  }

  private failWith(message: string): void {
    this.opts.listener.onError?.("internal", message, true);
    this.setState("failed");
    this.closed = true;
  }
}
