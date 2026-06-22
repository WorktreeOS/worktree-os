/**
 * Bun WebSocket handlers for the terminal-layer data plane.
 *
 * The lifecycle:
 *   1. The HTTP route upgrades a request whose `data` payload identifies the
 *      target terminal session.
 *   2. On `open`, the WebSocket buffers frames until the client sends a
 *      `hello` frame. Until then no `output` is delivered.
 *   3. `hello` triggers `manager.attach(...)`. The actor sends `hello-ack`,
 *      replay frames, replay-done, and switches to live output.
 *   4. Subsequent client frames are validated and routed to the actor.
 *   5. On `close`, the actor detaches the attachment.
 *
 * The `kind: "terminal-layer"` discriminator avoids collisions with the
 * legacy `/ui/v1/terminals/:id/attach` WebSocket path used by the existing
 * frontend during the migration.
 */

import type { ServerWebSocket } from "bun";
import type { AttachmentSink } from "./actor";
import type { TerminalSessionManager } from "./manager";
import {
  decodeTerminalClientFrame,
  TERMINAL_PROTOCOL_VERSION,
} from "./protocol-validation";
import {
  encodeTerminalServerFrame,
  type TerminalServerErrorCode,
  type TerminalServerFrame,
} from "./protocol";

export interface TerminalLayerWsData {
  kind: "terminal-layer";
  terminalId: string;
  attachmentId: string;
  /** Attached by `open` once the hello handshake completes. */
  attached?: boolean;
  /** Detach callback installed after `attach()` succeeds. */
  detach?: (reason?: string) => void;
}

export interface TerminalWsHandlers {
  open(ws: ServerWebSocket<TerminalLayerWsData>): void;
  message(
    ws: ServerWebSocket<TerminalLayerWsData>,
    raw: string | Buffer | ArrayBuffer | Uint8Array,
  ): void;
  close(
    ws: ServerWebSocket<TerminalLayerWsData>,
    code: number,
    reason: string,
  ): void;
}

function makeSink(ws: ServerWebSocket<TerminalLayerWsData>): AttachmentSink {
  return {
    send(frame: TerminalServerFrame): void {
      try {
        ws.send(encodeTerminalServerFrame(frame));
      } catch {
        /* swallow — the close handler will reconcile */
      }
    },
    close(code, reason): void {
      try {
        ws.close(code ?? 1000, reason ?? "closed");
      } catch {
        /* ignore */
      }
    },
    bufferedAmount(): number {
      try {
        return ws.getBufferedAmount?.() ?? 0;
      } catch {
        return 0;
      }
    },
  };
}

function sendError(
  ws: ServerWebSocket<TerminalLayerWsData>,
  code: TerminalServerErrorCode,
  message: string,
  fatal = false,
): void {
  try {
    ws.send(
      encodeTerminalServerFrame({
        type: "error",
        v: TERMINAL_PROTOCOL_VERSION,
        code,
        message,
        ...(fatal ? { fatal: true } : {}),
      }),
    );
  } catch {
    /* ignore */
  }
  if (fatal) {
    try {
      ws.close(1008, code);
    } catch {
      /* ignore */
    }
  }
}

export function createTerminalLayerWsHandlers(
  manager: TerminalSessionManager,
): TerminalWsHandlers {
  return {
    open(ws) {
      const data = ws.data;
      if (!data || data.kind !== "terminal-layer") return;
      // Validate the session exists before accepting hello so a misrouted
      // attach can be denied immediately with a typed error.
      const meta = manager.get(data.terminalId);
      if (!meta) {
        sendError(ws, "not-found", `terminal session ${data.terminalId} not found`, true);
      }
    },
    message(ws, raw) {
      const data = ws.data;
      if (!data || data.kind !== "terminal-layer") return;
      const decoded = decodeTerminalClientFrame(
        raw instanceof Uint8Array || raw instanceof ArrayBuffer
          ? raw
          : Buffer.isBuffer(raw)
            ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
            : raw,
      );
      if (!decoded.ok) {
        const code: TerminalServerErrorCode =
          decoded.error.code === "version-unsupported"
            ? "version-unsupported"
            : "invalid-message";
        sendError(ws, code, decoded.error.message, code === "version-unsupported");
        return;
      }
      const frame = decoded.frame;

      if (frame.type === "hello") {
        if (data.attached) {
          sendError(ws, "invalid-message", "hello has already been processed", false);
          return;
        }
        const sink = makeSink(ws);
        manager
          .attach(data.terminalId, {
            attachmentId: data.attachmentId,
            clientId: frame.clientId,
            cols: frame.cols,
            rows: frame.rows,
            desiredControl: frame.desiredControl,
            ...(typeof frame.lastSeenOutputSeq === "number"
              ? { lastSeenOutputSeq: frame.lastSeenOutputSeq }
              : {}),
            sink,
          })
          .then(() => {
            data.attached = true;
            data.detach = (reason) => {
              void manager.detach(data.terminalId, data.attachmentId, reason);
            };
          })
          .catch((e) => {
            sendError(ws, "internal", (e as Error).message, true);
          });
        return;
      }

      // All other frames require an established attachment.
      if (!data.attached) {
        sendError(ws, "invalid-message", "first frame must be 'hello'", true);
        return;
      }

      if (frame.type === "input") {
        void manager.input(data.terminalId, data.attachmentId, frame.data);
        return;
      }
      if (frame.type === "resize") {
        void manager.resize(
          data.terminalId,
          data.attachmentId,
          frame.cols,
          frame.rows,
        );
        return;
      }
      if (frame.type === "ack") {
        void manager.ack(data.terminalId, data.attachmentId, frame.ackSeq);
        return;
      }
      if (frame.type === "control") {
        if (frame.action === "request") {
          void manager.requestControl(data.terminalId, data.attachmentId);
        } else if (frame.action === "release") {
          void manager.releaseControl(data.terminalId, data.attachmentId);
        } else if (frame.action === "revoke") {
          // Revoke from self is equivalent to release; revoking another
          // attachment is not exposed in the first protocol version.
          void manager.releaseControl(data.terminalId, data.attachmentId);
        }
        return;
      }
    },
    close(ws, _code, _reason) {
      const data = ws.data;
      if (!data || data.kind !== "terminal-layer") return;
      if (typeof data.detach === "function") {
        try {
          data.detach("client closed");
        } catch {
          /* ignore */
        }
        data.detach = undefined;
      }
    },
  };
}
