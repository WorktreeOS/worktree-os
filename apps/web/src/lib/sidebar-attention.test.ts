import { describe, expect, test } from "bun:test";
import {
  classifySessionAttention,
  groupSessionsByAttention,
  orderSessionsForTreeNode,
  type StreamOrderKey,
} from "./sidebar-attention";
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
  worktreePath?: string;
}

function session(id: string, opts: SessionOpts = {}): TerminalSessionMetadata {
  return {
    id,
    worktreePath: opts.worktreePath ?? `/wt/${id}`,
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

describe("groupSessionsByAttention — band-order clustering", () => {
  // Band order: project 0 owns worktrees wA (rank 0) and wB (rank 1);
  // project 1 owns wC (rank 0). Unknown paths sink to the bottom.
  const RANKS: Record<string, StreamOrderKey> = {
    "/p0/wA": { project: 0, worktree: 0 },
    "/p0/wB": { project: 0, worktree: 1 },
    "/p1/wC": { project: 1, worktree: 0 },
  };
  const orderKey = (s: { worktreePath: string }): StreamOrderKey =>
    RANKS[s.worktreePath] ?? { project: 1e9, worktree: 1e9 };

  test("clusters by project then worktree; recency breaks ties inside a worktree", () => {
    const { groups } = groupSessionsByAttention(
      [
        session("b1", { activity: "working", worktreePath: "/p0/wB", telemetryUpdatedAt: "2026-01-01T10:00:00Z" }),
        session("a-old", { activity: "working", worktreePath: "/p0/wA", telemetryUpdatedAt: "2026-01-01T08:00:00Z" }),
        session("c1", { activity: "working", worktreePath: "/p1/wC", telemetryUpdatedAt: "2026-01-01T11:00:00Z" }),
        session("a-new", { activity: "working", worktreePath: "/p0/wA", telemetryUpdatedAt: "2026-01-01T09:00:00Z" }),
      ],
      orderKey,
    );
    // p0/wA (newer→older), then p0/wB, then p1/wC — independent of recency
    // across clusters; only within wA does recency order the two sessions.
    expect(groups.working.map((s) => s.id)).toEqual([
      "a-new",
      "a-old",
      "b1",
      "c1",
    ]);
  });

  test("unknown worktree paths sink to the bottom of their group", () => {
    const { groups } = groupSessionsByAttention(
      [
        session("ghost", { activity: "working", worktreePath: "/gone" }),
        session("known", { activity: "working", worktreePath: "/p0/wA" }),
      ],
      orderKey,
    );
    expect(groups.working.map((s) => s.id)).toEqual(["known", "ghost"]);
  });

  test("clustering holds across attention groups (same relative order)", () => {
    const { groups } = groupSessionsByAttention(
      [
        session("idleC", { activity: "idle", worktreePath: "/p1/wC" }),
        session("idleA", { activity: "idle", worktreePath: "/p0/wA" }),
      ],
      orderKey,
    );
    expect(groups.idle.map((s) => s.id)).toEqual(["idleA", "idleC"]);
  });
});

describe("classifySessionAttention — direct precedence", () => {
  test("awaiting-input → needsYou", () => {
    expect(classifySessionAttention(session("a", { activity: "awaiting-input" }))).toBe(
      "needsYou",
    );
  });

  test("awaiting-input outranks unread", () => {
    expect(
      classifySessionAttention(
        session("a", { activity: "awaiting-input", unreadSince: "2026-01-01T00:00:00Z" }),
      ),
    ).toBe("needsYou");
  });

  test("unread (not awaiting) → unread", () => {
    expect(
      classifySessionAttention(session("a", { unreadSince: "2026-01-01T00:00:00Z" })),
    ).toBe("unread");
  });

  test("working (no unread) → working", () => {
    expect(classifySessionAttention(session("a", { activity: "working" }))).toBe(
      "working",
    );
  });

  test("idle / plain shell → idle", () => {
    expect(classifySessionAttention(session("a", { activity: "idle" }))).toBe("idle");
    expect(classifySessionAttention(session("a"))).toBe("idle");
  });
});

describe("orderSessionsForTreeNode", () => {
  test("orders needsYou, unread, working, idle in that order", () => {
    const ordered = orderSessionsForTreeNode([
      session("idle1", { activity: "idle" }),
      session("working1", { activity: "working" }),
      session("unread1", { unreadSince: "2026-01-01T00:00:00Z" }),
      session("needsYou1", { activity: "awaiting-input" }),
    ]);
    expect(ordered.map((s) => s.id)).toEqual([
      "needsYou1",
      "unread1",
      "working1",
      "idle1",
    ]);
  });

  test("within a group, falls back to that group's own comparator", () => {
    const ordered = orderSessionsForTreeNode([
      session("new", { activity: "awaiting-input", askedAt: "2026-01-01T10:00:00Z" }),
      session("old", { activity: "awaiting-input", askedAt: "2026-01-01T08:00:00Z" }),
    ]);
    expect(ordered.map((s) => s.id)).toEqual(["old", "new"]);
  });

  test("empty input yields an empty array", () => {
    expect(orderSessionsForTreeNode([])).toEqual([]);
  });
});
