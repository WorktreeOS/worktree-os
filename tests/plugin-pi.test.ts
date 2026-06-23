import { describe, expect, test } from "bun:test";

import {
  type AgentActivityEvent,
  validateAgentActivityEvent,
} from "@worktreeos/core/agent-activity";
import { createPiHandlers } from "@worktreeos/plugin-pi";
import { buildActivityEvent } from "@worktreeos/plugin-pi/payload";

function harness() {
  const sent: AgentActivityEvent[] = [];
  const handlers = createPiHandlers({
    cwd: "/work/tree",
    send: (event) => sent.push(event),
  });
  return { handlers, sent };
}

/**
 * A pi `ExtensionContext` stand-in mirroring the real `ctx.sessionManager`. The
 * getters read `this` (like pi's real `SessionManager`, which returns
 * `this.sessionFile`), so a handler that calls them as detached functions would
 * throw — this guards against the unbound-method regression where every getter
 * silently returned undefined and telemetry never bound.
 */
function piCtx(
  opts: {
    sessionFile?: string;
    sessionId?: string;
    cwd?: string;
    /** Window on `ctx.model.contextWindow` (pi's primary source). */
    modelWindow?: number;
    /** Window on `ctx.getContextUsage().contextWindow` (the fallback). */
    usageWindow?: number;
  } = {},
) {
  class FakeSessionManager {
    constructor(
      private readonly file: string | undefined,
      private readonly id: string,
      private readonly dir: string,
    ) {}
    getSessionFile(): string | undefined {
      return this.file;
    }
    getSessionId(): string {
      return this.id;
    }
    getCwd(): string {
      return this.dir;
    }
  }
  return {
    cwd: opts.cwd ?? "/work/tree",
    sessionManager: new FakeSessionManager(
      opts.sessionFile,
      opts.sessionId ?? "pi-sess",
      opts.cwd ?? "/work/tree",
    ),
    ...(opts.modelWindow !== undefined
      ? { model: { contextWindow: opts.modelWindow } }
      : {}),
    getContextUsage: () =>
      opts.usageWindow !== undefined
        ? { contextWindow: opts.usageWindow, tokens: null, percent: null }
        : undefined,
  };
}

describe("buildActivityEvent (pi)", () => {
  test("produces schema-valid payloads tagged agent: pi", () => {
    const event = buildActivityEvent("prompt_submit", "s1", "/work/tree", {
      summary: "do things",
      detail: { query: "do things" },
    });
    expect(validateAgentActivityEvent(event).ok).toBe(true);
    expect(event.agent).toBe("pi");
    expect(event.eventId.startsWith("pi-")).toBe(true);
  });

  test("echoes terminal session id from env and truncates summary", () => {
    const event = buildActivityEvent("stop", "s1", "/work/tree", {
      summary: "z".repeat(400),
      env: { WOS_TERMINAL_SESSION_ID: "term-9" },
    });
    expect(event.terminalSessionId).toBe("term-9");
    expect(event.summary?.length).toBe(200);
  });

  test("eventIds are unique and pi-prefixed", () => {
    const a = buildActivityEvent("stop", "s1", "/w");
    const b = buildActivityEvent("stop", "s1", "/w");
    expect(a.eventId).not.toBe(b.eventId);
    expect(a.eventId.startsWith("pi-")).toBe(true);
  });
});

