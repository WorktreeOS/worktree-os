import { describe, expect, test } from "bun:test";
import { buildWorktreeTreeNodes } from "./sidebar-tree";
import type { AgentActivityState, TerminalSessionMetadata } from "./terminal-protocol";
import type { WorktreeSummary } from "./ui-api";

function worktree(path: string, opts: Partial<WorktreeSummary> = {}): WorktreeSummary {
  return {
    path,
    detached: false,
    isSource: false,
    sessionName: path,
    status: "running",
    ...opts,
  };
}

interface SessionOpts {
  activity?: AgentActivityState;
  unreadSince?: string;
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
    createdAt: "2026-01-01T00:00:00Z",
    ...(opts.unreadSince ? { unreadSince: opts.unreadSince } : {}),
    ...(opts.activity
      ? {
          agentActivity: {
            state: opts.activity,
            agent: "claude",
            lastEvent: "x",
            at: "2026-01-01T00:00:00Z",
          },
        }
      : {}),
  };
}

function byPath(
  sessions: TerminalSessionMetadata[],
): Map<string, TerminalSessionMetadata[]> {
  const map = new Map<string, TerminalSessionMetadata[]>();
  for (const s of sessions) {
    const list = map.get(s.worktreePath) ?? [];
    list.push(s);
    map.set(s.worktreePath, list);
  }
  return map;
}

const NO_COLLAPSED = new Set<string>();

describe("buildWorktreeTreeNodes — open by default", () => {
  test("a worktree with a needsYou session is open by default", () => {
    const wt = worktree("/wt/a");
    const sessions = [session("s1", { activity: "awaiting-input", worktreePath: "/wt/a" })];
    const nodes = buildWorktreeTreeNodes({
      worktrees: [wt],
      sessionsByPath: byPath(sessions),
      filter: "all",
      activeWorktreePath: null,
      collapsedPaths: NO_COLLAPSED,
    });
    expect(nodes[0]!.isOpen).toBe(true);
  });

  test("a purely idle, non-active worktree is still open by default", () => {
    const wt = worktree("/wt/a");
    const sessions = [session("s1", { activity: "idle", worktreePath: "/wt/a" })];
    const nodes = buildWorktreeTreeNodes({
      worktrees: [wt],
      sessionsByPath: byPath(sessions),
      filter: "all",
      activeWorktreePath: null,
      collapsedPaths: NO_COLLAPSED,
    });
    expect(nodes[0]!.isOpen).toBe(true);
  });

  test("a worktree with no sessions at all is still open by default", () => {
    const wt = worktree("/wt/a", { status: "not_started" });
    const nodes = buildWorktreeTreeNodes({
      worktrees: [wt],
      sessionsByPath: new Map(),
      filter: "all",
      activeWorktreePath: null,
      collapsedPaths: NO_COLLAPSED,
    });
    expect(nodes[0]!.isOpen).toBe(true);
  });
});

describe("buildWorktreeTreeNodes — manual collapse", () => {
  test("a manually collapsed worktree stays collapsed regardless of attention (sticky, matches demo)", () => {
    const wt = worktree("/wt/a");
    const sessions = [session("s1", { activity: "awaiting-input", worktreePath: "/wt/a" })];
    const nodes = buildWorktreeTreeNodes({
      worktrees: [wt],
      sessionsByPath: byPath(sessions),
      filter: "all",
      activeWorktreePath: null,
      collapsedPaths: new Set(["/wt/a"]),
    });
    expect(nodes[0]!.isOpen).toBe(false);
  });

  test("a manually collapsed worktree stays collapsed even when it's the active one", () => {
    const wt = worktree("/wt/a");
    const nodes = buildWorktreeTreeNodes({
      worktrees: [wt],
      sessionsByPath: new Map(),
      filter: "all",
      activeWorktreePath: "/wt/a",
      collapsedPaths: new Set(["/wt/a"]),
    });
    expect(nodes[0]!.isOpen).toBe(false);
  });

  test("removing a path from collapsedPaths reopens it (back to the open default)", () => {
    const wt = worktree("/wt/a");
    const nodes = buildWorktreeTreeNodes({
      worktrees: [wt],
      sessionsByPath: new Map(),
      filter: "all",
      activeWorktreePath: null,
      collapsedPaths: new Set(["/wt/b"]), // a different path collapsed, not this one
    });
    expect(nodes[0]!.isOpen).toBe(true);
  });
});

