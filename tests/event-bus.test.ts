import { test, expect, describe } from "bun:test";
import { DaemonEventBus } from "@worktreeos/daemon/event-bus";
import type { UnifiedEventEnvelope } from "@worktreeos/core/unified-events";

function makeBus(historyCapacity = 100) {
  return new DaemonEventBus({
    historyCapacity,
    now: () => new Date(0),
  });
}

describe("DaemonEventBus.publish", () => {
  test("assigns monotonically increasing ids", () => {
    const bus = makeBus();
    const a = bus.publish({ type: "project.removed", projectId: "p1" });
    const b = bus.publish({ type: "project.removed", projectId: "p2" });
    const c = bus.publish({ type: "project.removed", projectId: "p3" });
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(c.id).toBe(3);
    expect(a.id < b.id && b.id < c.id).toBe(true);
  });

  test("stamps timestamp from the injected clock", () => {
    const bus = makeBus();
    const env = bus.publish({ type: "project.removed", projectId: "p" });
    expect(env.timestamp).toBe(new Date(0).toISOString());
  });

  test("preserves scope identifiers from publish options", () => {
    const bus = makeBus();
    const env = bus.publish(
      { type: "project.removed", projectId: "p1" },
      {
        projectId: "p1",
        sessionName: "s1",
        worktreePath: "/w/1",
        operationId: "op-1",
      },
    );
    expect(env.projectId).toBe("p1");
    expect(env.sessionName).toBe("s1");
    expect(env.worktreePath).toBe("/w/1");
    expect(env.operationId).toBe("op-1");
    expect(env.type).toBe("project.removed");
  });

  test("delivers envelopes to live subscribers", () => {
    const bus = makeBus();
    const seen: UnifiedEventEnvelope[] = [];
    const sub = bus.subscribe((env) => seen.push(env));
    bus.publish({ type: "project.removed", projectId: "p1" });
    bus.publish({ type: "project.removed", projectId: "p2" });
    expect(seen.map((e) => e.id)).toEqual([1, 2]);
    sub.unsubscribe();
  });
});

describe("DaemonEventBus history", () => {
  test("retains envelopes up to the configured capacity", () => {
    const bus = makeBus(3);
    bus.publish({ type: "project.removed", projectId: "a" });
    bus.publish({ type: "project.removed", projectId: "b" });
    bus.publish({ type: "project.removed", projectId: "c" });
    bus.publish({ type: "project.removed", projectId: "d" });
    expect(bus.retainedCount).toBe(3);
    const replay = bus.subscribe(() => {}).history;
    expect(replay.map((e) => (e.event as { projectId: string }).projectId)).toEqual([
      "b",
      "c",
      "d",
    ]);
  });

  test("subscribe replays history filtered by sinceId", () => {
    const bus = makeBus();
    bus.publish({ type: "project.removed", projectId: "a" });
    bus.publish({ type: "project.removed", projectId: "b" });
    bus.publish({ type: "project.removed", projectId: "c" });
    const sub = bus.subscribe(() => {}, { sinceId: 2 });
    expect(sub.history.map((e) => e.id)).toEqual([3]);
  });
});

describe("DaemonEventBus filters", () => {
  test("filters envelopes by sessionName", () => {
    const bus = makeBus();
    const seen: number[] = [];
    bus.subscribe((env) => seen.push(env.id), {
      filter: { sessionNames: ["s1"] },
    });
    bus.publish({ type: "log.appended", sessionName: "s1", channel: "deployment", stream: "stdout", chunk: "x" }, { sessionName: "s1" });
    bus.publish({ type: "log.appended", sessionName: "s2", channel: "deployment", stream: "stdout", chunk: "y" }, { sessionName: "s2" });
    bus.publish({ type: "log.appended", sessionName: "s1", channel: "deployment", stream: "stdout", chunk: "z" }, { sessionName: "s1" });
    expect(seen).toEqual([1, 3]);
  });

  test("filters envelopes by event type", () => {
    const bus = makeBus();
    const seen: string[] = [];
    bus.subscribe((env) => seen.push(env.type), {
      filter: { types: ["project.added"] },
    });
    bus.publish({
      type: "project.added",
      project: { projectId: "p", name: "P", sourcePath: "/p" },
    });
    bus.publish({ type: "project.removed", projectId: "p" });
    expect(seen).toEqual(["project.added"]);
  });

  test("history reflects the filter", () => {
    const bus = makeBus();
    bus.publish({ type: "log.appended", sessionName: "s1", channel: "deployment", stream: "stdout", chunk: "x" }, { sessionName: "s1" });
    bus.publish({ type: "log.appended", sessionName: "s2", channel: "deployment", stream: "stdout", chunk: "y" }, { sessionName: "s2" });
    const sub = bus.subscribe(() => {}, { filter: { sessionNames: ["s2"] } });
    expect(sub.history.length).toBe(1);
    expect(sub.history[0]!.sessionName).toBe("s2");
  });
});

describe("DaemonEventBus subscriber isolation", () => {
  test("subscriber error does not stop publication for others", () => {
    const bus = makeBus();
    const good: number[] = [];
    bus.subscribe(() => {
      throw new Error("subscriber boom");
    });
    bus.subscribe((env) => good.push(env.id));
    bus.publish({ type: "project.removed", projectId: "p" });
    bus.publish({ type: "project.removed", projectId: "p2" });
    expect(good).toEqual([1, 2]);
  });

  test("unsubscribe removes the listener", () => {
    const bus = makeBus();
    const seen: number[] = [];
    const sub = bus.subscribe((env) => seen.push(env.id));
    bus.publish({ type: "project.removed", projectId: "p" });
    sub.unsubscribe();
    bus.publish({ type: "project.removed", projectId: "q" });
    expect(seen).toEqual([1]);
    expect(bus.subscriberCount).toBe(0);
  });

  test("shutdown clears subscribers and history", () => {
    const bus = makeBus();
    bus.subscribe(() => {});
    bus.publish({ type: "project.removed", projectId: "p" });
    bus.shutdown();
    expect(bus.subscriberCount).toBe(0);
    expect(bus.retainedCount).toBe(0);
  });
});
