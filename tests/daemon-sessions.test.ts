import { test, expect, describe } from "bun:test";
import {
  DaemonSessionRegistry,
  type FollowerStarter,
  type ServiceStreamContext,
} from "@worktreeos/daemon/daemon-sessions";
import type { ServiceFollower } from "@worktreeos/runtime/service-logs";

interface FakeStarterHandle {
  service: string;
  sink: (service: string, stream: any, chunk: string) => void;
  stopped: boolean;
}

function fakeStarter() {
  const handles: FakeStarterHandle[] = [];
  const starter: FollowerStarter = ({ services, sink }) =>
    services.map((s) => {
      const h: FakeStarterHandle = {
        service: s,
        sink,
        stopped: false,
      };
      handles.push(h);
      const follower: ServiceFollower = {
        service: s,
        channel: `service:${s}` as const,
        stop: () => {
          h.stopped = true;
        },
        done: Promise.resolve(),
      };
      return follower;
    });
  return { starter, handles };
}

function fakeResolver(
  services: string[],
  allowed?: string[],
): { resolver: (n: string) => Promise<ServiceStreamContext | null>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolver: async (sessionName) => {
      calls.push(sessionName);
      return {
        ctx: { projectName: "p", composeFile: "/c.yaml" },
        aggregateServices: services,
        ...(allowed ? { allowedServices: allowed } : {}),
      };
    },
  };
}

