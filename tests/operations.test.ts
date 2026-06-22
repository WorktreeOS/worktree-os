import { test, expect, describe } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  formatDownOutcome,
  formatStatusOutcome,
  runDownOperation,
  runServiceRestartOperation,
  runServiceStopOperation,
  runStatusOperation,
  runUpOperation,
  ServiceOperationError,
} from "@worktreeos/runtime/operations";
import { INIT_SERVICE_NAME } from "@worktreeos/compose/generated-compose";
import type { SessionContext } from "@worktreeos/core/session-context";
import type { DockerRunner } from "@worktreeos/compose/compose";
import { writeState, type WosState } from "@worktreeos/core/state";
import { sessionStatePath } from "@worktreeos/core/paths";
import { DEFAULT_HOST_PORT_RANGE } from "@worktreeos/core/config";

async function setupSession(initialized: boolean): Promise<{
  ctx: SessionContext;
  cleanup: () => Promise<void>;
  composeFile: string;
}> {
  const home = await mkdtemp(join(tmpdir(), "wos-ops-"));
  const prevHome = process.env.WOS_HOME;
  process.env.WOS_HOME = home;
  const worktreeRoot = await mkdtemp(join(tmpdir(), "wos-wt-"));
  const composeFile = resolve(worktreeRoot, "compose.yaml");
  await Bun.write(composeFile, "services: {}\n");
  const state: WosState | null = initialized
    ? { initialized: true, projectName: "test-proj", composeFile }
    : null;
  if (state) await writeState(sessionStatePath(worktreeRoot), state);

  const ctx: SessionContext = {
    worktreeRoot,
    source: { path: worktreeRoot, bare: false, detached: false },
    config: {
      cloneVolumes: [],
      hostPorts: { start: 20000, end: 29999 },
      app: { initScript: [] } as any,
      cache: [],
    } as any,
    projectName: "test-proj",
    sessionName: "session-name",
    sessionRoot: join(home, "sessions", "session-name"),
    state,
  };

  return {
    ctx,
    composeFile,
    cleanup: async () => {
      await rm(home, { recursive: true, force: true });
      await rm(worktreeRoot, { recursive: true, force: true });
      if (prevHome === undefined) delete process.env.WOS_HOME;
      else process.env.WOS_HOME = prevHome;
    },
  };
}

