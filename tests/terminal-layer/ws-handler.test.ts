import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalSessionManager } from "@worktreeos/daemon/terminal-layer/manager";
import { createFakeTerminalRuntime } from "@worktreeos/daemon/terminal-layer/testing";
import {
  createTerminalLayerWsHandlers,
  type TerminalLayerWsData,
} from "@worktreeos/daemon/terminal-layer/ws-handler";

interface FakeWs {
  data: TerminalLayerWsData;
  sent: string[];
  closed: Array<{ code: number; reason: string }>;
  close: (code?: number, reason?: string) => void;
  send: (msg: string) => number;
  getBufferedAmount: () => number;
}

function makeWs(data: TerminalLayerWsData): FakeWs {
  const sent: string[] = [];
  const closed: Array<{ code: number; reason: string }> = [];
  return {
    data,
    sent,
    closed,
    send(msg: string) {
      sent.push(msg);
      return msg.length;
    },
    close(code = 1000, reason = "") {
      closed.push({ code, reason });
    },
    getBufferedAmount() {
      return 0;
    },
  };
}

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "wos-tlayer-ws-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("terminal-layer WebSocket handlers", () => {
  test("open against an unknown session sends not-found fatal error and closes", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    const h = createTerminalLayerWsHandlers(mgr);
    const ws = makeWs({
      kind: "terminal-layer",
      terminalId: "missing",
      attachmentId: "a1",
    });
    h.open(ws as any);
    const sent = ws.sent.map((m) => JSON.parse(m));
    expect(sent.some((m) => m.type === "error" && m.code === "not-found")).toBe(true);
    expect(ws.closed.length).toBeGreaterThan(0);
  });

  test("first frame must be hello — other frames are rejected", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    const meta = await mgr.create({ worktreePath: tmp });
    const h = createTerminalLayerWsHandlers(mgr);
    const ws = makeWs({
      kind: "terminal-layer",
      terminalId: meta.id,
      attachmentId: "a1",
    });
    h.open(ws as any);
    h.message(ws as any, JSON.stringify({ type: "input", v: 1, data: "x" }));
    const sent = ws.sent.map((m) => JSON.parse(m));
    expect(sent.some((m) => m.type === "error" && m.code === "invalid-message")).toBe(true);
  });

  test("hello triggers attach and emits hello-ack", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    const meta = await mgr.create({ worktreePath: tmp });
    const h = createTerminalLayerWsHandlers(mgr);
    const ws = makeWs({
      kind: "terminal-layer",
      terminalId: meta.id,
      attachmentId: "a1",
    });
    h.open(ws as any);
    h.message(
      ws as any,
      JSON.stringify({
        type: "hello",
        v: 1,
        clientId: "c1",
        cols: 80,
        rows: 24,
        desiredControl: "controller",
      }),
    );
    // Manager.attach is async — let the queue drain.
    await Promise.resolve();
    await Promise.resolve();
    const sent = ws.sent.map((m) => JSON.parse(m));
    expect(sent.some((m) => m.type === "hello-ack")).toBe(true);
  });

  test("unsupported protocol version sends fatal error", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    const meta = await mgr.create({ worktreePath: tmp });
    const h = createTerminalLayerWsHandlers(mgr);
    const ws = makeWs({
      kind: "terminal-layer",
      terminalId: meta.id,
      attachmentId: "a1",
    });
    h.open(ws as any);
    h.message(
      ws as any,
      JSON.stringify({
        type: "hello",
        v: 99,
        clientId: "c1",
        cols: 80,
        rows: 24,
        desiredControl: "controller",
      }),
    );
    const sent = ws.sent.map((m) => JSON.parse(m));
    expect(sent.some((m) => m.type === "error" && m.code === "version-unsupported")).toBe(true);
    expect(ws.closed.length).toBeGreaterThan(0);
  });

  test("close after attach triggers detach", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    const meta = await mgr.create({ worktreePath: tmp });
    const h = createTerminalLayerWsHandlers(mgr);
    const ws = makeWs({
      kind: "terminal-layer",
      terminalId: meta.id,
      attachmentId: "a1",
    });
    h.open(ws as any);
    h.message(
      ws as any,
      JSON.stringify({
        type: "hello",
        v: 1,
        clientId: "c1",
        cols: 80,
        rows: 24,
        desiredControl: "controller",
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(ws.data.attached).toBe(true);
    h.close(ws as any, 1000, "bye");
    await new Promise((r) => setTimeout(r, 5));
    expect(mgr.get(meta.id)!.attachments?.length ?? 0).toBe(0);
  });
});
