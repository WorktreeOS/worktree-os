import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateConfig, type WosConfig } from "@worktreeos/core/config";
import {
  readState,
  type ShellServiceRuntimeState,
  type WosState,
} from "@worktreeos/core/state";
import { sessionStatePath } from "@worktreeos/core/paths";
import type { SessionContext } from "@worktreeos/core/session-context";
import type { WorktreeEntry } from "@worktreeos/core/git";
import {
  runShellUpProgram,
  shellServiceStatuses,
  stopOneShellService,
  buildShellServiceEnvironment,
  type ShellProcessHost,
  type ShellSpawnHandle,
  type ShellSpawnRequest,
} from "@worktreeos/runtime/shell";
import {
  runStatusOperation,
  runDownOperation,
  runServiceRestartOperation,
} from "@worktreeos/runtime/operations";

class FakeHost implements ShellProcessHost {
  spawns: ShellSpawnRequest[] = [];
  alive = new Set<number>();
  killed: Array<{ pid: number; signal: string }> = [];
  private nextPid = 1000;
  spawn(req: ShellSpawnRequest): ShellSpawnHandle {
    this.spawns.push(req);
    const pid = this.nextPid++;
    this.alive.add(pid);
    return { pid, processGroupId: pid };
  }
  isAlive(pid: number): boolean {
    return this.alive.has(pid);
  }
  kill(target: { pid: number; processGroupId?: number }, signal: "SIGTERM" | "SIGKILL"): void {
    this.killed.push({ pid: target.pid, signal });
    this.alive.delete(target.pid);
  }
  envFor(service: string): Record<string, string> | undefined {
    const req = this.spawns.find((s) => s.stdoutPath.includes(`${service}.stdout`));
    return req?.env;
  }
}

const HEALTHY_HTTP = async () => ({ status: 200 });
const FAST_DEFAULTS = {
  timeoutMs: 100,
  startPeriodMs: 0,
  intervalMs: 20,
  retries: 1,
  requestTimeoutMs: 50,
};

let home: string;
let worktreeRoot: string;
let prevHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "wos-shell-home-"));
  worktreeRoot = await mkdtemp(join(tmpdir(), "wos-shell-wt-"));
  prevHome = process.env.WOS_HOME;
  process.env.WOS_HOME = home;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.WOS_HOME;
  else process.env.WOS_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
  await rm(worktreeRoot, { recursive: true, force: true });
});

function shellConfig(raw: Record<string, unknown>): WosConfig {
  return validateConfig({ mode: "shell", ...raw });
}

function source(): WorktreeEntry {
  return { path: worktreeRoot, bare: false, detached: false };
}

function ctxFor(config: WosConfig, state: WosState | null): SessionContext {
  return {
    worktreeRoot,
    source: source(),
    config,
    projectName: "proj",
    sessionName: "session",
    sessionRoot: join(home, "sessions", "session"),
    state,
  };
}

