import { test, expect, describe } from "bun:test";
import { DockerStateStore } from "@worktreeos/daemon/docker/docker-state-store";
import {
  runServiceAction,
  ServiceActionTargetMissing,
} from "@worktreeos/daemon/docker/docker-service-actions";
import type { DockerContainerInspect } from "@worktreeos/daemon/docker/docker-client";

class FakeDockerClient {
  containers = new Map<string, DockerContainerInspect>();
  startCalls: string[] = [];
  stopCalls: string[] = [];
  restartCalls: string[] = [];
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
  streamLogs = async () => ({} as unknown);
  startContainer = async (id: string) => {
    this.startCalls.push(id);
  };
  stopContainer = async (id: string) => {
    this.stopCalls.push(id);
  };
  restartContainer = async (id: string) => {
    this.restartCalls.push(id);
  };
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

describe("runServiceAction", () => {
  test("invokes the right Docker API method for the resolved container", async () => {
    const fake = new FakeDockerClient();
    fake.containers.set("c1", makeContainer());
    const store = new DockerStateStore({
      client: fake as never,
      homeHash: "H",
      reconcileIntervalMs: 0,
    });
    await store.start();
    await runServiceAction(fake as never, store, {
      action: "restart",
      sessionName: "s",
      serviceName: "api",
    });
    expect(fake.restartCalls).toEqual(["c1"]);
    await store.stop();
  });

  test("throws ServiceActionTargetMissing when cache has no match", async () => {
    const fake = new FakeDockerClient();
    const store = new DockerStateStore({
      client: fake as never,
      homeHash: "H",
      reconcileIntervalMs: 0,
    });
    await store.start();
    await expect(
      runServiceAction(fake as never, store, {
        action: "stop",
        sessionName: "s",
        serviceName: "missing",
      }),
    ).rejects.toBeInstanceOf(ServiceActionTargetMissing);
    await store.stop();
  });
});
