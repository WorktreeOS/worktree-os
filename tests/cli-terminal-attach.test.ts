import { test, expect, describe } from "bun:test";
import {
  attachTerminal,
  ATTACH_TRANSPORT_FAILURE_CODE,
  type AttachIO,
  type AttachSocketFactory,
  type AttachSocketHandlers,
} from "../apps/cli/commands/terminal-attach";
import {
  encodeTerminalServerFrame,
  TERMINAL_PROTOCOL_VERSION,
  type TerminalServerFrame,
} from "@worktreeos/daemon/terminal-layer/protocol";

class FakeStdin {
  isTTY = true;
  rawModeCalls: boolean[] = [];
  resumed = false;
  paused = false;
  private listeners = new Set<(chunk: Buffer | string) => void>();
  setRawMode(mode: boolean): void {
    this.rawModeCalls.push(mode);
  }
  on(_event: "data", listener: (chunk: Buffer | string) => void): void {
    this.listeners.add(listener);
  }
  removeListener(_event: "data", listener: (chunk: Buffer | string) => void): void {
    this.listeners.delete(listener);
  }
  resume(): void {
    this.resumed = true;
  }
  pause(): void {
    this.paused = true;
  }
  emitData(chunk: Buffer | string): void {
    for (const l of this.listeners) l(chunk);
  }
}

class FakeStdout {
  columns = 80;
  rows = 24;
  written: string[] = [];
  private listeners = new Set<() => void>();
  write(data: string): void {
    this.written.push(data);
  }
  on(_event: "resize", listener: () => void): void {
    this.listeners.add(listener);
  }
  removeListener(_event: "resize", listener: () => void): void {
    this.listeners.delete(listener);
  }
  emitResize(): void {
    for (const l of this.listeners) l();
  }
}

interface Harness {
  io: AttachIO;
  stdin: FakeStdin;
  stdout: FakeStdout;
  stderr: { written: string[] };
  sent: string[];
  handlers: AttachSocketHandlers;
  closed: { value: boolean };
  factory: AttachSocketFactory;
}

function makeHarness(): Harness {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const stderrWritten: string[] = [];
  const sent: string[] = [];
  const closed = { value: false };
  let captured: AttachSocketHandlers | undefined;
  const factory: AttachSocketFactory = (_url, handlers) => {
    captured = handlers;
    return {
      send: (data) => sent.push(data),
      close: () => {
        closed.value = true;
      },
    };
  };
  const io: AttachIO = {
    stdin: stdin as unknown as AttachIO["stdin"],
    stdout: stdout as unknown as AttachIO["stdout"],
    stderr: { write: (d) => stderrWritten.push(d) },
  };
  return {
    io,
    stdin,
    stdout,
    stderr: { written: stderrWritten },
    sent,
    get handlers() {
      if (!captured) throw new Error("factory not invoked yet");
      return captured;
    },
    closed,
    factory,
  };
}

function serverFrame(frame: TerminalServerFrame): string {
  return encodeTerminalServerFrame(frame);
}

function parsedSent(sent: string[]): TerminalServerFrame[] {
  return sent.map((s) => JSON.parse(s) as TerminalServerFrame);
}