describe("buildWorktreeTreeNodes — filtering", () => {
  const wtA = worktree("/wt/a");
  const wtB = worktree("/wt/b"); // no sessions at all (e.g. stopped)
  const sessions = [
    session("needsYou", { activity: "awaiting-input", worktreePath: "/wt/a" }),
    session("working", { activity: "working", worktreePath: "/wt/a" }),
  ];

  test("filter 'all' includes every worktree with its full session set", () => {
    const nodes = buildWorktreeTreeNodes({
      worktrees: [wtA, wtB],
      sessionsByPath: byPath(sessions),
      filter: "all",
      activeWorktreePath: null,
      collapsedPaths: NO_COLLAPSED,
    });
    expect(nodes.map((n) => n.key)).toEqual(["/wt/a", "/wt/b"]);
    expect(nodes[0]!.sessions).toHaveLength(2);
    expect(nodes[1]!.sessions).toHaveLength(0);
  });

  test("a non-'all' filter narrows sessions and drops non-matching worktrees", () => {
    const nodes = buildWorktreeTreeNodes({
      worktrees: [wtA, wtB],
      sessionsByPath: byPath(sessions),
      filter: "working",
      activeWorktreePath: null,
      collapsedPaths: NO_COLLAPSED,
    });
    // wtB has zero sessions and filter isn't 'idle' → dropped entirely.
    expect(nodes.map((n) => n.key)).toEqual(["/wt/a"]);
    expect(nodes[0]!.sessions.map((n) => n.session.id)).toEqual(["working"]);
  });

  test("filter 'idle' keeps a worktree with zero sessions (shows as empty)", () => {
    const nodes = buildWorktreeTreeNodes({
      worktrees: [wtA, wtB],
      sessionsByPath: byPath(sessions),
      filter: "idle",
      activeWorktreePath: null,
      collapsedPaths: NO_COLLAPSED,
    });
    // wtA has no idle sessions → dropped; wtB has none at all → kept, empty.
    expect(nodes.map((n) => n.key)).toEqual(["/wt/b"]);
    expect(nodes[0]!.sessions).toHaveLength(0);
  });

  test("filter 'needsYou' keeps only the matching session", () => {
    const nodes = buildWorktreeTreeNodes({
      worktrees: [wtA, wtB],
      sessionsByPath: byPath(sessions),
      filter: "needsYou",
      activeWorktreePath: null,
      collapsedPaths: NO_COLLAPSED,
    });
    expect(nodes.map((n) => n.key)).toEqual(["/wt/a"]);
    expect(nodes[0]!.sessions.map((n) => n.session.id)).toEqual(["needsYou"]);
  });
});

describe("buildWorktreeTreeNodes — session ordering and tagging", () => {
  test("sessions come back tagged with their attention category, ordered needsYou > unread > working > idle", () => {
    const wt = worktree("/wt/a");
    const sessions = [
      session("idle1", { activity: "idle", worktreePath: "/wt/a" }),
      session("working1", { activity: "working", worktreePath: "/wt/a" }),
      session("unread1", { unreadSince: "2026-01-01T00:00:00Z", worktreePath: "/wt/a" }),
      session("needsYou1", { activity: "awaiting-input", worktreePath: "/wt/a" }),
    ];
    const nodes = buildWorktreeTreeNodes({
      worktrees: [wt],
      sessionsByPath: byPath(sessions),
      filter: "all",
      activeWorktreePath: null,
      collapsedPaths: NO_COLLAPSED,
    });
    expect(nodes[0]!.sessions.map((n) => [n.session.id, n.attention])).toEqual([
      ["needsYou1", "needsYou"],
      ["unread1", "unread"],
      ["working1", "working"],
      ["idle1", "idle"],
    ]);
  });
});

describe("buildWorktreeTreeNodes — no worktrees", () => {
  test("returns an empty array for no worktrees", () => {
    expect(
      buildWorktreeTreeNodes({
        worktrees: [],
        sessionsByPath: new Map(),
        filter: "all",
        activeWorktreePath: null,
        collapsedPaths: NO_COLLAPSED,
      }),
    ).toEqual([]);
  });
});
