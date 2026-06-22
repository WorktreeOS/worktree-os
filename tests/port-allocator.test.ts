import { test, expect, describe } from "bun:test";
import {
  allocatePorts,
  assertStaticPortsAvailable,
  assignStaticPorts,
  collectBindings,
  PortAllocationError,
  type AvailabilityChecker,
  type PortBinding,
} from "@worktreeos/compose/port-allocator";
import {
  appPortFromNumber,
  DEFAULT_HOST_PORT_RANGE,
  type WosConfig,
} from "@worktreeos/core/config";

function makeConfig(): WosConfig {
  return {
    cloneVolumes: [],
    app: {
      image: "node:22",
      initScript: [],
      services: {
        api: {
          image: null,
          ports: [appPortFromNumber(3000)],
          script: [],
          cwd: null,
          envFile: null,
          environment: {},
          volumes: [],
        },
        web: {
          image: null,
          ports: [appPortFromNumber(4200), appPortFromNumber(4210)],
          script: [],
          cwd: null,
          envFile: null,
          environment: {},
          volumes: [],
        },
      },
    },
    deps: {
      db: { image: "postgres:13", ports: [5432], environment: {}, volumes: [] },
    },
    hostPorts: { ...DEFAULT_HOST_PORT_RANGE },
    cache: [],
  };
}

const allowAll: AvailabilityChecker = async () => true;

describe("collectBindings", () => {
  test("returns app then dep bindings in alphabetic service order", () => {
    const bindings = collectBindings(makeConfig());
    expect(bindings).toEqual<PortBinding[]>([
      { kind: "app", service: "api", containerPort: 3000 },
      { kind: "app", service: "web", containerPort: 4200 },
      { kind: "app", service: "web", containerPort: 4210 },
      { kind: "deps", service: "db", containerPort: 5432 },
    ]);
  });

  test("returns empty for empty config", () => {
    const cfg: WosConfig = {
      cloneVolumes: [],
      app: { image: null, initScript: [], services: {} },
      deps: {},
      hostPorts: { ...DEFAULT_HOST_PORT_RANGE },
      cache: [],
    };
    expect(collectBindings(cfg)).toEqual([]);
  });

  test("scopes bindings to the selected service set when provided", () => {
    const bindings = collectBindings(makeConfig(), new Set(["api", "db"]));
    expect(bindings).toEqual<PortBinding[]>([
      { kind: "app", service: "api", containerPort: 3000 },
      { kind: "deps", service: "db", containerPort: 5432 },
    ]);
  });
});

