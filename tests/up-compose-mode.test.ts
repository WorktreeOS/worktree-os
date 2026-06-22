import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runUpProgram, type RunUpDeps } from "@worktreeos/runtime/up-program";
import type { DockerResult } from "@worktreeos/compose/compose";
import {
  cloneVolume,
  type ComposeExposePort,
  type WosConfig,
} from "@worktreeos/core/config";
import { readState, stateFilePath } from "@worktreeos/core/state";
import {
  sessionComposeBasePath,
  sessionComposeOverlayPath,
} from "@worktreeos/core/paths";
import type { DeploymentEvent, DeploymentObserver } from "@worktreeos/core/events";

const ORIGINAL_WOS_HOME = process.env.WOS_HOME;
let WOS_HOME_FOR_TESTS: string;
beforeAll(async () => {
  WOS_HOME_FOR_TESTS = await mkdtemp(resolve(tmpdir(), "wos-compose-home-"));
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

function recordingObserver(): {
  events: DeploymentEvent[];
  observer: DeploymentObserver;
} {
  const events: DeploymentEvent[] = [];
  return { events, observer: { emit: (e) => events.push(e) } };
}

async function makeWorkspace(): Promise<{
  root: string;
  sourceRoot: string;
  composePath: string;
}> {
  const root = await mkdtemp(resolve(tmpdir(), "wos-compose-mode-"));
  await mkdir(resolve(root, ".git"), { recursive: true });
  const composePath = resolve(root, "docker-compose.yaml");
  await writeFile(composePath, "services:\n  api: { image: nginx:alpine }\n");
  return { root, sourceRoot: root, composePath };
}

function exposeApi(port: number = 3000): ComposeExposePort {
  return { service: "api", port };
}

function composeModeConfig(extras?: {
  envFile?: string[];
  environment?: Record<string, string>;
  expose?: ComposeExposePort[];
  cloneVolumes?: ReturnType<typeof cloneVolume>[];
  dynamicPorts?: boolean;
}): WosConfig {
  return {
    mode: "compose",
    cloneVolumes: extras?.cloneVolumes ?? [],
    app: {
      image: null,
      initScript: [],
      connectNpmCache: false,
      connectYarnCache: false,
      connectBunCache: false,
      services: {},
    },
    deps: {},
    hostPorts: { start: 20000, end: 29999 },
    dynamicPorts: extras?.dynamicPorts ?? true,
    cache: [],
    compose: {
      config: "docker-compose.yaml",
      expose: extras?.expose ?? [exposeApi(3000)],
      envFile: extras?.envFile ?? [],
      environment: extras?.environment ?? {},
    },
  };
}

interface CallLog {
  args: string[];
  env?: Record<string, string>;
}

/** Return the docker-compose subcommand (the first non-flag arg after `-p` + every `-f <file>` pair). */
function subcommandOf(args: string[]): string | undefined {
  let i = 1;
  while (i < args.length) {
    const a = args[i];
    if (a === "-p") {
      i += 2;
      continue;
    }
    if (a === "-f") {
      i += 2;
      continue;
    }
    return a;
  }
  return undefined;
}

function makeRunner(): {
  calls: CallLog[];
  runner: (args: string[], opts?: { env?: Record<string, string> }) => Promise<DockerResult>;
} {
  const calls: CallLog[] = [];
  return {
    calls,
    runner: async (args, opts) => {
      calls.push({ args, env: opts?.env });
      const cmd = subcommandOf(args);
      if (cmd === "ps") {
        const services = [
          { Service: "api", State: "running", Status: "Up", Publishers: [] },
          { Service: "internal-db", State: "running", Status: "Up", Publishers: [] },
        ];
        return {
          stdout: services.map((s) => JSON.stringify(s)).join("\n"),
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
}

function makeDeps(opts: {
  workspace: { root: string; sourceRoot: string };
  config: WosConfig;
  runner: (args: string[], opts?: { env?: Record<string, string> }) => Promise<DockerResult>;
  observer?: DeploymentObserver;
  force?: boolean;
}): RunUpDeps {
  return {
    worktreeRoot: opts.workspace.root,
    config: opts.config,
    source: { path: opts.workspace.sourceRoot, bare: false, detached: false },
    projectName: "wos-compose-test",
    composeRunner: opts.runner,
    now: () => new Date("2026-05-18T12:00:00Z"),
    stdout: () => {},
    observer: opts.observer,
    force: opts.force,
  };
}

describe("runUpProgram (compose mode)", () => {
  test("writes sanitized base and overlay; persists composeFiles in state", async () => {
    const ws = await makeWorkspace();
    try {
      const { runner } = makeRunner();
      const state = await runUpProgram(
        makeDeps({ workspace: ws, config: composeModeConfig(), runner }),
      );
      const expectedBase = sessionComposeBasePath(ws.root);
      const expectedOverlay = sessionComposeOverlayPath(ws.root);

      expect(state.initialized).toBe(true);
      expect(state.composeFile).toBe(expectedBase);
      expect(state.composeFiles).toEqual([expectedBase, expectedOverlay]);
      // Compose mode now allocates host ports for exposed services.
      expect(state.portAssignments?.api?.["3000"]).toBeGreaterThanOrEqual(20000);

      const persisted = await readState(stateFilePath(ws.root));
      expect(persisted?.composeFiles).toEqual([expectedBase, expectedOverlay]);
      expect(await pathExists(expectedBase)).toBe(true);
      expect(await pathExists(expectedOverlay)).toBe(true);

      const overlayText = await Bun.file(expectedOverlay).text();
      expect(overlayText).toContain("api");
      expect(overlayText).toContain(":3000");
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("docker compose invocations pass -f for sanitized base and overlay in order", async () => {
    const ws = await makeWorkspace();
    try {
      const { calls, runner } = makeRunner();
      await runUpProgram(makeDeps({ workspace: ws, config: composeModeConfig(), runner }));
      const expectedBase = sessionComposeBasePath(ws.root);
      const expectedOverlay = sessionComposeOverlayPath(ws.root);
      const upCall = calls.find((c) => subcommandOf(c.args) === "up");
      expect(upCall).toBeDefined();
      // -p <proj> -f <base> -f <overlay>
      const fIndices: number[] = [];
      upCall!.args.forEach((a, i) => {
        if (a === "-f") fIndices.push(i);
      });
      expect(fIndices.length).toBe(2);
      expect(upCall!.args[fIndices[0]! + 1]).toBe(expectedBase);
      expect(upCall!.args[fIndices[1]! + 1]).toBe(expectedOverlay);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("propagates compose command environment to docker invocations", async () => {
    const ws = await makeWorkspace();
    try {
      await writeFile(resolve(ws.root, ".env.compose"), "FROM_FILE=1\n");
      const { calls, runner } = makeRunner();
      const config = composeModeConfig({
        envFile: [".env.compose"],
        environment: { FROM_INLINE: "yes" },
      });
      await runUpProgram(makeDeps({ workspace: ws, config, runner }));

      const upCall = calls.find((c) => subcommandOf(c.args) === "up");
      expect(upCall).toBeDefined();
      expect(upCall!.env?.FROM_FILE).toBe("1");
      expect(upCall!.env?.FROM_INLINE).toBe("yes");

      const psCall = calls.find((c) => subcommandOf(c.args) === "ps");
      expect(psCall?.env?.FROM_INLINE).toBe("yes");
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("resolves expose templates in compose.environment for up + status", async () => {
    const ws = await makeWorkspace();
    try {
      const { calls, runner } = makeRunner();
      const config = composeModeConfig({
        environment: { API_HOST_PORT: "${expose.api.hostPort[3000]}" },
      });
      const state = await runUpProgram(makeDeps({ workspace: ws, config, runner }));
      const assignedPort = String(state.portAssignments!.api!["3000"]);
      const upCall = calls.find((c) => subcommandOf(c.args) === "up");
      expect(upCall!.env!.API_HOST_PORT).toBe(assignedPort);
      const psCall = calls.find((c) => subcommandOf(c.args) === "ps");
      expect(psCall!.env!.API_HOST_PORT).toBe(assignedPort);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("filters services-discovered to compose.expose entries", async () => {
    const ws = await makeWorkspace();
    try {
      const { runner } = makeRunner();
      const { events, observer } = recordingObserver();
      await runUpProgram(
        makeDeps({
          workspace: ws,
          config: composeModeConfig({ expose: [exposeApi(3000)] }),
          runner,
          observer,
        }),
      );
      const discovered = events.find((e) => e.type === "services-discovered");
      expect(discovered).toBeDefined();
      if (discovered?.type !== "services-discovered") {
        throw new Error("expected services-discovered event");
      }
      expect(discovered.services).toEqual(["api"]);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("emits no healthcheck step in compose mode", async () => {
    const ws = await makeWorkspace();
    try {
      const { runner } = makeRunner();
      const { events, observer } = recordingObserver();
      await runUpProgram(
        makeDeps({ workspace: ws, config: composeModeConfig(), runner, observer }),
      );
      const healthcheckSteps = events.filter(
        (e) => e.type === "step" && e.id === "healthcheck",
      );
      expect(healthcheckSteps.length).toBe(0);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("invokes tunnel preparer with compose expose entries and resolves hostname templates", async () => {
    const ws = await makeWorkspace();
    try {
      const { calls, runner } = makeRunner();
      const prepareCalls: Array<Record<string, Record<string, number>>> = [];
      const config = composeModeConfig({
        expose: [{ service: "api", port: 3000 }],
        environment: {
          API_HOSTNAME: "${expose.api.hostname[3000]}",
          API_URL: "${expose.api.url[3000]}",
        },
      });
      const deps: RunUpDeps = {
        ...makeDeps({ workspace: ws, config, runner }),
        tunnelPreparer: {
          async prepare(assignments) {
            prepareCalls.push(assignments);
            // Simulate a tunnel for api:3000.
            return {
              hostnames: { api: { "3000": "preview-api.loca.lt" } },
              urls: { api: { "3000": "https://preview-api.loca.lt" } },
            };
          },
          async skip() {
            /* no-op for this test */
          },
        },
      };
      await runUpProgram(deps);
      expect(prepareCalls.length).toBeGreaterThan(0);
      const upCall = calls.find((c) => subcommandOf(c.args) === "up");
      expect(upCall!.env!.API_HOSTNAME).toBe("preview-api.loca.lt");
      expect(upCall!.env!.API_URL).toBe("https://preview-api.loca.lt");
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("retries on wos-managed port conflict and rewrites the overlay", async () => {
    const ws = await makeWorkspace();
    try {
      let upCalls = 0;
      const calls: { args: string[] }[] = [];
      const runner = async (
        args: string[],
        _opts?: { env?: Record<string, string> },
      ): Promise<DockerResult> => {
        calls.push({ args });
        const cmd = subcommandOf(args);
        if (cmd === "up") {
          upCalls += 1;
          if (upCalls === 1) {
            return {
              stdout: "",
              stderr: "Error response from daemon: port is already allocated :20000",
              exitCode: 1,
            };
          }
        }
        if (cmd === "ps") {
          return {
            stdout: JSON.stringify({
              Service: "api",
              State: "running",
              Status: "Up",
              Publishers: [],
            }),
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      await runUpProgram(
        makeDeps({ workspace: ws, config: composeModeConfig(), runner }),
      );
      expect(upCalls).toBeGreaterThanOrEqual(2);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("static ports publish the exposed port as the same host port", async () => {
    const ws = await makeWorkspace();
    try {
      const { runner } = makeRunner();
      const state = await runUpProgram(
        makeDeps({
          workspace: ws,
          config: composeModeConfig({ dynamicPorts: false }),
          runner,
        }),
      );
      expect(state.portAssignments?.api?.["3000"]).toBe(3000);
      const overlayText = await Bun.file(sessionComposeOverlayPath(ws.root)).text();
      expect(overlayText).toContain("3000:3000");
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("static ports do not retry on a compose port conflict", async () => {
    const ws = await makeWorkspace();
    try {
      let upCalls = 0;
      const runner = async (
        args: string[],
        _opts?: { env?: Record<string, string> },
      ): Promise<DockerResult> => {
        const cmd = subcommandOf(args);
        if (cmd === "up") {
          upCalls += 1;
          return {
            stdout: "",
            stderr: "Error response from daemon: port is already allocated :3000",
            exitCode: 1,
          };
        }
        if (cmd === "ps") return { stdout: "", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      await expect(
        runUpProgram(
          makeDeps({
            workspace: ws,
            config: composeModeConfig({ dynamicPorts: false }),
            runner,
          }),
        ),
      ).rejects.toThrow(/static host port conflict/);
      expect(upCalls).toBe(1);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("copies clone volumes in compose mode", async () => {
    const parent = await mkdtemp(resolve(tmpdir(), "wos-compose-clone-"));
    try {
      const sourceRoot = resolve(parent, "src");
      const currentRoot = resolve(parent, "current");
      await mkdir(sourceRoot, { recursive: true });
      await mkdir(resolve(currentRoot, ".git"), { recursive: true });
      await writeFile(resolve(sourceRoot, ".env.local"), "SECRET=42\n");
      await writeFile(
        resolve(currentRoot, "docker-compose.yaml"),
        "services:\n  api: { image: nginx:alpine }\n",
      );

      const { runner } = makeRunner();
      await runUpProgram({
        worktreeRoot: currentRoot,
        config: composeModeConfig({
          cloneVolumes: [cloneVolume(".env.local")],
        }),
        source: { path: sourceRoot, bare: false, detached: false },
        projectName: "wos-compose-clone-test",
        composeRunner: runner,
        now: () => new Date("2026-05-18T12:00:00Z"),
        stdout: () => {},
      });

      expect(await pathExists(resolve(currentRoot, ".env.local"))).toBe(true);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("fails with actionable error when compose.config missing on disk", async () => {
    const ws = await makeWorkspace();
    try {
      await rm(ws.composePath, { force: true });
      const { runner } = makeRunner();
      await expect(
        runUpProgram(makeDeps({ workspace: ws, config: composeModeConfig(), runner })),
      ).rejects.toThrow(/compose\.config file not found/);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });
});
