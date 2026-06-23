import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentActivityBlock } from "@worktreeos/core/agent-activity";
import { reduceAgentActivity } from "@worktreeos/core/agent-activity";
import type { UnifiedEventEnvelope } from "@worktreeos/core/unified-events";

import {
  AgentActivityIngest,
  findPiSessionFileById,
  piSessionsDirForCwd,
} from "@worktreeos/daemon/agent-activity-ingest";
import { DaemonEventBus } from "@worktreeos/daemon/event-bus";
import { TerminalSessionManager } from "@worktreeos/daemon/terminal-layer/manager";
import { createFakeTerminalRuntime } from "@worktreeos/daemon/terminal-layer/testing";
import type { TranscriptTelemetryReader } from "@worktreeos/daemon/terminal-layer/transcript-telemetry";

const TOKEN = "test-token";

function makeRequest(body: unknown, token: string | null = TOKEN): Request {
  return new Request("http://localhost/ui/v1/agent-events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function sampleEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    agent: "claude",
    event: "prompt_submit",
    agentSessionId: "agent-sess",
    cwd: "/work/tree",
    at: "2026-06-11T10:00:00.000Z",
    severity: "info",
    ...overrides,
  };
}

/** Minimal stand-in for the terminal-layer manager. */
function fakeTerminalLayer(sessionIds: string[]) {
  const blocks = new Map<string, AgentActivityBlock | null>();
  const titles = new Map<string, { title: string; titleSource: "user" | "agent" }>();
  // Sessions that count as "attended during the current working stretch"; the
  // sweep gates synthetic demotion on this (real manager tracks it on the actor).
  const attached = new Set<string>();
  const fake = {
    applyAgentActivity(id: string, event: never) {
      if (!sessionIds.includes(id)) return null;
      const previous = blocks.get(id) ?? null;
      const next = reduceAgentActivity(previous, event);
      if (next === previous) {
        return { worktreePath: "/work/tree", activity: null };
      }
      blocks.set(id, next);
      return { worktreePath: "/work/tree", activity: next };
    },
    attachedDuringWorking(id: string) {
      return attached.has(id);
    },
    get(id: string) {
      if (!sessionIds.includes(id)) return null;
      return { id, worktreePath: "/work/tree", ...(titles.get(id) ?? {}) };
    },
    list() {
      return sessionIds.map((id) => {
        const activity = blocks.get(id);
        return {
          id,
          worktreePath: "/work/tree",
          ...(activity ? { agentActivity: activity } : {}),
        };
      });
    },
    async setAgentTitle(id: string, title: string | undefined) {
      if (!sessionIds.includes(id)) return;
      if (title === undefined) titles.delete(id);
      else titles.set(id, { title, titleSource: "agent" });
    },
  };
  const setUserTitle = (id: string, title: string) =>
    titles.set(id, { title, titleSource: "user" });
  const markAttached = (id: string) => attached.add(id);
  return {
    manager: fake as unknown as TerminalSessionManager,
    blocks,
    titles,
    setUserTitle,
    markAttached,
  };
}

function collect(events: DaemonEventBus): UnifiedEventEnvelope[] {
  const out: UnifiedEventEnvelope[] = [];
  events.subscribe((env) => out.push(env), {
    filter: { types: ["agent.activity.changed"] },
  });
  return out;
}

