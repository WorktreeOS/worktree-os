import { describe, expect, test } from "bun:test";
import {
  appPortFromNumber,
  DEFAULT_HOST_PORT_RANGE,
  type AppPortSpec,
  type WosConfig,
} from "@worktreeos/core/config";
import {
  deployedAppServiceNames,
  hasRequiredHealthcheckFailure,
  runAppPortHealthchecks,
  summarizeHealthcheckFailures,
  waitingHealthcheckSnapshot,
  type HealthcheckHttpClient,
} from "@worktreeos/runtime/healthchecks";
import type { ServiceStatus } from "@worktreeos/compose/ps";

function configWithPorts(ports: AppPortSpec[]): WosConfig {
  return {
    cloneVolumes: [],
    app: {
      image: "node:22",
      initScript: [],
      services: {
        api: { image: null, ports, script: [], cwd: null, envFile: null, environment: {}, volumes: [] },
      },
    },
    deps: {},
    hostPorts: { ...DEFAULT_HOST_PORT_RANGE },
    cache: [],
  };
}

function apiServiceStatus(containerPort: number, hostPort: number | undefined): ServiceStatus {
  return {
    service: "api",
    state: "running",
    ports: [
      {
        containerPort,
        hostPort,
        hostIp: "127.0.0.1",
        protocol: "tcp",
      },
    ],
  };
}

function enabledHealthcheck(
  overrides: Partial<Extract<AppPortSpec["healthcheck"], { enabled: true }>> = {},
): Extract<AppPortSpec["healthcheck"], { enabled: true }> {
  return {
    enabled: true,
    url: "/",
    expectedStatus: 200,
    timeoutMs: 60000,
    startPeriodMs: 10000,
    intervalMs: 10000,
    retries: 3,
    ...overrides,
  };
}

