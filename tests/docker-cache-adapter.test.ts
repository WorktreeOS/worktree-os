import { test, expect, describe } from "bun:test";
import { DockerStateStore } from "@worktreeos/daemon/docker/docker-state-store";
import {
  listSessionServices,
  snapshotToServiceStatus,
} from "@worktreeos/daemon/docker/docker-cache-adapter";
import type { WosContainerSnapshot } from "@worktreeos/daemon/docker/docker-snapshot";
import type {
  DockerContainerInspect,
  DockerContainerListItem,
} from "@worktreeos/daemon/docker/docker-client";

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
  openEvents = (): {
    events: AsyncIterableIterator<unknown>;
    abort: () => void;
  } => {
    let aborted = false;
    return {
      abort() {
        aborted = true;
      },
      events: (async function* () {
        await new Promise<void>(() => {});
        void aborted;
      })() as AsyncIterableIterator<unknown>,
    };
  };
  streamLogs = async () => ({} as unknown);
  startContainer = async () => undefined;
  stopContainer = async () => undefined;
  restartContainer = async () => undefined;
}

function makeContainer(opts: {
  id: string;
  session: string;
  service: string;
  running?: boolean;
  homeHash?: string;
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
        "dev.wos.home-hash": opts.homeHash ?? "H",
        "dev.wos.session": opts.session,
        "dev.wos.project": "proj",
        "dev.wos.mode": "generated",
        "dev.wos.service": opts.service,
      },
    },
    NetworkSettings: { Ports: {} },
  };
}

describe("snapshotToServiceStatus", () => {
  function snapshot(
    overrides: Partial<WosContainerSnapshot> = {},
  ): WosContainerSnapshot {
    return {
      containerId: "c1",
      containerName: "c1",
      image: "node:22",
      homeHash: "H",
      sessionName: "s",
      projectName: "proj",
      serviceName: "api",
      mode: "generated",
      state: "running",
      status: "Up",
      ports: [],
      labels: {},
      ...overrides,
    };
  }

  test("forwards startedAt and restartCount", () => {
    const status = snapshotToServiceStatus(
      snapshot({ startedAt: "2026-05-29T00:00:00.000Z", restartCount: 4 }),
    );
    expect(status.startedAt).toBe("2026-05-29T00:00:00.000Z");
    expect(status.restartCount).toBe(4);
  });

  test("omits lifecycle fields for list-only snapshots", () => {
    const status = snapshotToServiceStatus(snapshot());
    expect(status.startedAt).toBeUndefined();
    expect(status.restartCount).toBeUndefined();
  });
});

describe("listSessionServices", () => {
  test("returns one entry per service for a session, sorted by name", async () => {
    const fake = new FakeDockerClient();
    fake.containers.set(
      "c1",
      makeContainer({ id: "c1", session: "s", service: "api" }),
    );
    fake.containers.set(
      "c2",
      makeContainer({ id: "c2", session: "s", service: "db" }),
    );
    fake.containers.set(
      "c3",
      makeContainer({ id: "c3", session: "other", service: "api" }),
    );
    const store = new DockerStateStore({
      client: fake as never,
      homeHash: "H",
      reconcileIntervalMs: 0,
    });
    await store.start();
    const services = listSessionServices(store, { sessionName: "s" });
    expect(services.map((s) => s.service)).toEqual(["api", "db"]);
    expect(services[0]!.state).toBe("running");
    await store.stop();
  });

  test("includes stopped services in results", async () => {
    const fake = new FakeDockerClient();
    fake.containers.set(
      "c1",
      makeContainer({ id: "c1", session: "s", service: "api", running: false }),
    );
    const store = new DockerStateStore({
      client: fake as never,
      homeHash: "H",
      reconcileIntervalMs: 0,
    });
    await store.start();
    const services = listSessionServices(store, { sessionName: "s" });
    expect(services.length).toBe(1);
    expect(services[0]!.state).toBe("exited");
    await store.stop();
  });
});
