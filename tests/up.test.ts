import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseUpArgs, runUpProgram, type RunUpDeps } from "../apps/cli/commands/up";
import { ComposeError, type DockerResult, type DockerRunner } from "@worktreeos/compose/compose";
import { cloneVolume, DEFAULT_HOST_PORT_RANGE, type WosConfig } from "@worktreeos/core/config";
import type { HealthcheckHttpClient } from "@worktreeos/runtime/healthchecks";
import {
  sessionComposePath,
  sessionRootForWorktree,
} from "@worktreeos/core/paths";
import { readState, stateFilePath, writeState } from "@worktreeos/core/state";
import type { DeploymentEvent, DeploymentObserver } from "@worktreeos/core/events";

const ORIGINAL_WOS_HOME = process.env.WOS_HOME;
let WOS_HOME_FOR_TESTS: string;
beforeAll(async () => {
  WOS_HOME_FOR_TESTS = await mkdtemp(resolve(tmpdir(), "wos-up-home-"));
  process.env.WOS_HOME = WOS_HOME_FOR_TESTS;
});
afterAll(async () => {
  if (ORIGINAL_WOS_HOME === undefined) delete process.env.WOS_HOME;
  else process.env.WOS_HOME = ORIGINAL_WOS_HOME;
  if (WOS_HOME_FOR_TESTS) {
    await rm(WOS_HOME_FOR_TESTS, { recursive: true, force: true });
  }
});

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function recordingObserver(): { events: DeploymentEvent[]; observer: DeploymentObserver } {
  const events: DeploymentEvent[] = [];
  return {
    events,
    observer: { emit: (e) => events.push(e) },
  };
}

async function makeWorkspace(): Promise<{ root: string; gitDir: string; sourceRoot: string }> {
  const root = await mkdtemp(resolve(tmpdir(), "wos-up-"));
  const gitDir = resolve(root, ".git");
  await mkdir(gitDir, { recursive: true });
  return { root, gitDir, sourceRoot: root };
}

function exampleConfig(): WosConfig {
  return {
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
              healthcheck: { enabled: false },
            },
          ],
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
}

function deps(
  overrides: Partial<RunUpDeps> & { workspace: { root: string; gitDir: string; sourceRoot: string } },
): RunUpDeps {
  const { workspace, ...rest } = overrides;
  return {
    worktreeRoot: workspace.root,
    config: exampleConfig(),
    source: { path: workspace.sourceRoot, bare: false, detached: false },
    projectName: "wos-repo-test1234",
    composeRunner: async () => ({ stdout: "[]", stderr: "", exitCode: 0 }),
    isPortAvailable: async () => true,
    now: () => new Date("2026-05-12T12:00:00Z"),
    maxAttempts: 3,
    stdout: () => {},
    ...rest,
  };
}

function classifyArgs(args: string[]): "down" | "up" | "ps" | "run" | "other" {
  // composeArgs returns ["compose", "-p", X, "-f", Y, ...rest]
  const cmd = args[5];
  if (cmd === "down") return "down";
  if (cmd === "up") return "up";
  if (cmd === "ps") return "ps";
  if (cmd === "run") return "run";
  return "other";
}

async function makeForceWorkspace(): Promise<{
  root: string;
  gitDir: string;
  sourceRoot: string;
}> {
  const parent = await mkdtemp(resolve(tmpdir(), "wos-up-force-"));
  const sourceRoot = resolve(parent, "src");
  const root = resolve(parent, "current");
  const gitDir = resolve(root, ".git");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(gitDir, { recursive: true });
  return { root, gitDir, sourceRoot };
}

