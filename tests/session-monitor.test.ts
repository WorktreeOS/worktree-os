import { test, expect, describe } from "bun:test";
import { DaemonEventBus } from "@worktreeos/daemon/event-bus";
import {
  SessionMonitorRegistry,
  type MonitorSnapshot,
  type SnapshotCollector,
} from "@worktreeos/daemon/session-monitor";
import type { UnifiedEventEnvelope } from "@worktreeos/core/unified-events";

function snapshot(
  compose: MonitorSnapshot["compose"] = [],
  healthchecks: MonitorSnapshot["healthchecks"] = [],
  tunnels: MonitorSnapshot["tunnels"] = [],
): MonitorSnapshot {
  return { compose, healthchecks, tunnels };
}

function scriptedCollector(steps: MonitorSnapshot[]): SnapshotCollector {
  let i = 0;
  return {
    async collect() {
      const next = steps[Math.min(i, steps.length - 1)]!;
      i += 1;
      return next;
    },
  };
}

class ManualScheduler {
  fires: Array<() => void> = [];
  schedule = (cb: () => void): { cancel(): void } => {
    this.fires.push(cb);
    return {
      cancel: () => {
        this.fires = this.fires.filter((f) => f !== cb);
      },
    };
  };
}

function makeRegistry() {
  const events = new DaemonEventBus({ now: () => new Date(0) });
  const captured: UnifiedEventEnvelope[] = [];
  events.subscribe((e) => captured.push(e));
  const sched = new ManualScheduler();
  const registry = new SessionMonitorRegistry(events, {
    schedule: sched.schedule,
  });
  return { events, captured, registry };
}

describe("SessionMonitorRegistry baseline", () => {
  test("first collection does not emit events", async () => {
    const { registry, captured } = makeRegistry();
    registry.start(
      "s1",
      scriptedCollector([
        snapshot([{ service: "web", state: "running" }]),
      ]),
    );
    await registry.tickNow("s1");
    expect(captured.length).toBe(0);
    registry.stop("s1");
  });
});

describe("SessionMonitorRegistry compose diffing", () => {
  test("emits service.crashed when running → exited", async () => {
    const { registry, captured } = makeRegistry();
    const steps = [
      snapshot([{ service: "web", state: "running" }]),
      snapshot([{ service: "web", state: "exited", status: "Exit 1" }]),
    ];
    registry.start("s1", scriptedCollector(steps));
    await registry.tickNow("s1");
    await registry.tickNow("s1");
    const types = captured.map((e) => e.type);
    expect(types).toContain("service.crashed");
    expect(types).toContain("compose.status.changed");
    expect(types).toContain("worktree.deployment-status.changed");
    registry.stop("s1");
  });

  test("emits service.stopped when running → stopped", async () => {
    const { registry, captured } = makeRegistry();
    registry.start(
      "s1",
      scriptedCollector([
        snapshot([{ service: "api", state: "running" }]),
        snapshot([{ service: "api", state: "stopped" }]),
      ]),
    );
    await registry.tickNow("s1");
    await registry.tickNow("s1");
    expect(captured.find((e) => e.type === "service.stopped")).toBeDefined();
    registry.stop("s1");
  });

  test("emits no events when snapshots are unchanged", async () => {
    const { registry, captured } = makeRegistry();
    const same = snapshot([{ service: "web", state: "running" }]);
    registry.start("s1", scriptedCollector([same, same, same]));
    await registry.tickNow("s1");
    await registry.tickNow("s1");
    await registry.tickNow("s1");
    expect(captured.length).toBe(0);
    registry.stop("s1");
  });
});

describe("SessionMonitorRegistry healthcheck diffing", () => {
  test("emits healthcheck.changed on state transition", async () => {
    const { registry, captured } = makeRegistry();
    registry.start(
      "s1",
      scriptedCollector([
        snapshot(
          [{ service: "web", state: "running" }],
          [{ service: "web", containerPort: 3000, state: "waiting" }],
        ),
        snapshot(
          [{ service: "web", state: "running" }],
          [{ service: "web", containerPort: 3000, state: "healthy" }],
        ),
      ]),
    );
    await registry.tickNow("s1");
    await registry.tickNow("s1");
    const hc = captured.find((e) => e.type === "healthcheck.changed");
    expect(hc).toBeDefined();
    const evt = hc!.event as { previous?: string; state: string };
    expect(evt.previous).toBe("waiting");
    expect(evt.state).toBe("healthy");
    registry.stop("s1");
  });
});

describe("SessionMonitorRegistry tunnel diffing", () => {
  test("emits tunnel.opened and tunnel.failed on state changes", async () => {
    const { registry, captured } = makeRegistry();
    registry.start(
      "s1",
      scriptedCollector([
        snapshot(
          [{ service: "web", state: "running" }],
          [],
          [
            {
              service: "web",
              containerPort: 3000,
              hostPort: 20001,
              state: "failed",
              message: "down",
            },
          ],
        ),
        snapshot(
          [{ service: "web", state: "running" }],
          [],
          [
            {
              service: "web",
              containerPort: 3000,
              hostPort: 20001,
              state: "active",
              url: "https://x",
              hostname: "x",
            },
          ],
        ),
      ]),
    );
    await registry.tickNow("s1");
    await registry.tickNow("s1");
    expect(captured.find((e) => e.type === "tunnel.opened")).toBeDefined();
    registry.stop("s1");
  });
});

