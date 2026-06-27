import { describe, expect, test } from "bun:test";
import {
  boardProjectOptions,
  buildBoardColumns,
  computeDropOrder,
  NO_STATUS_COLUMN_ID,
  orderBetween,
} from "../apps/web/src/lib/board";
import type {
  ProjectSummary,
  WorkflowStatusDto,
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
    status: "stopped",
    ...extra,
  };
}

function project(
  id: string,
  worktrees: WorktreeSummary[],
): ProjectSummary {
  return {
    id,
    displayName: id,
    sourcePath: `/src/${id}`,
    createdAt: "",
    lastSeenAt: "",
    colorSlot: 0,
    order: 0,
    stale: false,
    worktrees,
  };
}

const statuses: WorkflowStatusDto[] = [
  { id: "to-dev", name: "to dev", color: "#111111", order: 0 },
  { id: "review", name: "review", color: "#222222", order: 1 },
];

describe("orderBetween", () => {
  test("placements", () => {
    expect(orderBetween(undefined, undefined)).toBe(0);
    expect(orderBetween(undefined, 5)).toBe(4);
    expect(orderBetween(5, undefined)).toBe(6);
    expect(orderBetween(2, 4)).toBe(3);
  });
});

describe("buildBoardColumns", () => {
  test("leading No status column, then catalog order", () => {
    const cols = buildBoardColumns([], statuses);
    expect(cols.map((c) => c.id)).toEqual([
      NO_STATUS_COLUMN_ID,
      "to-dev",
      "review",
    ]);
    expect(cols[0]!.color).toBeUndefined();
    expect(cols[2]!.color).toBe("#222222");
  });

  test("places cards by assignment; unassigned and stale land in No status", () => {
    const projects = [
      project("alpha", [
        wt("/a/1", { workflowStatusId: "review", workflowOrder: 0 }),
        wt("/a/2"), // unassigned
        wt("/a/3", { workflowStatusId: "ghost", workflowOrder: 0 }), // stale id
      ]),
    ];
    const cols = buildBoardColumns(projects, statuses);
    const byId = new Map(cols.map((c) => [c.id, c]));
    expect(byId.get("review")!.cards.map((c) => c.worktree.path)).toEqual([
      "/a/1",
    ]);
    expect(
      byId.get(NO_STATUS_COLUMN_ID)!.cards.map((c) => c.worktree.path).sort(),
    ).toEqual(["/a/2", "/a/3"]);
  });

  test("sorts a column across projects by fractional order", () => {
    const projects = [
      project("alpha", [wt("/a/1", { workflowStatusId: "review", workflowOrder: 2 })]),
      project("beta", [wt("/b/1", { workflowStatusId: "review", workflowOrder: 1 })]),
    ];
    const cols = buildBoardColumns(projects, statuses);
    const review = cols.find((c) => c.id === "review")!;
    expect(review.cards.map((c) => c.worktree.path)).toEqual(["/b/1", "/a/1"]);
  });

  test("filters to a single project but keeps all columns", () => {
    const projects = [
      project("alpha", [wt("/a/1", { workflowStatusId: "review", workflowOrder: 0 })]),
      project("beta", [wt("/b/1", { workflowStatusId: "review", workflowOrder: 0 })]),
    ];
    const cols = buildBoardColumns(projects, statuses, "alpha");
    expect(cols).toHaveLength(3);
    const review = cols.find((c) => c.id === "review")!;
    expect(review.cards.map((c) => c.worktree.path)).toEqual(["/a/1"]);
  });
});

describe("computeDropOrder", () => {
  const cards = [
    { worktree: wt("/x/1", { workflowOrder: 0 }), projectId: "p", projectName: "p" },
    { worktree: wt("/x/2", { workflowOrder: 2 }), projectId: "p", projectName: "p" },
  ];
  test("between neighbors", () => {
    expect(computeDropOrder(cards, 1)).toBe(1);
  });
  test("at the head", () => {
    expect(computeDropOrder(cards, 0)).toBe(-1);
  });
  test("at the tail", () => {
    expect(computeDropOrder(cards, 2)).toBe(3);
  });
  test("empty column", () => {
    expect(computeDropOrder([], 0)).toBe(0);
  });
});

describe("boardProjectOptions", () => {
  test("lists only projects that have worktrees", () => {
    const projects = [
      project("alpha", [wt("/a/1")]),
      project("empty", []),
    ];
    expect(boardProjectOptions(projects)).toEqual([
      { id: "alpha", name: "alpha" },
    ]);
  });
});