async function flush(): Promise<void> {
  // Yield twice so the resolver promise + follower start microtasks complete.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("DaemonSessionRegistry on-demand service log streams", () => {
  test("does not spawn followers without an active subscriber", async () => {
    const f = fakeStarter();
    const r = fakeResolver(["api"]);
    const reg = new DaemonSessionRegistry({
      starter: f.starter,
      streamContextResolver: r.resolver,
    });
    await flush();
    expect(f.handles.length).toBe(0);
  });

  test("starts a follower when a subscriber opens a service channel", async () => {
    const f = fakeStarter();
    const r = fakeResolver(["api", "db"]);
    const reg = new DaemonSessionRegistry({
      starter: f.starter,
      streamContextResolver: r.resolver,
    });
    const received: string[] = [];
    const sub = reg.subscribe("s", (c) => received.push(c.chunk), {
      channel: "service:api",
    });
    await flush();
    expect(f.handles.length).toBe(1);
    expect(f.handles[0]!.service).toBe("api");
    f.handles[0]!.sink("api", "stdout", "live\n");
    expect(received).toEqual(["live\n"]);
    sub.unsubscribe();
    await flush();
    expect(f.handles[0]!.stopped).toBe(true);
  });

  test("shares a single follower across concurrent subscribers", async () => {
    const f = fakeStarter();
    const r = fakeResolver(["api"]);
    const reg = new DaemonSessionRegistry({
      starter: f.starter,
      streamContextResolver: r.resolver,
    });
    const a: string[] = [];
    const subA = reg.subscribe("s", (c) => a.push(c.chunk), {
      channel: "service:api",
    });
    await flush();
    f.handles[0]!.sink("api", "stdout", "first\n");
    expect(a).toEqual(["first\n"]);

    const b: string[] = [];
    const subB = reg.subscribe("s", (c) => b.push(c.chunk), {
      channel: "service:api",
    });
    expect(f.handles.length).toBe(1); // shared follower, not duplicated
    expect(b.length).toBe(0);
    // Second subscriber receives the active stream's bounded tail as history.
    expect(subB.history.map((c) => c.chunk)).toEqual(["first\n"]);

    f.handles[0]!.sink("api", "stdout", "second\n");
    expect(a).toEqual(["first\n", "second\n"]);
    expect(b).toEqual(["second\n"]);

    subA.unsubscribe();
    expect(f.handles[0]!.stopped).toBe(false); // B still subscribed
    subB.unsubscribe();
    await flush();
    expect(f.handles[0]!.stopped).toBe(true);
  });

  test("stops follower and discards buffer when last subscriber leaves", async () => {
    const f = fakeStarter();
    const r = fakeResolver(["api"]);
    const reg = new DaemonSessionRegistry({
      starter: f.starter,
      streamContextResolver: r.resolver,
    });
    const sub = reg.subscribe("s", () => {}, { channel: "service:api" });
    await flush();
    f.handles[0]!.sink("api", "stdout", "x\n");
    expect(reg.get("s")?.serviceStreams.has("api")).toBe(true);
    sub.unsubscribe();
    await flush();
    expect(reg.get("s")?.serviceStreams.has("api")).toBe(false);
  });

  test("filters subscriptions strictly by channel", async () => {
    const f = fakeStarter();
    const r = fakeResolver(["api", "db"]);
    const reg = new DaemonSessionRegistry({
      starter: f.starter,
      streamContextResolver: r.resolver,
    });
    const subApi = reg.subscribe("s", () => {}, { channel: "service:api" });
    const subDb = reg.subscribe("s", () => {}, { channel: "service:db" });
    await flush();
    const apiHandle = f.handles.find((h) => h.service === "api")!;
    const dbHandle = f.handles.find((h) => h.service === "db")!;
    const apiReceived: string[] = [];
    const sub = reg.subscribe(
      "s",
      (c) => apiReceived.push(`${c.channel}|${c.chunk}`),
      { channel: "service:api" },
    );
    apiHandle.sink("api", "stdout", "api-live\n");
    dbHandle.sink("db", "stdout", "db-live\n");
    expect(apiReceived).toEqual(["service:api|api-live\n"]);
    sub.unsubscribe();
    subApi.unsubscribe();
    subDb.unsubscribe();
  });

  test("quiet channel without resolved context stays open without leaking", async () => {
    const f = fakeStarter();
    const reg = new DaemonSessionRegistry({
      starter: f.starter,
      // No resolver → quiet channel never spawns a follower.
    });
    const received: string[] = [];
    const sub = reg.subscribe("s", (c) => received.push(c.chunk), {
      channel: "service:quiet",
    });
    expect(sub.history).toEqual([]);
    await flush();
    expect(f.handles.length).toBe(0);
    expect(received).toEqual([]);
    sub.unsubscribe();
  });

  test("subscriber for disallowed service in compose mode stays quiet", async () => {
    const f = fakeStarter();
    const r = fakeResolver(["api"], ["api"]);
    const reg = new DaemonSessionRegistry({
      starter: f.starter,
      streamContextResolver: r.resolver,
    });
    const received: string[] = [];
    const sub = reg.subscribe("s", (c) => received.push(c.chunk), {
      channel: "service:internal",
    });
    expect(sub.history).toEqual([]);
    await flush();
    expect(f.handles.length).toBe(0);
    expect(received).toEqual([]);
    sub.unsubscribe();
  });

  test("respects allowedServices filter (compose mode)", async () => {
    const f = fakeStarter();
    const r = fakeResolver(["api", "db"], ["api"]);
    const reg = new DaemonSessionRegistry({
      starter: f.starter,
      streamContextResolver: r.resolver,
    });
    const sub = reg.subscribe("s", () => {}, { channel: "service:db" });
    await flush();
    expect(f.handles.length).toBe(0); // db is not in allowedServices
    sub.unsubscribe();

    const sub2 = reg.subscribe("s", () => {}, { channel: "service:api" });
    await flush();
    expect(f.handles.length).toBe(1);
    sub2.unsubscribe();
  });

  test("aggregate (no-channel) subscription spawns followers for all services", async () => {
    const f = fakeStarter();
    const r = fakeResolver(["api", "db"]);
    const reg = new DaemonSessionRegistry({
      starter: f.starter,
      streamContextResolver: r.resolver,
    });
    const received: string[] = [];
    const sub = reg.subscribe("s", (c) => received.push(`${c.service}:${c.chunk}`));
    await flush();
    expect(f.handles.length).toBe(2);
    const apiHandle = f.handles.find((h) => h.service === "api")!;
    const dbHandle = f.handles.find((h) => h.service === "db")!;
    apiHandle.sink("api", "stdout", "x\n");
    dbHandle.sink("db", "stdout", "y\n");
    expect(received.sort()).toEqual(["api:x\n", "db:y\n"]);
    sub.unsubscribe();
    await flush();
    expect(apiHandle.stopped).toBe(true);
    expect(dbHandle.stopped).toBe(true);
  });

  test("aggregate subscription excludes init chunks", async () => {
    const f = fakeStarter();
    const r = fakeResolver(["api"]);
    const reg = new DaemonSessionRegistry({
      starter: f.starter,
      streamContextResolver: r.resolver,
    });
    reg.appendInit("s", "stdout", "init-line\n");
    const received: string[] = [];
    const sub = reg.subscribe("s", (c) => received.push(`${c.channel}|${c.chunk}`));
    await flush();
    expect(sub.history.map((c) => c.channel)).not.toContain("init");
    reg.appendInit("s", "stdout", "init-live\n");
    expect(received.every((r) => !r.startsWith("init|"))).toBe(true);
    sub.unsubscribe();
  });

  test("appendInit buffers init chunks and delivers to init subscribers", () => {
    const reg = new DaemonSessionRegistry();
    reg.appendInit("s", "stdout", "init-1\n");
    reg.appendInit("s", "stderr", "init-2\n");
    const sub = reg.subscribe("s", () => {}, { channel: "init" });
    expect(sub.history.map((c) => c.chunk)).toEqual(["init-1\n", "init-2\n"]);
    sub.unsubscribe();
  });

  test("subscribe with channel=init delivers init history and live chunks", () => {
    const reg = new DaemonSessionRegistry();
    reg.appendInit("s", "stdout", "init-history\n");
    const received: string[] = [];
    const sub = reg.subscribe("s", (c) => received.push(c.chunk), {
      channel: "init",
    });
    expect(sub.history.map((c) => c.chunk)).toEqual(["init-history\n"]);
    reg.appendInit("s", "stdout", "init-live\n");
    expect(received).toEqual(["init-live\n"]);
    sub.unsubscribe();
  });

  test("active tail buffer respects capacity", async () => {
    const f = fakeStarter();
    const r = fakeResolver(["api"]);
    const reg = new DaemonSessionRegistry({
      starter: f.starter,
      streamContextResolver: r.resolver,
      activeCapacity: 3,
    });
    const sub = reg.subscribe("s", () => {}, { channel: "service:api" });
    await flush();
    const handle = f.handles[0]!;
    for (let i = 0; i < 10; i += 1) handle.sink("api", "stdout", `line-${i}\n`);
    const stream = reg.get("s")!.serviceStreams.get("api")!;
    expect(stream.buffer.size()).toBeLessThanOrEqual(3);
    sub.unsubscribe();
  });

  test("resetSession stops streams and clears init buffer", async () => {
    const f = fakeStarter();
    const r = fakeResolver(["api"]);
    const reg = new DaemonSessionRegistry({
      starter: f.starter,
      streamContextResolver: r.resolver,
    });
    reg.appendInit("s", "stdout", "init\n");
    const sub = reg.subscribe("s", () => {}, { channel: "service:api" });
    await flush();
    expect(f.handles.length).toBe(1);

    await reg.resetSession("s");
    expect(f.handles[0]!.stopped).toBe(true);
    const session = reg.get("s")!;
    expect(session.serviceStreams.size).toBe(0);
    expect(session.initBuffer).toBeNull();
    sub.unsubscribe();
  });

  test("drop removes session entirely", async () => {
    const f = fakeStarter();
    const r = fakeResolver(["api"]);
    const reg = new DaemonSessionRegistry({
      starter: f.starter,
      streamContextResolver: r.resolver,
    });
    const sub = reg.subscribe("s", () => {}, { channel: "service:api" });
    await flush();
    await reg.drop("s");
    expect(reg.has("s")).toBe(false);
    expect(f.handles[0]!.stopped).toBe(true);
    sub.unsubscribe();
  });

  test("shutdown stops all followers across sessions", async () => {
    const f = fakeStarter();
    const r = fakeResolver(["api"]);
    const reg = new DaemonSessionRegistry({
      starter: f.starter,
      streamContextResolver: r.resolver,
    });
    const subA = reg.subscribe("a", () => {}, { channel: "service:api" });
    const subB = reg.subscribe("b", () => {}, { channel: "service:api" });
    await flush();
    expect(f.handles.length).toBe(2);
    await reg.shutdown();
    expect(f.handles.every((h) => h.stopped)).toBe(true);
    expect(reg.has("a")).toBe(false);
    expect(reg.has("b")).toBe(false);
    subA.unsubscribe();
    subB.unsubscribe();
  });
});