describe("allocatePorts", () => {
  test("assigns ports inside the default range and never duplicates", async () => {
    const bindings = collectBindings(makeConfig());
    const assignments = await allocatePorts(
      { projectName: "wos-repo-abcd1234", range: DEFAULT_HOST_PORT_RANGE, bindings },
      allowAll,
    );
    const ports = new Set<number>();
    for (const binding of bindings) {
      const p = assignments[binding.service]?.[String(binding.containerPort)];
      expect(typeof p).toBe("number");
      expect(p!).toBeGreaterThanOrEqual(DEFAULT_HOST_PORT_RANGE.start);
      expect(p!).toBeLessThanOrEqual(DEFAULT_HOST_PORT_RANGE.end);
      expect(ports.has(p!)).toBe(false);
      ports.add(p!);
    }
  });

  test("assigns ports inside a configured custom range", async () => {
    const bindings = collectBindings(makeConfig());
    const range = { start: 30000, end: 30099 };
    const assignments = await allocatePorts(
      { projectName: "p", range, bindings },
      allowAll,
    );
    for (const binding of bindings) {
      const p = assignments[binding.service]![String(binding.containerPort)]!;
      expect(p).toBeGreaterThanOrEqual(range.start);
      expect(p).toBeLessThanOrEqual(range.end);
    }
  });

  test("is stable across runs for the same project name", async () => {
    const bindings = collectBindings(makeConfig());
    const a = await allocatePorts(
      { projectName: "wos-repo-abcd1234", range: DEFAULT_HOST_PORT_RANGE, bindings },
      allowAll,
    );
    const b = await allocatePorts(
      { projectName: "wos-repo-abcd1234", range: DEFAULT_HOST_PORT_RANGE, bindings },
      allowAll,
    );
    expect(a).toEqual(b);
  });

  test("reuses valid previous assignments", async () => {
    const bindings = collectBindings(makeConfig());
    const previous = {
      api: { "3000": 21111 },
      db: { "5432": 21555 },
    };
    const assignments = await allocatePorts(
      {
        projectName: "p",
        range: DEFAULT_HOST_PORT_RANGE,
        bindings,
        previous,
      },
      allowAll,
    );
    expect(assignments.api!["3000"]).toBe(21111);
    expect(assignments.db!["5432"]).toBe(21555);
  });

  test("reallocates previous assignments that are outside the configured range", async () => {
    const bindings = [{ kind: "app" as const, service: "api", containerPort: 3000 }];
    const previous = { api: { "3000": 9000 } };
    const assignments = await allocatePorts(
      { projectName: "p", range: { start: 20000, end: 20100 }, bindings, previous },
      allowAll,
    );
    const port = assignments.api!["3000"]!;
    expect(port).toBeGreaterThanOrEqual(20000);
    expect(port).toBeLessThanOrEqual(20100);
    expect(port).not.toBe(9000);
  });

  test("reallocates duplicated previous assignments", async () => {
    const bindings = [
      { kind: "app" as const, service: "api", containerPort: 3000 },
      { kind: "deps" as const, service: "db", containerPort: 5432 },
    ];
    const previous = { api: { "3000": 20050 }, db: { "5432": 20050 } };
    const assignments = await allocatePorts(
      { projectName: "p", range: { start: 20000, end: 20100 }, bindings, previous },
      allowAll,
    );
    const a = assignments.api!["3000"]!;
    const b = assignments.db!["5432"]!;
    expect(a).not.toBe(b);
    // First binding (api) keeps the reused port; second falls back to deterministic allocation.
    expect(a).toBe(20050);
  });

  test("skips unavailable candidates and picks the next free port", async () => {
    const bindings = [{ kind: "app" as const, service: "api", containerPort: 3000 }];
    const range = { start: 20000, end: 20002 };
    const blocked = new Set<number>([20000, 20001]);
    const isAvailable: AvailabilityChecker = async (p) => !blocked.has(p);
    const assignments = await allocatePorts(
      { projectName: "p", range, bindings },
      isAvailable,
    );
    expect(assignments.api!["3000"]).toBe(20002);
  });

  test("fails when the configured range is too small", async () => {
    const bindings = [
      { kind: "app" as const, service: "api", containerPort: 3000 },
      { kind: "app" as const, service: "api", containerPort: 3001 },
      { kind: "app" as const, service: "api", containerPort: 3002 },
    ];
    await expect(
      allocatePorts(
        { projectName: "p", range: { start: 20000, end: 20001 }, bindings },
        allowAll,
      ),
    ).rejects.toThrow(PortAllocationError);
  });

  test("fails when range is exhausted by unavailability", async () => {
    const bindings = [{ kind: "app" as const, service: "api", containerPort: 3000 }];
    const range = { start: 20000, end: 20002 };
    const isAvailable: AvailabilityChecker = async () => false;
    await expect(
      allocatePorts({ projectName: "p", range, bindings }, isAvailable),
    ).rejects.toThrow(PortAllocationError);
  });

  test("respects excludedHostPorts for retry attempts", async () => {
    const bindings = [{ kind: "app" as const, service: "api", containerPort: 3000 }];
    const range = { start: 20000, end: 20002 };
    const previous = { api: { "3000": 20000 } };
    const assignments = await allocatePorts(
      {
        projectName: "p",
        range,
        bindings,
        previous,
        excludedHostPorts: new Set<number>([20000]),
      },
      allowAll,
    );
    expect(assignments.api!["3000"]).not.toBe(20000);
  });
});

describe("assignStaticPorts", () => {
  test("maps each binding to its declared port as the host port", () => {
    const bindings: PortBinding[] = [
      { kind: "app", service: "api", containerPort: 3000 },
      { kind: "deps", service: "db", containerPort: 5432 },
    ];
    expect(assignStaticPorts(bindings)).toEqual({
      api: { "3000": 3000 },
      db: { "5432": 5432 },
    });
  });

  test("ignores the configured host-port range", () => {
    const bindings: PortBinding[] = [
      { kind: "app", service: "api", containerPort: 80 },
    ];
    // 80 is well outside DEFAULT_HOST_PORT_RANGE; static mode uses it anyway.
    expect(assignStaticPorts(bindings).api!["80"]).toBe(80);
  });

  test("throws naming the duplicate when two bindings need the same port", () => {
    const bindings: PortBinding[] = [
      { kind: "app", service: "api", containerPort: 3000 },
      { kind: "app", service: "web", containerPort: 3000 },
    ];
    expect(() => assignStaticPorts(bindings)).toThrow(PortAllocationError);
    expect(() => assignStaticPorts(bindings)).toThrow(
      /static host port 3000 is required by both/,
    );
  });
});

describe("assertStaticPortsAvailable", () => {
  test("resolves when every static port is free", async () => {
    await expect(
      assertStaticPortsAvailable({ api: { "3000": 3000 } }, allowAll),
    ).resolves.toBeUndefined();
  });

  test("throws naming the unavailable port", async () => {
    const isAvailable: AvailabilityChecker = async (port) => port !== 3000;
    await expect(
      assertStaticPortsAvailable({ api: { "3000": 3000 } }, isAvailable),
    ).rejects.toThrow(/static host port 3000 .*already in use/);
  });
});