describe("createPiHandlers", () => {
  test("session_start carries the transcript path (from ctx) and source", () => {
    const { handlers, sent } = harness();
    handlers.session_start(
      { type: "session_start", reason: "startup" },
      piCtx({ sessionFile: "/p/sess.jsonl", sessionId: "pi-sess" }),
    );
    expect(sent.length).toBe(1);
    expect(sent[0]!.event).toBe("session_start");
    expect(sent[0]!.agent).toBe("pi");
    expect(sent[0]!.agentSessionId).toBe("pi-sess");
    expect(sent[0]!.detail?.transcriptPath).toBe("/p/sess.jsonl");
    expect(sent[0]!.detail?.source).toBe("startup");
  });

  test("session_start omits transcriptPath when the session manager has none (D3)", () => {
    const { handlers, sent } = harness();
    handlers.session_start({ reason: "startup" }, piCtx({})); // getSessionFile → undefined
    expect(sent.length).toBe(1);
    expect(sent[0]!.event).toBe("session_start");
    expect(sent[0]!.detail?.transcriptPath).toBeUndefined();
  });

  test("before_agent_start reports prompt_submit with a query summary", () => {
    const { handlers, sent } = harness();
    handlers.before_agent_start(
      { type: "before_agent_start", prompt: "fix the bug" },
      piCtx(),
    );
    expect(sent.length).toBe(1);
    expect(sent[0]!.event).toBe("prompt_submit");
    expect(sent[0]!.summary).toBe("fix the bug");
    expect(sent[0]!.detail?.query).toBe("fix the bug");
  });

  test("before_agent_start with no prompt emits nothing", () => {
    const { handlers, sent } = harness();
    handlers.before_agent_start({ type: "before_agent_start" }, piCtx());
    expect(sent.length).toBe(0);
  });

  test("agent_end reports stop (idle)", () => {
    const { handlers, sent } = harness();
    handlers.agent_end({ type: "agent_end", messages: [] }, piCtx());
    expect(sent.length).toBe(1);
    expect(sent[0]!.event).toBe("stop");
  });

  test("tool/turn end reports heartbeat (working liveness)", () => {
    const { handlers, sent } = harness();
    handlers.heartbeat(
      { type: "tool_execution_end", toolName: "bash", isError: false },
      piCtx(),
    );
    expect(sent.length).toBe(1);
    expect(sent[0]!.event).toBe("heartbeat");
  });

  test("every event carries the session file path once available (lazy file → rebind)", () => {
    const { handlers, sent } = harness();
    const ctx = piCtx({ sessionFile: "/p/now.jsonl", sessionId: "pi-sess" });
    handlers.before_agent_start({ prompt: "go" }, ctx);
    handlers.heartbeat({ toolName: "bash" }, ctx);
    handlers.agent_end({ messages: [] }, ctx);
    expect(sent.map((e) => e.event)).toEqual([
      "prompt_submit",
      "heartbeat",
      "stop",
    ]);
    // The daemon rebinds pi telemetry from any event's transcriptPath, so the
    // path must ride on the post-startup events too — not only session_start.
    for (const e of sent) {
      expect(e.detail?.transcriptPath).toBe("/p/now.jsonl");
    }
  });

  test("reports the model context window from ctx.model on every event", () => {
    const { handlers, sent } = harness();
    const ctx = piCtx({ sessionFile: "/p.jsonl", modelWindow: 1_048_576 });
    handlers.session_start({ reason: "startup" }, ctx);
    handlers.before_agent_start({ prompt: "go" }, ctx);
    handlers.heartbeat({ toolName: "bash" }, ctx);
    expect(sent.length).toBe(3);
    for (const e of sent) {
      expect(e.detail?.contextWindow).toBe(1_048_576);
    }
  });

  test("falls back to getContextUsage().contextWindow when ctx.model has none", () => {
    const { handlers, sent } = harness();
    handlers.before_agent_start(
      { prompt: "go" },
      piCtx({ usageWindow: 262_144 }),
    );
    expect(sent[0]!.detail?.contextWindow).toBe(262_144);
  });

  test("omits contextWindow when neither source reports a window", () => {
    const { handlers, sent } = harness();
    handlers.before_agent_start(
      { prompt: "go" },
      piCtx({ sessionFile: "/p.jsonl" }),
    );
    expect(sent[0]!.detail?.contextWindow).toBeUndefined();
  });

  test("no handler ever emits a needs-attention event", () => {
    const { handlers, sent } = harness();
    const ctx = piCtx({ sessionFile: "/p.jsonl", sessionId: "s" });
    handlers.session_start({ reason: "startup" }, ctx);
    handlers.before_agent_start({ prompt: "go" }, ctx);
    handlers.heartbeat({ toolName: "read" }, ctx);
    handlers.agent_end({ messages: [] }, ctx);
    expect(sent.length).toBe(4);
    for (const event of sent) {
      expect(event.severity).toBe("info");
      expect(validateAgentActivityEvent(event).ok).toBe(true);
    }
  });

  test("malformed events/ctx degrade to less telemetry and never throw", () => {
    const { handlers, sent } = harness();
    // Undefined / wrong-typed event AND ctx must not throw.
    expect(() => handlers.session_start(undefined, undefined)).not.toThrow();
    expect(() => handlers.before_agent_start(42 as unknown, null)).not.toThrow();
    expect(() => handlers.agent_end("nope" as unknown, 7 as unknown)).not.toThrow();
    expect(() => handlers.heartbeat(null as unknown, undefined)).not.toThrow();
    // A ctx whose session-manager getters throw must still degrade cleanly.
    const throwingCtx = {
      cwd: "/w",
      sessionManager: {
        getSessionFile() {
          throw new Error("boom");
        },
        getSessionId() {
          throw new Error("boom");
        },
      },
    };
    expect(() => handlers.session_start({ reason: "startup" }, throwingCtx)).not.toThrow();
    expect(sent.every((e) => e.severity === "info")).toBe(true);
  });
});