describe("attachTerminal", () => {
  test("sends a controller hello and enables raw mode on open", async () => {
    const h = makeHarness();
    const p = attachTerminal({
      url: "ws://x/attach",
      cols: 80,
      rows: 24,
      io: h.io,
      socketFactory: h.factory,
    });
    h.handlers.onOpen();
    const hello = parsedSent(h.sent)[0] as unknown as {
      type: string;
      desiredControl: string;
      cols: number;
    };
    expect(hello.type).toBe("hello");
    expect(hello.desiredControl).toBe("controller");
    expect(h.stdin.rawModeCalls).toEqual([true]);
    expect(h.stdin.resumed).toBe(true);
    // finish the session so the promise resolves
    h.handlers.onMessage(
      serverFrame({ type: "exit", v: TERMINAL_PROTOCOL_VERSION, exit: { exitedAt: "t", exitCode: 0 } }),
    );
    await p;
  });

  test("writes remote output to stdout", async () => {
    const h = makeHarness();
    const p = attachTerminal({ url: "ws://x", cols: 80, rows: 24, io: h.io, socketFactory: h.factory });
    h.handlers.onOpen();
    h.handlers.onMessage(
      serverFrame({ type: "output", v: TERMINAL_PROTOCOL_VERSION, seq: 1, data: "hello\n" }),
    );
    expect(h.stdout.written).toContain("hello\n");
    h.handlers.onMessage(
      serverFrame({ type: "exit", v: TERMINAL_PROTOCOL_VERSION, exit: { exitedAt: "t", exitCode: 0 } }),
    );
    await p;
  });

  test("forwards local stdin to input frames and resize to resize frames", async () => {
    const h = makeHarness();
    const p = attachTerminal({ url: "ws://x", cols: 80, rows: 24, io: h.io, socketFactory: h.factory });
    h.handlers.onOpen();
    h.sent.length = 0;
    h.stdin.emitData("ls\n");
    h.stdout.columns = 120;
    h.stdout.rows = 40;
    h.stdout.emitResize();
    const frames = parsedSent(h.sent) as unknown as Array<{
      type: string;
      data?: string;
      cols?: number;
      rows?: number;
    }>;
    expect(frames[0]).toMatchObject({ type: "input", data: "ls\n" });
    expect(frames[1]).toMatchObject({ type: "resize", cols: 120, rows: 40 });
    h.handlers.onMessage(
      serverFrame({ type: "exit", v: TERMINAL_PROTOCOL_VERSION, exit: { exitedAt: "t", exitCode: 0 } }),
    );
    await p;
  });

  test("resolves with the remote exit code and restores raw mode", async () => {
    const h = makeHarness();
    const p = attachTerminal({ url: "ws://x", cols: 80, rows: 24, io: h.io, socketFactory: h.factory });
    h.handlers.onOpen();
    h.handlers.onMessage(
      serverFrame({ type: "exit", v: TERMINAL_PROTOCOL_VERSION, exit: { exitedAt: "t", exitCode: 7 } }),
    );
    const code = await p;
    expect(code).toBe(7);
    expect(h.stdin.rawModeCalls).toEqual([true, false]);
    expect(h.closed.value).toBe(true);
  });

  test("maps a signal-only exit to 128 + signal", async () => {
    const h = makeHarness();
    const p = attachTerminal({ url: "ws://x", cols: 80, rows: 24, io: h.io, socketFactory: h.factory });
    h.handlers.onOpen();
    h.handlers.onMessage(
      serverFrame({ type: "exit", v: TERMINAL_PROTOCOL_VERSION, exit: { exitedAt: "t", signal: 9 } }),
    );
    expect(await p).toBe(137);
  });

  test("returns the transport failure code when the socket closes before exit", async () => {
    const h = makeHarness();
    const p = attachTerminal({ url: "ws://x", cols: 80, rows: 24, io: h.io, socketFactory: h.factory });
    h.handlers.onOpen();
    h.handlers.onClose();
    const code = await p;
    expect(code).toBe(ATTACH_TRANSPORT_FAILURE_CODE);
    expect(h.stdin.rawModeCalls).toEqual([true, false]);
  });

  test("treats a fatal error frame as transport failure", async () => {
    const h = makeHarness();
    const p = attachTerminal({ url: "ws://x", cols: 80, rows: 24, io: h.io, socketFactory: h.factory });
    h.handlers.onOpen();
    h.handlers.onMessage(
      serverFrame({
        type: "error",
        v: TERMINAL_PROTOCOL_VERSION,
        code: "not-found",
        message: "terminal session gone",
        fatal: true,
      }),
    );
    const code = await p;
    expect(code).toBe(ATTACH_TRANSPORT_FAILURE_CODE);
    expect(h.stderr.written.join("")).toContain("terminal session gone");
  });

  test("does not enable raw mode when stdin is not a TTY", async () => {
    const h = makeHarness();
    h.stdin.isTTY = false;
    const p = attachTerminal({ url: "ws://x", cols: 80, rows: 24, io: h.io, socketFactory: h.factory });
    h.handlers.onOpen();
    expect(h.stdin.rawModeCalls).toEqual([]);
    h.handlers.onMessage(
      serverFrame({ type: "exit", v: TERMINAL_PROTOCOL_VERSION, exit: { exitedAt: "t", exitCode: 0 } }),
    );
    await p;
  });
});
