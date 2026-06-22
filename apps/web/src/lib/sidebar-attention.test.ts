import { describe, expect, test } from "bun:test";
import { groupSessionsByAttention } from "./sidebar-attention";
import type {
  AgentActivityState,
  TerminalSessionMetadata,
} from "./terminal-protocol";

interface SessionOpts {
  activity?: AgentActivityState;
  at?: string;
  askedAt?: string;
  unreadSince?: string;
  telemetryUpdatedAt?: string;
  createdAt?: string;
}

function session(id: string, opts: SessionOpts = {}): TerminalSessionMetadata {
  return {
    id,
    worktreePath: `/wt/${id}`,
    status: "running",
    shell: "zsh",
    cwd: `/wt/${id}`,
    cols: 80,
    rows: 24,
    createdAt: opts.createdAt ?? "2026-01-01T00:00:00Z",
    ...(opts.unreadSince ? { unreadSince: opts.unreadSince } : {}),
    ...(opts.activity
      ? {
          agentActivity: {
            state: opts.activity,
            agent: "claude",
            lastEvent: "x",
            at: opts.at ?? "2026-01-01T00:00:00Z",
            ...(opts.askedAt
              ? { question: { summary: "permission?", askedAt: opts.askedAt } }
              : {}),
          },
        }
      : {}),
    ...(opts.telemetryUpdatedAt
      ? {
          agentTelemetry: {
            mainTokens: 1000,
            subagentTokens: 0,
            contextUsed: 1000,
            contextWindow: 200_000,
            updatedAt: opts.telemetryUpdatedAt,
          },
        }
      : {}),
  };
}

describe("groupSessionsByAttention — classification precedence", () => {
  test("awaiting-input → Needs you", () => {
    const { groups } = groupSessionsByAttention([
      session("a", { activity: "awaiting-input" }),
    ]);
    expect(groups.needsYou.map((s) => s.id)).toEqual(["a"]);
    expect(groups.unread).toHaveLength(0);
  });

  test("a blocked agent outranks its unread output", () => {
    const { groups } = groupSessionsByAttention([
      session("a", { activity: "awaiting-input", unreadSince: "2026-01-01T00:00:00Z" }),
    ]);
    expect(groups.needsYou.map((s) => s.id)).toEqual(["a"]);
    expect(groups.unread).toHaveLength(0);
  });

  test("unread (not awaiting) → Unread", () => {
    const { groups } = groupSessionsByAttention([
      session("a", { activity: "working", unreadSince: "2026-01-01T00:00:00Z" }),
    ]);
    expect(groups.unread.map((s) => s.id)).toEqual(["a"]);
    expect(groups.working).toHaveLength(0);
  });

  test("working (no unread) → Working", () => {
    const { groups } = groupSessionsByAttention([
      session("a", { activity: "working" }),
    ]);
    expect(groups.working.map((s) => s.id)).toEqual(["a"]);
  });

  test("idle agent → Idle", () => {
    const { groups } = groupSessionsByAttention([
      session("a", { activity: "idle" }),
    ]);
    expect(groups.idle.map((s) => s.id)).toEqual(["a"]);
  });

  test("plain shell (no activity, no unread) → Idle", () => {
    const { groups } = groupSessionsByAttention([session("a")]);
    expect(groups.idle.map((s) => s.id)).toEqual(["a"]);
  });

  test("empty input yields empty groups and zero counts", () => {
    const { groups, counts } = groupSessionsByAttention([]);
    expect(groups).toEqual({ needsYou: [], unread: [], working: [], idle: [] });
    expect(counts).toEqual({
      needsYou: 0,
      unread: 0,
      working: 0,
      idle: 0,
      total: 0,
    });
  });

  test("counts reflect every group and the total", () => {
    const { counts } = groupSessionsByAttention([
      session("a", { activity: "awaiting-input" }),
      session("b", { unreadSince: "2026-01-01T00:00:00Z" }),
      session("c", { activity: "working" }),
      session("d", { activity: "working" }),
      session("e"),
    ]);
    expect(counts).toEqual({
      needsYou: 1,
      unread: 1,
      working: 2,
      idle: 1,
      total: 5,
    });
  });
});

describe("groupSessionsByAttention — within-group ordering", () => {
  test("Needs you — oldest wait first (askedAt ascending)", () => {
    const { groups } = groupSessionsByAttention([
      session("new", { activity: "awaiting-input", askedAt: "2026-01-01T10:00:00Z" }),
      session("old", { activity: "awaiting-input", askedAt: "2026-01-01T08:00:00Z" }),
      session("mid", { activity: "awaiting-input", askedAt: "2026-01-01T09:00:00Z" }),
    ]);
    expect(groups.needsYou.map((s) => s.id)).toEqual(["old", "mid", "new"]);
  });

  test("Needs you — falls back to activity timestamp when no askedAt", () => {
    const { groups } = groupSessionsByAttention([
      session("late", { activity: "awaiting-input", at: "2026-01-01T10:00:00Z" }),
      session("early", { activity: "awaiting-input", at: "2026-01-01T08:00:00Z" }),
    ]);
    expect(groups.needsYou.map((s) => s.id)).toEqual(["early", "late"]);
  });

  test("Unread — most recent output first (unreadSince descending)", () => {
    const { groups } = groupSessionsByAttention([
      session("older", { unreadSince: "2026-01-01T08:00:00Z" }),
      session("newer", { unreadSince: "2026-01-01T10:00:00Z" }),
      session("mid", { unreadSince: "2026-01-01T09:00:00Z" }),
    ]);
    expect(groups.unread.map((s) => s.id)).toEqual(["newer", "mid", "older"]);
  });

  test("Working — most recently active first (telemetry > activity > createdAt)", () => {
    const { groups } = groupSessionsByAttention([
      session("stale", { activity: "working", telemetryUpdatedAt: "2026-01-01T08:00:00Z" }),
      session("fresh", { activity: "working", telemetryUpdatedAt: "2026-01-01T10:00:00Z" }),
    ]);
    expect(groups.working.map((s) => s.id)).toEqual(["fresh", "stale"]);
  });

  test("Idle — recency falls back to createdAt when no telemetry/activity", () => {
    const { groups } = groupSessionsByAttention([
      session("first", { createdAt: "2026-01-01T08:00:00Z" }),
      session("last", { createdAt: "2026-01-01T10:00:00Z" }),
    ]);
    expect(groups.idle.map((s) => s.id)).toEqual(["last", "first"]);
  });
});
