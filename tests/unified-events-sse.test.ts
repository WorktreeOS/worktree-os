import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { startDaemon, type DaemonHandle } from "@worktreeos/daemon/daemon-server";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
  withDaemonDefaults,
} from "./helpers/daemon-test-harness.ts";
import type { SessionContext } from "@worktreeos/core/session-context";
import { splitSseStream, decodeSseFrame } from "@worktreeos/daemon/unified-event-sse";
import type { UnifiedEventEnvelope } from "@worktreeos/core/unified-events";

function fakeContext(): SessionContext {
  return {
    worktreeRoot: "/fake/worktree",
    source: { path: "/fake/source", bare: false, detached: false },
    config: {
      cloneVolumes: [],
      hostPorts: { start: 20000, end: 29999 },
      app: { image: null, initScript: [], services: {} },
      deps: {},
      cache: [],
    } as any,
    projectName: "proj",
    sessionName: "fake-session",
    sessionRoot: "/tmp/fake-session",
    state: null,
  };
}

let tmpHome: string;
let daemon: DaemonHandle;

beforeEach(async () => {
  tmpHome = await createDaemonTestHome("wos-events-");
});

afterEach(async () => {
  await teardownDaemonTestHome(tmpHome, daemon);
  daemon = undefined as unknown as DaemonHandle;
});

function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${daemon.webUrl}${path}`, init);
}

function openSse(
  path: string,
  init?: RequestInit,
): { promise: Promise<Response>; abort: () => void } {
  const ctrl = new AbortController();
  const promise = fetchUi(path, { ...init, signal: ctrl.signal });
  return { promise, abort: () => ctrl.abort() };
}

async function readSomeFrames(
  res: Response,
  count: number,
  timeoutMs = 1000,
): Promise<{ envelopes: UnifiedEventEnvelope[]; raw: string }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const envelopes: UnifiedEventEnvelope[] = [];
  const start = Date.now();
  while (envelopes.length < count) {
    if (Date.now() - start > timeoutMs) break;
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const { frames, rest } = splitSseStream(buf);
    buf = rest;
    for (const frame of frames) {
      const decoded = decodeSseFrame(frame);
      if (!decoded) continue;
      try {
        envelopes.push(JSON.parse(decoded.data));
      } catch {
        /* ignore non-JSON frames */
      }
      if (envelopes.length >= count) break;
    }
  }
  try {
    await reader.cancel();
  } catch {
    /* ignore */
  }
  return { envelopes, raw: buf };
}

describe("/ui/v1/events SSE", () => {
  test("returns text/event-stream and replays history", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => fakeContext(),
      }),
    );
    daemon.events.publish({ type: "project.removed", projectId: "p1" });
    daemon.events.publish({ type: "project.removed", projectId: "p2" });

    const res = await fetchUi("/ui/v1/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-cache");

    const { envelopes } = await readSomeFrames(res, 2);
    expect(envelopes.length).toBe(2);
    expect(envelopes[0]!.event).toEqual({
      type: "project.removed",
      projectId: "p1",
    });
    expect(envelopes[1]!.event).toEqual({
      type: "project.removed",
      projectId: "p2",
    });
  });

  test("filters by session query param", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => fakeContext(),
      }),
    );
    daemon.events.publish(
      { type: "log.appended", sessionName: "s1", channel: "deployment", stream: "stdout", chunk: "a" },
      { sessionName: "s1" },
    );
    daemon.events.publish(
      { type: "log.appended", sessionName: "s2", channel: "deployment", stream: "stdout", chunk: "b" },
      { sessionName: "s2" },
    );
    daemon.events.publish(
      { type: "log.appended", sessionName: "s1", channel: "deployment", stream: "stdout", chunk: "c" },
      { sessionName: "s1" },
    );
    const res = await fetchUi("/ui/v1/events?session=s1");
    const { envelopes } = await readSomeFrames(res, 2);
    expect(envelopes.length).toBe(2);
    expect(envelopes.every((e) => e.sessionName === "s1")).toBe(true);
  });

  test("replays from Last-Event-ID header", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => fakeContext(),
      }),
    );
    daemon.events.publish({ type: "project.removed", projectId: "a" });
    daemon.events.publish({ type: "project.removed", projectId: "b" });
    daemon.events.publish({ type: "project.removed", projectId: "c" });
    const res = await fetchUi("/ui/v1/events", {
      headers: { "Last-Event-ID": "2" },
    });
    const { envelopes } = await readSomeFrames(res, 1);
    expect(envelopes.length).toBe(1);
    expect(envelopes[0]!.id).toBe(3);
  });

  test("disconnect releases the subscription", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => fakeContext(),
      }),
    );
    daemon.events.publish({ type: "project.removed", projectId: "p" });
    // Baseline excludes persistent daemon subscribers (e.g. the notification
    // engine); the SSE stream adds exactly one and must release it on disconnect.
    const baseline = daemon.events.subscriberCount;
    const { promise, abort } = openSse("/ui/v1/events");
    const res = await promise;
    await readSomeFrames(res, 1);
    expect(daemon.events.subscriberCount).toBe(baseline + 1);
    abort();
    // Wait for the abort propagation through Bun's request signal.
    for (let i = 0; i < 20; i += 1) {
      if (daemon.events.subscriberCount === baseline) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(daemon.events.subscriberCount).toBe(baseline);
  });
});

describe("legacy /v1/events", () => {
  test("removed socket-era endpoint returns a structured 404", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => fakeContext(),
      }),
    );
    const res = await fetchUi("/v1/events");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("not-found");
    expect(body.message).toContain("/ui/v1");
  });
});