describe("runShellUpProgram", () => {
  test("starts services dependency-first, persists shell state, injects WOS_* env", async () => {
    const config = shellConfig({
      app: {
        services: {
          web: { script: ["run web"], dependencies: ["api"] },
          api: { script: ["run api"], ports: [{ port: 3000, healthcheck: false }] },
        },
      },
    });
    const host = new FakeHost();
    const state = await runShellUpProgram({
      worktreeRoot,
      config,
      source: source(),
      projectName: "proj",
      shellProcessHost: host,
      shellBaseEnv: { PATH: "/bin" },
      isPortAvailable: async () => true,
      stdout: () => {},
    });

    // api before web (dependency-first order).
    const order = host.spawns.map((s) =>
      s.stdoutPath.includes("api.stdout") ? "api" : "web",
    );
    expect(order).toEqual(["api", "web"]);

    expect(state.backend).toBe("shell");
    expect(state.mode).toBe("shell");
    expect(state.initialized).toBe(true);
    expect(Object.keys(state.shell!.services).sort()).toEqual(["api", "web"]);
    const apiPort = state.portAssignments!.api!["3000"]!;
    expect(state.shell!.services.api!.ports).toEqual({ "3000": apiPort });

    const apiEnv = host.envFor("api")!;
    expect(apiEnv.WOS_SERVICE_PORT).toBe(String(apiPort));
    expect(apiEnv.WOS_SERVICE_HOSTNAME).toBe("localhost");
    expect(apiEnv.PATH).toBe("/bin");

    // web has no ports → no WOS_SERVICE_* variables.
    const webEnv = host.envFor("web")!;
    expect(webEnv.WOS_SERVICE_PORT).toBeUndefined();
    expect(webEnv.WOS_SERVICE_HOSTNAME).toBeUndefined();

    // Persisted state is readable from disk.
    const persisted = await readState(sessionStatePath(worktreeRoot));
    expect(persisted!.shell!.services.api!.pid).toBe(
      state.shell!.services.api!.pid,
    );
  });

  test("tolerates a tunnel preparer that returns a partial resolution", async () => {
    const config = shellConfig({
      app: {
        services: {
          api: { script: ["run api"], ports: [{ port: 3000, healthcheck: false }] },
        },
      },
    });
    const host = new FakeHost();
    // Mirrors the daemon's buildTunnelPreparer, which returns `{}` when no
    // tunnel server is running: a non-nullish object whose `hostnames`/`urls`
    // are absent. `?? emptyTunnelResolution()` does not replace it, so the up
    // must still default the missing maps instead of crashing on
    // `tunnelHostnames[service]`.
    const tunnelPreparer = {
      prepare: async () => ({}) as never,
      skip: async () => {},
    };
    const state = await runShellUpProgram({
      worktreeRoot,
      config,
      source: source(),
      projectName: "proj",
      shellProcessHost: host,
      shellBaseEnv: {},
      isPortAvailable: async () => true,
      stdout: () => {},
      tunnelPreparer,
    });
    expect(Object.keys(state.shell!.services)).toEqual(["api"]);
    const apiPort = state.portAssignments!.api!["3000"]!;
    expect(host.envFor("api")!.WOS_SERVICE_PORT).toBe(String(apiPort));
    expect(host.envFor("api")!.WOS_SERVICE_HOSTNAME).toBe("localhost");
  });

  test("multi-port service describes the first configured port", async () => {
    const config = shellConfig({
      app: {
        services: {
          api: {
            script: ["run api"],
            ports: [
              { port: 3000, healthcheck: false },
              { port: 3001, healthcheck: false },
            ],
          },
        },
      },
    });
    const host = new FakeHost();
    const state = await runShellUpProgram({
      worktreeRoot,
      config,
      source: source(),
      projectName: "proj",
      shellProcessHost: host,
      shellBaseEnv: {},
      isPortAvailable: async () => true,
      stdout: () => {},
    });
    const first = state.portAssignments!.api!["3000"]!;
    expect(host.envFor("api")!.WOS_SERVICE_PORT).toBe(String(first));
  });

  test("required healthcheck failure fails the up operation", async () => {
    const config = shellConfig({
      app: { services: { api: { script: ["run api"], ports: [3000] } } },
    });
    const host = new FakeHost();
    await expect(
      runShellUpProgram({
        worktreeRoot,
        config,
        source: source(),
        projectName: "proj",
        shellProcessHost: host,
        shellBaseEnv: {},
        isPortAvailable: async () => true,
        stdout: () => {},
        healthcheckHttp: async () => ({ status: 500 }),
        healthcheckDefaults: FAST_DEFAULTS,
      }),
    ).rejects.toThrow(/healthcheck failed/);
  });

  test("static ports inject the declared port as WOS_SERVICE_PORT", async () => {
    const config = shellConfig({
      dynamic_ports: false,
      app: {
        services: {
          api: { script: ["run api"], ports: [{ port: 3000, healthcheck: false }] },
        },
      },
    });
    const host = new FakeHost();
    const state = await runShellUpProgram({
      worktreeRoot,
      config,
      source: source(),
      projectName: "proj",
      shellProcessHost: host,
      shellBaseEnv: {},
      isPortAvailable: async () => true,
      stdout: () => {},
    });
    expect(state.portAssignments!.api!["3000"]).toBe(3000);
    expect(state.shell!.services.api!.ports).toEqual({ "3000": 3000 });
    expect(host.envFor("api")!.WOS_SERVICE_PORT).toBe("3000");
  });

  test("static ports fail when the declared port is unavailable", async () => {
    const config = shellConfig({
      dynamic_ports: false,
      app: {
        services: {
          api: { script: ["run api"], ports: [{ port: 3000, healthcheck: false }] },
        },
      },
    });
    const host = new FakeHost();
    await expect(
      runShellUpProgram({
        worktreeRoot,
        config,
        source: source(),
        projectName: "proj",
        shellProcessHost: host,
        shellBaseEnv: {},
        isPortAvailable: async (port) => port !== 3000,
        stdout: () => {},
      }),
    ).rejects.toThrow(/static host port 3000.*already in use/);
    // No service was spawned because availability is checked before startup.
    expect(host.spawns.length).toBe(0);
  });

  test("replaces a prior shell deployment by stopping its services", async () => {
    const config = shellConfig({
      app: { services: { api: { script: ["run api"], ports: [{ port: 3000, healthcheck: false }] } } },
    });
    const host = new FakeHost();
    const first = await runShellUpProgram({
      worktreeRoot,
      config,
      source: source(),
      projectName: "proj",
      shellProcessHost: host,
      shellBaseEnv: {},
      isPortAvailable: async () => true,
      stdout: () => {},
    });
    const firstPid = first.shell!.services.api!.pid;
    await runShellUpProgram({
      worktreeRoot,
      config,
      source: source(),
      projectName: "proj",
      shellProcessHost: host,
      shellBaseEnv: {},
      isPortAvailable: async () => true,
      stdout: () => {},
    });
    expect(host.killed.some((k) => k.pid === firstPid)).toBe(true);
    expect(host.alive.has(firstPid)).toBe(false);
  });
});

