import type { ProjectSummary } from "./ui-api";
import { isDeploymentRunning } from "./sidebar-grouping";

/* Active-project model for the per-project rail (see demo/side-menu-v3.html).
 *
 * The rail is scoped to one active project. Resolution order (design.md):
 *   1. explicit user selection persisted in `wos.sidebar.activeProject`
 *   2. the project that owns the currently selected worktree (`activePath`)
 *   3. the first registered project
 * A pure resolver so the precedence is unit-testable without the React tree. */

export const ACTIVE_PROJECT_STORAGE_KEY = "wos.sidebar.activeProject";

export function readActiveProjectId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY);
    return typeof raw === "string" && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function writeActiveProjectId(value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value) window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, value);
    else window.localStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY);
  } catch {
    /* ignore quota / privacy mode */
  }
}

export function resolveActiveProjectId(opts: {
  persistedId: string | null;
  activePath: string | null;
  projects: ReadonlyArray<ProjectSummary>;
}): string | null {
  const { persistedId, activePath, projects } = opts;
  if (projects.length === 0) return null;
  if (persistedId && projects.some((p) => p.id === persistedId)) {
    return persistedId;
  }
  if (activePath) {
    const owning = projects.find((p) =>
      p.worktrees.some((wt) => wt.path === activePath),
    );
    if (owning) return owning.id;
  }
  return projects[0]!.id;
}

/** The project that owns a given worktree path, or null. */
export function projectOwningPath(
  projects: ReadonlyArray<ProjectSummary>,
  path: string | null,
): ProjectSummary | null {
  if (!path) return null;
  return (
    projects.find((p) => p.worktrees.some((wt) => wt.path === path)) ?? null
  );
}

/** Worktrees of a project whose deployment status is running / partial. */
export function projectRunningCount(project: ProjectSummary): number {
  return project.worktrees.filter((wt) => isDeploymentRunning(wt.status)).length;
}
