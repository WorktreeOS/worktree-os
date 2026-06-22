import { test, expect, describe } from "bun:test";
import { DockerStateStore } from "@worktreeos/daemon/docker/docker-state-store";
import type {
  DockerContainerInspect,
  DockerContainerListItem,
  DockerContainerStats,
  DockerEvent,
} from "@worktreeos/daemon/docker/docker-client";

/**
 * Minimal stub of DockerClient. Returns deterministic responses so the state
 * store logic can be exercised without touching the Docker socket.
 */
class FakeDockerClient {
  containers = new Map<string, DockerContainerInspect>();
  inspectErrors = new Map<string, number>();
  pendingEvents: DockerEvent[] = [];
  listCalls = 0;

  listContainers = async (
    _filter?: unknown,
    _opts?: unknown,
  ): Promise<DockerContainerListItem[]> => {
    this.listCalls += 1;
    const out: DockerContainerListItem[] = [];
    for (const c of this.containers.values()) {
      out.push(toListItem(c));
    }
    return out;
  };

  inspectContainer = async (id: string): Promise<DockerContainerInspect> => {
    const status = this.inspectErrors.get(id);
    if (status !== undefined) {
      const err = new Error("inspect failed") as Error & { status?: number };
      err.status = status;
      throw err;
    }
    const c = this.containers.get(id);
    if (!c) {
      const err = new Error("not found") as Error & { status?: number };
      err.status = 404;
      throw err;
    }
    return c;
  };

  openEvents = (): {
    events: AsyncIterableIterator<DockerEvent>;
    abort: () => void;
  } => {
    const pending = this.pendingEvents.slice();
    this.pendingEvents = [];
    let i = 0;
    let resolved = false;
    return {
      abort() {
        resolved = true;
      },
      events: (async function* () {
        for (const ev of pending) {
          if (resolved) return;
          yield ev;
        }
        // Pause indefinitely until aborted (avoids "done" before tests poke).
        await new Promise<void>(() => {});
      })() as AsyncIterableIterator<DockerEvent>,
    };
  };

  stats = new Map<string, DockerContainerStats>();
  statsErrors = new Set<string>();
  statsCalls: string[] = [];
  statsContainer = async (id: string): Promise<DockerContainerStats> => {
    this.statsCalls.push(id);
    if (this.statsErrors.has(id)) throw new Error("stats failed");
    const s = this.stats.get(id);
    if (!s) throw new Error("no stats");
    return s;
  };

  // unused but matches DockerClient shape
  streamLogs = async () => ({} as unknown);
  startContainer = async () => undefined;
  stopContainer = async () => undefined;
  restartContainer = async () => undefined;
}

function makeContainer(opts: {
  id: string;
  name: string;
  session: string;
  service: string;
  homeHash: string;
  running?: boolean;
  mode?: "generated" | "compose";
  deploymentId?: string;
}): DockerContainerInspect {
  return {
    Id: opts.id,
    Name: "/" + opts.name,
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
        "dev.wos.home-hash": opts.homeHash,
        "dev.wos.session": opts.session,
        "dev.wos.project": "proj",
        "dev.wos.mode": opts.mode ?? "generated",
        "dev.wos.service": opts.service,
        ...(opts.deploymentId ? { "dev.wos.deployment-id": opts.deploymentId } : {}),
      },
    },
    NetworkSettings: { Ports: {} },
  };
}

function toListItem(c: DockerContainerInspect): DockerContainerListItem {
  return {
    Id: c.Id,
    Names: [c.Name],
    Image: c.Image,
    ImageID: "",
    Labels: c.Config.Labels,
    State: c.State.Status,
    Status: c.State.Running ? "Up" : "Exited",
    Ports: [],
  };
}

