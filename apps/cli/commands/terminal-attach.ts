import {
  encodeTerminalClientFrame,
  TERMINAL_PROTOCOL_VERSION,
  type TerminalServerFrame,
} from "@worktreeos/daemon/terminal-layer/protocol";

/** wos-level exit code used when the attach transport fails before an exit. */
export const ATTACH_TRANSPORT_FAILURE_CODE = 1;

/** Minimal stdin surface the attach client needs (a subset of `tty.ReadStream`). */
export interface AttachStdin {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  removeListener(event: "data", listener: (chunk: Buffer | string) => void): void;
  resume?: () => void;
  pause?: () => void;
}

/** Minimal stdout surface the attach client needs (a subset of `tty.WriteStream`). */
export interface AttachStdout {
  columns?: number;
  rows?: number;
  write(data: string): void;
  on(event: "resize", listener: () => void): void;
  removeListener(event: "resize", listener: () => void): void;
}

export interface AttachIO {
  stdin: AttachStdin;
  stdout: AttachStdout;
  stderr: { write(data: string): void };
}

/** Socket abstraction so tests can drive frames without a real WebSocket. */
export interface AttachSocket {
  send(data: string): void;
  close(): void;
}

export interface AttachSocketHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(): void;
  onError(error: Error): void;
}

export type AttachSocketFactory = (
  url: string,
  handlers: AttachSocketHandlers,
) => AttachSocket;

export interface AttachOptions {
  /** WebSocket URL of the terminal attach endpoint. */
  url: string;
  /** Initial terminal width in columns. */
  cols: number;
  /** Initial terminal height in rows. */
  rows: number;
  /** Stable client id for diagnostics; defaults to a random UUID. */
  clientId?: string;
  /** Override local I/O streams (tests). Defaults to process streams. */
  io?: AttachIO;
  /** Override the socket factory (tests). Defaults to a Bun `WebSocket`. */
  socketFactory?: AttachSocketFactory;
}

const defaultSocketFactory: AttachSocketFactory = (url, handlers) => {
  const ws = new WebSocket(url);
  ws.addEventListener("open", () => handlers.onOpen());
  ws.addEventListener("message", (ev: MessageEvent) => {
    const data =
      typeof ev.data === "string"
        ? ev.data
        : ev.data instanceof ArrayBuffer
          ? new TextDecoder().decode(ev.data)
          : String(ev.data);
    handlers.onMessage(data);
  });
  ws.addEventListener("close", () => handlers.onClose());
  ws.addEventListener("error", () =>
    handlers.onError(new Error("terminal attach websocket error")),
  );
  return {
    send: (data) => ws.send(data),
    close: () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
};

function defaultIO(): AttachIO {
  return {
    stdin: process.stdin as unknown as AttachStdin,
    stdout: process.stdout as unknown as AttachStdout,
    stderr: { write: (d) => process.stderr.write(d) },
  };
}

/**
 * Attach the local terminal to a daemon terminal-layer session over the
 * terminal WebSocket protocol. Forwards local stdin to input frames and local
 * resize events to resize frames, writes remote output to stdout, and resolves
 * with the remote command's exit code. Puts a TTY stdin into raw mode and
 * restores it on exit, transport error, or close.
 *
 * Resolves with {@link ATTACH_TRANSPORT_FAILURE_CODE} when the connection ends
 * before an exit frame is received.
 */
export function attachTerminal(opts: AttachOptions): Promise<number> {
  const io = opts.io ?? defaultIO();
  const factory = opts.socketFactory ?? defaultSocketFactory;
  const clientId = opts.clientId ?? crypto.randomUUID();
  const { stdin, stdout, stderr } = io;
  const isTTY = Boolean(stdin.isTTY) && typeof stdin.setRawMode === "function";

  const currentCols = (): number => stdout.columns ?? opts.cols;
  const currentRows = (): number => stdout.rows ?? opts.rows;

  return new Promise<number>((resolve) => {
    let settled = false;
    let exitCode: number | null = null;
    let rawEnabled = false;
    let onStdin: ((chunk: Buffer | string) => void) | null = null;
    let onResize: (() => void) | null = null;
    let socket: AttachSocket | null = null;

    const restoreRaw = (): void => {
      if (rawEnabled && typeof stdin.setRawMode === "function") {
        try {
          stdin.setRawMode(false);
        } catch {
          /* ignore */
        }
        rawEnabled = false;
      }
    };

    const cleanup = (): void => {
      if (onStdin) {
        try {
          stdin.removeListener("data", onStdin);
        } catch {
          /* ignore */
        }
        onStdin = null;
      }
      if (onResize) {
        try {
          stdout.removeListener("resize", onResize);
        } catch {
          /* ignore */
        }
        onResize = null;
      }
      restoreRaw();
      if (typeof stdin.pause === "function") {
        try {
          stdin.pause();
        } catch {
          /* ignore */
        }
      }
    };

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
      resolve(code);
    };

    const send = (frame: Parameters<typeof encodeTerminalClientFrame>[0]): void => {
      try {
        socket?.send(encodeTerminalClientFrame(frame));
      } catch {
        /* the close/error handler will reconcile */
      }
    };

    const handlers: AttachSocketHandlers = {
      onOpen() {
        send({
          type: "hello",
          v: TERMINAL_PROTOCOL_VERSION,
          clientId,
          cols: currentCols(),
          rows: currentRows(),
          desiredControl: "controller",
        });
        if (isTTY && typeof stdin.setRawMode === "function") {
          try {
            stdin.setRawMode(true);
            rawEnabled = true;
          } catch {
            /* fall back to cooked mode */
          }
        }
        onStdin = (chunk) => {
          const data =
            typeof chunk === "string" ? chunk : chunk.toString("utf8");
          send({ type: "input", v: TERMINAL_PROTOCOL_VERSION, data });
        };
        stdin.on("data", onStdin);
        if (typeof stdin.resume === "function") stdin.resume();
        onResize = () => {
          send({
            type: "resize",
            v: TERMINAL_PROTOCOL_VERSION,
            cols: currentCols(),
            rows: currentRows(),
          });
        };
        stdout.on("resize", onResize);
      },
      onMessage(raw) {
        let frame: TerminalServerFrame;
        try {
          frame = JSON.parse(raw) as TerminalServerFrame;
        } catch {
          return;
        }
        if (frame.type === "output") {
          stdout.write(frame.data);
          return;
        }
        if (frame.type === "exit") {
          const { exitCode: code, signal } = frame.exit;
          exitCode =
            typeof code === "number"
              ? code
              : typeof signal === "number"
                ? 128 + signal
                : 0;
          finish(exitCode);
          return;
        }
        if (frame.type === "error" && frame.fatal) {
          stderr.write(`wos exec: terminal error: ${frame.message}\n`);
          finish(ATTACH_TRANSPORT_FAILURE_CODE);
        }
      },
      onClose() {
        if (exitCode !== null) {
          finish(exitCode);
        } else {
          finish(ATTACH_TRANSPORT_FAILURE_CODE);
        }
      },
      onError(error) {
        if (settled) return;
        stderr.write(`wos exec: ${error.message}\n`);
        finish(ATTACH_TRANSPORT_FAILURE_CODE);
      },
    };

    socket = factory(opts.url, handlers);
  });
}