describe("AgentActivityIngest.handle", () => {
  test("rejects missing or wrong token with 401", async () => {
    const ingest = new AgentActivityIngest({ token: TOKEN });
    expect((await ingest.handle(makeRequest(sampleEvent(), null))).status).toBe(401);
    expect((await ingest.handle(makeRequest(sampleEvent(), "wrong"))).status).toBe(401);
  });

  test("rejects malformed JSON and invalid schema with 400", async () => {
    const ingest = new AgentActivityIngest({ token: TOKEN });
    expect((await ingest.handle(makeRequest("{not json"))).status).toBe(400);
    expect(
      (await ingest.handle(makeRequest(sampleEvent({ severity: "loud" })))).status,
    ).toBe(400);
  });

  test("accepts unattributable events with 200 and changes nothing", async () => {
    const events = new DaemonEventBus();
    const seen = collect(events);
    const ingest = new AgentActivityIngest({
      token: TOKEN,
      events,
      resolveWorktreePath: async () => null,
    });
    const res = await ingest.handle(makeRequest(sampleEvent()));
    expect(res.status).toBe(200);
    expect(seen.length).toBe(0);
  });

  test("binds via terminalSessionId and publishes agent.activity.changed", async () => {
    const events = new DaemonEventBus();
    const seen = collect(events);
    const { manager } = fakeTerminalLayer(["term-1"]);
    const ingest = new AgentActivityIngest({
      token: TOKEN,
      events,
      terminalLayer: manager,
    });

    const res = await ingest.handle(
      makeRequest(sampleEvent({ terminalSessionId: "term-1" })),
    );
    expect(res.status).toBe(200);
    expect(seen.length).toBe(1);
    const payload = seen[0]!.event;
    if (payload.type !== "agent.activity.changed") throw new Error("wrong type");
    expect(payload.terminalSessionId).toBe("term-1");
    expect(payload.activity.state).toBe("working");
    expect(seen[0]!.worktreePath).toBe("/work/tree");
  });

  test("question event drives awaiting-input with summary", async () => {
    const events = new DaemonEventBus();
    const seen = collect(events);
    const { manager } = fakeTerminalLayer(["term-1"]);
    const ingest = new AgentActivityIngest({
      token: TOKEN,
      events,
      terminalLayer: manager,
    });
    await ingest.handle(makeRequest(sampleEvent({ terminalSessionId: "term-1" })));
    await ingest.handle(
      makeRequest(
        sampleEvent({
          terminalSessionId: "term-1",
          event: "question_asked",
          severity: "needs-attention",
          summary: "Pick a database",
        }),
      ),
    );
    const payload = seen[1]!.event;
    if (payload.type !== "agent.activity.changed") throw new Error("wrong type");
    expect(payload.activity.state).toBe("awaiting-input");
    expect(payload.activity.question?.summary).toBe("Pick a database");
  });

  test("heartbeat after awaiting-input resumes working and publishes", async () => {
    const events = new DaemonEventBus();
    const seen = collect(events);
    const { manager } = fakeTerminalLayer(["term-1"]);
    const ingest = new AgentActivityIngest({
      token: TOKEN,
      events,
      terminalLayer: manager,
    });
    await ingest.handle(makeRequest(sampleEvent({ terminalSessionId: "term-1" })));
    await ingest.handle(
      makeRequest(
        sampleEvent({
          terminalSessionId: "term-1",
          event: "question_asked",
          severity: "needs-attention",
          summary: "Pick a database",
        }),
      ),
    );
    expect(seen.length).toBe(2); // working, awaiting-input

    // The PostToolUse after the user answered arrives as a heartbeat.
    await ingest.handle(
      makeRequest(sampleEvent({ terminalSessionId: "term-1", event: "heartbeat" })),
    );
    expect(seen.length).toBe(3);
    const payload = seen[2]!.event;
    if (payload.type !== "agent.activity.changed") throw new Error("wrong type");
    expect(payload.activity.state).toBe("working");
    expect(payload.activity.question).toBeUndefined();
  });

  test("duplicate eventId is deduplicated and publishes once", async () => {
    const events = new DaemonEventBus();
    const seen = collect(events);
    const { manager } = fakeTerminalLayer(["term-1"]);
    const ingest = new AgentActivityIngest({
      token: TOKEN,
      events,
      terminalLayer: manager,
    });
    const event = sampleEvent({ terminalSessionId: "term-1", eventId: "dup-1" });
    expect((await ingest.handle(makeRequest(event))).status).toBe(200);
    expect((await ingest.handle(makeRequest(event))).status).toBe(200);
    expect(seen.length).toBe(1);
  });

  test("cwd fallback attributes to worktree without a session claim", async () => {
    const events = new DaemonEventBus();
    const seen = collect(events);
    const ingest = new AgentActivityIngest({
      token: TOKEN,
      events,
      resolveWorktreePath: async (cwd) =>
        cwd.startsWith("/work/tree") ? "/work/tree" : null,
    });
    const res = await ingest.handle(makeRequest(sampleEvent()));
    expect(res.status).toBe(200);
    expect(seen.length).toBe(1);
    const payload = seen[0]!.event;
    if (payload.type !== "agent.activity.changed") throw new Error("wrong type");
    expect(payload.terminalSessionId).toBeUndefined();
    expect(payload.worktreePath).toBe("/work/tree");
  });

  test("unknown event kinds are accepted but publish nothing", async () => {
    const events = new DaemonEventBus();
    const seen = collect(events);
    const { manager } = fakeTerminalLayer(["term-1"]);
    const ingest = new AgentActivityIngest({
      token: TOKEN,
      events,
      terminalLayer: manager,
    });
    const res = await ingest.handle(
      makeRequest(
        sampleEvent({ terminalSessionId: "term-1", event: "future_kind" }),
      ),
    );
    expect(res.status).toBe(200);
    expect(seen.length).toBe(0);
  });
});

