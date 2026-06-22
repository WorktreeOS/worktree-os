import { test, expect, describe } from "bun:test";
import { createRuntimeCollector } from "@worktreeos/daemon/session-monitor-runtime";
import { DockerStateStore } from "@worktreeos/daemon/docker/docker-state-store";
import { TunnelRegistry } from "@worktreeos/runtime/tunnel-registry";
import type {
  DockerContainerInspect,
  DockerContainerListItem,
} from "@worktreeos/daemon/docker/docker-client";
import type { WosConfig } from "@worktreeos/core/config";

class FakeDockerClient {
  containers = new Map<string, DockerContainerInspect>();
  listContainers = async (): Promise<DockerContainerListItem[]> =>
    Array.from(this.containers.values()).map((c) => ({
      Id: c.Id,
      Names: [c.Name],
      Image: c.Image,
      ImageID: "",
      Labels: c.Config.Labels,
      State: c.State.Status,
      Status: c.State.Running ? "Up" : "Exited",
      Ports: [],
    }));
  inspectContainer = async (id: string): Promise<DockerContainerInspect> => {
    const c = this.containers.get(id);
    if (!c) {
      const err = new Error("not found") as Error & { status?: number };
      err.status = 404;
      throw err;
    }
    return c;
  };
  openEvents = () => ({
    abort() {},
    events: (async function* () {
      await new Promise<void>(() => {});
    })() as AsyncIterableIterator<unknown>,
  });
  streamLogs = async () => ({}) as unknown;
  startContainer = async () => undefined;
  stopContainer = async () => undefined;
  restartContainer = async () => undefined;
}

function makeContainer(opts: {
  id: string;
  session: string;
  service: string;
  running?: boolean;
}): DockerContainerInspect {
  return {
    Id: opts.id,
    Name: "/" + opts.id,
    Image: "node:22",
    State: {
      Status: opts.running === false ? "exited" : "running",
      Running: opts.running !== false,
      Paused: false,
      Restarting: false,
      OOMKilled: false,
      Dead: false,
      Pid: 1,
      ExitCode: 0,
    },
    Config: {
      Labels: {
        "dev.wos.managed": "true",
        "dev.wos.schema": "1",
        "dev.wos.home-hash": "H",
        "dev.wos.session": opts.session,
        "dev.wos.project": "proj",
        "dev.wos.mode": "generated",
        "dev.wos.service": opts.service,
      },
    },
    NetworkSettings: { Ports: {} },
  };
}

const generatedConfig = {
  cloneVolumes: [],
  hostPorts: { start: 20000, end: 29999 },
  app: { initScript: [], services: {} },
  cache: [],
} as unknown as WosConfig;

const throwingRunner = async () => {
  throw new Error("docker compose ps must not be called");
};

describe("createRuntimeCollector with Docker cache", () => {
  test("collects managed services from the cache, not docker compose ps", async () => {
    const fake = new FakeDockerClient();
    fake.containers.set(
      "c1",
      makeContainer({ id: "c1", session: "s", service: "api" }),
    );
    fake.containers.set(
      "c2",
      makeContainer({ id: "c2", session: "s", service: "db", running: false }),
    );
    const store = new DockerStateStore({
      client: fake as never,
      homeHash: "H",
      reconcileIntervalMs: 0,
    });
    await store.start();
    const collector = createRuntimeCollector({
      sessionName: "s",
      composeContext: { projectName: "proj", composeFile: "/c.yaml" },
      config: generatedConfig,
      tunnels: new TunnelRegistry(),
      dockerRunner: throwingRunner as never,
      dockerState: store,
    });
    const snapshot = await collector.collect();
    expect(snapshot.compose.map((s) => s.service)).toEqual(["api", "db"]);
    expect(
      snapshot.compose.find((s) => s.service === "db")!.state,
    ).toBe("exited");
    expect(snapshot.healthchecks).toEqual([]);
    await store.stop();
  });

  test("falls back to docker compose ps when the cache has not synced", async () => {
    const fake = new FakeDockerClient();
    // Store never started → hasSynced() is false → fall back to compose ps.
    const store = new DockerStateStore({
      client: fake as never,
      homeHash: "H",
      reconcileIntervalMs: 0,
    });
    const psCalls: string[][] = [];
    const collector = createRuntimeCollector({
      sessionName: "s",
      composeContext: { projectName: "proj", composeFile: "/c.yaml" },
      config: generatedConfig,
      tunnels: new TunnelRegistry(),
      dockerRunner: (async (args: string[]) => {
        psCalls.push(args);
        return {
          stdout: '{"Service":"api","State":"running","Publishers":[]}\n',
          stderr: "",
          exitCode: 0,
        };
      }) as never,
      dockerState: store,
    });
    const snapshot = await collector.collect();
    expect(psCalls.length).toBe(1);
    expect(snapshot.compose.map((s) => s.service)).toEqual(["api"]);
  });
});
