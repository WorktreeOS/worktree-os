import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { startDaemon, type DaemonHandle } from "@worktreeos/daemon/daemon-server";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
  withDaemonDefaults,
} from "./helpers/daemon-test-harness.ts";
import type { SessionContext } from "@worktreeos/core/session-context";
import { createUiApi } from "../apps/web/src/lib/ui-api";
import type { UnifiedEventEnvelope } from "../apps/web/src/lib/unified-events";

function fakeContext(): SessionContext {
  return {
    worktreeRoot: "/fake",
    source: { path: "/fake", bare: false, detached: false },
    config: {
      cloneVolumes: [],
      hostPorts: { start: 20000, end: 29999 },
      app: { image: null, initScript: [], services: {} },
      deps: {},
      cache: [],
    } as any,
    projectName: "p",
    sessionName: "fake-session",
    sessionRoot: "/tmp/fake-session",
    state: null,
  };
}

let tmpHome: string;
let daemon: DaemonHandle | null = null;

beforeEach(async () => {
  tmpHome = await createDaemonTestHome("wos-web-uni-");
  daemon = null;
});

afterEach(async () => {
  await teardownDaemonTestHome(tmpHome, daemon);
  daemon = null;
});

async function startWithHome() {
  return startDaemon(
    withDaemonDefaults(tmpHome, {
      resolveSession: async () => fakeContext(),
      web: { host: "127.0.0.1", port: 0, assetRoot: undefined },
    }),
  );
}

async function collect(
  iter: AsyncGenerator<UnifiedEventEnvelope, void, void>,
  count: number,
  timeoutMs = 2000,
): Promise<UnifiedEventEnvelope[]> {
  const out: UnifiedEventEnvelope[] = [];
  const start = Date.now();
  for await (const env of iter) {
    out.push(env);
    if (out.length >= count) break;
    if (Date.now() - start > timeoutMs) break;
  }
  return out;
}

describe("web unified events client", () => {
  test("receives published envelopes through SSE", async () => {
    daemon = await startWithHome();
    const api = createUiApi(daemon.webUrl!);
    daemon.events.publish({ type: "project.removed", projectId: "p1" });
    daemon.events.publish({ type: "project.removed", projectId: "p2" });
    const abort = new AbortController();
    const events = await collect(
      api.streamUnifiedEvents({ signal: abort.signal }),
      2,
    );
    abort.abort();
    expect(events.length).toBe(2);
    expect(events.map((e) => (e.event as { projectId: string }).projectId)).toEqual([
      "p1",
      "p2",
    ]);
  });

  test("filters by session and replays from lastEventId", async () => {
    daemon = await startWithHome();
    const api = createUiApi(daemon.webUrl!);
    daemon.events.publish(
      {
        type: "log.appended",
        sessionName: "s1",
        channel: "deployment",
        stream: "stdout",
        chunk: "a",
      },
      { sessionName: "s1" },
    );
    daemon.events.publish(
      {
        type: "log.appended",
        sessionName: "s2",
        channel: "deployment",
        stream: "stdout",
        chunk: "b",
      },
      { sessionName: "s2" },
    );
    daemon.events.publish(
      {
        type: "log.appended",
        sessionName: "s1",
        channel: "deployment",
        stream: "stdout",
        chunk: "c",
      },
      { sessionName: "s1" },
    );
    const abort1 = new AbortController();
    const filtered = await collect(
      api.streamUnifiedEvents({ signal: abort1.signal, session: "s1" }),
      2,
    );
    abort1.abort();
    expect(filtered.length).toBe(2);
    expect(filtered.every((e) => e.sessionName === "s1")).toBe(true);

    // Now resume from the second event id.
    const abort2 = new AbortController();
    const replay = await collect(
      api.streamUnifiedEvents({ signal: abort2.signal, lastEventId: 2 }),
      1,
    );
    abort2.abort();
    expect(replay[0]!.id).toBe(3);
  });
});
