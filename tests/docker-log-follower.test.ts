import { test, expect, describe } from "bun:test";
import { DockerStateStore } from "@worktreeos/daemon/docker/docker-state-store";
import { createDockerLogFollowerStarter } from "@worktreeos/daemon/docker/docker-log-follower";
import type { DockerContainerInspect } from "@worktreeos/daemon/docker/docker-client";

/** A fake log stream that yields the given chunks then completes. */
function fakeLogStream(chunks: string[]) {
  let aborted = false;
  return {
    abort() {
      aborted = true;
    },
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) {
        if (aborted) return;
        yield c;
      }
    },
  };
}

class FakeDockerClient {
  streamLogsCalls: Array<{ id: string; follow?: boolean; tail?: number }> = [];
  logChunks: string[] = [];
  containers = new Map<string, DockerContainerInspect>();
  listContainers = async () =>
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
  inspectContainer = async (id: string) => {
    const c = this.containers.get(id);
    if (!c) {
      const err = new Error("nf") as Error & { status?: number };
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
  streamLogs = async (
    id: string,
    opts: { follow?: boolean; tail?: number },
  ) => {
    this.streamLogsCalls.push({ id, ...opts });
    return fakeLogStream(this.logChunks) as never;
  };
  startContainer = async () => undefined;
  stopContainer = async () => undefined;
  restartContainer = async () => undefined;
}

function makeContainer(): DockerContainerInspect {
  return {
    Id: "c1",
    Name: "/proj-api",
    Image: "node:22",
    State: {
      Status: "running",
      Running: true,
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
        "dev.wos.session": "s",
        "dev.wos.project": "proj",
        "dev.wos.mode": "generated",
        "dev.wos.service": "api",
      },
    },
    NetworkSettings: { Ports: {} },
  };
}

async function makeStore(fake: FakeDockerClient): Promise<DockerStateStore> {
  const store = new DockerStateStore({
    client: fake as never,
    homeHash: "H",
    reconcileIntervalMs: 0,
  });
  await store.start();
  return store;
}

describe("createDockerLogFollowerStarter", () => {
  test("streams logs from the resolved container and delivers chunks to the sink", async () => {
    const fake = new FakeDockerClient();
    fake.containers.set("c1", makeContainer());
    fake.logChunks = ["line-1\n", "line-2\n"];
    const store = await makeStore(fake);
    const starter = createDockerLogFollowerStarter({
      client: fake as never,
      store,
      tail: 50,
    });
    const received: Array<{ service: string; stream: string; chunk: string }> = [];
    const followers = starter({
      ctx: { projectName: "proj", composeFile: "/c.yaml" },
      services: ["api"],
      sessionName: "s",
      sink: (service, stream, chunk) => received.push({ service, stream, chunk }),
    });
    expect(followers.map((f) => f.service)).toEqual(["api"]);
    await Promise.all(followers.map((f) => f.done));
    expect(fake.streamLogsCalls).toEqual([
      { id: "c1", follow: true, tail: 50 },
    ]);
    expect(received).toEqual([
      { service: "api", stream: "stdout", chunk: "line-1\n" },
      { service: "api", stream: "stdout", chunk: "line-2\n" },
    ]);
    await store.stop();
  });

  test("starts no follower when the service has no current container in cache", async () => {
    const fake = new FakeDockerClient();
    const store = await makeStore(fake);
    const starter = createDockerLogFollowerStarter({
      client: fake as never,
      store,
    });
    const followers = starter({
      ctx: { projectName: "proj", composeFile: "/c.yaml" },
      services: ["api"],
      sessionName: "s",
      sink: () => {},
    });
    expect(followers).toEqual([]);
    expect(fake.streamLogsCalls).toEqual([]);
    await store.stop();
  });

  test("returns no followers without a session name", async () => {
    const fake = new FakeDockerClient();
    fake.containers.set("c1", makeContainer());
    const store = await makeStore(fake);
    const starter = createDockerLogFollowerStarter({
      client: fake as never,
      store,
    });
    const followers = starter({
      ctx: { projectName: "proj", composeFile: "/c.yaml" },
      services: ["api"],
      sink: () => {},
    });
    expect(followers).toEqual([]);
    await store.stop();
  });
});