describe("DockerStateStore", () => {
  test("initial full sync populates cache and excludes other home-hashes", async () => {
    const fake = new FakeDockerClient();
    fake.containers.set(
      "c1",
      makeContainer({ id: "c1", name: "proj-api", session: "s", service: "api", homeHash: "MINE" }),
    );
    fake.containers.set(
      "c2",
      makeContainer({ id: "c2", name: "proj-db", session: "s", service: "db", homeHash: "OTHER" }),
    );
    const store = new DockerStateStore({
      client: fake as never,
      homeHash: "MINE",
      reconcileIntervalMs: 0,
    });
    await store.start();
    const list = store.list();
    expect(list.length).toBe(1);
    expect(list[0]!.serviceName).toBe("api");
    await store.stop();
  });

  test("includes stopped containers and filters by session", async () => {
    const fake = new FakeDockerClient();
    fake.containers.set(
      "c1",
      makeContainer({ id: "c1", name: "p-api", session: "sA", service: "api", homeHash: "H" }),
    );
    fake.containers.set(
      "c2",
      makeContainer({
        id: "c2",
        name: "p-db",
        session: "sA",
        service: "db",
        homeHash: "H",
        running: false,
      }),
    );
    fake.containers.set(
      "c3",
      makeContainer({ id: "c3", name: "p-api", session: "sB", service: "api", homeHash: "H" }),
    );
    const store = new DockerStateStore({
      client: fake as never,
      homeHash: "H",
      reconcileIntervalMs: 0,
    });
    await store.start();
    const sA = store.list({ sessionName: "sA" });
    expect(new Set(sA.map((s) => s.serviceName))).toEqual(new Set(["api", "db"]));
    // Stopped containers still appear.
    const db = sA.find((s) => s.serviceName === "db")!;
    expect(db.state).toBe("exited");
    await store.stop();
  });

  test("findCurrent prefers running container", async () => {
    const fake = new FakeDockerClient();
    fake.containers.set(
      "c1",
      makeContainer({
        id: "c1",
        name: "old",
        session: "s",
        service: "api",
        homeHash: "H",
        running: false,
      }),
    );
    fake.containers.set(
      "c2",
      makeContainer({ id: "c2", name: "new", session: "s", service: "api", homeHash: "H" }),
    );
    const store = new DockerStateStore({
      client: fake as never,
      homeHash: "H",
      reconcileIntervalMs: 0,
    });
    await store.start();
    const found = store.findCurrent("s", "api");
    expect(found?.containerId).toBe("c2");
    await store.stop();
  });

  test("destroy event removes container", async () => {
    const fake = new FakeDockerClient();
    fake.containers.set(
      "c1",
      makeContainer({ id: "c1", name: "p-api", session: "s", service: "api", homeHash: "H" }),
    );
    fake.pendingEvents.push({
      Type: "container",
      Action: "destroy",
      Actor: { ID: "c1", Attributes: {} },
      time: 0,
      timeNano: 0,
    });
    const store = new DockerStateStore({
      client: fake as never,
      homeHash: "H",
      reconcileIntervalMs: 0,
    });
    await store.start();
    // Allow async event consumer to process.
    await new Promise((r) => setTimeout(r, 20));
    expect(store.list().length).toBe(0);
    await store.stop();
  });

  test("syncNow refreshes cache after external changes", async () => {
    const fake = new FakeDockerClient();
    fake.containers.set(
      "c1",
      makeContainer({ id: "c1", name: "p-api", session: "s", service: "api", homeHash: "H" }),
    );
    const store = new DockerStateStore({
      client: fake as never,
      homeHash: "H",
      reconcileIntervalMs: 0,
    });
    await store.start();
    expect(store.list().length).toBe(1);
    fake.containers.delete("c1");
    fake.containers.set(
      "c2",
      makeContainer({ id: "c2", name: "p-db", session: "s", service: "db", homeHash: "H" }),
    );
    await store.syncNow();
    const list = store.list();
    expect(list.length).toBe(1);
    expect(list[0]!.serviceName).toBe("db");
    await store.stop();
  });

  test("sampleStats attaches usage to running containers only", async () => {
    const fake = new FakeDockerClient();
    fake.containers.set(
      "c1",
      makeContainer({ id: "c1", name: "p-api", session: "s", service: "api", homeHash: "H" }),
    );
    fake.containers.set(
      "c2",
      makeContainer({
        id: "c2",
        name: "p-db",
        session: "s",
        service: "db",
        homeHash: "H",
        running: false,
      }),
    );
    fake.stats.set("c1", {
      cpu_stats: {
        cpu_usage: { total_usage: 200 },
        system_cpu_usage: 2000,
        online_cpus: 2,
      },
      precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
      memory_stats: { usage: 64 * 1024 * 1024, limit: 256 * 1024 * 1024 },
    });
    const store = new DockerStateStore({
      client: fake as never,
      homeHash: "H",
      reconcileIntervalMs: 0,
      statsIntervalMs: 0,
    });
    await store.start();
    await store.sampleStats();
    const api = store.findCurrent("s", "api");
    expect(api?.resourceUsage?.cpuPercent).toBeCloseTo(20, 5); // 0.1 * 2 * 100
    expect(api?.resourceUsage?.memUsedBytes).toBe(64 * 1024 * 1024);
    // Stopped container is never sampled.
    expect(fake.statsCalls).toEqual(["c1"]);
    const db = store.list({ sessionName: "s" }).find((s) => s.serviceName === "db");
    expect(db?.resourceUsage).toBeUndefined();
    await store.stop();
  });

  test("sampleStats survives per-container stats failures", async () => {
    const fake = new FakeDockerClient();
    fake.containers.set(
      "c1",
      makeContainer({ id: "c1", name: "p-api", session: "s", service: "api", homeHash: "H" }),
    );
    fake.statsErrors.add("c1");
    const store = new DockerStateStore({
      client: fake as never,
      homeHash: "H",
      reconcileIntervalMs: 0,
      statsIntervalMs: 0,
    });
    await store.start();
    await store.sampleStats();
    const api = store.findCurrent("s", "api");
    expect(api?.state).toBe("running");
    expect(api?.resourceUsage).toBeUndefined();
    await store.stop();
  });

  test("excludes internal init service from user-facing list by default", async () => {
    const fake = new FakeDockerClient();
    fake.containers.set(
      "c1",
      makeContainer({ id: "c1", name: "p-api", session: "s", service: "api", homeHash: "H" }),
    );
    fake.containers.set(
      "ci",
      makeContainer({
        id: "ci",
        name: "p-init",
        session: "s",
        service: "wos-init",
        homeHash: "H",
        running: false,
      }),
    );
    const store = new DockerStateStore({
      client: fake as never,
      homeHash: "H",
      reconcileIntervalMs: 0,
    });
    await store.start();
    expect(store.list().map((s) => s.serviceName)).toEqual(["api"]);
    const all = store.list({ includeInternal: true }).map((s) => s.serviceName).sort();
    expect(all).toEqual(["api", "wos-init"]);
    await store.stop();
  });
});