describe("buildShellServiceEnvironment", () => {
  test("automatic variables override user-supplied values", async () => {
    const config = shellConfig({
      app: {
        services: {
          api: {
            script: ["x"],
            ports: [{ port: 3000, healthcheck: false }],
            environment: { WOS_SERVICE_PORT: "999", FOO: "bar" },
          },
        },
      },
    });
    const { env } = await buildShellServiceEnvironment({
      config,
      service: "api",
      svc: config.app.services.api!,
      worktreeRoot,
      assignments: { api: { "3000": 21000 } },
      tunnelHostnames: {},
      tunnelUrls: {},
      baseEnv: {},
    });
    expect(env.WOS_SERVICE_PORT).toBe("21000");
    expect(env.FOO).toBe("bar");
  });

  test("resolves runtime-argument and host-port templates", async () => {
    const config = shellConfig({
      arguments: ["API_HOST"],
      app: {
        services: {
          api: {
            script: ["x"],
            ports: [{ port: 3000, healthcheck: false }],
            environment: {
              SELF: "http://localhost:${app.services.api.hostPort[3000]}",
              REMOTE: "${API_HOST:-fallback}",
            },
          },
        },
      },
    });
    const { env } = await buildShellServiceEnvironment({
      config,
      service: "api",
      svc: config.app.services.api!,
      worktreeRoot,
      assignments: { api: { "3000": 21000 } },
      tunnelHostnames: {},
      tunnelUrls: {},
      runtimeArguments: { API_HOST: "example.test" },
      baseEnv: {},
    });
    expect(env.SELF).toBe("http://localhost:21000");
    expect(env.REMOTE).toBe("example.test");
  });

  test("uses tunnel hostname for WOS_SERVICE_HOSTNAME when available", async () => {
    const config = shellConfig({
      app: { services: { api: { script: ["x"], ports: [{ port: 3000, healthcheck: false }] } } },
    });
    const { env } = await buildShellServiceEnvironment({
      config,
      service: "api",
      svc: config.app.services.api!,
      worktreeRoot,
      assignments: { api: { "3000": 21000 } },
      tunnelHostnames: { api: { "3000": "feature-api.example.com" } },
      tunnelUrls: {},
      baseEnv: {},
    });
    expect(env.WOS_SERVICE_HOSTNAME).toBe("feature-api.example.com");
  });

  test("resolves url template to active tunnel url", async () => {
    const config = shellConfig({
      app: {
        services: {
          api: {
            script: ["x"],
            ports: [{ port: 3000, healthcheck: false }],
            environment: { PUBLIC_URL: "${app.services.api.url[3000]}" },
          },
        },
      },
    });
    const { env } = await buildShellServiceEnvironment({
      config,
      service: "api",
      svc: config.app.services.api!,
      worktreeRoot,
      assignments: { api: { "3000": 21000 } },
      tunnelHostnames: { api: { "3000": "feature-api.example.com" } },
      tunnelUrls: { api: { "3000": "https://feature-api.example.com" } },
      baseEnv: {},
    });
    expect(env.PUBLIC_URL).toBe("https://feature-api.example.com");
  });

  test("resolves url template to http://localhost:<hostPort> without a tunnel", async () => {
    const config = shellConfig({
      app: {
        services: {
          api: {
            script: ["x"],
            ports: [{ port: 3000, healthcheck: false }],
            environment: { PUBLIC_URL: "${app.services.api.url[3000]}" },
          },
        },
      },
    });
    const { env } = await buildShellServiceEnvironment({
      config,
      service: "api",
      svc: config.app.services.api!,
      worktreeRoot,
      assignments: { api: { "3000": 21000 } },
      tunnelHostnames: {},
      tunnelUrls: {},
      baseEnv: {},
    });
    expect(env.PUBLIC_URL).toBe("http://localhost:21000");
  });

  test("falls back to serviceBind for hostname, url and WOS_SERVICE_HOSTNAME", async () => {
    const config = shellConfig({
      app: {
        services: {
          api: {
            script: ["x"],
            ports: [{ port: 3000, healthcheck: false }],
            environment: {
              PUBLIC_URL: "${app.services.api.url[3000]}",
              HOST: "${app.services.api.hostname[3000]}",
            },
          },
        },
      },
    });
    const { env } = await buildShellServiceEnvironment({
      config,
      service: "api",
      svc: config.app.services.api!,
      worktreeRoot,
      assignments: { api: { "3000": 21000 } },
      tunnelHostnames: {},
      tunnelUrls: {},
      baseEnv: {},
      serviceBind: "192.168.1.18",
    });
    expect(env.HOST).toBe("192.168.1.18");
    expect(env.PUBLIC_URL).toBe("http://192.168.1.18:21000");
    expect(env.WOS_SERVICE_HOSTNAME).toBe("192.168.1.18");
  });

  test("active tunnel wins over serviceBind", async () => {
    const config = shellConfig({
      app: {
        services: {
          api: {
            script: ["x"],
            ports: [{ port: 3000, healthcheck: false }],
            environment: { PUBLIC_URL: "${app.services.api.url[3000]}" },
          },
        },
      },
    });
    const { env } = await buildShellServiceEnvironment({
      config,
      service: "api",
      svc: config.app.services.api!,
      worktreeRoot,
      assignments: { api: { "3000": 21000 } },
      tunnelHostnames: { api: { "3000": "feature-api.example.com" } },
      tunnelUrls: { api: { "3000": "https://feature-api.example.com" } },
      baseEnv: {},
      serviceBind: "192.168.1.18",
    });
    expect(env.PUBLIC_URL).toBe("https://feature-api.example.com");
    expect(env.WOS_SERVICE_HOSTNAME).toBe("feature-api.example.com");
  });

  test("brackets an IPv6 serviceBind in the url fallback", async () => {
    const config = shellConfig({
      app: {
        services: {
          api: {
            script: ["x"],
            ports: [{ port: 3000, healthcheck: false }],
            environment: { PUBLIC_URL: "${app.services.api.url[3000]}" },
          },
        },
      },
    });
    const { env } = await buildShellServiceEnvironment({
      config,
      service: "api",
      svc: config.app.services.api!,
      worktreeRoot,
      assignments: { api: { "3000": 21000 } },
      tunnelHostnames: {},
      tunnelUrls: {},
      baseEnv: {},
      serviceBind: "fd00::1",
    });
    expect(env.PUBLIC_URL).toBe("http://[fd00::1]:21000");
  });
});

