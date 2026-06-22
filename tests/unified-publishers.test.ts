import { test, expect, describe } from "bun:test";
import { DaemonEventBus } from "@worktreeos/daemon/event-bus";
import {
  createTunnelEventPublisher,
  publishOperationConflict,
  publishOperationFinished,
  publishOperationStarted,
  publishProjectAdded,
  publishProjectUpdated,
  publishWorktreeStatusChanged,
  wrapObserverWithUnified,
} from "@worktreeos/daemon/unified-publishers";
import type { OperationRecord } from "@worktreeos/daemon/operation-registry";
import type { DeploymentObserver, DeploymentEvent } from "@worktreeos/core/events";

function makeBus() {
  return new DaemonEventBus({ now: () => new Date(0) });
}

function fakeRecord(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    operationId: "op-1",
    sessionName: "sess-1",
    kind: "up",
    status: "running",
    startedAt: new Date(0).toISOString(),
    history: [],
    subscribers: new Set(),
    ...overrides,
  };
}

describe("operation publishers", () => {
  test("publishes operation.started", () => {
    const bus = makeBus();
    publishOperationStarted(bus, fakeRecord(), "/w/1");
    const env = bus.subscribe(() => {}).history[0]!;
    expect(env.type).toBe("operation.started");
    expect(env.sessionName).toBe("sess-1");
    expect(env.operationId).toBe("op-1");
    expect(env.worktreePath).toBe("/w/1");
  });

  test("publishes operation.finished on success", () => {
    const bus = makeBus();
    publishOperationFinished(bus, fakeRecord({ status: "succeeded" }));
    const env = bus.subscribe(() => {}).history[0]!;
    expect(env.type).toBe("operation.finished");
  });

  test("publishes operation.failed when record is failed", () => {
    const bus = makeBus();
    publishOperationFinished(
      bus,
      fakeRecord({ status: "failed", failureMessage: "boom" }),
    );
    const env = bus.subscribe(() => {}).history[0]!;
    expect(env.type).toBe("operation.failed");
    expect((env.event as { message: string }).message).toBe("boom");
  });

  test("publishes worktree.deployment-status.changed pending with scope metadata", () => {
    const bus = makeBus();
    publishWorktreeStatusChanged(bus, "sess-1", "pending", {
      operationId: "op-1",
      worktreePath: "/w/1",
    });
    const env = bus.subscribe(() => {}).history[0]!;
    expect(env.type).toBe("worktree.deployment-status.changed");
    expect(env.sessionName).toBe("sess-1");
    expect(env.operationId).toBe("op-1");
    expect(env.worktreePath).toBe("/w/1");
    const payload = env.event as {
      sessionName: string;
      status: string;
    };
    expect(payload.sessionName).toBe("sess-1");
    expect(payload.status).toBe("pending");
  });

  test("publishes operation.conflict", () => {
    const bus = makeBus();
    publishOperationConflict(
      bus,
      "up",
      "sess-1",
      {
        operationId: "active",
        sessionName: "sess-1",
        kind: "up",
        status: "running",
        startedAt: new Date(0).toISOString(),
      },
      "/w/1",
    );
    const env = bus.subscribe(() => {}).history[0]!;
    expect(env.type).toBe("operation.conflict");
  });
});

describe("project publishers", () => {
  test("project.added", () => {
    const bus = makeBus();
    publishProjectAdded(bus, {
      id: "p1",
      displayName: "Demo",
      sourcePath: "/src/demo",
      createdAt: "",
      lastSeenAt: "",
    });
    const env = bus.subscribe(() => {}).history[0]!;
    expect(env.type).toBe("project.added");
    expect(env.projectId).toBe("p1");
  });

  test("project.updated", () => {
    const bus = makeBus();
    publishProjectUpdated(bus, {
      id: "p1",
      displayName: "Demo",
      sourcePath: "/src/demo",
      createdAt: "",
      lastSeenAt: "",
    });
    const env = bus.subscribe(() => {}).history[0]!;
    expect(env.type).toBe("project.updated");
  });
});

describe("wrapObserverWithUnified", () => {
  test("forwards deployment events to base observer and bus", () => {
    const bus = makeBus();
    const seen: DeploymentEvent[] = [];
    const base: DeploymentObserver = {
      emit(e) {
        seen.push(e);
      },
    };
    const wrapped = wrapObserverWithUnified(base, bus, {
      operationId: "op-1",
      sessionName: "sess-1",
      worktreePath: "/w/1",
    });
    wrapped.emit({ type: "step", id: "compose-up", state: "running" });
    wrapped.emit({
      type: "log",
      channel: "deployment",
      stream: "stdout",
      chunk: "hello",
    });
    expect(seen.length).toBe(2);
    const history = bus.subscribe(() => {}).history;
    expect(history.map((e) => e.type)).toEqual([
      "deployment.step",
      "log.appended",
    ]);
  });

  test("returns base unchanged when bus is missing", () => {
    const base: DeploymentObserver = { emit: () => {} };
    expect(wrapObserverWithUnified(base, undefined, {
      operationId: "op-1",
      sessionName: "sess-1",
    })).toBe(base);
  });
});

describe("tunnel publisher", () => {
  test("publishes opened/failed/closed/reset/dropped events", () => {
    const bus = makeBus();
    const publisher = createTunnelEventPublisher(bus);
    publisher.publishOpened("sess-1", {
      service: "web",
      containerPort: 3000,
      hostPort: 20000,
      state: "active",
      url: "https://x.lt",
      hostname: "x.lt",
    });
    publisher.publishFailed("sess-1", {
      service: "web",
      containerPort: 3001,
      hostPort: 20001,
      state: "failed",
      message: "bad",
    });
    publisher.publishClosed("sess-1", { service: "web", containerPort: 3000 });
    publisher.publishReset("sess-1");
    publisher.publishDropped("sess-1");
    const types = bus
      .subscribe(() => {})
      .history.map((e) => e.type);
    expect(types).toEqual([
      "tunnel.opened",
      "tunnel.failed",
      "tunnel.closed",
      "tunnel.reset",
      "tunnel.dropped",
    ]);
  });
});