describe("AgentActivityIngest staleness sweep", () => {
  const T0 = Date.parse("2026-06-11T10:00:00.000Z");
  const TTL = 180_000;

  test("expiry demotes an attended stale working session to a stale idle and publishes", async () => {
    const events = new DaemonEventBus();
    const seen = collect(events);
    const { manager, markAttached } = fakeTerminalLayer(["term-1"]);
    const ingest = new AgentActivityIngest({ token: TOKEN, events, terminalLayer: manager });

    await ingest.handle(makeRequest(sampleEvent({ terminalSessionId: "term-1" })));
    expect(seen.length).toBe(1); // working
    markAttached("term-1"); // attended during this working stretch

    ingest.sweepStaleActivity(T0 + TTL + 1);
    expect(seen.length).toBe(2);
    const payload = seen[1]!.event;
    if (payload.type !== "agent.activity.changed") throw new Error("wrong type");
    expect(payload.terminalSessionId).toBe("term-1");
    expect(payload.activity.state).toBe("idle");
    // A staleness demotion is soft, not a hook stop.
    expect(payload.activity.idleKind).toBe("stale");

    // A second sweep is a no-op: the block is already idle.
    ingest.sweepStaleActivity(T0 + TTL * 100);
    expect(seen.length).toBe(2);
  });

  test("a never-attended stale working session is not demoted", async () => {
    const events = new DaemonEventBus();
    const seen = collect(events);
    const { manager } = fakeTerminalLayer(["term-1"]);
    const ingest = new AgentActivityIngest({ token: TOKEN, events, terminalLayer: manager });

    await ingest.handle(makeRequest(sampleEvent({ terminalSessionId: "term-1" })));
    expect(seen.length).toBe(1); // working

    // Detached for the whole stretch: a silent working block is almost
    // certainly still working, so staleness leaves it alone.
    ingest.sweepStaleActivity(T0 + TTL * 100);
    expect(seen.length).toBe(1);
  });

  test("worktree-fallback blocks are never demoted by staleness", async () => {
    const events = new DaemonEventBus();
    const seen = collect(events);
    const ingest = new AgentActivityIngest({
      token: TOKEN,
      events,
      resolveWorktreePath: async () => "/work/tree",
    });

    await ingest.handle(makeRequest(sampleEvent()));
    expect(seen.length).toBe(1);

    // No terminal session → no attachment history → treated as never-attended.
    ingest.sweepStaleActivity(T0 + TTL * 100);
    expect(seen.length).toBe(1);
  });

  test("heartbeat refreshes freshness and prevents demotion", async () => {
    const events = new DaemonEventBus();
    const seen = collect(events);
    const { manager } = fakeTerminalLayer(["term-1"]);
    const ingest = new AgentActivityIngest({ token: TOKEN, events, terminalLayer: manager });

    await ingest.handle(makeRequest(sampleEvent({ terminalSessionId: "term-1" })));
    // Heartbeat well after the prompt but before any sweep — publishes nothing.
    await ingest.handle(
      makeRequest(
        sampleEvent({
          terminalSessionId: "term-1",
          event: "heartbeat",
          at: "2026-06-11T10:01:00.000Z",
        }),
      ),
    );
    expect(seen.length).toBe(1); // heartbeat did not publish

    // Sweep within TTL of the heartbeat (not the original prompt): stays working.
    ingest.sweepStaleActivity(Date.parse("2026-06-11T10:01:00.000Z") + TTL - 1);
    expect(seen.length).toBe(1);
  });

  test("awaiting-input is never demoted", async () => {
    const events = new DaemonEventBus();
    const seen = collect(events);
    const { manager } = fakeTerminalLayer(["term-1"]);
    const ingest = new AgentActivityIngest({ token: TOKEN, events, terminalLayer: manager });

    await ingest.handle(makeRequest(sampleEvent({ terminalSessionId: "term-1" })));
    await ingest.handle(
      makeRequest(
        sampleEvent({
          terminalSessionId: "term-1",
          event: "question_asked",
          severity: "needs-attention",
          summary: "Pick one",
        }),
      ),
    );
    expect(seen.length).toBe(2);

    ingest.sweepStaleActivity(T0 + TTL * 100);
    expect(seen.length).toBe(2);
  });

  test("WOS_AGENT_ACTIVITY_TTL_MS overrides the default TTL", async () => {
    const previous = process.env.WOS_AGENT_ACTIVITY_TTL_MS;
    process.env.WOS_AGENT_ACTIVITY_TTL_MS = "1000";
    try {
      const events = new DaemonEventBus();
      const seen = collect(events);
      const { manager, markAttached } = fakeTerminalLayer(["term-1"]);
      const ingest = new AgentActivityIngest({ token: TOKEN, events, terminalLayer: manager });

      await ingest.handle(makeRequest(sampleEvent({ terminalSessionId: "term-1" })));
      markAttached("term-1");
      // Past the 1s override but well within the 90s default.
      ingest.sweepStaleActivity(T0 + 2_000);
      expect(seen.length).toBe(2);
      const payload = seen[1]!.event;
      if (payload.type !== "agent.activity.changed") throw new Error("wrong type");
      expect(payload.activity.state).toBe("idle");
    } finally {
      if (previous === undefined) delete process.env.WOS_AGENT_ACTIVITY_TTL_MS;
      else process.env.WOS_AGENT_ACTIVITY_TTL_MS = previous;
    }
  });
});