describe("shell status, down, restart", () => {
  function stateWithService(pid: number): WosState {
    const meta: ShellServiceRuntimeState = {
      pid,
      processGroupId: pid,
      command: ["sh", "-lc", "(run api)"],
      cwd: worktreeRoot,
      environmentKeys: ["PATH"],
      logFiles: { stdout: "/tmp/a.out", stderr: "/tmp/a.err" },
      startedAt: "2026-05-29T00:00:00.000Z",
      ports: { "3000": 21000 },
    };
    return {
      initialized: true,
      projectName: "proj",
      composeFile: "",
      backend: "shell",
      mode: "shell",
      portAssignments: { api: { "3000": 21000 } },
      worktreeRoot,
      shell: { services: { api: meta } },
    };
  }

  test("shellServiceStatuses reports running vs exited via pid liveness", () => {
    const host = new FakeHost();
    host.alive.add(7);
    const stateRunning = shellServiceStatuses(stateWithService(7), host);
    expect(stateRunning[0]!.state).toBe("running");
    expect(stateRunning[0]!.ports[0]).toEqual({
      containerPort: 3000,
      hostPort: 21000,
      hostIp: "127.0.0.1",
      protocol: "tcp",
    });
    const stateDead = shellServiceStatuses(stateWithService(8), host);
    expect(stateDead[0]!.state).toBe("exited");
  });

  test("shellServiceStatuses reports zero restarts and omits startedAt", () => {
    const host = new FakeHost();
    host.alive.add(7);
    const status = shellServiceStatuses(stateWithService(7), host)[0]!;
    expect(status.restartCount).toBe(0);
    expect(status.startedAt).toBeUndefined();
  });

  test("runStatusOperation reports shell services without Docker", async () => {
    const host = new FakeHost();
    host.alive.add(7);
    const config = shellConfig({
      app: { services: { api: { script: ["run api"], ports: [{ port: 3000, healthcheck: false }] } } },
    });
    const ctx = ctxFor(config, stateWithService(7));
    const outcome = await runStatusOperation(ctx, { shellProcessHost: host });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.services.map((s) => s.service)).toEqual(["api"]);
      expect(outcome.services[0]!.state).toBe("running");
    }
  });

  test("runDownOperation stops all shell services", async () => {
    const host = new FakeHost();
    host.alive.add(7);
    const config = shellConfig({ app: { services: { api: { script: ["run api"] } } } });
    const ctx = ctxFor(config, stateWithService(7));
    const outcome = await runDownOperation(ctx, { shellProcessHost: host });
    expect(outcome).toEqual({ kind: "stopped" });
    expect(host.alive.has(7)).toBe(false);
    expect(host.killed.some((k) => k.pid === 7)).toBe(true);
    // The persisted service records are cleared so a later status snapshot
    // reports no managed services (clean `stopped`) instead of leaving the
    // exited process recorded as a failure forever.
    const persisted = await readState(sessionStatePath(worktreeRoot));
    expect(persisted?.shell?.services).toEqual({});
  });

  test("stopOneShellService stops only the requested service", async () => {
    const host = new FakeHost();
    host.alive.add(7);
    host.alive.add(9);
    const state = stateWithService(7);
    state.shell!.services.web = { ...state.shell!.services.api!, pid: 9 };
    await stopOneShellService(state, "api", { shellProcessHost: host });
    expect(host.alive.has(7)).toBe(false);
    expect(host.alive.has(9)).toBe(true);
  });

  test("restart replays persisted runtime arguments for env templates", async () => {
    const host = new FakeHost();
    const config = shellConfig({
      arguments: ["TOKEN"],
      app: {
        services: {
          api: {
            script: ["run api"],
            ports: [{ port: 3000, healthcheck: false }],
            // No default — only resolvable from the submitted runtime argument.
            environment: { AUTH: "${TOKEN}" },
          },
        },
      },
    });
    // `up` records the submitted runtime arguments in shell state.
    const upState = await runShellUpProgram({
      worktreeRoot,
      config,
      source: source(),
      projectName: "proj",
      shellProcessHost: host,
      shellBaseEnv: {},
      isPortAvailable: async () => true,
      stdout: () => {},
      runtimeArguments: { TOKEN: "secret-123" },
    });
    expect(upState.shell!.runtimeArguments).toEqual({ TOKEN: "secret-123" });
    expect(host.envFor("api")!.AUTH).toBe("secret-123");

    // Restart must NOT throw and must re-resolve the template from persisted args.
    const ctx = ctxFor(config, upState);
    await runServiceRestartOperation(ctx, "api", { shellProcessHost: host });
    const persisted = await readState(sessionStatePath(worktreeRoot));
    expect(persisted!.shell!.runtimeArguments).toEqual({ TOKEN: "secret-123" });
    // The most recent spawn (restart) resolved AUTH from the persisted arg.
    expect(host.spawns.at(-1)!.env.AUTH).toBe("secret-123");
  });

  test("runServiceRestartOperation stops the old process and starts a new one", async () => {
    const host = new FakeHost();
    host.alive.add(7);
    const config = shellConfig({
      app: { services: { api: { script: ["run api"], ports: [{ port: 3000, healthcheck: false }] } } },
    });
    const ctx = ctxFor(config, stateWithService(7));
    await runServiceRestartOperation(ctx, "api", { shellProcessHost: host });
    expect(host.killed.some((k) => k.pid === 7)).toBe(true);
    const persisted = await readState(sessionStatePath(worktreeRoot));
    expect(persisted!.shell!.services.api!.pid).not.toBe(7);
    expect(host.alive.has(persisted!.shell!.services.api!.pid)).toBe(true);
  });
});

describe("shell host init", () => {
  test("runs top-level init script on the host before starting services", async () => {
    const marker = join(worktreeRoot, "init-marker.txt");
    const config = shellConfig({
      app: {
        init_script: [`echo ok > ${marker}`],
        services: { api: { script: ["run api"], ports: [{ port: 3000, healthcheck: false }] } },
      },
    });
    const host = new FakeHost();
    await runShellUpProgram({
      worktreeRoot,
      config,
      source: source(),
      projectName: "proj",
      shellProcessHost: host,
      shellBaseEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      isPortAvailable: async () => true,
      stdout: () => {},
    });
    const content = await readFile(marker, "utf8");
    expect(content.trim()).toBe("ok");
  });
});
