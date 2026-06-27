import { describe, expect, test } from "bun:test";
import {
  buildSwitcherRows,
  groupSwitcherRows,
  searchSwitcherRows,
  switcherRowRank,
} from "../apps/web/src/lib/worktree-switcher";
import type {
  DeploymentStatus,
  ProjectSummary,
  WorktreeSummary,
} from "../apps/web/src/lib/ui-api";

function wt(
  path: string,
  extra: Partial<WorktreeSummary> = {},
): WorktreeSummary {
  return {
    path,
    detached: false,
    isSource: false,
    sessionName: path,
    status: "stopped" as DeploymentStatus,
    ...extra,
  };
}

function project(
  id: string,
  displayName: string,
  worktrees: WorktreeSummary[],
): ProjectSummary {
  return {
    id,
    displayName,
    sourcePath: `/src/${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    colorSlot: 0,
    order: 0,
    stale: false,
    worktrees,
  };
}

const projects: ProjectSummary[] = [
  project("alpha", "Alpha App", [
    wt("/alpha/main", { branch: "main", isSource: true, status: "running" }),
    wt("/alpha/feature", { branch: "feature/login", note: "wip auth" }),
    wt("/alpha/bugfix", { branch: "bugfix/crash", status: "failed" }),
  ]),
  project("beta", "Beta Service", [
    wt("/beta/main", { branch: "develop", displayName: "Beta develop" }),
    wt("/beta/exp", { branch: "experiment" }),
  ]),
];

const noTerminals = new Map<string, number>();

describe("buildSwitcherRows", () => {
  test("flattens every worktree across projects with metadata", () => {
    const rows = buildSwitcherRows(projects, {
      currentPath: "/alpha/feature",
      pinnedPaths: new Set(),
      terminalCounts: noTerminals,
    });
    expect(rows.map((r) => r.path)).toEqual([
      "/alpha/main",
      "/alpha/feature",
      "/alpha/bugfix",
      "/beta/main",
      "/beta/exp",
    ]);
    const feature = rows.find((r) => r.path === "/alpha/feature")!;
    expect(feature.projectName).toBe("Alpha App");
    expect(feature.label).toBe("feature/login");
    expect(feature.isCurrent).toBe(true);
    expect(feature.isCurrentProject).toBe(true);
  });

  test("prefers display name for the row label", () => {
    const rows = buildSwitcherRows(projects, {
      currentPath: null,
      pinnedPaths: new Set(),
      terminalCounts: noTerminals,
    });
    expect(rows.find((r) => r.path === "/beta/main")!.label).toBe(
      "Beta develop",
    );
  });

  test("derives current project from the current path", () => {
    const rows = buildSwitcherRows(projects, {
      currentPath: "/beta/exp",
      pinnedPaths: new Set(),
      terminalCounts: noTerminals,
    });
    const currentProjectPaths = rows
      .filter((r) => r.isCurrentProject)
      .map((r) => r.path);
    expect(currentProjectPaths).toEqual(["/beta/main", "/beta/exp"]);
  });

  test("no current path means no current or current-project rows", () => {
    const rows = buildSwitcherRows(projects, {
      currentPath: null,
      pinnedPaths: new Set(),
      terminalCounts: noTerminals,
    });
    expect(rows.some((r) => r.isCurrent)).toBe(false);
    expect(rows.some((r) => r.isCurrentProject)).toBe(false);
  });

  test("marks deployment-running and terminal-active worktrees as active", () => {
    const rows = buildSwitcherRows(projects, {
      currentPath: "/alpha/main",
      pinnedPaths: new Set(),
      terminalCounts: new Map<string, number>([["/beta/exp", 2]]),
    });
    expect(rows.find((r) => r.path === "/alpha/main")!.isActive).toBe(true);
    const betaExp = rows.find((r) => r.path === "/beta/exp")!;
    expect(betaExp.isActive).toBe(true);
    expect(betaExp.terminalCount).toBe(2);
    expect(rows.find((r) => r.path === "/alpha/bugfix")!.isActive).toBe(false);
  });

  test("marks pinned worktrees from the pinned set", () => {
    const rows = buildSwitcherRows(projects, {
      currentPath: null,
      pinnedPaths: new Set(["/beta/main"]),
      terminalCounts: noTerminals,
    });
    expect(rows.find((r) => r.path === "/beta/main")!.isPinned).toBe(true);
    expect(rows.find((r) => r.path === "/beta/exp")!.isPinned).toBe(false);
  });
});

describe("switcherRowRank", () => {
  test("active outranks pinned outranks current-project outranks other", () => {
    const rows = buildSwitcherRows(projects, {
      currentPath: "/alpha/feature",
      pinnedPaths: new Set(["/beta/main"]),
      terminalCounts: new Map<string, number>([["/beta/exp", 1]]),
    });
    const byPath = (p: string) => rows.find((r) => r.path === p)!;
    expect(switcherRowRank(byPath("/alpha/main"))).toBe(0); // running
    expect(switcherRowRank(byPath("/beta/exp"))).toBe(0); // terminal-active
    expect(switcherRowRank(byPath("/beta/main"))).toBe(1); // pinned
    expect(switcherRowRank(byPath("/alpha/feature"))).toBe(2); // current project
    expect(switcherRowRank(byPath("/alpha/bugfix"))).toBe(2); // current project
  });

  test("active wins even when the worktree is also pinned", () => {
    const rows = buildSwitcherRows(projects, {
      currentPath: null,
      pinnedPaths: new Set(["/alpha/main"]),
      terminalCounts: noTerminals,
    });
    // /alpha/main is running AND pinned → active bucket.
    expect(switcherRowRank(rows.find((r) => r.path === "/alpha/main")!)).toBe(0);
  });
});

describe("groupSwitcherRows", () => {
  test("assigns each worktree to exactly one group by priority", () => {
    const rows = buildSwitcherRows(projects, {
      currentPath: "/alpha/feature",
      pinnedPaths: new Set(["/beta/main"]),
      terminalCounts: new Map<string, number>([["/beta/exp", 1]]),
    });
    const groups = groupSwitcherRows(rows);
    expect(groups.active.map((r) => r.path)).toEqual([
      "/alpha/main",
      "/beta/exp",
    ]);
    expect(groups.pinned.map((r) => r.path)).toEqual(["/beta/main"]);
    // Sorted source-first then by label: "bugfix/crash" < "feature/login".
    expect(groups.currentProject.map((r) => r.path)).toEqual([
      "/alpha/bugfix",
      "/alpha/feature",
    ]);
    expect(groups.others).toEqual([]);

    // No worktree appears in more than one group.
    const seen = [
      ...groups.active,
      ...groups.pinned,
      ...groups.currentProject,
      ...groups.others,
    ].map((r) => r.path);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(rows.length);
  });

  test("active group sorts the source worktree first", () => {
    const rows = buildSwitcherRows(projects, {
      currentPath: null,
      pinnedPaths: new Set(),
      terminalCounts: new Map<string, number>([
        ["/alpha/feature", 1],
        ["/alpha/main", 1],
      ]),
    });
    const groups = groupSwitcherRows(rows);
    expect(groups.active.map((r) => r.path)).toEqual([
      "/alpha/main",
      "/alpha/feature",
    ]);
  });

  test("non-active, non-pinned worktrees outside the current project fall to others", () => {
    const rows = buildSwitcherRows(projects, {
      currentPath: "/alpha/feature",
      pinnedPaths: new Set(),
      terminalCounts: noTerminals,
    });
    const groups = groupSwitcherRows(rows);
    // /alpha/main is running → active, the two beta worktrees → others.
    expect(groups.active.map((r) => r.path)).toEqual(["/alpha/main"]);
    expect(groups.others.map((r) => r.path)).toEqual([
      "/beta/main",
      "/beta/exp",
    ]);
  });
});

describe("searchSwitcherRows", () => {
  const rows = buildSwitcherRows(projects, {
    currentPath: "/alpha/feature",
    pinnedPaths: new Set(),
    terminalCounts: noTerminals,
  });

  test("blank query returns null so callers render the grouped view", () => {
    expect(searchSwitcherRows(rows, "")).toBeNull();
    expect(searchSwitcherRows(rows, "   ")).toBeNull();
  });

  test("matches on branch name", () => {
    const result = searchSwitcherRows(rows, "experiment")!;
    expect(result.map((r) => r.path)).toEqual(["/beta/exp"]);
  });

  test("matches on display name", () => {
    const result = searchSwitcherRows(rows, "Beta develop")!;
    expect(result.map((r) => r.path)).toEqual(["/beta/main"]);
  });

  test("matches on note text", () => {
    const result = searchSwitcherRows(rows, "wip auth")!;
    expect(result.map((r) => r.path)).toEqual(["/alpha/feature"]);
  });

  test("matches on project name", () => {
    const result = searchSwitcherRows(rows, "beta")!;
    expect(result.map((r) => r.path)).toEqual(["/beta/main", "/beta/exp"]);
  });

  test("matches on path", () => {
    const result = searchSwitcherRows(rows, "/alpha/bugfix")!;
    expect(result.map((r) => r.path)).toEqual(["/alpha/bugfix"]);
  });

  test("orders results by switcher priority, active first", () => {
    // All alpha worktrees match "alpha" by path; /alpha/main is running.
    const result = searchSwitcherRows(rows, "/alpha/")!;
    expect(result[0]!.path).toBe("/alpha/main"); // active ranks first
    expect(result.map((r) => r.path)).toEqual([
      "/alpha/main",
      "/alpha/bugfix",
      "/alpha/feature",
    ]);
  });

  test("is case-insensitive", () => {
    const result = searchSwitcherRows(rows, "FEATURE/LOGIN")!;
    expect(result.map((r) => r.path)).toEqual(["/alpha/feature"]);
  });
});