describe("AgentActivityIngest auto-titles", () => {
  function makeIngest(sessionIds: string[] = ["term-1"]) {
    const layer = fakeTerminalLayer(sessionIds);
    const ingest = new AgentActivityIngest({
      token: TOKEN,
      events: new DaemonEventBus(),
      terminalLayer: layer.manager,
    });
    return { ingest, ...layer };
  }

  test("first prompt names an untitled session with agent provenance", async () => {
    const { ingest, titles } = makeIngest();
    await ingest.handle(
      makeRequest(sampleEvent({ terminalSessionId: "term-1", title: "Fix login bug" })),
    );
    expect(titles.get("term-1")).toEqual({
      title: "Fix login bug",
      titleSource: "agent",
    });
  });

  test("hook titles defer to a transcript ai-title", async () => {
    const layer = fakeTerminalLayer(["term-1"]);
    const ingest = new AgentActivityIngest({
      token: TOKEN,
      events: new DaemonEventBus(),
      terminalLayer: layer.manager,
      transcriptTelemetry: {
        aiTitle: (id: string) => (id === "term-1" ? "AI title" : undefined),
      } as unknown as TranscriptTelemetryReader,
    });
    await ingest.handle(
      makeRequest(sampleEvent({ terminalSessionId: "term-1", title: "raw prompt" })),
    );
    await ingest.handle(
      makeRequest(
        sampleEvent({ terminalSessionId: "term-1", event: "stop", title: "stop summary" }),
      ),
    );
    expect(layer.titles.get("term-1")).toBeUndefined();
  });

  test("later prompt does not rename a titled session", async () => {
    const { ingest, titles } = makeIngest();
    await ingest.handle(
      makeRequest(sampleEvent({ terminalSessionId: "term-1", title: "First task" })),
    );
    await ingest.handle(
      makeRequest(sampleEvent({ terminalSessionId: "term-1", title: "Second task" })),
    );
    expect(titles.get("term-1")?.title).toBe("First task");
  });

  test("stop summary upgrades an agent-sourced title", async () => {
    const { ingest, titles } = makeIngest();
    await ingest.handle(
      makeRequest(sampleEvent({ terminalSessionId: "term-1", title: "raw prompt" })),
    );
    await ingest.handle(
      makeRequest(
        sampleEvent({ terminalSessionId: "term-1", event: "stop", title: "Login bug fix" }),
      ),
    );
    expect(titles.get("term-1")?.title).toBe("Login bug fix");
  });

  test("user-sourced title is never overwritten", async () => {
    const { ingest, titles, setUserTitle } = makeIngest();
    setUserTitle("term-1", "my session");
    await ingest.handle(
      makeRequest(sampleEvent({ terminalSessionId: "term-1", title: "Agent name" })),
    );
    await ingest.handle(
      makeRequest(
        sampleEvent({ terminalSessionId: "term-1", event: "stop", title: "Agent summary" }),
      ),
    );
    expect(titles.get("term-1")).toEqual({ title: "my session", titleSource: "user" });
  });

  test("session_start clears an agent-sourced title but not a user one", async () => {
    const { ingest, titles, setUserTitle } = makeIngest(["term-1", "term-2"]);
    await ingest.handle(
      makeRequest(sampleEvent({ terminalSessionId: "term-1", title: "Old task" })),
    );
    setUserTitle("term-2", "my session");
    await ingest.handle(
      makeRequest(sampleEvent({ terminalSessionId: "term-1", event: "session_start" })),
    );
    await ingest.handle(
      makeRequest(sampleEvent({ terminalSessionId: "term-2", event: "session_start" })),
    );
    expect(titles.get("term-1")).toBeUndefined();
    expect(titles.get("term-2")?.title).toBe("my session");
  });

  test("invalid title is dropped silently without failing ingestion", async () => {
    const { ingest, titles } = makeIngest();
    const res = await ingest.handle(
      makeRequest(sampleEvent({ terminalSessionId: "term-1", title: "bad\u0007title" })),
    );
    expect(res.status).toBe(200);
    expect(titles.get("term-1")).toBeUndefined();
  });

  test("events without a title leave the session untouched", async () => {
    const { ingest, titles } = makeIngest();
    const res = await ingest.handle(
      makeRequest(sampleEvent({ terminalSessionId: "term-1" })),
    );
    expect(res.status).toBe(200);
    expect(titles.size).toBe(0);
  });
});