describe("SessionMonitorRegistry deployment status (new lifecycle)", () => {
  test("emits running_partial when one service stops", async () => {
    const { registry, captured } = makeRegistry();
    registry.start(
      "s1",
      scriptedCollector([
        snapshot([
          { service: "web", state: "running" },
          { service: "api", state: "running" },
        ]),
        snapshot([
          { service: "web", state: "running" },
          { service: "api", state: "stopped" },
        ]),
      ]),
    );
    await registry.tickNow("s1");
    await registry.tickNow("s1");
    const status = captured.find(
      (e) => e.type === "worktree.deployment-status.changed",
    );
    expect(status).toBeDefined();
    const evt = status!.event as {
      status: string;
      summary?: { running: number; total: number };
    };
    expect(evt.status).toBe("running_partial");
    expect(evt.summary?.running).toBe(1);
    expect(evt.summary?.total).toBe(2);
    registry.stop("s1");
  });

  test("emits running_partial when healthcheck fails (compose still running)", async () => {
    const { registry, captured } = makeRegistry();
    registry.start(
      "s1",
      scriptedCollector([
        snapshot(
          [{ service: "web", state: "running" }],
          [{ service: "web", containerPort: 3000, state: "healthy" }],
        ),
        snapshot(
          [{ service: "web", state: "running" }],
          [{ service: "web", containerPort: 3000, state: "failed" }],
        ),
      ]),
    );
    await registry.tickNow("s1");
    await registry.tickNow("s1");
    const status = captured.find(
      (e) => e.type === "worktree.deployment-status.changed",
    );
    expect(status).toBeDefined();
    const evt = status!.event as { status: string };
    expect(evt.status).toBe("running_partial");
    registry.stop("s1");
  });

  test("emits status event when only summary counts change", async () => {
    const { registry, captured } = makeRegistry();
    // Both ticks classify as running_partial overall, but service counts
    // change so an aggregate event MUST still fire on the second transition.
    registry.start(
      "s1",
      scriptedCollector([
        snapshot([
          { service: "web", state: "running" },
          { service: "api", state: "running" },
          { service: "db", state: "stopped" },
        ]),
        snapshot([
          { service: "web", state: "running" },
          { service: "api", state: "stopped" },
          { service: "db", state: "stopped" },
        ]),
      ]),
    );
    await registry.tickNow("s1");
    await registry.tickNow("s1");
    const statusEvents = captured.filter(
      (e) => e.type === "worktree.deployment-status.changed",
    );
    expect(statusEvents.length).toBe(1);
    const evt = statusEvents[0]!.event as {
      status: string;
      summary?: { running: number; total: number };
    };
    expect(evt.status).toBe("running_partial");
    expect(evt.summary?.running).toBe(1);
    expect(evt.summary?.total).toBe(3);
    registry.stop("s1");
  });

  test("collector throws repeatedly → no aggregate events emitted", async () => {
    const { registry, captured } = makeRegistry();
    const failing: SnapshotCollector = {
      async collect() {
        throw new Error("docker unreachable");
      },
    };
    registry.start("s1", failing);
    await registry.tickNow("s1");
    await registry.tickNow("s1");
    expect(captured.length).toBe(0);
    registry.stop("s1");
  });
});

describe("SessionMonitorRegistry resilience", () => {
  test("collector throws → next tick still works", async () => {
    const { registry, captured } = makeRegistry();
    let calls = 0;
    const flaky: SnapshotCollector = {
      async collect() {
        calls += 1;
        if (calls === 1) return snapshot([{ service: "web", state: "running" }]);
        if (calls === 2) throw new Error("kaboom");
        return snapshot([{ service: "web", state: "exited" }]);
      },
    };
    registry.start("s1", flaky);
    await registry.tickNow("s1"); // baseline
    await registry.tickNow("s1"); // throws → no event, baseline still in place
    expect(captured.length).toBe(0);
    await registry.tickNow("s1"); // exited compared to baseline → crashed
    expect(captured.find((e) => e.type === "service.crashed")).toBeDefined();
    registry.stop("s1");
  });

  test("stop releases the monitor", () => {
    const { registry } = makeRegistry();
    registry.start("s1", scriptedCollector([snapshot()]));
    expect(registry.has("s1")).toBe(true);
    registry.stop("s1");
    expect(registry.has("s1")).toBe(false);
    expect(registry.size()).toBe(0);
  });

  test("shutdown clears all monitors", () => {
    const { registry } = makeRegistry();
    registry.start("s1", scriptedCollector([snapshot()]));
    registry.start("s2", scriptedCollector([snapshot()]));
    expect(registry.size()).toBe(2);
    registry.shutdown();
    expect(registry.size()).toBe(0);
  });
});