describe("runAppPortHealthchecks", () => {
  test("returns healthy when GET returns expected status", async () => {
    const http: HealthcheckHttpClient = async () => ({ status: 200 });
    const results = await runAppPortHealthchecks({
      config: configWithPorts([appPortFromNumber(3000)]),
      services: [apiServiceStatus(3000, 21001)],
      http,
    });
    expect(results.length).toBe(1);
    expect(results[0]?.state).toBe("healthy");
    expect(results[0]?.url).toBe("http://localhost:21001/");
    expect(results[0]?.observedStatus).toBe(200);
  });

  test("marks failed when default-lenient check sees 5xx", async () => {
    const http: HealthcheckHttpClient = async () => ({ status: 500 });
    const results = await runAppPortHealthchecks({
      config: configWithPorts([appPortFromNumber(3000)]),
      services: [apiServiceStatus(3000, 21001)],
      http,
    });
    expect(results[0]?.state).toBe("failed");
    expect(results[0]?.observedStatus).toBe(500);
    expect(results[0]?.message).toContain("expected HTTP <500, got 500");
  });

  test("default lenient mode accepts redirects and 4xx as healthy", async () => {
    for (const status of [200, 204, 302, 404]) {
      const http: HealthcheckHttpClient = async () => ({ status });
      const results = await runAppPortHealthchecks({
        config: configWithPorts([appPortFromNumber(3000)]),
        services: [apiServiceStatus(3000, 21001)],
        http,
      });
      expect(results[0]?.state).toBe("healthy");
      expect(results[0]?.observedStatus).toBe(status);
    }
  });

  test("explicit status pins strict equality", async () => {
    const http: HealthcheckHttpClient = async () => ({ status: 404 });
    const results = await runAppPortHealthchecks({
      config: configWithPorts([
        {
          containerPort: 3000,
          allowFailure: false,
          healthcheck: { enabled: true, url: "/", expectedStatus: 200 },
        },
      ]),
      services: [apiServiceStatus(3000, 21001)],
      http,
    });
    expect(results[0]?.state).toBe("failed");
    expect(results[0]?.message).toContain("expected HTTP 200, got 404");
  });

  test("marks failed on transport error", async () => {
    const http: HealthcheckHttpClient = async () => {
      throw new Error("connection refused");
    };
    const results = await runAppPortHealthchecks({
      config: configWithPorts([appPortFromNumber(3000)]),
      services: [apiServiceStatus(3000, 21001)],
      http,
    });
    expect(results[0]?.state).toBe("failed");
    expect(results[0]?.message).toContain("connection refused");
  });

  test("disabled healthcheck does not run http and is reported disabled", async () => {
    let called = 0;
    const http: HealthcheckHttpClient = async () => {
      called += 1;
      return { status: 200 };
    };
    const results = await runAppPortHealthchecks({
      config: configWithPorts([
        {
          containerPort: 3000,
          allowFailure: false,
          healthcheck: { enabled: false },
        },
      ]),
      services: [apiServiceStatus(3000, 21001)],
      http,
    });
    expect(called).toBe(0);
    expect(results[0]?.state).toBe("disabled");
    expect(results[0]?.enabled).toBe(false);
  });

  test("missing published host port fails the check", async () => {
    const http: HealthcheckHttpClient = async () => ({ status: 200 });
    const results = await runAppPortHealthchecks({
      config: configWithPorts([appPortFromNumber(3000)]),
      services: [apiServiceStatus(3000, undefined)],
      http,
    });
    expect(results[0]?.state).toBe("failed");
    expect(results[0]?.message).toContain("no published host port");
  });

  test("allow_failure converts failed state to failed-allowed", async () => {
    const http: HealthcheckHttpClient = async () => ({ status: 500 });
    const results = await runAppPortHealthchecks({
      config: configWithPorts([
        {
          containerPort: 3000,
          allowFailure: true,
          healthcheck: enabledHealthcheck({ timeoutMs: 5000 }),
        },
      ]),
      services: [apiServiceStatus(3000, 21001)],
      http,
    });
    expect(results[0]?.state).toBe("failed-allowed");
    expect(results[0]?.allowFailure).toBe(true);
  });

  test("returns results sorted by service then by container port", async () => {
    const http: HealthcheckHttpClient = async () => ({ status: 200 });
    const config: WosConfig = {
      cloneVolumes: [],
      app: {
        image: "node:22",
        initScript: [],
        services: {
          web: {
            image: null,
            ports: [appPortFromNumber(4210), appPortFromNumber(4200)],
            script: [],
            cwd: null,
            envFile: null,
            environment: {},
            volumes: [],
          },
          api: {
            image: null,
            ports: [appPortFromNumber(3000)],
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
    };
    const services: ServiceStatus[] = [
      apiServiceStatus(3000, 21001),
      {
        service: "web",
        state: "running",
        ports: [
          { containerPort: 4200, hostPort: 21002, hostIp: "127.0.0.1", protocol: "tcp" },
          { containerPort: 4210, hostPort: 21003, hostIp: "127.0.0.1", protocol: "tcp" },
        ],
      },
    ];
    const results = await runAppPortHealthchecks({ config, services, http });
    expect(results.map((r) => `${r.service}:${r.containerPort}`)).toEqual([
      "api:3000",
      "web:4200",
      "web:4210",
    ]);
  });

  test("timeout aborts and reports timeout message", async () => {
    const http: HealthcheckHttpClient = async (_url, signal) => {
      return await new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          const err: Error & { name?: string } = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    };
    const results = await runAppPortHealthchecks({
      config: configWithPorts([
        {
          containerPort: 3000,
          allowFailure: false,
          healthcheck: enabledHealthcheck({ timeoutMs: 10 }),
        },
      ]),
      services: [apiServiceStatus(3000, 21001)],
      http,
    });
    expect(results[0]?.state).toBe("failed");
    expect(results[0]?.message).toContain("timed out");
  });
});

describe("runAppPortHealthchecks wait mode", () => {
  test("polls until success and returns healthy", async () => {
    let attempts = 0;
    const http: HealthcheckHttpClient = async () => {
      attempts += 1;
      if (attempts < 3) return { status: 500 };
      return { status: 200 };
    };
    let virtualNow = 0;
    const results = await runAppPortHealthchecks({
      config: configWithPorts([
        {
          containerPort: 3000,
          allowFailure: false,
          healthcheck: enabledHealthcheck({ timeoutMs: 30000 }),
        },
      ]),
      services: [apiServiceStatus(3000, 21001)],
      http,
      mode: "wait",
      now: () => virtualNow,
      sleep: async (ms) => {
        virtualNow += ms;
      },
    });
    expect(attempts).toBe(3);
    expect(results[0]?.state).toBe("healthy");
  });

  test("returns failed when overall timeout exhausted in wait mode", async () => {
    let attempts = 0;
    const http: HealthcheckHttpClient = async () => {
      attempts += 1;
      return { status: 500 };
    };
    let virtualNow = 0;
    const results = await runAppPortHealthchecks({
      config: configWithPorts([
        {
          containerPort: 3000,
          allowFailure: false,
          healthcheck: enabledHealthcheck({
            timeoutMs: 2000,
            startPeriodMs: 0,
            intervalMs: 500,
            retries: 10,
          }),
        },
      ]),
      services: [apiServiceStatus(3000, 21001)],
      http,
      mode: "wait",
      now: () => virtualNow,
      sleep: async (ms) => {
        virtualNow += ms;
      },
    });
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(results[0]?.state).toBe("failed");
    expect(results[0]?.message).toContain("expected HTTP 200");
  });

  test("ignores failures during start_period and enforces retries afterward", async () => {
    let attempts = 0;
    const http: HealthcheckHttpClient = async () => {
      attempts += 1;
      return { status: 500 };
    };
    let virtualNow = 0;
    const results = await runAppPortHealthchecks({
      config: configWithPorts([
        {
          containerPort: 3000,
          allowFailure: false,
          healthcheck: enabledHealthcheck({ retries: 2 }),
        },
      ]),
      services: [apiServiceStatus(3000, 21001)],
      http,
      mode: "wait",
      now: () => virtualNow,
      sleep: async (ms) => {
        virtualNow += ms;
      },
    });
    expect(attempts).toBe(3);
    expect(results[0]?.state).toBe("failed");
  });

  test("allow_failure converts wait-mode timeout to failed-allowed", async () => {
    const http: HealthcheckHttpClient = async () => ({ status: 500 });
    let virtualNow = 0;
    const results = await runAppPortHealthchecks({
      config: configWithPorts([
        {
          containerPort: 3000,
          allowFailure: true,
          healthcheck: enabledHealthcheck({ timeoutMs: 1000 }),
        },
      ]),
      services: [apiServiceStatus(3000, 21001)],
      http,
      mode: "wait",
      now: () => virtualNow,
      sleep: async (ms) => {
        virtualNow += ms;
      },
    });
    expect(results[0]?.state).toBe("failed-allowed");
  });

  test("aborts early when signal is fired during wait loop", async () => {
    let attempts = 0;
    const abort = new AbortController();
    const http: HealthcheckHttpClient = async () => {
      attempts += 1;
      if (attempts === 2) abort.abort();
      return { status: 500 };
    };
    let virtualNow = 0;
    const results = await runAppPortHealthchecks({
      config: configWithPorts([
        {
          containerPort: 3000,
          allowFailure: false,
          healthcheck: enabledHealthcheck({ timeoutMs: 60000 }),
        },
      ]),
      services: [apiServiceStatus(3000, 21001)],
      http,
      mode: "wait",
      now: () => virtualNow,
      sleep: async (ms) => {
        virtualNow += ms;
      },
      signal: abort.signal,
    });
    expect(attempts).toBe(2);
    expect(results[0]?.state).toBe("failed");
  });
});

describe("waitingHealthcheckSnapshot", () => {
  test("returns a waiting entry per enabled port and disabled entry otherwise", () => {
    const cfg = configWithPorts([
      {
        containerPort: 3000,
        allowFailure: false,
        healthcheck: enabledHealthcheck({ url: "/health", timeoutMs: 30000 }),
      },
      {
        containerPort: 3001,
        allowFailure: false,
        healthcheck: { enabled: false },
      },
    ]);
    const snapshot = waitingHealthcheckSnapshot(cfg, [apiServiceStatus(3000, 21001)]);
    expect(snapshot.map((r) => r.state)).toEqual(["waiting", "disabled"]);
    expect(snapshot[0]?.url).toBe("http://localhost:21001/health");
    expect(snapshot[0]?.timeoutMs).toBe(30000);
    expect(snapshot[0]?.startPeriodMs).toBe(10000);
    expect(snapshot[0]?.intervalMs).toBe(10000);
    expect(snapshot[0]?.retries).toBe(3);
  });

  test("uses runtime defaults when per-port timing fields are omitted", () => {
    const cfg = configWithPorts([
      {
        containerPort: 3000,
        allowFailure: false,
        healthcheck: { enabled: true, url: "/", expectedStatus: 200 },
      },
    ]);
    const snapshot = waitingHealthcheckSnapshot(
      cfg,
      [apiServiceStatus(3000, 21001)],
      {
        timeoutMs: 90_000,
        startPeriodMs: 7000,
        intervalMs: 1500,
        retries: 7,
        requestTimeoutMs: 9000,
      },
    );
    expect(snapshot[0]?.timeoutMs).toBe(90_000);
    expect(snapshot[0]?.startPeriodMs).toBe(7000);
    expect(snapshot[0]?.intervalMs).toBe(1500);
    expect(snapshot[0]?.retries).toBe(7);
  });
});

describe("runAppPortHealthchecks defaults", () => {
  test("per-port timing wins over defaults", async () => {
    const http: HealthcheckHttpClient = async () => ({ status: 500 });
    const results = await runAppPortHealthchecks({
      config: configWithPorts([
        {
          containerPort: 3000,
          allowFailure: false,
          healthcheck: enabledHealthcheck({ timeoutMs: 10, retries: 1 }),
        },
      ]),
      services: [apiServiceStatus(3000, 21001)],
      http,
      defaults: {
        timeoutMs: 999999,
        startPeriodMs: 0,
        intervalMs: 1,
        retries: 999,
        requestTimeoutMs: 500,
      },
    });
    expect(results[0]?.timeoutMs).toBe(10);
    expect(results[0]?.retries).toBe(1);
  });

  test("defaults fill in missing per-port timing fields", async () => {
    const http: HealthcheckHttpClient = async () => ({ status: 200 });
    const results = await runAppPortHealthchecks({
      config: configWithPorts([
        {
          containerPort: 3000,
          allowFailure: false,
          healthcheck: { enabled: true, url: "/", expectedStatus: 200 },
        },
      ]),
      services: [apiServiceStatus(3000, 21001)],
      http,
      defaults: {
        timeoutMs: 12345,
        startPeriodMs: 678,
        intervalMs: 90,
        retries: 4,
        requestTimeoutMs: 500,
      },
    });
    expect(results[0]?.state).toBe("healthy");
    expect(results[0]?.timeoutMs).toBe(12345);
    expect(results[0]?.startPeriodMs).toBe(678);
    expect(results[0]?.intervalMs).toBe(90);
    expect(results[0]?.retries).toBe(4);
  });

  test("onAttempt fires per wait-mode attempt with status or error", async () => {
    const events: { attempt: number; status?: number; error?: string; matched: boolean }[] =
      [];
    let attempts = 0;
    const http: HealthcheckHttpClient = async () => {
      attempts += 1;
      if (attempts < 3) return { status: 503 };
      return { status: 200 };
    };
    let virtualNow = 0;
    await runAppPortHealthchecks({
      config: configWithPorts([
        {
          containerPort: 3000,
          allowFailure: false,
          healthcheck: enabledHealthcheck({ timeoutMs: 30_000 }),
        },
      ]),
      services: [apiServiceStatus(3000, 21001)],
      http,
      mode: "wait",
      now: () => virtualNow,
      sleep: async (ms) => {
        virtualNow += ms;
      },
      onAttempt: (a) =>
        events.push({
          attempt: a.attempt,
          status: a.status,
          error: a.error,
          matched: a.matched,
        }),
    });
    expect(events).toEqual([
      { attempt: 1, status: 503, error: undefined, matched: false },
      { attempt: 2, status: 503, error: undefined, matched: false },
      { attempt: 3, status: 200, error: undefined, matched: true },
    ]);
  });

  test("requestTimeoutMs caps each wait-mode attempt", async () => {
    const http: HealthcheckHttpClient = async (_url, signal) => {
      return await new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          const err: Error & { name?: string } = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    };
    let virtualNow = 0;
    const results = await runAppPortHealthchecks({
      config: configWithPorts([
        {
          containerPort: 3000,
          allowFailure: false,
          healthcheck: { enabled: true, url: "/", expectedStatus: 200 },
        },
      ]),
      services: [apiServiceStatus(3000, 21001)],
      http,
      mode: "wait",
      now: () => virtualNow,
      sleep: async (ms) => {
        virtualNow += ms;
      },
      defaults: {
        timeoutMs: 60_000,
        startPeriodMs: 0,
        intervalMs: 100,
        retries: 1,
        requestTimeoutMs: 50,
      },
    });
    expect(results[0]?.state).toBe("failed");
    expect(results[0]?.message).toContain("timed out after 50ms");
  });
});

describe("hasRequiredHealthcheckFailure", () => {
  test("returns true when any required check failed", () => {
    expect(
      hasRequiredHealthcheckFailure([
        {
          service: "api",
          containerPort: 3000,
          state: "failed",
          enabled: true,
          allowFailure: false,
        },
      ]),
    ).toBe(true);
  });

  test("returns false when all failures are allowed", () => {
    expect(
      hasRequiredHealthcheckFailure([
        {
          service: "api",
          containerPort: 3000,
          state: "failed-allowed",
          enabled: true,
          allowFailure: true,
        },
        {
          service: "web",
          containerPort: 4200,
          state: "healthy",
          enabled: true,
          allowFailure: false,
        },
      ]),
    ).toBe(false);
  });
});

describe("summarizeHealthcheckFailures", () => {
  test("describes failed entries only", () => {
    const summary = summarizeHealthcheckFailures([
      {
        service: "api",
        containerPort: 3000,
        state: "failed",
        enabled: true,
        allowFailure: false,
        url: "http://localhost:21001/",
        message: "expected HTTP 200, got 500",
      },
      {
        service: "api",
        containerPort: 3001,
        state: "failed-allowed",
        enabled: true,
        allowFailure: true,
        message: "should not appear",
      },
    ]);
    expect(summary).toContain("api:3000");
    expect(summary).toContain("expected HTTP 200");
    expect(summary).not.toContain("api:3001");
  });
});

describe("deployedAppServiceNames", () => {
  test("returns the set of service names from the observed snapshot", () => {
    const services: ServiceStatus[] = [
      apiServiceStatus(3000, 21001),
      {
        service: "web",
        state: "running",
        ports: [],
      },
    ];
    const names = deployedAppServiceNames(services);
    expect(names.has("api")).toBe(true);
    expect(names.has("web")).toBe(true);
    expect(names.has("admin")).toBe(false);
    expect(names.size).toBe(2);
  });

  test("returns empty set when no services are deployed", () => {
    expect(deployedAppServiceNames([]).size).toBe(0);
  });
});

describe("selective generated-compose scoping", () => {
  function configForSelectiveDeployment(): WosConfig {
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
            ports: [appPortFromNumber(4200)],
            script: [],
            cwd: null,
            envFile: null,
            environment: {},
            volumes: [],
          },
          admin: {
            image: null,
            ports: [appPortFromNumber(5000)],
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
    };
  }

  test("runAppPortHealthchecks omits configured app services absent from the deployed scope", async () => {
    const http: HealthcheckHttpClient = async () => ({ status: 200 });
    const services: ServiceStatus[] = [
      apiServiceStatus(3000, 21001),
      {
        service: "web",
        state: "running",
        ports: [
          { containerPort: 4200, hostPort: 21002, hostIp: "127.0.0.1", protocol: "tcp" },
        ],
      },
    ];
    const results = await runAppPortHealthchecks({
      config: configForSelectiveDeployment(),
      services,
      http,
      selectedServices: deployedAppServiceNames(services),
    });
    const services_in_results = results.map((r) => r.service);
    expect(services_in_results).toContain("api");
    expect(services_in_results).toContain("web");
    expect(services_in_results).not.toContain("admin");
    expect(results.every((r) => r.state === "healthy")).toBe(true);
  });

  test("waitingHealthcheckSnapshot omits configured app services absent from the deployed scope", () => {
    const services: ServiceStatus[] = [apiServiceStatus(3000, 21001)];
    const snapshot = waitingHealthcheckSnapshot(
      configForSelectiveDeployment(),
      services,
      undefined,
      deployedAppServiceNames(services),
    );
    const services_in_snapshot = snapshot.map((r) => r.service);
    expect(services_in_snapshot).toEqual(["api"]);
  });

  test("failed deployed healthcheck still reports failed when scoped", async () => {
    const http: HealthcheckHttpClient = async () => ({ status: 500 });
    const services: ServiceStatus[] = [
      apiServiceStatus(3000, 21001),
      {
        service: "web",
        state: "running",
        ports: [
          { containerPort: 4200, hostPort: 21002, hostIp: "127.0.0.1", protocol: "tcp" },
        ],
      },
    ];
    const results = await runAppPortHealthchecks({
      config: configForSelectiveDeployment(),
      services,
      http,
      selectedServices: deployedAppServiceNames(services),
    });
    const apiRow = results.find((r) => r.service === "api");
    const webRow = results.find((r) => r.service === "web");
    expect(apiRow?.state).toBe("failed");
    expect(webRow?.state).toBe("failed");
    expect(results.some((r) => r.service === "admin")).toBe(false);
  });
});
