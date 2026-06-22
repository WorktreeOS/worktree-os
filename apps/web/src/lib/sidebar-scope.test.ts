import { describe, expect, test } from "bun:test";
import {
  activeScopeSummary,
  activeScopeSummaryText,
  groupActiveWorktrees,
} from "./sidebar-scope";
import type {
  DeploymentStatus,
  ProjectSummary,
  WorktreeSummary,
} from "./ui-api";

function wt(path: string, status: DeploymentStatus): WorktreeSummary {
  return {
    path,
    detached: false,
    isSource: false,
    sessionName: path,
    status,
  };
}

function project(
  id: string,
  worktrees: WorktreeSummary[],
): ProjectSummary {
  return {
    id,
    displayName: id,
    sourcePath: `/repo/${id}`,
    createdAt: "2026-01-01T00:00:00Z",
    lastSeenAt: "2026-01-01T00:00:00Z",
    stale: false,
    worktrees,
  };
}

describe("groupActiveWorktrees", () => {
  const projects = [
    project("acme-shop", [
      wt("/a/failed", "failed"),
      wt("/a/running", "running"),
      wt("/a/partial", "running_partial"),
      wt("/a/stopped", "stopped"),
      wt("/a/terminal-only", "not_started"),
    ]),
    project("ml-pipelines", [
      wt("/b/running", "running"),
      wt("/b/idle", "not_started"),
    ]),
    project("internal-tools", [
      wt("/c/stopped", "stopped"),
      wt("/c/idle", "not_started"),
    ]),
  ];

  test("keeps running / partial / terminal-bearing worktrees, grouped by project", () => {
    const counts = new Map([["/a/terminal-only", 2]]);
    const groups = groupActiveWorktrees(projects, counts);
    expect(groups.map((g) => g.project.id)).toEqual([
      "acme-shop",
      "ml-pipelines",
    ]);
    expect(groups[0]!.worktrees.map((w) => w.path)).toEqual([
      "/a/running",
      "/a/partial",
      "/a/terminal-only",
    ]);
    expect(groups[1]!.worktrees.map((w) => w.path)).toEqual(["/b/running"]);
  });

  test("a fully idle project disappears", () => {
    const groups = groupActiveWorktrees(projects, new Map());
    expect(groups.some((g) => g.project.id === "internal-tools")).toBe(false);
  });

  test("a terminal session alone makes a stopped worktree active", () => {
    const counts = new Map([["/c/stopped", 1]]);
    const groups = groupActiveWorktrees(
      [projects[2]!],
      counts,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.worktrees.map((w) => w.path)).toEqual(["/c/stopped"]);
  });

  test("nothing running yields no groups", () => {
    expect(groupActiveWorktrees([projects[2]!], new Map())).toEqual([]);
  });
});

describe("activeScopeSummary", () => {
  test("counts worktrees and projects across groups", () => {
    const groups = groupActiveWorktrees(
      [
        project("a", [wt("/a/1", "running"), wt("/a/2", "running_partial")]),
        project("b", [wt("/b/1", "running")]),
      ],
      new Map(),
    );
    expect(activeScopeSummary(groups)).toEqual({ worktrees: 3, projects: 2 });
  });

  test("summary text pluralises and handles empty", () => {
    expect(activeScopeSummaryText({ worktrees: 0, projects: 0 })).toBe(
      "nothing running",
    );
    expect(activeScopeSummaryText({ worktrees: 1, projects: 1 })).toBe(
      "1 live worktree · 1 project",
    );
    expect(activeScopeSummaryText({ worktrees: 4, projects: 2 })).toBe(
      "4 live worktrees · 2 projects",
    );
  });
});
