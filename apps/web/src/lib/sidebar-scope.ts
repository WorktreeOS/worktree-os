import type { ProjectSummary, WorktreeSummary } from "./ui-api";
import {
  isSidebarRunningWorktree,
  type TerminalCountsByPath,
} from "./sidebar-grouping";

/* Rail scope model (see demo/sidebar-v3/index.html).
 *
 * The project switcher is the rail's single scope control. Besides one
 * project, the dropdown offers a first-class "Active now" scope: every
 * worktree in any project with at least one live terminal session or a
 * running / partial runtime, grouped under its project. Pure helpers so the
 * filter and the counts are unit-testable without the React tree. */

export type SidebarScope = "project" | "active-now";

export const SIDEBAR_SCOPE_STORAGE_KEY = "wos.sidebar.scope";

export function readSidebarScope(): SidebarScope {
  if (typeof window === "undefined") return "project";
  try {
    const raw = window.localStorage.getItem(SIDEBAR_SCOPE_STORAGE_KEY);
    return raw === "active-now" ? "active-now" : "project";
  } catch {
    return "project";
  }
}

export function writeSidebarScope(value: SidebarScope): void {
  if (typeof window === "undefined") return;
  try {
    if (value === "active-now") {
      window.localStorage.setItem(SIDEBAR_SCOPE_STORAGE_KEY, value);
    } else {
      window.localStorage.removeItem(SIDEBAR_SCOPE_STORAGE_KEY);
    }
  } catch {
    /* ignore quota / privacy mode */
  }
}

export interface ActiveScopeGroup {
  project: ProjectSummary;
  worktrees: WorktreeSummary[];
}

/* Projects (in registration order) with only their active worktrees, in the
 * project's own worktree order. Projects with nothing alive drop out. */
export function groupActiveWorktrees(
  projects: ReadonlyArray<ProjectSummary>,
  counts: TerminalCountsByPath,
): ActiveScopeGroup[] {
  const groups: ActiveScopeGroup[] = [];
  for (const project of projects) {
    const worktrees = project.worktrees.filter((wt) =>
      isSidebarRunningWorktree(wt, counts),
    );
    if (worktrees.length > 0) groups.push({ project, worktrees });
  }
  return groups;
}

export interface ActiveScopeSummary {
  worktrees: number;
  projects: number;
}

export function activeScopeSummary(
  groups: ReadonlyArray<ActiveScopeGroup>,
): ActiveScopeSummary {
  return {
    worktrees: groups.reduce((acc, g) => acc + g.worktrees.length, 0),
    projects: groups.length,
  };
}

/* "4 live worktrees · 2 projects" — the anchor / dropdown sub line. */
export function activeScopeSummaryText(summary: ActiveScopeSummary): string {
  if (summary.worktrees === 0) return "nothing running";
  const wts = `${summary.worktrees} live ${
    summary.worktrees === 1 ? "worktree" : "worktrees"
  }`;
  const projects = `${summary.projects} ${
    summary.projects === 1 ? "project" : "projects"
  }`;
  return `${wts} · ${projects}`;
}