describe("createRuntimeCollector selective generated scope", () => {
  test("returns only healthchecks for deployed app services", async () => {
    const { createRuntimeCollector } = await import(
      "@worktreeos/daemon/session-monitor-runtime"
    );
    const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
    const { DEFAULT_HOST_PORT_RANGE } = await import("@worktreeos/core/config");
    const config = {
      cloneVolumes: [],
      app: {
        image: "node:22",
        initScript: [],
        services: {
          api: {
            image: null,
            ports: [
              {
                containerPort: 3000,
                allowFailure: false,
                healthcheck: {
                  enabled: true,
                  url: "/",
                  expectedStatus: 200,
                  timeoutMs: 5000,
                  startPeriodMs: 10000,
                  intervalMs: 10000,
                  retries: 3,
                },
              },
            ],
            script: [],
            cwd: null,
            envFile: null,
            environment: {},
            volumes: [],
          },
          admin: {
            image: null,
            ports: [
              {
                containerPort: 5000,
                allowFailure: false,
                healthcheck: {
                  enabled: true,
                  url: "/",
                  expectedStatus: 200,
                  timeoutMs: 5000,
                  startPeriodMs: 10000,
                  intervalMs: 10000,
                  retries: 3,
                },
              },
            ],
            script: [],
            cwd: null,
            envFile: null,
            environment: {},
            volumes: [],
          },
        },
      },
      deps: {},
      hostPorts: { ...DEFAULT_HOST_PORT_RANGE },
      cache: [],
    } as any;
    const dockerRunner = async () => ({
      stdout: JSON.stringify([
        {
          Service: "api",
          State: "running",
          Publishers: [
            {
              TargetPort: 3000,
              PublishedPort: 21001,
              URL: "127.0.0.1",
              Protocol: "tcp",
            },
          ],
        },
      ]),
      stderr: "",
      exitCode: 0,
    });
    const httpCalls: string[] = [];
    const collector = createRuntimeCollector({
      sessionName: "s1",
      composeContext: { projectName: "p", composeFile: "/c.yaml" },
      config,
      tunnels: new TunnelRegistry(),
      dockerRunner,
      healthcheckHttp: async (url) => {
        httpCalls.push(url);
        return { status: 200 };
      },
    });
    const snap = await collector.collect();
    expect(snap.healthchecks.length).toBe(1);
    expect(snap.healthchecks[0]?.service).toBe("api");
    expect(snap.healthchecks.some((h) => h.service === "admin")).toBe(false);
    expect(httpCalls.length).toBe(1);
    expect(httpCalls[0]).toContain("21001");
  });
});

describe("SessionMonitorRegistry selective generated scope", () => {
  test("absent app services do not flip aggregate status to running_partial", async () => {
    const { registry, captured } = makeRegistry();
    // Baseline: api stopped, no healthchecks.
    // Then transition to running with scoped healthcheck only — admin is a
    // configured app service but absent from the deployed snapshot and
    // produces no healthcheck row. Status must transition to `running`, NOT
    // `running_partial`, because absent configured services do not produce
    // failed/waiting rows.
    registry.start(
      "s1",
      scriptedCollector([
        snapshot([{ service: "api", state: "stopped" }], []),
        snapshot(
          [{ service: "api", state: "running" }],
          [{ service: "api", containerPort: 3000, state: "healthy" }],
        ),
      ]),
    );
    await registry.tickNow("s1");
    await registry.tickNow("s1");
    const statusEvents = captured.filter(
      (e) => e.type === "worktree.deployment-status.changed",
    );
    expect(statusEvents.length).toBeGreaterThan(0);
    const last = statusEvents[statusEvents.length - 1]!;
    expect((last.event as { status: string }).status).toBe("running");
    // No healthcheck events for absent configured services.
    const hcEvents = captured.filter((e) => e.type === "healthcheck.changed");
    expect(hcEvents.every((e) => (e.event as { service: string }).service === "api")).toBe(
      true,
    );
    registry.stop("s1");
  });

  test("failed deployed healthcheck still produces running_partial under selective scope", async () => {
    const { registry, captured } = makeRegistry();
    registry.start(
      "s1",
      scriptedCollector([
        snapshot(
          [
            { service: "api", state: "running" },
            { service: "web", state: "running" },
          ],
          [
            { service: "api", containerPort: 3000, state: "healthy" },
            { service: "web", containerPort: 4200, state: "healthy" },
          ],
        ),
        snapshot(
          [
            { service: "api", state: "running" },
            { service: "web", state: "running" },
          ],
          [
            { service: "api", containerPort: 3000, state: "healthy" },
            { service: "web", containerPort: 4200, state: "failed" },
          ],
        ),
      ]),
    );
    await registry.tickNow("s1");
    await registry.tickNow("s1");
    const status = captured.find(
      (e) => e.type === "worktree.deployment-status.changed",
    );
    expect(status).toBeDefined();
    expect((status!.event as { status: string }).status).toBe("running_partial");
    registry.stop("s1");
  });
});
