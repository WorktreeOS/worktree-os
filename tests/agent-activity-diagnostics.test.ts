import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentActivityEvent,
  STALE_DEMOTION_EVENT,
} from "@worktreeos/core/agent-activity";
import {
  defaultLoggingConfig,
  type LoggingConfig,
} from "@worktreeos/core/global-config";
import { createDaemonLogger, type DaemonLogger } from "@worktreeos/daemon/logger";
import { TerminalSessionManager } from "@worktreeos/daemon/terminal-layer/manager";
import { createFakeTerminalRuntime } from "@worktreeos/daemon/terminal-layer/testing";
import { AgentActivityIngest } from "@worktreeos/daemon/agent-activity-ingest";

const TOKEN = "diag-token";

function captureLogger(level: LoggingConfig["level"] = "trace"): {
  logger: DaemonLogger;
  lines: Record<string, unknown>[];
} {
  const lines: Record<string, unknown>[] = [];
  const cfg: LoggingConfig = { ...defaultLoggingConfig(), enabled: true, level };
  const logger = createDaemonLogger(cfg, process.env, {
    sink: (line) => lines.push(JSON.parse(line)),
  });
  return { logger, lines };
}

function event(kind: string, eventId: string): AgentActivityEvent {
  return {
    v: 1,
    eventId,
    agent: "claude",
    event: kind,
    agentSessionId: "agent-1",
    cwd: "/work/tree",
    at: "2026-06-11T10:00:00.000Z",
    severity: "info",
  };
}

function attachOptions(attachmentId: string) {
  return {
    attachmentId,
    cols: 80,
    rows: 24,
    desiredControl: "controller" as const,
    sink: { send() {}, close() {} },
  };
}

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/ui/v1/agent-events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });
}

describe("status transition + unread diagnostics (manager)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "wos-diag-mgr-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function setup(level: LoggingConfig["level"] = "trace") {
    const r = createFakeTerminalRuntime();
    const { logger, lines } = captureLogger(level);
    const mgr = new TerminalSessionManager({
      runtime: r.runtime,
      logger,
      now: () => new Date("2026-06-11T10:00:00.000Z"),
    });
    const meta = await mgr.create({ worktreePath: tmp });
    return { mgr, meta, lines };
  }

  test("logs a transition with previous, next, and the triggering event", async () => {
    const { mgr, meta, lines } = await setup();
    mgr.applyAgentActivity(meta.id, event("prompt_submit", "e1"));
    const t = lines.find((l) => l.msg === "transition");
    expect(t).toMatchObject({
      level: "info",
      module: "terminal",
      sid: meta.id,
      from: "none",
      to: "working",
      event: "prompt_submit",
      eventId: "e1",
    });
  });

  test("marks unread on a detached hook-stop idle", async () => {
    const { mgr, meta, lines } = await setup();
    mgr.applyAgentActivity(meta.id, event("prompt_submit", "e1"));
    mgr.applyAgentActivity(meta.id, event("stop", "e2"));
    const mark = lines.find((l) => l.msg === "unread.mark");
    expect(mark).toMatchObject({ level: "info", sid: meta.id, state: "idle/stop" });
    expect(mgr.get(meta.id)?.unreadSince).toBe("2026-06-11T10:00:00.000Z");
  });

  test("skips unread (attached) and logs the reason", async () => {
    const { mgr, meta, lines } = await setup();
    await mgr.attach(meta.id, attachOptions("att-1"));
    mgr.applyAgentActivity(meta.id, event("prompt_submit", "e1"));
    mgr.applyAgentActivity(meta.id, event("stop", "e2"));
    const skip = lines.find((l) => l.msg === "unread.skip");
    expect(skip).toMatchObject({ level: "debug", reason: "attached" });
    expect(mgr.get(meta.id)?.unreadSince).toBeUndefined();
  });

  test("skips unread (stale-idle) on a synthetic staleness demotion", async () => {
    const { mgr, meta, lines } = await setup();
    mgr.applyAgentActivity(meta.id, event("prompt_submit", "e1"));
    mgr.applyAgentActivity(meta.id, event(STALE_DEMOTION_EVENT, "e2"));
    const skip = lines.find((l) => l.msg === "unread.skip");
    expect(skip).toMatchObject({ reason: "stale-idle" });
    expect(mgr.get(meta.id)?.unreadSince).toBeUndefined();
  });

  test("a non-transition logs only at trace", async () => {
    const debug = await setup("debug");
    // Two identical stop events: the second produces no state change.
    debug.mgr.applyAgentActivity(debug.meta.id, event("prompt_submit", "e1"));
    debug.mgr.applyAgentActivity(debug.meta.id, event("stop", "e2"));
    const before = debug.lines.length;
    debug.mgr.applyAgentActivity(debug.meta.id, event("stop", "e3"));
    // At debug level, the repeat stop emits no new `transition`/`transition.none`.
    expect(
      debug.lines.slice(before).some((l) => l.msg === "transition"),
    ).toBe(false);
    expect(
      debug.lines.slice(before).some((l) => l.msg === "transition.none"),
    ).toBe(false);
  });
});

describe("ingest attribution diagnostics", () => {
  test("logs a dropped event with its reason and cwd", async () => {
    const { logger, lines } = captureLogger("debug");
    const ingest = new AgentActivityIngest({
      token: TOKEN,
      logger,
      resolveWorktreePath: async () => null,
    });
    await ingest.handle(
      makeRequest(event("prompt_submit", "drop-1")),
    );
    const drop = lines.find(
      (l) => l.msg === "attribution" && l.target === "dropped",
    );
    expect(drop).toMatchObject({
      module: "agent-activity",
      eventId: "drop-1",
      reason: "no-worktree",
      cwd: "/work/tree",
    });
  });

  test("heartbeat ingest is gated to trace", async () => {
    const { logger, lines } = captureLogger("debug");
    const ingest = new AgentActivityIngest({
      token: TOKEN,
      logger,
      resolveWorktreePath: async () => null,
    });
    await ingest.handle(makeRequest(event("heartbeat", "hb-1")));
    // At debug level a heartbeat (logged at trace) produces no records.
    expect(lines.some((l) => l.eventId === "hb-1")).toBe(false);

    await ingest.handle(makeRequest(event("prompt_submit", "ps-1")));
    // A non-heartbeat event logs ingest at debug.
    expect(lines.some((l) => l.msg === "ingest" && l.eventId === "ps-1")).toBe(true);
  });
});
