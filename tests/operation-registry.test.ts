import { test, expect, describe } from "bun:test";
import { OperationRegistry, isMutatingKind } from "@worktreeos/daemon/operation-registry";
import type { StreamEnvelope } from "@worktreeos/daemon/daemon-protocol";

function makeRegistry() {
  let i = 0;
  return new OperationRegistry({
    historyCapacity: 1000,
    now: () => new Date(0),
    newId: () => `op-${++i}`,
  });
}

describe("isMutatingKind", () => {
  test("up and down are mutating; status is not", () => {
    expect(isMutatingKind("up")).toBe(true);
    expect(isMutatingKind("down")).toBe(true);
    expect(isMutatingKind("status")).toBe(false);
  });
});

describe("OperationRegistry.begin", () => {
  test("starts a new mutating operation and exposes it as active", () => {
    const reg = makeRegistry();
    const r = reg.begin("session-1", "up");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.status).toBe("running");
    expect(reg.activeMutatingFor("session-1")?.operationId).toBe(r.record.operationId);
  });

  test("rejects concurrent mutating operations for the same session", () => {
    const reg = makeRegistry();
    const first = reg.begin("s", "up");
    expect(first.ok).toBe(true);
    const second = reg.begin("s", "down");
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.conflict.metadata.kind).toBe("up");
    expect(second.conflict.metadata.operationId).toBe(
      first.ok ? first.record.operationId : "",
    );
  });

  test("allows mutating operations for different sessions concurrently", () => {
    const reg = makeRegistry();
    const a = reg.begin("session-a", "up");
    const b = reg.begin("session-b", "up");
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  test("status operations never conflict even when an up is running", () => {
    const reg = makeRegistry();
    reg.begin("s", "up");
    const status = reg.begin("s", "status");
    expect(status.ok).toBe(true);
  });

  test("status operations never lock the session", () => {
    const reg = makeRegistry();
    reg.begin("s", "status");
    const up = reg.begin("s", "up");
    expect(up.ok).toBe(true);
  });
});

describe("OperationRegistry events", () => {
  test("observer emits monotonically increasing sequence numbers", () => {
    const reg = makeRegistry();
    const r = reg.begin("s", "up");
    if (!r.ok) throw new Error("begin failed");
    const obs = reg.observerFor(r.record);
    obs.emit({ type: "step", id: "prepare", state: "running" });
    obs.emit({ type: "step", id: "prepare", state: "done" });
    obs.emit({ type: "complete", lastUp: "2026-05-13T12:00:00.000Z" });
    const seq = r.record.history.map((e) => e.sequence);
    expect(seq).toEqual([1, 2, 3]);
  });

  test("subscribe delivers history and live envelopes", () => {
    const reg = makeRegistry();
    const r = reg.begin("s", "up");
    if (!r.ok) throw new Error("begin failed");
    const obs = reg.observerFor(r.record);
    obs.emit({ type: "step", id: "prepare", state: "running" });
    const live: StreamEnvelope[] = [];
    const { history, unsubscribe } = reg.subscribe(r.record, (e) => live.push(e));
    expect(history.length).toBe(1);
    obs.emit({ type: "step", id: "prepare", state: "done" });
    expect(live.length).toBe(1);
    expect(live[0]!.sequence).toBe(2);
    unsubscribe();
    obs.emit({ type: "complete", lastUp: "2026-05-13T12:00:00.000Z" });
    expect(live.length).toBe(1);
  });

  test("finish emits a terminal envelope and releases the session lock", () => {
    const reg = makeRegistry();
    const r = reg.begin("s", "up");
    if (!r.ok) throw new Error("begin failed");
    reg.finish(r.record, "succeeded");
    expect(r.record.status).toBe("succeeded");
    expect(reg.activeMutatingFor("s")).toBeNull();
    const last = r.record.history[r.record.history.length - 1]!;
    expect("terminal" in last).toBe(true);
    if ("terminal" in last) expect(last.terminal.status).toBe("succeeded");
  });

  test("finish releases lock for failed operations too", () => {
    const reg = makeRegistry();
    const r = reg.begin("s", "up");
    if (!r.ok) throw new Error("begin failed");
    reg.finish(r.record, "failed", "boom");
    expect(r.record.failureMessage).toBe("boom");
    expect(reg.activeMutatingFor("s")).toBeNull();
    const next = reg.begin("s", "up");
    expect(next.ok).toBe(true);
  });

  test("subscribe after finish only returns history (no live listener)", () => {
    const reg = makeRegistry();
    const r = reg.begin("s", "up");
    if (!r.ok) throw new Error("begin failed");
    const obs = reg.observerFor(r.record);
    obs.emit({ type: "step", id: "prepare", state: "running" });
    reg.finish(r.record, "succeeded");
    const live: StreamEnvelope[] = [];
    const { history } = reg.subscribe(r.record, (e) => live.push(e));
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(live.length).toBe(0);
  });

  test("history is bounded by capacity", () => {
    const reg = new OperationRegistry({ historyCapacity: 3 });
    const r = reg.begin("s", "up");
    if (!r.ok) throw new Error("begin failed");
    const obs = reg.observerFor(r.record);
    for (let i = 0; i < 10; i += 1) {
      obs.emit({ type: "step", id: "prepare", state: "running" });
    }
    expect(r.record.history.length).toBeLessThanOrEqual(3);
  });
});

describe("conflict metadata", () => {
  test("conflict response references the running operation id", () => {
    const reg = makeRegistry();
    const first = reg.begin("s", "up");
    if (!first.ok) throw new Error("begin failed");
    const second = reg.begin("s", "down");
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.conflict.metadata.operationId).toBe(first.record.operationId);
    expect(second.conflict.metadata.status).toBe("running");
    expect(second.conflict.metadata.sessionName).toBe("s");
  });
});