describe("runDownOperation", () => {
  test("returns no-deployment when state is null", async () => {
    const { ctx, cleanup } = await setupSession(false);
    try {
      const outcome = await runDownOperation(ctx, { composeRunner: failingRunner });
      expect(outcome).toEqual({ kind: "no-deployment" });
    } finally {
      await cleanup();
    }
  });

  test("invokes compose down with project/compose file when initialized", async () => {
    const { ctx, cleanup, composeFile } = await setupSession(true);
    const calls: string[][] = [];
    const runner: DockerRunner = async (args) => {
      calls.push(args);
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    try {
      const outcome = await runDownOperation(ctx, { composeRunner: runner });
      expect(outcome).toEqual({ kind: "stopped" });
      expect(calls.length).toBe(1);
      expect(calls[0]).toContain("down");
      expect(calls[0]).toContain("-p");
      expect(calls[0]).toContain("test-proj");
      expect(calls[0]).toContain(composeFile);
    } finally {
      await cleanup();
    }
  });
});

describe("runStatusOperation", () => {
  test("returns no-deployment when state is null", async () => {
    const { ctx, cleanup } = await setupSession(false);
    try {
      const outcome = await runStatusOperation(ctx, { composeRunner: failingRunner });
      expect(outcome.kind).toBe("no-deployment");
    } finally {
      await cleanup();
    }
  });

  test("returns parsed services when initialized", async () => {
    const { ctx, cleanup } = await setupSession(true);
    const runner: DockerRunner = async () => ({
      stdout: '{"Service":"api","State":"running","Publishers":[]}\n',
      stderr: "",
      exitCode: 0,
    });
    try {
      const outcome = await runStatusOperation(ctx, { composeRunner: runner });
      expect(outcome.kind).toBe("ok");
      if (outcome.kind === "ok") {
        expect(outcome.services.map((s) => s.service)).toEqual(["api"]);
        expect(outcome.appPortHealthchecks).toEqual([]);
      }
    } finally {
      await cleanup();
    }
  });

  test("uses serviceSnapshot instead of docker compose ps when provided", async () => {
    const { ctx, cleanup } = await setupSession(true);
    try {
      // `failingRunner` would throw if compose ps were invoked.
      const outcome = await runStatusOperation(ctx, {
        composeRunner: failingRunner,
        serviceSnapshot: [
          { service: "api", state: "running", status: "Up", ports: [] },
          { service: "db", state: "exited", status: "Exited (0)", ports: [] },
        ],
      });
      expect(outcome.kind).toBe("ok");
      if (outcome.kind === "ok") {
        expect(outcome.services.map((s) => s.service)).toEqual(["api", "db"]);
        expect(
          outcome.services.find((s) => s.service === "db")!.state,
        ).toBe("exited");
        // No app ports configured, so no healthchecks regardless of snapshot.
        expect(outcome.appPortHealthchecks).toEqual([]);
      }
    } finally {
      await cleanup();
    }
  });

  test("empty serviceSnapshot yields no services without calling compose ps", async () => {
    const { ctx, cleanup } = await setupSession(true);
    try {
      const outcome = await runStatusOperation(ctx, {
        composeRunner: failingRunner,
        serviceSnapshot: [],
      });
      expect(outcome.kind).toBe("ok");
      if (outcome.kind === "ok") {
        expect(outcome.services).toEqual([]);
        expect(outcome.appPortHealthchecks).toEqual([]);
      }
    } finally {
      await cleanup();
    }
  });

  test("runs healthchecks for configured app ports", async () => {
    const { ctx, cleanup } = await setupSession(true);
    (ctx.config.app as any).image = "node:22";
    (ctx.config.app as any).services = {
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
    };
    (ctx.config as any).deps = {};
    const runner: DockerRunner = async () => ({
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
    try {
      const outcome = await runStatusOperation(ctx, {
        composeRunner: runner,
        healthcheckHttp: async () => ({ status: 200 }),
      });
      expect(outcome.kind).toBe("ok");
      if (outcome.kind === "ok") {
        expect(outcome.appPortHealthchecks.length).toBe(1);
        expect(outcome.appPortHealthchecks[0]?.state).toBe("healthy");
      }
    } finally {
      await cleanup();
    }
  });

  test("scopes app-port healthchecks to serviceSnapshot services", async () => {
    const { ctx, cleanup } = await setupSession(true);
    (ctx.config.app as any).image = "node:22";
    const portWithHealthcheck = (containerPort: number) => ({
      containerPort,
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
    });
    const svc = (port: number) => ({
      image: null,
      ports: [portWithHealthcheck(port)],
      script: [],
      cwd: null,
      envFile: null,
      environment: {},
      volumes: [],
    });
    (ctx.config.app as any).services = { api: svc(3000), web: svc(4000) };
    (ctx.config as any).deps = {};
    try {
      // Snapshot contains only `api`; `web` is absent from the deployed set.
      const outcome = await runStatusOperation(ctx, {
        composeRunner: failingRunner,
        healthcheckHttp: async () => ({ status: 200 }),
        serviceSnapshot: [
          { service: "api", state: "running", status: "Up", ports: [] },
        ],
      });
      expect(outcome.kind).toBe("ok");
      if (outcome.kind === "ok") {
        expect(outcome.appPortHealthchecks.map((h) => h.service)).toEqual([
          "api",
        ]);
      }
    } finally {
      await cleanup();
    }
  });

  test("reportHealthchecksAsWaiting skips HTTP and yields waiting state", async () => {
    const { ctx, cleanup } = await setupSession(true);
    (ctx.config.app as any).image = "node:22";
    (ctx.config.app as any).services = {
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
              timeoutMs: 30000,
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
    };
    (ctx.config as any).deps = {};
    const runner: DockerRunner = async () => ({
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
    let httpCalled = 0;
    try {
      const outcome = await runStatusOperation(ctx, {
        composeRunner: runner,
        healthcheckHttp: async () => {
          httpCalled += 1;
          return { status: 500 };
        },
        reportHealthchecksAsWaiting: true,
      });
      expect(httpCalled).toBe(0);
      expect(outcome.kind).toBe("ok");
      if (outcome.kind === "ok") {
        expect(outcome.appPortHealthchecks[0]?.state).toBe("waiting");
      }
    } finally {
      await cleanup();
    }
  });

  test("selective generated-compose status omits absent app healthchecks", async () => {
    const { ctx, cleanup } = await setupSession(true);
    (ctx.config.app as any).image = "node:22";
    (ctx.config.app as any).services = {
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
      web: {
        image: null,
        ports: [
          {
            containerPort: 4200,
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
    };
    (ctx.config as any).deps = {};
    const runner: DockerRunner = async () => ({
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
        {
          Service: "web",
          State: "running",
          Publishers: [
            {
              TargetPort: 4200,
              PublishedPort: 21002,
              URL: "127.0.0.1",
              Protocol: "tcp",
            },
          ],
        },
      ]),
      stderr: "",
      exitCode: 0,
    });
    try {
      const outcome = await runStatusOperation(ctx, {
        composeRunner: runner,
        healthcheckHttp: async () => ({ status: 200 }),
      });
      expect(outcome.kind).toBe("ok");
      if (outcome.kind === "ok") {
        const hcServices = outcome.appPortHealthchecks.map((r) => r.service);
        expect(hcServices).toContain("api");
        expect(hcServices).toContain("web");
        expect(hcServices).not.toContain("admin");
        expect(outcome.appPortHealthchecks.length).toBe(2);
        expect(outcome.appPortHealthchecks.every((h) => h.state === "healthy")).toBe(true);
        expect(outcome.services.length).toBe(2);
      }
    } finally {
      await cleanup();
    }
  });

  test("selective generated-compose waiting snapshot omits absent app healthchecks", async () => {
    const { ctx, cleanup } = await setupSession(true);
    (ctx.config.app as any).image = "node:22";
    (ctx.config.app as any).services = {
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
    };
    (ctx.config as any).deps = {};
    const runner: DockerRunner = async () => ({
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
    try {
      const outcome = await runStatusOperation(ctx, {
        composeRunner: runner,
        reportHealthchecksAsWaiting: true,
      });
      expect(outcome.kind).toBe("ok");
      if (outcome.kind === "ok") {
        const hcServices = outcome.appPortHealthchecks.map((r) => r.service);
        expect(hcServices).toEqual(["api"]);
        expect(outcome.appPortHealthchecks[0]?.state).toBe("waiting");
      }
    } finally {
      await cleanup();
    }
  });
});

describe("runServiceStopOperation", () => {
  test("rejects when service name is empty", async () => {
    const { ctx, cleanup } = await setupSession(true);
    try {
      let caught: unknown;
      try {
        await runServiceStopOperation(ctx, "  ", { composeRunner: failingRunner });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ServiceOperationError);
      expect((caught as ServiceOperationError).code).toBe("invalid-service");
    } finally {
      await cleanup();
    }
  });

  test("rejects internal init service", async () => {
    const { ctx, cleanup } = await setupSession(true);
    try {
      let caught: unknown;
      try {
        await runServiceStopOperation(ctx, INIT_SERVICE_NAME, {
          composeRunner: failingRunner,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ServiceOperationError);
      expect((caught as ServiceOperationError).code).toBe("internal-service");
    } finally {
      await cleanup();
    }
  });

  test("rejects when deployment is not initialized", async () => {
    const { ctx, cleanup } = await setupSession(false);
    try {
      let caught: unknown;
      try {
        await runServiceStopOperation(ctx, "api", {
          composeRunner: failingRunner,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ServiceOperationError);
      expect((caught as ServiceOperationError).code).toBe("no-deployment");
    } finally {
      await cleanup();
    }
  });

  test("invokes compose stop with persisted project/compose file", async () => {
    const { ctx, cleanup, composeFile } = await setupSession(true);
    const calls: string[][] = [];
    const runner: DockerRunner = async (args) => {
      calls.push(args);
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    try {
      await runServiceStopOperation(ctx, "api", { composeRunner: runner });
      expect(calls.length).toBe(1);
      expect(calls[0]).toEqual([
        "compose",
        "-p",
        "test-proj",
        "-f",
        composeFile,
        "stop",
        "api",
      ]);
    } finally {
      await cleanup();
    }
  });

  test("propagates compose failures", async () => {
    const { ctx, cleanup } = await setupSession(true);
    const runner: DockerRunner = async () => ({
      stdout: "",
      stderr: "boom\n",
      exitCode: 1,
    });
    try {
      let caught: unknown;
      try {
        await runServiceStopOperation(ctx, "api", { composeRunner: runner });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      expect((caught as Error).message).toContain("docker compose stop");
    } finally {
      await cleanup();
    }
  });
});

describe("runServiceRestartOperation", () => {
  test("removes the existing container, then invokes compose up for the named service", async () => {
    const { ctx, cleanup, composeFile } = await setupSession(true);
    const calls: string[][] = [];
    const runner: DockerRunner = async (args) => {
      calls.push(args);
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    try {
      await runServiceRestartOperation(ctx, "api", { composeRunner: runner });
      expect(calls).toEqual([
        [
          "compose",
          "-p",
          "test-proj",
          "-f",
          composeFile,
          "rm",
          "-f",
          "-s",
          "api",
        ],
        [
          "compose",
          "-p",
          "test-proj",
          "-f",
          composeFile,
          "up",
          "-d",
          "api",
        ],
      ]);
    } finally {
      await cleanup();
    }
  });

  test("rejects when deployment is not initialized", async () => {
    const { ctx, cleanup } = await setupSession(false);
    try {
      let caught: unknown;
      try {
        await runServiceRestartOperation(ctx, "api", {
          composeRunner: failingRunner,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ServiceOperationError);
      expect((caught as ServiceOperationError).code).toBe("no-deployment");
    } finally {
      await cleanup();
    }
  });

  test("propagates compose failures", async () => {
    const { ctx, cleanup } = await setupSession(true);
    let call = 0;
    const runner: DockerRunner = async () => {
      call += 1;
      if (call === 1) return { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "nope\n", exitCode: 2 };
    };
    try {
      let caught: unknown;
      try {
        await runServiceRestartOperation(ctx, "api", { composeRunner: runner });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      expect((caught as Error).message).toContain("docker compose up -d api");
    } finally {
      await cleanup();
    }
  });
});

describe("format helpers", () => {
  test("formatDownOutcome renders no-deployment message", () => {
    expect(formatDownOutcome({ kind: "no-deployment" })).toContain(
      "no wos deployment",
    );
    expect(formatDownOutcome({ kind: "stopped" })).toBe("");
  });

  test("formatStatusOutcome renders no-deployment message", () => {
    expect(formatStatusOutcome({ kind: "no-deployment" })).toContain(
      "no wos deployment",
    );
  });

  test("formatStatusOutcome renders service table for ok", () => {
    const out = formatStatusOutcome({
      kind: "ok",
      services: [{ service: "api", state: "running", ports: [] }],
      state: { initialized: true, projectName: "p", composeFile: "/c.yaml" },
      appPortHealthchecks: [],
    });
    expect(out).toContain("api");
    expect(out).toContain("running");
  });
});

describe("runUpOperation daemon-routed config freshness", () => {
  test("second up uses updated config without daemon restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "wos-daemon-up-"));
    const prevHome = process.env.WOS_HOME;
    process.env.WOS_HOME = home;
    const worktreeRoot = await mkdtemp(join(tmpdir(), "wos-daemon-wt-"));
    const gitDir = join(worktreeRoot, ".git");
    await mkdir(gitDir, { recursive: true });
    try {
      const baseConfig = {
        cloneVolumes: [],
        app: {
          image: "node:22",
          initScript: [],
          services: {
            api: {
              image: null,
              ports: [{ containerPort: 3000, allowFailure: false, healthcheck: { enabled: false } }],
              script: ["bun dev"],
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

      const ctx1: SessionContext = {
        worktreeRoot,
        source: { path: worktreeRoot, bare: false, detached: false },
        config: baseConfig as any,
        projectName: "wos-daemon-test",
        sessionName: "daemon-sess",
        sessionRoot: join(home, "sessions", "daemon-sess"),
        state: null,
      };
      const runner: DockerRunner = async (args) => {
        if (args[5] === "ps") return { stdout: "[]", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      };

      const state1 = await runUpOperation(ctx1, { composeRunner: runner }, () => {});
      const text1 = await Bun.file(state1.composeFile).text();
      expect(text1).toContain("postgres:13");

      const updatedConfig = {
        ...baseConfig,
        deps: {
          redis: { image: "redis:7", ports: [6379], environment: {}, volumes: [] },
        },
      };
      const ctx2: SessionContext = {
        ...ctx1,
        config: updatedConfig as any,
        state: state1,
      };

      const state2 = await runUpOperation(ctx2, { composeRunner: runner }, () => {});
      const text2 = await Bun.file(state2.composeFile).text();
      expect(text2).toContain("redis:7");
      expect(text2).not.toContain("postgres:13");
    } finally {
      if (prevHome === undefined) delete process.env.WOS_HOME;
      else process.env.WOS_HOME = prevHome;
      await rm(home, { recursive: true, force: true });
      await rm(worktreeRoot, { recursive: true, force: true });
    }
  });
});

const failingRunner: DockerRunner = async () => {
  throw new Error("runner should not be called");
};
