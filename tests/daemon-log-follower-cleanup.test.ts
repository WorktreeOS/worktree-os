import { test, expect, describe } from "bun:test";
import type { FollowerStarter } from "@worktreeos/daemon/daemon-sessions";
import type { ServiceFollower } from "@worktreeos/runtime/service-logs";
import { createDaemonTestHarness } from "./helpers/daemon-test-harness.ts";
import { findLeakedComposeLogFollowers } from "./helpers/compose-process-cleanup.ts";

function fakeStarter() {
  const stopped: string[] = [];
  const starter: FollowerStarter = ({ services }) =>
    services.map((service) => {
      const follower: ServiceFollower = {
        service,
        channel: `service:${service}` as const,
        stop: () => {
          stopped.push(service);
        },
        done: Promise.resolve(),
      };
      return follower;
    });
  return { starter, stopped };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("daemon log follower cleanup", () => {
  test("stops active followers when the daemon shuts down", async () => {
    const fake = fakeStarter();
    const harness = await createDaemonTestHarness({
      resolveSession: async () => ({}) as any,
      followerStarter: fake.starter,
    });
    harness.daemon.sessions.setStreamContextResolver(async () => ({
      ctx: { projectName: "p", composeFile: "/c.yaml" },
      aggregateServices: ["api"],
    }));
    const sub = harness.daemon.sessions.subscribe("s1", () => {}, {
      channel: "service:api",
    });
    await flush();
    expect(fake.stopped).toEqual([]);
    sub.unsubscribe();
    await flush();
    await harness.stop();
    expect(findLeakedComposeLogFollowers(harness.wosHome)).toEqual([]);
  });

  test("stops followers when the last subscriber cancels", async () => {
    const fake = fakeStarter();
    const harness = await createDaemonTestHarness({
      resolveSession: async () => ({}) as any,
      followerStarter: fake.starter,
    });
    harness.daemon.sessions.setStreamContextResolver(async () => ({
      ctx: { projectName: "p", composeFile: "/c.yaml" },
      aggregateServices: ["api"],
    }));
    const sub = harness.daemon.sessions.subscribe("s1", () => {}, {
      channel: "service:api",
    });
    await flush();
    sub.unsubscribe();
    await flush();
    expect(fake.stopped).toEqual(["api"]);
    await harness.stop();
  });

  test("default harness does not use live docker followers", async () => {
    const harness = await createDaemonTestHarness({
      resolveSession: async () => ({}) as any,
    });
    harness.daemon.sessions.setStreamContextResolver(async () => ({
      ctx: { projectName: "p", composeFile: "/c.yaml" },
      aggregateServices: ["api"],
    }));
    harness.daemon.sessions.subscribe("s1", () => {}, { channel: "service:api" });
    await flush();
    expect(findLeakedComposeLogFollowers(harness.wosHome)).toEqual([]);
    await harness.stop();
  });
});
