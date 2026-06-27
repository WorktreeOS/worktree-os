import { describe, expect, test } from "bun:test";
import {
  projectOwningPath,
  projectRunningCount,
  resolveActiveProjectId,
} from "../apps/web/src/lib/sidebar-active-project";
import type {
  DeploymentStatus,
  ProjectSummary,
  WorktreeSummary,
} from "../apps/web/src/lib/ui-api";

function wt(
  path: string,
  status: DeploymentStatus = "stopped",
): WorktreeSummary {
  return {
    path,
    detached: false,
    isSource: false,
    sessionName: path,
    status,
  };
}

function project(id: string, worktrees: WorktreeSummary[]): ProjectSummary {
  return {
    id,
    displayName: id,
    sourcePath: `/src/${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    colorSlot: 0,
    order: 0,
    stale: false,
    worktrees,
  };
}

const acme = project("acme", [
  wt("/acme/main", "running"),
  wt("/acme/feature", "running_partial"),
  wt("/acme/idle", "stopped"),
]);
const ml = project("ml", [wt("/ml/exp", "stopped")]);
const projects = [acme, ml];

describe("resolveActiveProjectId", () => {
  test("prefers a valid persisted selection", () => {
    expect(
      resolveActiveProjectId({
        persistedId: "ml",
        activePath: "/acme/main",
        projects,
      }),
    ).toBe("ml");
  });

  test("falls back to the project owning the active worktree", () => {
    expect(
      resolveActiveProjectId({
        persistedId: null,
        activePath: "/ml/exp",
        projects,
      }),
    ).toBe("ml");
  });

  test("ignores a stale persisted id and uses the owning project", () => {
    expect(
      resolveActiveProjectId({
        persistedId: "gone",
        activePath: "/acme/feature",
        projects,
      }),
    ).toBe("acme");
  });

  test("falls back to the first project with no selection and no active path", () => {
    expect(
      resolveActiveProjectId({ persistedId: null, activePath: null, projects }),
    ).toBe("acme");
  });

  test("returns null when there are no projects", () => {
    expect(
      resolveActiveProjectId({ persistedId: "acme", activePath: null, projects: [] }),
    ).toBeNull();
  });
});

describe("projectOwningPath", () => {
  test("finds the project that owns a worktree path", () => {
    expect(projectOwningPath(projects, "/acme/feature")?.id).toBe("acme");
    expect(projectOwningPath(projects, "/ml/exp")?.id).toBe("ml");
  });

  test("returns null for an unknown or null path", () => {
    expect(projectOwningPath(projects, "/nope")).toBeNull();
    expect(projectOwningPath(projects, null)).toBeNull();
  });
});

describe("projectRunningCount", () => {
  test("counts running and running_partial worktrees", () => {
    expect(projectRunningCount(acme)).toBe(2);
    expect(projectRunningCount(ml)).toBe(0);
  });
});
