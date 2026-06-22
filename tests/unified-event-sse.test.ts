import { test, expect, describe } from "bun:test";
import {
  decodeSseFrame,
  encodeSseFrame,
  encodeSseKeepalive,
  parseLastEventId,
  splitSseStream,
} from "@worktreeos/daemon/unified-event-sse";
import type { UnifiedEventEnvelope } from "@worktreeos/core/unified-events";
import { DaemonEventBus } from "@worktreeos/daemon/event-bus";
import { deploymentEventToUnified } from "@worktreeos/core/unified-events";

function sampleEnvelope(): UnifiedEventEnvelope {
  return {
    id: 42,
    timestamp: "2026-05-18T10:00:00.000Z",
    type: "log.appended",
    sessionName: "s1",
    event: {
      type: "log.appended",
      sessionName: "s1",
      channel: "deployment",
      stream: "stdout",
      chunk: "hello\n",
    },
  };
}

describe("encodeSseFrame", () => {
  test("emits id/event/data fields and double newline", () => {
    const frame = encodeSseFrame(sampleEnvelope());
    expect(frame.startsWith("id: 42\n")).toBe(true);
    expect(frame.includes("event: log.appended\n")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);
    const dataLine = frame
      .split("\n")
      .find((l) => l.startsWith("data: "))!
      .slice("data: ".length);
    const parsed = JSON.parse(dataLine);
    expect(parsed.id).toBe(42);
    expect(parsed.event.chunk).toBe("hello\n");
  });
});

describe("decodeSseFrame", () => {
  test("round-trips an encoded envelope", () => {
    const env = sampleEnvelope();
    const frame = encodeSseFrame(env);
    const decoded = decodeSseFrame(frame)!;
    expect(decoded.id).toBe(env.id);
    expect(decoded.event).toBe(env.type);
    const parsed = JSON.parse(decoded.data);
    expect(parsed.id).toBe(env.id);
  });

  test("ignores keepalive comments", () => {
    expect(decodeSseFrame(encodeSseKeepalive(new Date(0)))).toBeNull();
  });
});

describe("splitSseStream", () => {
  test("splits a buffer of multiple frames and keeps trailing partial", () => {
    const a = encodeSseFrame({ ...sampleEnvelope(), id: 1 });
    const b = encodeSseFrame({ ...sampleEnvelope(), id: 2 });
    const partial = "id: 3\nevent: log.appended\n";
    const { frames, rest } = splitSseStream(a + b + partial);
    expect(frames.length).toBe(2);
    expect(rest).toBe(partial);
  });
});

describe("parseLastEventId", () => {
  test("parses a numeric header", () => {
    expect(parseLastEventId("17")).toBe(17);
  });
  test("returns undefined for missing/invalid values", () => {
    expect(parseLastEventId(null)).toBeUndefined();
    expect(parseLastEventId("")).toBeUndefined();
    expect(parseLastEventId("not-a-number")).toBeUndefined();
    expect(parseLastEventId("-1")).toBeUndefined();
    expect(parseLastEventId("1.5")).toBeUndefined();
  });
});

describe("Last-Event-ID replay", () => {
  test("replays envelopes after the requested id", () => {
    const bus = new DaemonEventBus({ now: () => new Date(0) });
    bus.publish({ type: "project.removed", projectId: "a" });
    bus.publish({ type: "project.removed", projectId: "b" });
    bus.publish({ type: "project.removed", projectId: "c" });
    const sub = bus.subscribe(() => {}, { sinceId: parseLastEventId("1") });
    expect(sub.history.map((e) => e.id)).toEqual([2, 3]);
  });
});

describe("deploymentEventToUnified", () => {
  test("maps step events", () => {
    const out = deploymentEventToUnified("s1", "op-1", {
      type: "step",
      id: "compose-up",
      state: "running",
      message: "starting",
    });
    expect(out.length).toBe(1);
    expect(out[0]!.type).toBe("deployment.step");
  });

  test("maps log events to log.appended", () => {
    const out = deploymentEventToUnified("s1", "op-1", {
      type: "log",
      channel: "deployment",
      stream: "stdout",
      chunk: "x",
    });
    expect(out[0]!.type).toBe("log.appended");
  });

  test("maps volume-clone complete phase", () => {
    const out = deploymentEventToUnified("s1", "op-1", {
      type: "volume-clone",
      phase: "complete",
      path: "/v",
      index: 0,
      total: 1,
    });
    expect(out[0]!.type).toBe("deployment.volume-clone");
    expect((out[0] as { phase: string }).phase).toBe("complete");
  });

  test("maps complete and failure events", () => {
    expect(
      deploymentEventToUnified("s1", "op-1", { type: "complete", lastUp: "t" })[0]!.type,
    ).toBe("deployment.completed");
    expect(
      deploymentEventToUnified("s1", "op-1", { type: "failure", message: "bad" })[0]!.type,
    ).toBe("deployment.failed");
  });
});
