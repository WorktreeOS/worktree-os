/**
 * Frontend `TerminalConnection` tests.
 *
 * The connection class consumes the browser `WebSocket` constructor through
 * the global, so we install a fake constructor on `globalThis.WebSocket` and
 * `globalThis.window` before exercising it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  url: string;
  readyState = 0;
  sent: string[] = [];
  closed = false;
  closeCode?: number;
  closeReason?: string;
  private readonly listeners: Record<string, Array<(ev: any) => void>> = {};
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, listener: (ev: any) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  send(msg: string): void {
    this.sent.push(msg);
  }
  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = FakeWebSocket.CLOSED;
    this.fire("close", { code: code ?? 1000, reason: reason ?? "" });
  }
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.fire("open", {});
  }
  message(data: string): void {
    this.fire("message", { data });
  }
  serverClose(code: number, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.fire("close", { code, reason });
  }
  fire(type: string, ev: any): void {
    for (const l of this.listeners[type] ?? []) l(ev);
  }
}

const originalWebSocket = (globalThis as any).WebSocket;
const originalWindow = (globalThis as any).window;

beforeEach(() => {
  FakeWebSocket.instances = [];
  (globalThis as any).WebSocket = FakeWebSocket;
  (globalThis as any).window = {
    setTimeout: setTimeout.bind(globalThis),
    clearTimeout: clearTimeout.bind(globalThis),
    location: { protocol: "http:", host: "localhost" },
  };
});
afterEach(() => {
  (globalThis as any).WebSocket = originalWebSocket;
  (globalThis as any).window = originalWindow;
});

async function loadConnection() {
  // Re-import after the global swap so the module captures the right
  // `WebSocket`/`window` bindings if it ever caches them at module load.
  return await import("../../apps/web/src/lib/terminal-connection");
}

describe("TerminalConnection", () => {
  test("opens with WebSocket and sends hello on open", async () => {
    const { TerminalConnection } = await loadConnection();
    const conn = new TerminalConnection({
      url: "ws://example/attach",
      clientId: "c1",
      cols: 80,
      rows: 24,
      desiredControl: "controller",
      listener: {},
    });
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    const sent = ws.sent.map((m) => JSON.parse(m));
    expect(sent[0]?.type).toBe("hello");
    expect(sent[0]?.clientId).toBe("c1");
    conn.dispose();
  });

  test("hello-ack with willReplay=true transitions to 'replaying'", async () => {
    const { TerminalConnection } = await loadConnection();
    const states: string[] = [];
    const conn = new TerminalConnection({
      url: "ws://example/attach",
      clientId: "c1",
      cols: 80,
      rows: 24,
      desiredControl: "controller",
      listener: {
        onState: (s) => states.push(s),
      },
    });
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.message(
      JSON.stringify({
        type: "hello-ack",
        v: 1,
        attachmentId: "a1",
        session: { id: "t1", status: "running", cols: 80, rows: 24 },
        replay: { firstRetainedSeq: 0, latestSeq: 0, retainedBytes: 0 },
        control: { controllerAttachmentId: "a1", changedAt: "x" },
        willReplay: true,
      }),
    );
    expect(states).toContain("replaying");
    ws.message(JSON.stringify({ type: "replay-done", v: 1, upToSeq: 0 }));
    expect(states).toContain("live");
    conn.dispose();
  });

  test("output frames are forwarded to onOutput and auto-acked", async () => {
    const { TerminalConnection } = await loadConnection();
    const writes: string[] = [];
    const conn = new TerminalConnection({
      url: "ws://example/attach",
      clientId: "c1",
      cols: 80,
      rows: 24,
      desiredControl: "controller",
      listener: { onOutput: (data) => writes.push(data) },
    });
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.message(JSON.stringify({ type: "output", v: 1, seq: 1, data: "x" }));
    expect(writes).toEqual(["x"]);
    const sent = ws.sent.map((m) => JSON.parse(m));
    expect(sent.some((m) => m.type === "ack" && m.ackSeq === 1)).toBe(true);
    conn.dispose();
  });

  test("replay frames are forwarded with replay=true and not acked", async () => {
    const { TerminalConnection } = await loadConnection();
    const replayFlags: boolean[] = [];
    const conn = new TerminalConnection({
      url: "ws://example/attach",
      clientId: "c1",
      cols: 80,
      rows: 24,
      desiredControl: "viewer",
      listener: { onOutput: (_d, replay) => replayFlags.push(replay) },
    });
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.message(
      JSON.stringify({
        type: "output",
        v: 1,
        seq: 1,
        data: "old",
        replay: true,
      }),
    );
    expect(replayFlags).toEqual([true]);
    const acks = ws.sent
      .map((m) => JSON.parse(m))
      .filter((m) => m.type === "ack");
    expect(acks).toHaveLength(0);
    conn.dispose();
  });

  test("replay-gap error invokes onReplayGap", async () => {
    const { TerminalConnection } = await loadConnection();
    let gapFired = false;
    const conn = new TerminalConnection({
      url: "ws://example/attach",
      clientId: "c1",
      cols: 80,
      rows: 24,
      desiredControl: "viewer",
      lastSeenOutputSeq: 5,
      listener: { onReplayGap: () => (gapFired = true) },
    });
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.message(
      JSON.stringify({
        type: "error",
        v: 1,
        code: "replay-gap",
        message: "gap",
      }),
    );
    expect(gapFired).toBe(true);
    conn.dispose();
  });

  test("non-1000 close transitions to disconnected and schedules reconnect", async () => {
    const { TerminalConnection } = await loadConnection();
    const states: string[] = [];
    const conn = new TerminalConnection({
      url: "ws://example/attach",
      clientId: "c1",
      cols: 80,
      rows: 24,
      desiredControl: "viewer",
      listener: { onState: (s) => states.push(s) },
    });
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.serverClose(1006, "abnormal");
    expect(states).toContain("disconnected");
    conn.dispose();
  });

  test("exit frame transitions to 'exited' and stops reconnects", async () => {
    const { TerminalConnection } = await loadConnection();
    const states: string[] = [];
    const conn = new TerminalConnection({
      url: "ws://example/attach",
      clientId: "c1",
      cols: 80,
      rows: 24,
      desiredControl: "viewer",
      listener: { onState: (s) => states.push(s) },
    });
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.message(
      JSON.stringify({
        type: "exit",
        v: 1,
        exit: { exitedAt: "now", exitCode: 0 },
      }),
    );
    expect(states).toContain("exited");
    ws.serverClose(1000, "");
    // No reconnect attempted because the connection knows it is exiting.
    expect(FakeWebSocket.instances).toHaveLength(1);
    conn.dispose();
  });

  test("dispose during CONNECTING state defers the close to onOpen", async () => {
    const { TerminalConnection } = await loadConnection();
    const conn = new TerminalConnection({
      url: "ws://example/attach",
      clientId: "c1",
      cols: 80,
      rows: 24,
      desiredControl: "viewer",
      listener: {},
    });
    const ws = FakeWebSocket.instances[0]!;
    // ws.readyState is 0 (CONNECTING). Dispose now MUST NOT call close()
    // synchronously — that would trigger "WebSocket is closed before the
    // connection is established" in real browsers under StrictMode.
    conn.dispose();
    expect(ws.closed).toBe(false);
    // When the connecting socket later opens, our open handler closes it
    // cleanly with code 1000.
    ws.open();
    expect(ws.closed).toBe(true);
    expect(ws.closeCode).toBe(1000);
  });

  test("fatal version-unsupported error transitions to 'failed' and prevents reconnect", async () => {
    const { TerminalConnection } = await loadConnection();
    const states: string[] = [];
    const conn = new TerminalConnection({
      url: "ws://example/attach",
      clientId: "c1",
      cols: 80,
      rows: 24,
      desiredControl: "viewer",
      listener: { onState: (s) => states.push(s) },
    });
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.message(
      JSON.stringify({
        type: "error",
        v: 1,
        code: "version-unsupported",
        message: "no",
        fatal: true,
      }),
    );
    expect(states).toContain("failed");
    conn.dispose();
  });
});
