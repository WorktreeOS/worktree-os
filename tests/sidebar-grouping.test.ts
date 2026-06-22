import { describe, expect, test } from "bun:test";
import {
  branchExpandable,
  getTerminalCountForPath,
  isDeploymentRunning,
  isSidebarRunningWorktree,
  worktreeHasRuntime,
} from "../apps/web/src/lib/sidebar-grouping";
import type { DeploymentStatus, WorktreeSummary } from "../apps/web/src/lib/ui-api";

function wt(
  path: string,
  status: DeploymentStatus,
  extra: Partial<WorktreeSummary> = {},
): WorktreeSummary {
  return {
    path,
    detached: false,
    isSource: false,
    sessionName: path,
    status,
    ...extra,
  };
}

describe("isDeploymentRunning", () => {
  test("returns true for running and running_partial", () => {
    expect(isDeploymentRunning("running")).toBe(true);
    expect(isDeploymentRunning("running_partial")).toBe(true);
  });

  test("returns false for every other deployment state", () => {
    const others: DeploymentStatus[] = [
      "pending",
      "checking",
      "stopping",
      "stopped",
      "failed",
      "not_started",
      "unknown",
    ];
    for (const s of others) expect(isDeploymentRunning(s)).toBe(false);
  });
});

describe("getTerminalCountForPath", () => {
  test("returns 0 for unknown paths", () => {
    expect(getTerminalCountForPath(new Map(), "/missing")).toBe(0);
  });

  test("returns the live count when present", () => {
    const counts = new Map<string, number>([["/a", 2]]);
    expect(getTerminalCountForPath(counts, "/a")).toBe(2);
  });
});

describe("isSidebarRunningWorktree", () => {
  const empty = new Map<string, number>();

  test("running deployment counts as active even without terminals", () => {
    expect(isSidebarRunningWorktree(wt("/a", "running"), empty)).toBe(true);
  });

  test("running_partial deployment counts as active even without terminals", () => {
    expect(isSidebarRunningWorktree(wt("/a", "running_partial"), empty)).toBe(
      true,
    );
  });

  test("stopped worktree with a live terminal counts as active", () => {
    const counts = new Map<string, number>([["/a", 1]]);
    expect(isSidebarRunningWorktree(wt("/a", "stopped"), counts)).toBe(true);
  });

  test("not_started worktree with a live terminal counts as active", () => {
    const counts = new Map<string, number>([["/a", 3]]);
    expect(isSidebarRunningWorktree(wt("/a", "not_started"), counts)).toBe(
      true,
    );
  });

  test("stopped worktree with zero terminals is not active", () => {
    expect(isSidebarRunningWorktree(wt("/a", "stopped"), empty)).toBe(false);
  });

  test("failed worktree with zero terminals is not active", () => {
    expect(isSidebarRunningWorktree(wt("/a", "failed"), empty)).toBe(false);
  });

  test("a count entry of zero is not enough to promote", () => {
    const counts = new Map<string, number>([["/a", 0]]);
    expect(isSidebarRunningWorktree(wt("/a", "stopped"), counts)).toBe(false);
  });

  test("terminal removal demotes a stopped worktree on the next snapshot", () => {
    const stopped = wt("/a", "stopped");
    const before = new Map<string, number>([["/a", 1]]);
    expect(isSidebarRunningWorktree(stopped, before)).toBe(true);
    const after = new Map<string, number>();
    expect(isSidebarRunningWorktree(stopped, after)).toBe(false);
  });
});

describe("worktreeHasRuntime", () => {
  test("is true for any deployed / failed state", () => {
    const live: DeploymentStatus[] = [
      "pending",
      "checking",
      "running",
      "running_partial",
      "stopping",
      "failed",
    ];
    for (const s of live) expect(worktreeHasRuntime(s)).toBe(true);
  });

  test("is false for never-started, fully-stopped, and unknown", () => {
    expect(worktreeHasRuntime("not_started")).toBe(false);
    expect(worktreeHasRuntime("stopped")).toBe(false);
    expect(worktreeHasRuntime("unknown")).toBe(false);
  });
});

describe("branchExpandable", () => {
  test("a running branch is expandable even with no sessions", () => {
    expect(branchExpandable("running", 0)).toBe(true);
  });

  test("a failed branch is expandable (its Runtime line needs eyes)", () => {
    expect(branchExpandable("failed", 0)).toBe(true);
  });

  test("a stopped branch with no sessions is not expandable", () => {
    expect(branchExpandable("stopped", 0)).toBe(false);
    expect(branchExpandable("not_started", 0)).toBe(false);
  });

  test("a stopped branch with a live session is expandable to reach it", () => {
    expect(branchExpandable("stopped", 1)).toBe(true);
    expect(branchExpandable("not_started", 2)).toBe(true);
  });
});
