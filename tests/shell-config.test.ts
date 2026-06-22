import { test, expect, describe } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  validateConfig,
  ConfigError,
  isShellMode,
  deploymentModeOf,
} from "@worktreeos/core/config";
import {
  readState,
  writeState,
  stateBackend,
  type WosState,
} from "@worktreeos/core/state";
import { sessionStatePath } from "@worktreeos/core/paths";

describe("shell-mode config validation", () => {
  test("accepts a shell config and preserves supported fields", () => {
    const cfg = validateConfig({
      mode: "shell",
      clone_volumes: ["node_modules"],
      cache: [{ key: "deps", paths: ["node_modules"] }],
      host_ports: { range: { start: 21000, end: 21999 } },
      targets: { frontend: ["web"] },
      arguments: ["API_URL"],
      app: {
        init_script: ["bun install"],
        services: {
          api: {
            script: ["bun run dev"],
            ports: [3000, 3001],
            cwd: "packages/api",
            env_file: ".env",
            environment: { FOO: "bar" },
            init_script: ["bun run build"],
          },
          web: {
            script: ["bun run web"],
            dependencies: ["api"],
          },
        },
      },
    });
    expect(cfg.mode).toBe("shell");
    expect(isShellMode(cfg)).toBe(true);
    expect(deploymentModeOf(cfg)).toBe("shell");
    expect(cfg.hostPorts).toEqual({ start: 21000, end: 21999 });
    expect(cfg.cloneVolumes[0]?.source).toBe("node_modules");
    expect(cfg.cache.length).toBe(1);
    expect(cfg.targets).toEqual({ frontend: ["web"] });
    expect(cfg.arguments).toEqual(["API_URL"]);
    expect(cfg.app.initScript).toEqual(["bun install"]);
    const api = cfg.app.services.api!;
    expect(api.script).toEqual(["bun run dev"]);
    expect(api.ports.map((p) => p.containerPort)).toEqual([3000, 3001]);
    expect(api.cwd).toBe("packages/api");
    expect(api.envFile).toBe(".env");
    expect(api.environment).toEqual({ FOO: "bar" });
    expect(api.initScript).toEqual(["bun run build"]);
    expect(cfg.app.services.web!.dependencies).toEqual(["api"]);
    // Shell mode keeps Docker-only structural fields neutral.
    expect(cfg.app.image).toBeNull();
    expect(api.image).toBeNull();
    expect(api.volumes).toEqual([]);
    expect(cfg.deps).toEqual({});
  });

  test("requires a non-empty script for each service", () => {
    expect(() =>
      validateConfig({ mode: "shell", app: { services: { api: {} } } }),
    ).toThrow(/app\.services\.api\.script/);
    expect(() =>
      validateConfig({ mode: "shell", app: { services: { api: { script: [] } } } }),
    ).toThrow(/app\.services\.api\.script/);
  });

  test("rejects app.image", () => {
    expect(() =>
      validateConfig({
        mode: "shell",
        app: { image: "node:20", services: { api: { script: ["x"] } } },
      }),
    ).toThrow(/shell mode/);
  });

  test("rejects per-service image", () => {
    expect(() =>
      validateConfig({
        mode: "shell",
        app: { services: { api: { image: "node:20", script: ["x"] } } },
      }),
    ).toThrow(/app\.services\.api\.image/);
  });

  test("rejects dependency containers (deps)", () => {
    expect(() =>
      validateConfig({
        mode: "shell",
        deps: { db: { image: "postgres" } },
        app: { services: { api: { script: ["x"] } } },
      }),
    ).toThrow(/dependency containers/);
  });

  test("rejects service volumes", () => {
    expect(() =>
      validateConfig({
        mode: "shell",
        app: { services: { api: { script: ["x"], volumes: ["./data:/data"] } } },
      }),
    ).toThrow(/app\.services\.api\.volumes/);
  });

  test("rejects package-manager cache mount flags", () => {
    expect(() =>
      validateConfig({
        mode: "shell",
        app: { connect_bun_cache: true, services: { api: { script: ["x"] } } },
      }),
    ).toThrow(/connect_bun_cache/);
  });

  test("rejects a compose mapping in shell mode", () => {
    expect(() =>
      validateConfig({
        mode: "shell",
        compose: { config: "x", expose: ["a:1"] },
        app: { services: { api: { script: ["x"] } } },
      }),
    ).toThrow(ConfigError);
  });

  test("validates dependency and target references", () => {
    expect(() =>
      validateConfig({
        mode: "shell",
        app: { services: { api: { script: ["x"], dependencies: ["ghost"] } } },
      }),
    ).toThrow(/unknown service "ghost"/);
    expect(() =>
      validateConfig({
        mode: "shell",
        targets: { t: ["ghost"] },
        app: { services: { api: { script: ["x"] } } },
      }),
    ).toThrow(/unknown service "ghost"/);
  });
});

describe("backend-discriminated state", () => {
  async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const home = await mkdtemp(join(tmpdir(), "wos-shell-state-"));
    const prev = process.env.WOS_HOME;
    process.env.WOS_HOME = home;
    try {
      return await fn(home);
    } finally {
      if (prev === undefined) delete process.env.WOS_HOME;
      else process.env.WOS_HOME = prev;
      await rm(home, { recursive: true, force: true });
    }
  }

  test("round-trips shell runtime state", async () => {
    await withHome(async () => {
      const worktreeRoot = "/tmp/wt-shell-round";
      const state: WosState = {
        initialized: true,
        projectName: "p",
        composeFile: "",
        backend: "shell",
        mode: "shell",
        portAssignments: { api: { "3000": 21000 } },
        worktreeRoot,
        shell: {
          services: {
            api: {
              pid: 4242,
              processGroupId: 4242,
              command: ["sh", "-lc", "(bun run dev)"],
              cwd: worktreeRoot,
              environmentKeys: ["PATH", "WOS_SERVICE_PORT"],
              logFiles: { stdout: "/tmp/a.out", stderr: "/tmp/a.err" },
              startedAt: "2026-05-29T00:00:00.000Z",
              ports: { "3000": 21000 },
            },
          },
        },
      };
      const path = sessionStatePath(worktreeRoot);
      await writeState(path, state);
      const read = await readState(path);
      expect(read).toEqual(state);
      expect(stateBackend(read!)).toBe("shell");
    });
  });

  test("legacy state without backend reads as docker", () => {
    const legacy: WosState = {
      initialized: true,
      projectName: "p",
      composeFile: "/tmp/compose.yaml",
    };
    expect(stateBackend(legacy)).toBe("docker");
  });
});