function configWithCloneVolumes(): WosConfig {
  return {
    cloneVolumes: [cloneVolume(".env.local")],
    app: {
      image: "node:22",
      initScript: ["bun install"],
      services: {
        api: {
          image: null,
          ports: [
            {
              containerPort: 3000,
              allowFailure: false,
              healthcheck: { enabled: false },
            },
          ],
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
}

describe("runUpProgram", () => {
  test("allocates ports, writes compose, persists state and assignments", async () => {
    const ws = await makeWorkspace();
    try {
      const state = await runUpProgram(
        deps({
          workspace: ws,
          composeRunner: async () => ({ stdout: "[]", stderr: "", exitCode: 0 }),
        }),
      );
      expect(state.initialized).toBe(true);
      expect(state.portAssignments?.api?.["3000"]).toBeDefined();
      expect(state.portAssignments?.db?.["5432"]).toBeDefined();
      const port = state.portAssignments!.api!["3000"]!;
      expect(port).toBeGreaterThanOrEqual(DEFAULT_HOST_PORT_RANGE.start);
      expect(port).toBeLessThanOrEqual(DEFAULT_HOST_PORT_RANGE.end);

      const persisted = await readState(stateFilePath(ws.root));
      expect(persisted?.portAssignments).toEqual(state.portAssignments!);
      expect(persisted?.lastUp).toBe("2026-05-12T12:00:00.000Z");

      const composeText = await Bun.file(state.composeFile).text();
      expect(composeText).toContain(`"${port}:3000"`);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("persists lastUpCommit when a deploy commit is provided", async () => {
    const ws = await makeWorkspace();
    try {
      const state = await runUpProgram(
        deps({
          workspace: ws,
          deployCommit: "abc123def",
          composeRunner: async () => ({ stdout: "[]", stderr: "", exitCode: 0 }),
        }),
      );
      expect(state.lastUpCommit).toBe("abc123def");
      const persisted = await readState(stateFilePath(ws.root));
      expect(persisted?.lastUpCommit).toBe("abc123def");
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("leaves lastUpCommit unset when no deploy commit is provided", async () => {
    const ws = await makeWorkspace();
    try {
      const state = await runUpProgram(
        deps({
          workspace: ws,
          composeRunner: async () => ({ stdout: "[]", stderr: "", exitCode: 0 }),
        }),
      );
      expect(state.lastUpCommit).toBeUndefined();
      const persisted = await readState(stateFilePath(ws.root));
      expect(persisted?.lastUpCommit).toBeUndefined();
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("persists lastUpDurationMs measured across the up", async () => {
    const ws = await makeWorkspace();
    try {
      // Advancing clock: start at 12:00:00, finish at 12:00:07 -> 7000ms.
      const times = [
        new Date("2026-05-12T12:00:00Z"),
        new Date("2026-05-12T12:00:07Z"),
      ];
      let tick = 0;
      const state = await runUpProgram(
        deps({
          workspace: ws,
          now: () => times[Math.min(tick++, times.length - 1)]!,
          composeRunner: async () => ({ stdout: "[]", stderr: "", exitCode: 0 }),
        }),
      );
      expect(state.lastUpDurationMs).toBe(7000);
      const persisted = await readState(stateFilePath(ws.root));
      expect(persisted?.lastUpDurationMs).toBe(7000);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("writes connected package-manager cache mounts into init compose service", async () => {
    const ws = await makeWorkspace();
    try {
      const npmCache = resolve(ws.root, "host-npm-cache");
      await mkdir(npmCache);
      const config = exampleConfig();
      config.app.initScript = ["bun install"];
      config.app.connectNpmCache = true;

      const state = await runUpProgram(
        deps({
          workspace: ws,
          config,
          packageManagerCacheRunner: async (args) => {
            if (args.join(" ") === "npm config get cache") {
              return { stdout: `${npmCache}\n`, exitCode: 0 };
            }
            return { stdout: "", exitCode: 1 };
          },
          composeRunner: async () => ({ stdout: "[]", stderr: "", exitCode: 0 }),
        }),
      );

      const composeText = await Bun.file(state.composeFile).text();
      expect(composeText).toContain(`${npmCache}:/wos-cache/npm`);
      expect(composeText).toContain("NPM_CONFIG_CACHE: \"/wos-cache/npm\"");
      expect(composeText).not.toContain(`${npmCache}:/wos-cache/npm:ro`);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("retries with new ports after a port bind conflict", async () => {
    const ws = await makeWorkspace();
    try {
      const upCalls: number[][] = [];
      let upAttempt = 0;
      let conflictPort = 0;
      const runner: DockerRunner = async (args): Promise<DockerResult> => {
        const kind = classifyArgs(args);
        if (kind === "up") {
          upAttempt += 1;
          if (upAttempt === 1) {
            // Read compose file to find the assigned api port and report a conflict on it.
            const composeFile = args[4]!;
            const text = await Bun.file(composeFile).text();
            const match = text.match(/"(\d+):3000"/);
            conflictPort = match ? Number(match[1]) : 0;
            upCalls.push([conflictPort]);
            return {
              stdout: "",
              stderr: `Error: Bind for 0.0.0.0:${conflictPort} failed: port is already allocated`,
              exitCode: 1,
            };
          }
          upCalls.push([upAttempt]);
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (kind === "ps") return { stdout: "[]", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      const { events, observer } = recordingObserver();
      const state = await runUpProgram(
        deps({ workspace: ws, composeRunner: runner, observer }),
      );
      expect(upAttempt).toBe(2);
      const finalApiPort = state.portAssignments!.api!["3000"]!;
      expect(finalApiPort).not.toBe(conflictPort);
      const persisted = await readState(stateFilePath(ws.root));
      expect(persisted?.portAssignments?.api?.["3000"]).toBe(finalApiPort);
      const retries = events.filter((e) => e.type === "retry");
      expect(retries.length).toBe(1);
      expect(retries[0]).toMatchObject({ type: "retry", attempt: 1, maxAttempts: 3 });
      const deploymentLogs = events.filter(
        (e) => e.type === "log" && e.channel === "deployment" && e.stream === "stderr",
      );
      expect(deploymentLogs.some((l) => l.type === "log" && l.chunk.includes("port is already allocated"))).toBe(
        true,
      );
      const stepStates = events
        .filter((e) => e.type === "step")
        .map((e) => (e.type === "step" ? `${e.id}:${e.state}` : ""));
      expect(stepStates).toContain("compose-up:done");
      expect(stepStates).toContain("status:done");
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("fails after retry exhaustion with actionable error", async () => {
    const ws = await makeWorkspace();
    try {
      const runner: DockerRunner = async (args): Promise<DockerResult> => {
        const kind = classifyArgs(args);
        if (kind === "up") {
          return {
            stdout: "",
            stderr:
              "Error: Bind for 0.0.0.0:20000 failed: port is already allocated",
            exitCode: 1,
          };
        }
        if (kind === "ps") return { stdout: "[]", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      await expect(
        runUpProgram(deps({ workspace: ws, composeRunner: runner, maxAttempts: 2 })),
      ).rejects.toThrow(/host-port allocation could not be completed/);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("does not retry on non-port compose errors", async () => {
    const ws = await makeWorkspace();
    try {
      let upAttempts = 0;
      const runner: DockerRunner = async (args): Promise<DockerResult> => {
        const kind = classifyArgs(args);
        if (kind === "up") {
          upAttempts += 1;
          return { stdout: "", stderr: "image pull failed: not found", exitCode: 1 };
        }
        if (kind === "ps") return { stdout: "[]", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      await expect(
        runUpProgram(deps({ workspace: ws, composeRunner: runner })),
      ).rejects.toThrow(ComposeError);
      expect(upAttempts).toBe(1);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("tunnel preparer is invoked once before compose with assigned host ports", async () => {
    const ws = await makeWorkspace();
    try {
      const prepareCalls: Array<Record<string, Record<string, number>>> = [];
      const preparer = {
        prepare: async (assignments: Record<string, Record<string, number>>) => {
          prepareCalls.push(JSON.parse(JSON.stringify(assignments)));
          return { hostnames: { api: { "3000": "preview.example.com" } }, urls: {} };
        },
        skip: async () => {},
      };
      const state = await runUpProgram(
        deps({ workspace: ws, tunnelPreparer: preparer }),
      );
      expect(prepareCalls).toHaveLength(1);
      const assignedApi = state.portAssignments!.api!["3000"]!;
      expect(prepareCalls[0]!.api!["3000"]).toBe(assignedApi);
      const composeText = await Bun.file(state.composeFile).text();
      expect(composeText).toContain(`"${assignedApi}:3000"`);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("tunnel preparer is re-invoked on port-conflict retry", async () => {
    const ws = await makeWorkspace();
    try {
      let upAttempt = 0;
      let conflictPort = 0;
      const runner: DockerRunner = async (args): Promise<DockerResult> => {
        const kind = classifyArgs(args);
        if (kind === "up") {
          upAttempt += 1;
          if (upAttempt === 1) {
            const composeFile = args[4]!;
            const text = await Bun.file(composeFile).text();
            const match = text.match(/"(\d+):3000"/);
            conflictPort = match ? Number(match[1]) : 0;
            return {
              stdout: "",
              stderr: `Error: Bind for 0.0.0.0:${conflictPort} failed: port is already allocated`,
              exitCode: 1,
            };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (kind === "ps") return { stdout: "[]", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      const prepareCalls: Array<Record<string, Record<string, number>>> = [];
      const preparer = {
        prepare: async (assignments: Record<string, Record<string, number>>) => {
          prepareCalls.push(JSON.parse(JSON.stringify(assignments)));
          return { hostnames: {}, urls: {} };
        },
        skip: async () => {},
      };
      const state = await runUpProgram(
        deps({ workspace: ws, composeRunner: runner, tunnelPreparer: preparer }),
      );
      expect(prepareCalls).toHaveLength(2);
      const finalApiPort = state.portAssignments!.api!["3000"]!;
      expect(finalApiPort).not.toBe(conflictPort);
      expect(prepareCalls[1]!.api!["3000"]).toBe(finalApiPort);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("persists compose and state under a custom WOS_HOME session", async () => {
    const ws = await makeWorkspace();
    const customHome = await mkdtemp(resolve(tmpdir(), "wos-custom-home-"));
    const prev = process.env.WOS_HOME;
    process.env.WOS_HOME = customHome;
    try {
      const state = await runUpProgram(deps({ workspace: ws }));
      const expectedSessionRoot = sessionRootForWorktree(ws.root);
      const expectedComposePath = sessionComposePath(ws.root);
      const expectedStatePath = stateFilePath(ws.root);

      expect(expectedSessionRoot.startsWith(customHome + "/")).toBe(true);
      expect(state.composeFile).toBe(expectedComposePath);
      expect(await pathExists(state.composeFile)).toBe(true);
      expect(await pathExists(expectedStatePath)).toBe(true);

      const persisted = await readState(expectedStatePath);
      expect(persisted?.initialized).toBe(true);
      expect(persisted?.composeFile).toBe(expectedComposePath);
      expect(persisted?.portAssignments).toEqual(state.portAssignments!);
    } finally {
      if (prev === undefined) delete process.env.WOS_HOME;
      else process.env.WOS_HOME = prev;
      await rm(ws.root, { recursive: true, force: true });
      await rm(customHome, { recursive: true, force: true });
    }
  });

  test("reuses prior assignments when state already exists", async () => {
    const ws = await makeWorkspace();
    try {
      // First run establishes assignments.
      const first = await runUpProgram(deps({ workspace: ws }));
      const firstPort = first.portAssignments!.api!["3000"]!;
      // Second run should reuse them when nothing else changes.
      const second = await runUpProgram(deps({ workspace: ws }));
      expect(second.portAssignments!.api!["3000"]).toBe(firstPort);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("selective up emits only selected services in the generated compose", async () => {
    const ws = await makeWorkspace();
    try {
      const config = exampleConfig();
      // Add a second app service that should be omitted from selective up.
      config.app.services.web = {
        image: null,
        ports: [
          {
            containerPort: 4200,
            allowFailure: false,
            healthcheck: { enabled: false },
          },
        ],
        script: ["bun dev"],
        cwd: null,
        envFile: null,
        environment: {},
        volumes: [],
      };
      const state = await runUpProgram(
        deps({
          workspace: ws,
          config,
          composeRunner: async () => ({ stdout: "[]", stderr: "", exitCode: 0 }),
          selection: { kind: "services", services: ["api"] },
        }),
      );
      const composeText = await Bun.file(state.composeFile).text();
      expect(composeText).toContain("api:");
      expect(composeText).not.toMatch(/^\s+web:/m);
      expect(state.portAssignments?.web).toBeUndefined();
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("selective up resolves a configured target", async () => {
    const ws = await makeWorkspace();
    try {
      const config = exampleConfig();
      config.targets = { api: ["api"] };
      const state = await runUpProgram(
        deps({
          workspace: ws,
          config,
          composeRunner: async () => ({ stdout: "[]", stderr: "", exitCode: 0 }),
          selection: { kind: "target", target: "api" },
        }),
      );
      expect(state.portAssignments?.api).toBeDefined();
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("selective up expands transitive dependencies", async () => {
    const ws = await makeWorkspace();
    try {
      const config = exampleConfig();
      config.app.services.api!.dependencies = ["db"];
      config.app.services.web = {
        image: null,
        ports: [],
        script: ["bun dev"],
        cwd: null,
        envFile: null,
        environment: {},
        volumes: [],
      };
      const state = await runUpProgram(
        deps({
          workspace: ws,
          config,
          composeRunner: async () => ({ stdout: "[]", stderr: "", exitCode: 0 }),
          selection: { kind: "services", services: ["api"] },
        }),
      );
      expect(state.portAssignments?.api).toBeDefined();
      expect(state.portAssignments?.db).toBeDefined();
      const composeText = await Bun.file(state.composeFile).text();
      expect(composeText).not.toMatch(/^\s+web:/m);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("selective up runs service-level init for selected service only", async () => {
    const ws = await makeWorkspace();
    try {
      const config = exampleConfig();
      config.app.initScript = ["bun install"];
      config.app.services.api!.initScript = ["echo api-init"];
      config.app.services.admin = {
        image: null,
        ports: [],
        script: ["bun dev"],
        cwd: null,
        envFile: null,
        environment: {},
        volumes: [],
        initScript: ["echo admin-init"],
      };
      const initCommands: string[] = [];
      const runner: DockerRunner = async (args): Promise<DockerResult> => {
        const kind = classifyArgs(args);
        if (kind === "run") {
          initCommands.push(args.join(" "));
        }
        if (kind === "ps") return { stdout: "[]", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      await runUpProgram(
        deps({
          workspace: ws,
          config,
          composeRunner: runner,
          selection: { kind: "services", services: ["api"] },
        }),
      );
      const joined = initCommands.join(" \n ");
      expect(joined).toContain("bun install");
      expect(joined).toContain("echo api-init");
      expect(joined).not.toContain("echo admin-init");
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("compose-mode rejects selective up", async () => {
    const ws = await makeWorkspace();
    try {
      const composeFile = resolve(ws.root, "docker-compose.yaml");
      await writeFile(composeFile, "services:\n  api:\n    image: nginx\n");
      const config: WosConfig = {
        mode: "compose",
        cloneVolumes: [],
        app: {
          image: null,
          initScript: [],
          services: {},
        },
        deps: {},
        hostPorts: { ...DEFAULT_HOST_PORT_RANGE },
        cache: [],
        compose: {
          config: composeFile,
          expose: [{ service: "api", port: 80 }],
          envFile: [],
          environment: {},
        },
      };
      await expect(
        runUpProgram(
          deps({
            workspace: ws,
            config,
            composeRunner: async () => ({ stdout: "[]", stderr: "", exitCode: 0 }),
            selection: { kind: "services", services: ["api"] },
          }),
        ),
      ).rejects.toThrow(/selective startup .* supported only in generated-compose mode/);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });
});

describe("runUpProgram with force", () => {
  test("force=true reruns clone-volume copy and init script on initialized worktree", async () => {
    const ws = await makeForceWorkspace();
    try {
      await writeFile(resolve(ws.sourceRoot, ".env.local"), "FRESH=1");
      await writeFile(resolve(ws.root, ".env.local"), "STALE=1");
      const statePath = stateFilePath(ws.root);
      await writeState(statePath, {
        initialized: true,
        projectName: "wos-repo-test1234",
        composeFile: resolve(ws.root, "old-compose.yaml"),
        portAssignments: { api: { "3000": 20100 }, db: { "5432": 20101 } },
      });
      const runCalls: string[][] = [];
      const runner: DockerRunner = async (args): Promise<DockerResult> => {
        const kind = classifyArgs(args);
        if (kind === "run") runCalls.push(args);
        if (kind === "ps") return { stdout: "[]", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      };

      const state = await runUpProgram(
        deps({
          workspace: ws,
          config: configWithCloneVolumes(),
          composeRunner: runner,
          force: true,
        }),
      );

      expect(state.initialized).toBe(true);
      expect(await Bun.file(resolve(ws.root, ".env.local")).text()).toBe(
        "FRESH=1",
      );
      expect(runCalls.length).toBe(1);
      expect(runCalls[0]).toContain("--entrypoint");
      expect(runCalls[0]?.[runCalls[0]!.length - 1]).toBe("(bun install)");
      const persisted = await readState(statePath);
      expect(persisted?.initialized).toBe(true);
      expect(persisted?.portAssignments?.api?.["3000"]).toBe(
        state.portAssignments!.api!["3000"]!,
      );
    } finally {
      await rm(ws.root, { recursive: true, force: true });
      await rm(ws.sourceRoot, { recursive: true, force: true });
    }
  });

  test("force=false skips clone-volume copy and init script on initialized worktree", async () => {
    const ws = await makeForceWorkspace();
    try {
      await writeFile(resolve(ws.sourceRoot, ".env.local"), "FRESH=1");
      await writeFile(resolve(ws.root, ".env.local"), "STALE=1");
      const statePath = stateFilePath(ws.root);
      await writeState(statePath, {
        initialized: true,
        projectName: "wos-repo-test1234",
        composeFile: resolve(ws.root, "old-compose.yaml"),
        portAssignments: { api: { "3000": 20100 }, db: { "5432": 20101 } },
      });
      const runCalls: string[][] = [];
      const runner: DockerRunner = async (args): Promise<DockerResult> => {
        const kind = classifyArgs(args);
        if (kind === "run") runCalls.push(args);
        if (kind === "ps") return { stdout: "[]", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      };

      await runUpProgram(
        deps({
          workspace: ws,
          config: configWithCloneVolumes(),
          composeRunner: runner,
        }),
      );

      expect(runCalls.length).toBe(0);
      expect(await Bun.file(resolve(ws.root, ".env.local")).text()).toBe(
        "STALE=1",
      );
    } finally {
      await rm(ws.root, { recursive: true, force: true });
      await rm(ws.sourceRoot, { recursive: true, force: true });
    }
  });

  test("force=false skips package-manager cache detection on initialized worktree", async () => {
    const ws = await makeForceWorkspace();
    try {
      const statePath = stateFilePath(ws.root);
      await writeState(statePath, {
        initialized: true,
        projectName: "wos-repo-test1234",
        composeFile: resolve(ws.root, "old-compose.yaml"),
        portAssignments: { api: { "3000": 20100 }, db: { "5432": 20101 } },
      });
      const config = configWithCloneVolumes();
      config.app.connectNpmCache = true;
      let calls = 0;

      await runUpProgram(
        deps({
          workspace: ws,
          config,
          packageManagerCacheRunner: async () => {
            calls += 1;
            return { stdout: "", exitCode: 1 };
          },
        }),
      );

      expect(calls).toBe(0);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
      await rm(ws.sourceRoot, { recursive: true, force: true });
    }
  });

  test("force=true fails on missing clone-volume source, skips init, unmarks initialized", async () => {
    const ws = await makeForceWorkspace();
    try {
      // Source worktree intentionally lacks .env.local.
      await writeFile(resolve(ws.root, ".env.local"), "STALE=1");
      const statePath = stateFilePath(ws.root);
      await writeState(statePath, {
        initialized: true,
        projectName: "wos-repo-test1234",
        composeFile: resolve(ws.root, "old-compose.yaml"),
        portAssignments: { api: { "3000": 20100 }, db: { "5432": 20101 } },
      });
      const runCalls: string[][] = [];
      const runner: DockerRunner = async (args): Promise<DockerResult> => {
        const kind = classifyArgs(args);
        if (kind === "run") runCalls.push(args);
        if (kind === "ps") return { stdout: "[]", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      };

      await expect(
        runUpProgram(
          deps({
            workspace: ws,
            config: configWithCloneVolumes(),
            composeRunner: runner,
            force: true,
          }),
        ),
      ).rejects.toThrow();

      expect(runCalls.length).toBe(0);
      expect(await pathExists(resolve(ws.root, ".env.local"))).toBe(false);
      const persisted = await readState(statePath);
      expect(persisted?.initialized).toBe(false);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
      await rm(ws.sourceRoot, { recursive: true, force: true });
    }
  });

  test("force=true restores and saves configured cache entries on a hit", async () => {
    const ws = await makeForceWorkspace();
    try {
      const statePath = stateFilePath(ws.root);
      await writeState(statePath, {
        initialized: true,
        projectName: "wos-repo-test1234",
        composeFile: resolve(ws.root, "old-compose.yaml"),
        portAssignments: { api: { "3000": 20100 }, db: { "5432": 20101 } },
      });
      await writeFile(resolve(ws.root, "yarn.lock"), "lock-v1");
      await mkdir(resolve(ws.root, "node_modules"));
      await writeFile(resolve(ws.root, "node_modules", "stale.txt"), "stale");

      const cacheRoot = resolve(ws.root, ".cache-root");
      await mkdir(cacheRoot, { recursive: true });
      const { computeCacheKeyHash, encodedPathName } = await import("@worktreeos/runtime/cache");
      const entry = {
        key: { kind: "files" as const, files: ["yarn.lock"] },
        paths: ["node_modules"],
      };
      const keyHash = await computeCacheKeyHash(entry, ws.root);
      const cachedDir = resolve(cacheRoot, keyHash, encodedPathName("node_modules"));
      await mkdir(cachedDir, { recursive: true });
      await writeFile(resolve(cachedDir, "fresh.txt"), "cached");

      const config: WosConfig = {
        cloneVolumes: [],
        app: {
          image: "node:22",
          initScript: ["bun install"],
          services: {
            api: {
          image: null,
          ports: [
            {
              containerPort: 3000,
              allowFailure: false,
              healthcheck: { enabled: false },
            },
          ],
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
        cache: [entry],
      };

      await runUpProgram(
        deps({
          workspace: ws,
          config,
          cacheRoot,
          force: true,
          composeRunner: async () => ({ stdout: "[]", stderr: "", exitCode: 0 }),
        }),
      );

      expect(await pathExists(resolve(ws.root, "node_modules", "stale.txt"))).toBe(false);
      expect(await Bun.file(resolve(ws.root, "node_modules", "fresh.txt")).text()).toBe(
        "cached",
      );
      expect(await pathExists(resolve(cacheRoot, keyHash))).toBe(true);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
      await rm(ws.sourceRoot, { recursive: true, force: true });
    }
  });

  test("does not save cache when init script fails", async () => {
    const ws = await makeForceWorkspace();
    try {
      await writeFile(resolve(ws.root, "yarn.lock"), "lock-v2");
      await mkdir(resolve(ws.root, "node_modules"));
      await writeFile(resolve(ws.root, "node_modules", "fresh.txt"), "fresh");

      const cacheRoot = resolve(ws.root, ".cache-root");
      await mkdir(cacheRoot, { recursive: true });
      const { computeCacheKeyHash } = await import("@worktreeos/runtime/cache");
      const entry = {
        key: { kind: "files" as const, files: ["yarn.lock"] },
        paths: ["node_modules"],
      };
      const keyHash = await computeCacheKeyHash(entry, ws.root);

      const config: WosConfig = {
        cloneVolumes: [],
        app: {
          image: "node:22",
          initScript: ["bun install"],
          services: {
            api: {
          image: null,
          ports: [
            {
              containerPort: 3000,
              allowFailure: false,
              healthcheck: { enabled: false },
            },
          ],
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
        cache: [entry],
      };

      const runner: DockerRunner = async (args): Promise<DockerResult> => {
        if (classifyArgs(args) === "run") {
          return { stdout: "", stderr: "init failed", exitCode: 1 };
        }
        if (classifyArgs(args) === "ps") return { stdout: "[]", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      };

      await expect(
        runUpProgram(
          deps({
            workspace: ws,
            config,
            cacheRoot,
            force: true,
            composeRunner: runner,
          }),
        ),
      ).rejects.toThrow();
      expect(await pathExists(resolve(cacheRoot, keyHash))).toBe(false);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
      await rm(ws.sourceRoot, { recursive: true, force: true });
    }
  });

  test("parseUpArgs reads --force only when present", () => {
    expect(parseUpArgs([])).toEqual({
      force: false,
      detached: false,
      noTunnel: false,
      services: undefined,
      target: undefined,
    });
    expect(parseUpArgs(["--force"])).toEqual({
      force: true,
      detached: false,
      noTunnel: false,
      services: undefined,
      target: undefined,
    });
  });

  test("parseUpArgs rejects unknown options", () => {
    expect(() => parseUpArgs(["--other"])).toThrow();
  });

  test("parseUpArgs reads -d as the detached flag", () => {
    expect(parseUpArgs(["-d"])).toEqual({
      force: false,
      detached: true,
      noTunnel: false,
      services: undefined,
      target: undefined,
    });
  });

  test("parseUpArgs reads --no-tunnel as the tunnel skip flag", () => {
    expect(parseUpArgs(["--no-tunnel"])).toEqual({
      force: false,
      detached: false,
      noTunnel: true,
      services: undefined,
      target: undefined,
    });
    expect(parseUpArgs(["-d", "--no-tunnel"])).toEqual({
      force: false,
      detached: true,
      noTunnel: true,
      services: undefined,
      target: undefined,
    });
  });

  test("parseUpArgs combines -d and --force in any order", () => {
    expect(parseUpArgs(["-d", "--force"])).toEqual({
      force: true,
      detached: true,
      noTunnel: false,
      services: undefined,
      target: undefined,
    });
    expect(parseUpArgs(["--force", "-d"])).toEqual({
      force: true,
      detached: true,
      noTunnel: false,
      services: undefined,
      target: undefined,
    });
  });
});

describe("runUpProgram compose rewrite", () => {
  test("second up rewrites compose.yaml from updated config", async () => {
    const ws = await makeWorkspace();
    try {
      const first = await runUpProgram(deps({ workspace: ws }));
      const firstText = await Bun.file(first.composeFile).text();
      expect(firstText).toContain("postgres:13");

      const updatedConfig = exampleConfig();
      updatedConfig.deps = {
        redis: { image: "redis:7", ports: [6379], environment: {}, volumes: [] },
      };
      const second = await runUpProgram(deps({ workspace: ws, config: updatedConfig }));
      const secondText = await Bun.file(second.composeFile).text();
      expect(secondText).toContain("redis:7");
      expect(secondText).not.toContain("postgres:13");
      expect(second.composeFile).toBe(first.composeFile);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("previous compose is used for shutdown and rewritten compose for startup", async () => {
    const ws = await makeWorkspace();
    try {
      const first = await runUpProgram(deps({ workspace: ws }));

      const downFiles: string[] = [];
      const upFiles: string[] = [];
      const runner: DockerRunner = async (args): Promise<DockerResult> => {
        const kind = classifyArgs(args);
        const file = args[4]!;
        if (kind === "down") downFiles.push(file);
        if (kind === "up") upFiles.push(file);
        if (kind === "ps") return { stdout: "[]", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      };

      const updatedConfig = exampleConfig();
      updatedConfig.deps = {
        redis: { image: "redis:7", ports: [6379], environment: {}, volumes: [] },
      };

      const second = await runUpProgram(
        deps({ workspace: ws, config: updatedConfig, composeRunner: runner }),
      );

      expect(downFiles.length).toBe(1);
      expect(downFiles[0]).toBe(first.composeFile);
      expect(upFiles.length).toBe(1);
      expect(upFiles[0]).toBe(second.composeFile);
      const upText = await Bun.file(upFiles[0]!).text();
      expect(upText).toContain("redis:7");
      expect(upText).not.toContain("postgres:13");
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });
});

describe("runUpProgram source-worktree mode", () => {
  test("skips clone-volume copy but runs init/cache/deployment from source worktree", async () => {
    const ws = await makeWorkspace();
    try {
      await writeFile(resolve(ws.root, ".env.local"), "SOURCE=1");
      const runCalls: string[][] = [];
      const runner: DockerRunner = async (args): Promise<DockerResult> => {
        const kind = classifyArgs(args);
        if (kind === "run") runCalls.push(args);
        if (kind === "ps") return { stdout: "[]", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      const { events, observer } = recordingObserver();

      const state = await runUpProgram(
        deps({
          workspace: ws,
          config: configWithCloneVolumes(),
          composeRunner: runner,
          observer,
        }),
      );

      expect(state.initialized).toBe(true);
      expect(await Bun.file(resolve(ws.root, ".env.local")).text()).toBe("SOURCE=1");
      expect(runCalls.length).toBe(1);
      const volumeEvents = events.filter((e) => e.type === "volume-clone");
      expect(volumeEvents.length).toBe(0);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("force=true from source worktree does not remove clone-volume destinations", async () => {
    const ws = await makeWorkspace();
    try {
      await writeFile(resolve(ws.root, ".env.local"), "SOURCE=1");
      const statePath = stateFilePath(ws.root);
      await writeState(statePath, {
        initialized: true,
        projectName: "wos-repo-test1234",
        composeFile: resolve(ws.root, "old-compose.yaml"),
        portAssignments: { api: { "3000": 20100 }, db: { "5432": 20101 } },
      });
      const runner: DockerRunner = async (args): Promise<DockerResult> => {
        if (classifyArgs(args) === "ps") return { stdout: "[]", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      const { events, observer } = recordingObserver();

      const state = await runUpProgram(
        deps({
          workspace: ws,
          config: configWithCloneVolumes(),
          composeRunner: runner,
          force: true,
          observer,
        }),
      );

      expect(state.initialized).toBe(true);
      expect(await pathExists(resolve(ws.root, ".env.local"))).toBe(true);
      expect(await Bun.file(resolve(ws.root, ".env.local")).text()).toBe("SOURCE=1");
      const volumeEvents = events.filter((e) => e.type === "volume-clone");
      expect(volumeEvents.length).toBe(0);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });
});

describe("runUpProgram healthchecks", () => {
  function configWithEnabledHealthcheck(timeoutMs = 100): WosConfig {
    return {
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
                  timeoutMs,
                  startPeriodMs: 10000,
                  intervalMs: 10000,
                  retries: 3,
                },
              },
            ],
            script: ["bun dev"],
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

  function psWithApiPort(hostPort: number): string {
    return JSON.stringify([
      {
        Service: "api",
        State: "running",
        Status: "Up 1s",
        Publishers: [
          {
            TargetPort: 3000,
            PublishedPort: hostPort,
            URL: "127.0.0.1",
            Protocol: "tcp",
          },
        ],
      },
    ]);
  }

  test("succeeds when required healthcheck passes", async () => {
    const ws = await makeWorkspace();
    try {
      let hostPort = 0;
      const composeRunner = async (
        args: string[],
      ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
        const cmd = args[5];
        if (cmd === "ps") {
          // Read assigned port from compose file
          const composeFile = args[4]!;
          const text = await Bun.file(composeFile).text();
          const match = text.match(/"(\d+):3000"/);
          hostPort = match ? Number(match[1]) : 0;
          return { stdout: psWithApiPort(hostPort), stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      const http: HealthcheckHttpClient = async () => ({ status: 200 });
      const state = await runUpProgram(
        deps({
          workspace: ws,
          config: configWithEnabledHealthcheck(),
          composeRunner,
          healthcheckHttp: http,
        }),
      );
      expect(state.initialized).toBe(true);
      expect(hostPort).toBeGreaterThan(0);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("fails when required healthcheck fails", async () => {
    const ws = await makeWorkspace();
    try {
      const composeRunner = async (
        args: string[],
      ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
        const cmd = args[5];
        if (cmd === "ps") {
          return { stdout: psWithApiPort(21001), stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      const http: HealthcheckHttpClient = async () => ({ status: 500 });
      await expect(
        runUpProgram(
          deps({
            workspace: ws,
            config: configWithEnabledHealthcheck(),
            composeRunner,
            healthcheckHttp: http,
          }),
        ),
      ).rejects.toThrow(/app-port healthcheck failed/);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("progress.composeStarted flips to true after compose-up regardless of healthcheck outcome", async () => {
    // Happy path: compose-up succeeds and healthcheck passes — composeStarted
    // must be true after the program completes.
    const wsOk = await makeWorkspace();
    try {
      const composeRunner = async (
        args: string[],
      ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
        const cmd = args[5];
        if (cmd === "ps") {
          return { stdout: psWithApiPort(21001), stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      const http: HealthcheckHttpClient = async () => ({ status: 200 });
      const progress = { composeStarted: false };
      await runUpProgram(
        deps({
          workspace: wsOk,
          config: configWithEnabledHealthcheck(),
          composeRunner,
          healthcheckHttp: http,
          progress,
        }),
      );
      expect(progress.composeStarted).toBe(true);
    } finally {
      await rm(wsOk.root, { recursive: true, force: true });
    }

    // Failure path: compose-up succeeds but the required healthcheck fails —
    // composeStarted must still be true so the daemon caller can decide to
    // keep tunnel routes open while the user diagnoses the failure.
    const wsFail = await makeWorkspace();
    try {
      const composeRunner = async (
        args: string[],
      ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
        const cmd = args[5];
        if (cmd === "ps") {
          return { stdout: psWithApiPort(21001), stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      const http: HealthcheckHttpClient = async () => ({ status: 500 });
      const progress = { composeStarted: false };
      await expect(
        runUpProgram(
          deps({
            workspace: wsFail,
            config: configWithEnabledHealthcheck(),
            composeRunner,
            healthcheckHttp: http,
            progress,
          }),
        ),
      ).rejects.toThrow(/app-port healthcheck failed/);
      expect(progress.composeStarted).toBe(true);
    } finally {
      await rm(wsFail.root, { recursive: true, force: true });
    }

    // Before-compose-up failure: a non-port compose error makes the retry
    // loop exit before `composeStarted` is set.
    const wsEarly = await makeWorkspace();
    try {
      const runner: DockerRunner = async (args): Promise<DockerResult> => {
        const cmd = args[5];
        if (cmd === "up") {
          return {
            stdout: "",
            stderr: "image pull failed: not found",
            exitCode: 1,
          };
        }
        if (cmd === "ps") return { stdout: "[]", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      const progress = { composeStarted: false };
      await expect(
        runUpProgram(
          deps({ workspace: wsEarly, composeRunner: runner, progress }),
        ),
      ).rejects.toThrow();
      expect(progress.composeStarted).toBe(false);
    } finally {
      await rm(wsEarly.root, { recursive: true, force: true });
    }
  });

  test("emits a matched healthcheck-attempt event with max attempts from retries", async () => {
    const ws = await makeWorkspace();
    try {
      const composeRunner = async (
        args: string[],
      ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
        const cmd = args[5];
        if (cmd === "ps") {
          return { stdout: psWithApiPort(21001), stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      const http: HealthcheckHttpClient = async () => ({ status: 200 });
      const { events, observer } = recordingObserver();
      await runUpProgram(
        deps({
          workspace: ws,
          config: configWithEnabledHealthcheck(),
          composeRunner,
          healthcheckHttp: http,
          observer,
        }),
      );
      const attempts = events.filter(
        (e): e is Extract<DeploymentEvent, { type: "healthcheck-attempt" }> =>
          e.type === "healthcheck-attempt",
      );
      expect(attempts.length).toBeGreaterThanOrEqual(1);
      const matched = attempts.find((a) => a.matched);
      expect(matched).toMatchObject({
        service: "api",
        containerPort: 3000,
        attempt: 1,
        maxAttempts: 3,
        status: 200,
        matched: true,
      });
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("emits failing healthcheck-attempt events with the observed status", async () => {
    const ws = await makeWorkspace();
    try {
      const composeRunner = async (
        args: string[],
      ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
        const cmd = args[5];
        if (cmd === "ps") {
          return { stdout: psWithApiPort(21001), stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      const http: HealthcheckHttpClient = async () => ({ status: 503 });
      const { events, observer } = recordingObserver();
      await expect(
        runUpProgram(
          deps({
            workspace: ws,
            config: configWithEnabledHealthcheck(),
            composeRunner,
            healthcheckHttp: http,
            observer,
          }),
        ),
      ).rejects.toThrow(/app-port healthcheck failed/);
      const attempts = events.filter(
        (e): e is Extract<DeploymentEvent, { type: "healthcheck-attempt" }> =>
          e.type === "healthcheck-attempt",
      );
      expect(attempts.length).toBeGreaterThanOrEqual(1);
      for (const a of attempts) {
        expect(a.matched).toBe(false);
        expect(a.status).toBe(503);
        expect(a.maxAttempts).toBe(3);
      }
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("allowed failure does not fail up", async () => {
    const ws = await makeWorkspace();
    try {
      const cfg = configWithEnabledHealthcheck();
      cfg.app.services.api!.ports[0]!.allowFailure = true;
      const composeRunner = async (
        args: string[],
      ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
        const cmd = args[5];
        if (cmd === "ps") {
          return { stdout: psWithApiPort(21001), stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      const http: HealthcheckHttpClient = async () => ({ status: 500 });
      const state = await runUpProgram(
        deps({
          workspace: ws,
          config: cfg,
          composeRunner,
          healthcheckHttp: http,
        }),
      );
      expect(state.initialized).toBe(true);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });
});

describe("runUpProgram static ports (dynamic_ports: false)", () => {
  function staticConfig(): WosConfig {
    return { ...exampleConfig(), dynamicPorts: false };
  }

  test("publishes each declared port as the same host port", async () => {
    const ws = await makeWorkspace();
    try {
      const state = await runUpProgram(
        deps({
          workspace: ws,
          config: staticConfig(),
          composeRunner: async () => ({ stdout: "[]", stderr: "", exitCode: 0 }),
        }),
      );
      expect(state.portAssignments?.api?.["3000"]).toBe(3000);
      expect(state.portAssignments?.db?.["5432"]).toBe(5432);
      const composeText = await Bun.file(state.composeFile).text();
      expect(composeText).toContain(`"3000:3000"`);
      expect(composeText).toContain(`"5432:5432"`);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("fails before startup when a declared static port is unavailable", async () => {
    const ws = await makeWorkspace();
    try {
      let upAttempts = 0;
      const runner: DockerRunner = async (args): Promise<DockerResult> => {
        if (classifyArgs(args) === "up") upAttempts += 1;
        return { stdout: "[]", stderr: "", exitCode: 0 };
      };
      await expect(
        runUpProgram(
          deps({
            workspace: ws,
            config: staticConfig(),
            composeRunner: runner,
            isPortAvailable: async (port) => port !== 3000,
          }),
        ),
      ).rejects.toThrow(/static host port 3000.*already in use/);
      expect(upAttempts).toBe(0);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("does not retry on a static compose port conflict", async () => {
    const ws = await makeWorkspace();
    try {
      let upAttempts = 0;
      const runner: DockerRunner = async (args): Promise<DockerResult> => {
        const kind = classifyArgs(args);
        if (kind === "up") {
          upAttempts += 1;
          return {
            stdout: "",
            stderr: "Error: Bind for 0.0.0.0:3000 failed: port is already allocated",
            exitCode: 1,
          };
        }
        if (kind === "ps") return { stdout: "[]", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      await expect(
        runUpProgram(
          deps({ workspace: ws, config: staticConfig(), composeRunner: runner }),
        ),
      ).rejects.toThrow(/static host port conflict/);
      expect(upAttempts).toBe(1);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("fails when two services require the same static host port", async () => {
    const ws = await makeWorkspace();
    try {
      const cfg: WosConfig = {
        ...staticConfig(),
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
            web: {
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
        deps: {},
      };
      await expect(
        runUpProgram(deps({ workspace: ws, config: cfg })),
      ).rejects.toThrow(/static host port 3000 is required by both/);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });
});