describe("transcript binding from session_start", () => {
  function makeReaderSpy() {
    const binds: Array<{ id: string; path: string; agentSessionId: string; source?: string }> = [];
    const reader = {
      bind(id: string, path: string, agentSessionId: string, source?: string) {
        binds.push({ id, path, agentSessionId, source });
      },
    };
    return { binds, reader };
  }

  test("session_start with transcriptPath binds the reader", async () => {
    const { manager } = fakeTerminalLayer(["term-1"]);
    const { binds, reader } = makeReaderSpy();
    const ingest = new AgentActivityIngest({
      token: TOKEN,
      terminalLayer: manager,
      transcriptTelemetry: reader as never,
    });
    const res = await ingest.handle(
      makeRequest(
        sampleEvent({
          event: "session_start",
          terminalSessionId: "term-1",
          detail: { transcriptPath: "/p/sess.jsonl", source: "clear" },
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(binds).toEqual([
      { id: "term-1", path: "/p/sess.jsonl", agentSessionId: "agent-sess", source: "clear" },
    ]);
  });

  test("session_start without transcriptPath does not bind", async () => {
    const { manager } = fakeTerminalLayer(["term-1"]);
    const { binds, reader } = makeReaderSpy();
    const ingest = new AgentActivityIngest({
      token: TOKEN,
      terminalLayer: manager,
      transcriptTelemetry: reader as never,
    });
    await ingest.handle(
      makeRequest(sampleEvent({ event: "session_start", terminalSessionId: "term-1" })),
    );
    await ingest.handle(
      makeRequest(
        sampleEvent({
          terminalSessionId: "term-1",
          detail: { transcriptPath: "/p/sess.jsonl" },
        }),
      ),
    );
    expect(binds).toEqual([]);
  });
});

describe("pi transcript binding from session_start", () => {
  /** Spy that also captures the `agent` selected on the binding options. */
  function makePiReaderSpy() {
    const binds: Array<{
      id: string;
      path: string;
      agentSessionId: string;
      source?: string;
      agent?: string;
      contextWindow?: number;
    }> = [];
    const reader = {
      bind(
        id: string,
        path: string,
        agentSessionId: string,
        source?: string,
        _seed?: unknown,
        options?: { agent?: string; contextWindow?: number },
      ) {
        binds.push({
          id,
          path,
          agentSessionId,
          source,
          agent: options?.agent,
          ...(options?.contextWindow
            ? { contextWindow: options.contextWindow }
            : {}),
        });
      },
    };
    return { binds, reader };
  }

  test("a pi session_start with a transcriptPath binds that file with the pi parser", async () => {
    const { manager } = fakeTerminalLayer(["term-1"]);
    const { binds, reader } = makePiReaderSpy();
    const ingest = new AgentActivityIngest({
      token: TOKEN,
      terminalLayer: manager,
      transcriptTelemetry: reader as never,
    });
    const res = await ingest.handle(
      makeRequest(
        sampleEvent({
          agent: "pi",
          event: "session_start",
          terminalSessionId: "term-1",
          agentSessionId: "pi-sess",
          detail: { transcriptPath: "/p/pi.jsonl", source: "startup" },
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(binds).toEqual([
      {
        id: "term-1",
        path: "/p/pi.jsonl",
        agentSessionId: "pi-sess",
        source: "startup",
        agent: "pi",
      },
    ]);
  });

  test("a pi event threads detail.contextWindow into the bind options", async () => {
    const { manager } = fakeTerminalLayer(["term-1"]);
    const { binds, reader } = makePiReaderSpy();
    const ingest = new AgentActivityIngest({
      token: TOKEN,
      terminalLayer: manager,
      transcriptTelemetry: reader as never,
    });
    await ingest.handle(
      makeRequest(
        sampleEvent({
          agent: "pi",
          event: "session_start",
          terminalSessionId: "term-1",
          agentSessionId: "pi-sess",
          // pi reports the exact window per model; deepseek-v4-pro is 1M.
          detail: { transcriptPath: "/p/pi.jsonl", contextWindow: 1_048_576 },
        }),
      ),
    );
    expect(binds).toEqual([
      {
        id: "term-1",
        path: "/p/pi.jsonl",
        agentSessionId: "pi-sess",
        source: undefined,
        agent: "pi",
        contextWindow: 1_048_576,
      },
    ]);
  });

  test("a pi prompt_submit carrying a transcriptPath rebinds (not only session_start)", async () => {
    // pi's session file is created lazily, so the path is absent at
    // session_start and arrives on a later event — the daemon must rebind then.
    const { manager } = fakeTerminalLayer(["term-1"]);
    const { binds, reader } = makePiReaderSpy();
    const ingest = new AgentActivityIngest({
      token: TOKEN,
      terminalLayer: manager,
      transcriptTelemetry: reader as never,
    });
    await ingest.handle(
      makeRequest(
        sampleEvent({
          agent: "pi",
          event: "prompt_submit",
          terminalSessionId: "term-1",
          agentSessionId: "pi-sess",
          detail: { query: "go", transcriptPath: "/p/now.jsonl" },
        }),
      ),
    );
    expect(binds).toEqual([
      {
        id: "term-1",
        path: "/p/now.jsonl",
        agentSessionId: "pi-sess",
        source: undefined,
        agent: "pi",
      },
    ]);
  });

  test("a pi heartbeat with no path does not trigger a directory scan", async () => {
    // A path-less heartbeat must not dir-scan (which would fire every few
    // seconds); only session_start falls back to the scan.
    const { manager } = fakeTerminalLayer(["term-1"]);
    const { binds, reader } = makePiReaderSpy();
    const ingest = new AgentActivityIngest({
      token: TOKEN,
      terminalLayer: manager,
      transcriptTelemetry: reader as never,
    });
    await ingest.handle(
      makeRequest(
        sampleEvent({
          agent: "pi",
          event: "heartbeat",
          terminalSessionId: "term-1",
          agentSessionId: "pi-sess",
        }),
      ),
    );
    expect(binds).toEqual([]);
  });

  test("piSessionsDirForCwd matches pi's real segment-join encoding", () => {
    // pi joins non-empty path segments with `-` and wraps in `--…--` — the
    // leading separator is dropped (NOT a literal `/`→`-` replace, which would
    // add an extra leading dash). Verified against a real ~/.pi/agent/sessions.
    const dir = piSessionsDirForCwd("/Users/x/.wos/worktrees/wos-d38/pi-dev", {
      PI_CONFIG_DIR: "/home/.pi",
    });
    expect(dir.endsWith("/--Users-x-.wos-worktrees-wos-d38-pi-dev--")).toBe(true);
  });

  test("findPiSessionFileById resolves the session file by its id suffix", async () => {
    const home = mkdtempSync(join(tmpdir(), "wos-pi-home-"));
    try {
      const cwd = "/work/proj";
      const dir = piSessionsDirForCwd(cwd, { PI_CONFIG_DIR: join(home, ".pi") });
      mkdirSync(dir, { recursive: true });
      // pi names session files `<timestamp>_<sessionId>.jsonl`.
      const want = join(dir, "2026-06-23T09-52-11-047Z_pi-sess-123.jsonl");
      writeFileSync(want, "{}\n");
      writeFileSync(join(dir, "2026-06-23T09-13-50-548Z_other-sess.jsonl"), "{}\n");

      const env = { PI_CONFIG_DIR: join(home, ".pi") };
      expect(await findPiSessionFileById(cwd, "pi-sess-123", env)).toBe(want);
      // An unknown id resolves nothing rather than an unrelated newest file.
      expect(await findPiSessionFileById(cwd, "missing", env)).toBeUndefined();
      // An empty id never scans.
      expect(await findPiSessionFileById(cwd, "", env)).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a pi session_start with no transcriptPath binds its own file resolved by id", async () => {
    const home = mkdtempSync(join(tmpdir(), "wos-pi-home-"));
    const prev = process.env.PI_CONFIG_DIR;
    try {
      process.env.PI_CONFIG_DIR = join(home, ".pi");
      const cwd = "/work/scan";
      const dir = piSessionsDirForCwd(cwd);
      mkdirSync(dir, { recursive: true });
      // The session's own file, plus an unrelated NEWER one that must be ignored
      // (a "newest file" scan would have bound it — the id keys to the right one).
      const own = join(dir, "2026-06-23T09-00-00-000Z_pi-sess.jsonl");
      const unrelated = join(dir, "2026-06-23T10-00-00-000Z_other.jsonl");
      writeFileSync(own, "{}\n");
      writeFileSync(unrelated, "{}\n");
      utimesSync(own, new Date(1_000_000), new Date(1_000_000));
      utimesSync(unrelated, new Date(2_000_000), new Date(2_000_000));

      const { manager } = fakeTerminalLayer(["term-1"]);
      const { binds, reader } = makePiReaderSpy();
      const ingest = new AgentActivityIngest({
        token: TOKEN,
        terminalLayer: manager,
        transcriptTelemetry: reader as never,
      });
      await ingest.handle(
        makeRequest(
          sampleEvent({
            agent: "pi",
            event: "session_start",
            terminalSessionId: "term-1",
            agentSessionId: "pi-sess",
            cwd,
          }),
        ),
      );
      expect(binds).toEqual([
        {
          id: "term-1",
          path: own,
          agentSessionId: "pi-sess",
          source: undefined,
          agent: "pi",
        },
      ]);
    } finally {
      if (prev === undefined) delete process.env.PI_CONFIG_DIR;
      else process.env.PI_CONFIG_DIR = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("AgentActivityIngest staleness sweep (real manager)", () => {
  const T0 = Date.parse("2026-06-11T10:00:00.000Z");
  const TTL = 180_000;

  async function withWorktree<T>(fn: (tmp: string) => Promise<T>): Promise<T> {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "wos-sweep-"));
    try {
      return await fn(tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  function realManager(now: () => Date) {
    const r = createFakeTerminalRuntime();
    return new TerminalSessionManager({
      runtime: r.runtime,
      now,
      // The sweep only sees a session's activity while an agent is its
      // foreground command, so the fake must report one.
      activeCommandResolver: () => ({
        pid: 1001,
        command: "claude",
        args: "claude",
        agent: "claude",
      }),
    });
  }

  function promptSubmit(terminalSessionId: string, at: string): AgentActivityEvent {
    return {
      v: 1,
      eventId: `ps-${at}`,
      agent: "claude",
      event: "prompt_submit",
      agentSessionId: "agent-1",
      terminalSessionId,
      cwd: "/tmp",
      at,
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

  test("a detached session survives past the TTL", async () => {
    await withWorktree(async (tmp) => {
      const events = new DaemonEventBus();
      const seen = collect(events);
      const mgr = realManager(() => new Date("2026-06-11T10:10:00.000Z"));
      const meta = await mgr.create({ worktreePath: tmp });
      const ingest = new AgentActivityIngest({ token: TOKEN, events, terminalLayer: mgr });

      mgr.applyAgentActivity(meta.id, promptSubmit(meta.id, "2026-06-11T10:00:00.000Z"));
      ingest.sweepStaleActivity(T0 + TTL * 100);

      expect(mgr.get(meta.id)?.agentActivity?.state).toBe("working");
      expect(mgr.get(meta.id)?.unreadSince).toBeUndefined();
      expect(seen.length).toBe(0);
    });
  });

  test("an attended session demotes to a stale idle with no unread", async () => {
    await withWorktree(async (tmp) => {
      const events = new DaemonEventBus();
      const seen = collect(events);
      const mgr = realManager(() => new Date("2026-06-11T10:10:00.000Z"));
      const meta = await mgr.create({ worktreePath: tmp });
      const ingest = new AgentActivityIngest({ token: TOKEN, events, terminalLayer: mgr });

      mgr.applyAgentActivity(meta.id, promptSubmit(meta.id, "2026-06-11T10:00:00.000Z"));
      // Attended during this stretch, then the client closes the tab.
      await mgr.attach(meta.id, attachOptions("att-1"));
      await mgr.detach(meta.id, "att-1");

      ingest.sweepStaleActivity(T0 + TTL + 1);

      const activity = mgr.get(meta.id)?.agentActivity;
      expect(activity?.state).toBe("idle");
      expect(activity?.idleKind).toBe("stale");
      // A guessed stop never marks unread.
      expect(mgr.get(meta.id)?.unreadSince).toBeUndefined();
      expect(seen.length).toBe(1);
      const payload = seen[0]!.event;
      if (payload.type !== "agent.activity.changed") throw new Error("wrong type");
      expect(payload.terminalSessionId).toBe(meta.id);
      expect(payload.activity.state).toBe("idle");
    });
  });
});

describe("AgentActivityIngest post-restart recovery (real manager)", () => {
  async function withWorktree<T>(fn: (tmp: string) => Promise<T>): Promise<T> {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "wos-restart-"));
    try {
      return await fn(tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  function realManager(now: () => Date) {
    const r = createFakeTerminalRuntime();
    return new TerminalSessionManager({
      runtime: r.runtime,
      now,
      activeCommandResolver: () => ({
        pid: 1001,
        command: "claude",
        args: "claude",
        agent: "claude",
      }),
    });
  }

  test("a heartbeat after a daemon restart bootstraps working with no unread", async () => {
    await withWorktree(async (tmp) => {
      const events = new DaemonEventBus();
      const seen = collect(events);
      const mgr = realManager(() => new Date("2026-06-11T10:10:00.000Z"));
      const meta = await mgr.create({ worktreePath: tmp });
      const ingest = new AgentActivityIngest({ token: TOKEN, events, terminalLayer: mgr });

      // A daemon restart cleared the in-memory block; the still-working agent's
      // next tool execution arrives as a heartbeat with no prior block.
      expect(mgr.get(meta.id)?.agentActivity).toBeUndefined();
      const res = await ingest.handle(
        makeRequest(sampleEvent({ terminalSessionId: meta.id, event: "heartbeat" })),
      );
      expect(res.status).toBe(200);

      // The block is re-established as working, and the transition is published.
      expect(mgr.get(meta.id)?.agentActivity?.state).toBe("working");
      expect(seen.length).toBe(1);
      const payload = seen[0]!.event;
      if (payload.type !== "agent.activity.changed") throw new Error("wrong type");
      expect(payload.terminalSessionId).toBe(meta.id);
      expect(payload.activity.state).toBe("working");
      // A fresh working block is not unread-qualifying — no notification.
      expect(mgr.get(meta.id)?.unreadSince).toBeUndefined();
    });
  });

  test("a transcript-growth refresh on a block-less session does not bootstrap", async () => {
    await withWorktree(async (tmp) => {
      const events = new DaemonEventBus();
      const seen = collect(events);
      const mgr = realManager(() => new Date("2026-06-11T10:10:00.000Z"));
      const meta = await mgr.create({ worktreePath: tmp });

      // Post-restart, no block. Transcript growth must NOT bootstrap working:
      // trailing summary/title records are appended after a real stop and would
      // falsely resurrect a finished turn. Only a heartbeat may create a block.
      expect(mgr.get(meta.id)?.agentActivity).toBeUndefined();
      mgr.refreshAgentActivity(meta.id, "2026-06-11T10:05:00.000Z");
      expect(mgr.get(meta.id)?.agentActivity).toBeUndefined();
      expect(seen.length).toBe(0);
    });
  });
});

describe("createAndPersistAgentToken", () => {
  test("reuses the persisted token across daemon runs", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createAndPersistAgentToken } = await import(
      "@worktreeos/daemon/agent-activity-ingest"
    );
    const home = mkdtempSync(join(tmpdir(), "wos-token-"));
    try {
      const env = { WOS_HOME: home } as NodeJS.ProcessEnv;
      const first = createAndPersistAgentToken(env);
      const second = createAndPersistAgentToken(env);
      expect(first).toHaveLength(64);
      expect(second).toBe(first);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
