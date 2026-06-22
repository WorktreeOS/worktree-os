import { describe, expect, test } from "bun:test";

import {
  AGENT_ACTIVITY_SUMMARY_MAX,
  AGENT_ACTIVITY_TITLE_MAX,
  type AgentActivityEvent,
  DEFAULT_AGENT_ACTIVITY_TTL_MS,
  isAgentActivityStale,
  reduceAgentActivity,
  STALE_DEMOTION_EVENT,
  truncateActivitySummary,
  validateAgentActivityEvent,
} from "@worktreeos/core/agent-activity";

function sampleEvent(overrides: Record<string, unknown> = {}): unknown {
  return {
    v: 1,
    eventId: "evt-1",
    agent: "claude",
    event: "prompt_submit",
    agentSessionId: "sess-1",
    cwd: "/tmp/worktree",
    at: "2026-06-11T10:00:00.000Z",
    severity: "info",
    ...overrides,
  };
}

describe("validateAgentActivityEvent", () => {
  test("accepts a valid event", () => {
    const result = validateAgentActivityEvent(sampleEvent());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.agent).toBe("claude");
  });

  test("tolerates unknown agent and extra fields", () => {
    const result = validateAgentActivityEvent(
      sampleEvent({ agent: "future-agent", futureField: { nested: true } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.futureField).toEqual({ nested: true });
  });

  test("rejects missing eventId", () => {
    const result = validateAgentActivityEvent(sampleEvent({ eventId: "" }));
    expect(result.ok).toBe(false);
  });

  test("rejects missing event kind", () => {
    const result = validateAgentActivityEvent(sampleEvent({ event: undefined }));
    expect(result.ok).toBe(false);
  });

  test("rejects invalid severity", () => {
    const result = validateAgentActivityEvent(sampleEvent({ severity: "loud" }));
    expect(result.ok).toBe(false);
  });

  test("rejects non-object payloads", () => {
    expect(validateAgentActivityEvent("nope").ok).toBe(false);
    expect(validateAgentActivityEvent(null).ok).toBe(false);
    expect(validateAgentActivityEvent([]).ok).toBe(false);
  });

  test("truncates over-long summaries", () => {
    const result = validateAgentActivityEvent(
      sampleEvent({ summary: "x".repeat(500) }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.summary?.length).toBe(AGENT_ACTIVITY_SUMMARY_MAX);
    }
  });

  test("accepts an event with a title and preserves it", () => {
    const result = validateAgentActivityEvent(sampleEvent({ title: "Fix login bug" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.title).toBe("Fix login bug");
  });

  test("accepts an event without a title", () => {
    const result = validateAgentActivityEvent(sampleEvent());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.title).toBeUndefined();
  });

  test("truncates over-long titles and rejects non-string titles", () => {
    const result = validateAgentActivityEvent(
      sampleEvent({ title: "t".repeat(200) }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.title?.length).toBe(AGENT_ACTIVITY_TITLE_MAX);
    }
    expect(validateAgentActivityEvent(sampleEvent({ title: 42 })).ok).toBe(false);
  });
});

describe("truncateActivitySummary", () => {
  test("leaves short strings unchanged", () => {
    expect(truncateActivitySummary("hello")).toBe("hello");
  });

  test("truncates to the limit", () => {
    expect(truncateActivitySummary("x".repeat(300)).length).toBe(
      AGENT_ACTIVITY_SUMMARY_MAX,
    );
  });
});

describe("reduceAgentActivity", () => {
  function ev(kind: string, extra: Record<string, unknown> = {}) {
    const result = validateAgentActivityEvent(sampleEvent({ event: kind, ...extra }));
    if (!result.ok) throw new Error(result.error);
    return result.event as AgentActivityEvent;
  }

  test("prompt_submit moves to working and records query", () => {
    const block = reduceAgentActivity(null, ev("prompt_submit", {
      detail: { query: "fix the bug" },
    }));
    expect(block?.state).toBe("working");
    expect(block?.lastQuery).toBe("fix the bug");
  });

  test("stop maps to idle, not done", () => {
    const block = reduceAgentActivity(
      reduceAgentActivity(null, ev("prompt_submit")),
      ev("stop"),
    );
    expect(block?.state).toBe("idle");
  });

  test("question_asked moves to awaiting-input with summary", () => {
    const block = reduceAgentActivity(
      reduceAgentActivity(null, ev("prompt_submit")),
      ev("question_asked", {
        severity: "needs-attention",
        summary: "Which database should we use?",
      }),
    );
    expect(block?.state).toBe("awaiting-input");
    expect(block?.question?.summary).toBe("Which database should we use?");
  });

  test("permission_replied returns to working", () => {
    const awaiting = reduceAgentActivity(null, ev("permission_request"));
    const block = reduceAgentActivity(awaiting, ev("permission_replied"));
    expect(block?.state).toBe("working");
    expect(block?.question).toBeUndefined();
  });

  test("next prompt_submit clears pending question", () => {
    const awaiting = reduceAgentActivity(null, ev("question_asked"));
    const block = reduceAgentActivity(awaiting, ev("prompt_submit"));
    expect(block?.state).toBe("working");
    expect(block?.question).toBeUndefined();
  });

  test("unknown event kind leaves state unchanged", () => {
    const working = reduceAgentActivity(null, ev("prompt_submit"));
    const block = reduceAgentActivity(working, ev("totally_new_kind"));
    expect(block).toBe(working);
  });

  test("session_start without prior block is idle", () => {
    const block = reduceAgentActivity(null, ev("session_start"));
    expect(block?.state).toBe("idle");
  });

  test("heartbeat validates", () => {
    const result = validateAgentActivityEvent(sampleEvent({ event: "heartbeat" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.event).toBe("heartbeat");
  });

  test("heartbeat refreshes freshness without a publish-worthy transition", () => {
    const working = reduceAgentActivity(
      null,
      ev("prompt_submit", { at: "2026-06-11T10:00:00.000Z" }),
    );
    const block = reduceAgentActivity(
      working,
      ev("heartbeat", { at: "2026-06-11T10:00:30.000Z" }),
    );
    // Same reference → callers treat it as a non-transition (no publish).
    expect(block).toBe(working);
    expect(block?.state).toBe("working");
    expect(block?.lastEventAt).toBe("2026-06-11T10:00:30.000Z");
    // Transition timestamp stays at the last real transition.
    expect(block?.at).toBe("2026-06-11T10:00:00.000Z");
  });

  test("heartbeat without a prior block bootstraps a fresh working block", () => {
    // The in-memory block was lost to a daemon restart while the agent kept
    // working; the next tool execution (a heartbeat) re-establishes `working`.
    const block = reduceAgentActivity(
      null,
      ev("heartbeat", { at: "2026-06-11T10:00:30.000Z" }),
    );
    expect(block?.state).toBe("working");
    expect(block?.idleKind).toBeUndefined();
    expect(block?.lastEventAt).toBe("2026-06-11T10:00:30.000Z");
  });

  test("heartbeat after a reply resumes working and clears the question", () => {
    const awaiting = reduceAgentActivity(
      null,
      ev("question_asked", { severity: "needs-attention", summary: "Pick one" }),
    );
    expect(awaiting?.state).toBe("awaiting-input");
    const block = reduceAgentActivity(awaiting, ev("heartbeat"));
    // A real transition → a new block (publish-worthy), not the same ref.
    expect(block).not.toBe(awaiting);
    expect(block?.state).toBe("working");
    expect(block?.question).toBeUndefined();
  });

  test("every event refreshes lastEventAt", () => {
    const block = reduceAgentActivity(
      null,
      ev("prompt_submit", { at: "2026-06-11T11:22:33.000Z" }),
    );
    expect(block?.lastEventAt).toBe("2026-06-11T11:22:33.000Z");
  });
});

describe("reduceAgentActivity idle provenance", () => {
  function ev(kind: string, extra: Record<string, unknown> = {}) {
    const result = validateAgentActivityEvent(sampleEvent({ event: kind, ...extra }));
    if (!result.ok) throw new Error(result.error);
    return result.event as AgentActivityEvent;
  }

  /** Build the sweep-internal demotion event (skips schema validation). */
  function staleStop(extra: Record<string, unknown> = {}): AgentActivityEvent {
    return {
      v: 1,
      eventId: "stale-1",
      agent: "claude",
      event: STALE_DEMOTION_EVENT,
      agentSessionId: "",
      cwd: "",
      at: "2026-06-11T10:01:30.000Z",
      severity: "info",
      ...extra,
    } as AgentActivityEvent;
  }

  test("hook stop yields a hard, sticky idle that heartbeat does not resurrect", () => {
    const working = reduceAgentActivity(null, ev("prompt_submit"));
    const idle = reduceAgentActivity(working, ev("stop"));
    expect(idle?.state).toBe("idle");
    expect(idle?.idleKind).toBe("stop");
    const after = reduceAgentActivity(
      idle,
      ev("heartbeat", { at: "2026-06-11T10:05:00.000Z" }),
    );
    // Same reference → non-transition: stays a hook-stop idle, freshness only.
    expect(after).toBe(idle);
    expect(after?.state).toBe("idle");
    expect(after?.idleKind).toBe("stop");
    expect(after?.lastEventAt).toBe("2026-06-11T10:05:00.000Z");
  });

  test("staleness demotion yields a soft idle resurrected by a heartbeat", () => {
    const working = reduceAgentActivity(null, ev("prompt_submit"));
    const stale = reduceAgentActivity(working, staleStop());
    expect(stale?.state).toBe("idle");
    expect(stale?.idleKind).toBe("stale");
    const resumed = reduceAgentActivity(
      stale,
      ev("heartbeat", { at: "2026-06-11T10:06:00.000Z" }),
    );
    // A real transition → a new block (publish-worthy), provenance cleared.
    expect(resumed).not.toBe(stale);
    expect(resumed?.state).toBe("working");
    expect(resumed?.idleKind).toBeUndefined();
  });

  test("staleness demotion only applies to a working block", () => {
    const idle = reduceAgentActivity(
      reduceAgentActivity(null, ev("prompt_submit")),
      ev("stop"),
    );
    // A hook-stop idle is not re-demoted by the sweep's synthetic event.
    expect(reduceAgentActivity(idle, staleStop())).toBe(idle);
    expect(reduceAgentActivity(null, staleStop())).toBeNull();
  });

  test("entering working from any path clears the idle provenance", () => {
    const working = reduceAgentActivity(null, ev("prompt_submit"));
    const stale = reduceAgentActivity(working, staleStop());
    expect(stale?.idleKind).toBe("stale");
    // A fresh prompt resets provenance.
    const resumed = reduceAgentActivity(stale, ev("prompt_submit"));
    expect(resumed?.state).toBe("working");
    expect(resumed?.idleKind).toBeUndefined();
  });
});

describe("isAgentActivityStale", () => {
  const t0 = Date.parse("2026-06-11T10:00:00.000Z");
  const working = reduceAgentActivity(null, {
    v: 1,
    eventId: "e",
    agent: "claude",
    event: "prompt_submit",
    agentSessionId: "s",
    cwd: "/w",
    at: "2026-06-11T10:00:00.000Z",
    severity: "info",
  } as AgentActivityEvent)!;

  test("working block past the TTL is stale", () => {
    expect(
      isAgentActivityStale(working, t0 + DEFAULT_AGENT_ACTIVITY_TTL_MS + 1, DEFAULT_AGENT_ACTIVITY_TTL_MS),
    ).toBe(true);
  });

  test("working block within the TTL is fresh", () => {
    expect(
      isAgentActivityStale(working, t0 + DEFAULT_AGENT_ACTIVITY_TTL_MS - 1, DEFAULT_AGENT_ACTIVITY_TTL_MS),
    ).toBe(false);
  });

  test("idle and awaiting-input never go stale", () => {
    const idle = { ...working, state: "idle" as const };
    const awaiting = { ...working, state: "awaiting-input" as const };
    const farFuture = t0 + DEFAULT_AGENT_ACTIVITY_TTL_MS * 100;
    expect(isAgentActivityStale(idle, farFuture, DEFAULT_AGENT_ACTIVITY_TTL_MS)).toBe(false);
    expect(isAgentActivityStale(awaiting, farFuture, DEFAULT_AGENT_ACTIVITY_TTL_MS)).toBe(false);
  });

  test("null block is never stale", () => {
    expect(isAgentActivityStale(null, t0 + 1_000_000, DEFAULT_AGENT_ACTIVITY_TTL_MS)).toBe(false);
  });
});
