import type { DeploymentStatus, ProjectSummary, WorktreeSummary } from "./ui-api";
import {
  getTerminalCountForPath,
  isSidebarRunningWorktree,
  type TerminalCountsByPath,
} from "./sidebar-grouping";
import { worktreeLabel } from "./sidebar-labels";

/* Pure data model for the in-context worktree switcher.
 *
 * The switcher flattens every project's worktrees into a single row list with
 * the metadata it needs to prioritize, group, and search — without re-deriving
 * sidebar internals. "Active" reuses the sidebar's running/terminal-active
 * predicate so the switcher and the sidebar agree on what counts as live, and
 * "pinned" reuses the sidebar's persisted pin set. */

export interface SwitcherRow {
  path: string;
  /** Display label (display name → branch → short HEAD → path). */
  label: string;
  projectId: string;
  projectName: string;
  branch?: string;
  note?: string;
  isSource: boolean;
  status: DeploymentStatus;
  /** This row is the currently selected worktree. */
  isCurrent: boolean;
  /** Deployment-running or has a live terminal session (sidebar predicate). */
  isActive: boolean;
  /** Path is in the sidebar's pinned set. */
  isPinned: boolean;
  /** Row belongs to the project that owns the current worktree. */
  isCurrentProject: boolean;
  terminalCount: number;
  /** Lowercased haystack: label, branch, display name, note, project, path. */
  searchText: string;
  /** Underlying summary, retained for rendering status/badges. */
  worktree: WorktreeSummary;
}

export interface SwitcherGroups {
  /** Running or terminal-active worktrees. */
  active: SwitcherRow[];
  /** Pinned worktrees not already surfaced as active. */
  pinned: SwitcherRow[];
  /** Current-project worktrees not already surfaced as active or pinned. */
  currentProject: SwitcherRow[];
  /** Everything else. */
  others: SwitcherRow[];
}

export interface BuildSwitcherRowsOptions {
  /** Absolute path of the currently selected worktree, if any. */
  currentPath: string | null;
  pinnedPaths: ReadonlySet<string>;
  terminalCounts: TerminalCountsByPath;
}

function buildSearchText(
  wt: WorktreeSummary,
  label: string,
  projectName: string,
): string {
  return [
    label,
    wt.branch ?? "",
    wt.displayName ?? "",
    wt.note ?? "",
    projectName,
    wt.path,
  ]
    .join(" ")
    .toLowerCase();
}

/**
 * Flatten every project's worktrees into switcher rows. The current project is
 * derived from `currentPath`: the project that contains it owns the
 * `currentProject` flag, so the helper needs only the path, not the route's
 * loaded detail.
 */
export function buildSwitcherRows(
  projects: readonly ProjectSummary[],
  options: BuildSwitcherRowsOptions,
): SwitcherRow[] {
  const { currentPath, pinnedPaths, terminalCounts } = options;
  const currentProjectId = currentPath
    ? projects.find((p) => p.worktrees.some((wt) => wt.path === currentPath))?.id
    : undefined;

  return projects.flatMap((project) =>
    project.worktrees.map((wt) => {
      const label = worktreeLabel(wt);
      return {
        path: wt.path,
        label,
        projectId: project.id,
        projectName: project.displayName,
        branch: wt.branch,
        note: wt.note,
        isSource: wt.isSource,
        status: wt.status,
        isCurrent: currentPath != null && wt.path === currentPath,
        isActive: isSidebarRunningWorktree(wt, terminalCounts),
        isPinned: pinnedPaths.has(wt.path),
        isCurrentProject:
          currentProjectId != null && project.id === currentProjectId,
        terminalCount: getTerminalCountForPath(terminalCounts, wt.path),
        searchText: buildSearchText(wt, label, project.displayName),
        worktree: wt,
      } satisfies SwitcherRow;
    }),
  );
}

/** Source-first, then case-insensitive label order. */
function compareRows(a: SwitcherRow, b: SwitcherRow): number {
  if (a.isSource !== b.isSource) return a.isSource ? -1 : 1;
  const byLabel = a.label.localeCompare(b.label);
  if (byLabel !== 0) return byLabel;
  return a.path.localeCompare(b.path);
}

/**
 * Priority rank used both to assign a row to a single group and to order
 * search results: active (0) → pinned (1) → current project (2) → other (3).
 * A row is assigned to exactly its highest-priority bucket so the switcher
 * never lists the same worktree twice.
 */
export function switcherRowRank(row: SwitcherRow): number {
  if (row.isActive) return 0;
  if (row.isPinned) return 1;
  if (row.isCurrentProject) return 2;
  return 3;
}

/**
 * Partition rows into the switcher's priority groups for the no-search view.
 * Each row lands in exactly one group (its highest-priority bucket). Active and
 * pinned groups sort source-first then by label; the others group also clusters
 * by project so a long tail stays scannable.
 */
export function groupSwitcherRows(rows: readonly SwitcherRow[]): SwitcherGroups {
  const groups: SwitcherGroups = {
    active: [],
    pinned: [],
    currentProject: [],
    others: [],
  };
  for (const row of rows) {
    switch (switcherRowRank(row)) {
      case 0:
        groups.active.push(row);
        break;
      case 1:
        groups.pinned.push(row);
        break;
      case 2:
        groups.currentProject.push(row);
        break;
      default:
        groups.others.push(row);
    }
  }
  groups.active.sort(compareRows);
  groups.pinned.sort(compareRows);
  groups.currentProject.sort(compareRows);
  groups.others.sort((a, b) => {
    const byProject = a.projectName.localeCompare(b.projectName);
    if (byProject !== 0) return byProject;
    return compareRows(a, b);
  });
  return groups;
}

/**
 * Filter rows by a free-text query (display name, branch, project name, note,
 * or path) and order them by switcher priority. Returns `null` when the query
 * is blank — callers should render the grouped view in that case.
 */
export function searchSwitcherRows(
  rows: readonly SwitcherRow[],
  query: string,
): SwitcherRow[] | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  return rows
    .filter((row) => row.searchText.includes(q))
    .sort((a, b) => {
      const byRank = switcherRowRank(a) - switcherRowRank(b);
      if (byRank !== 0) return byRank;
      return compareRows(a, b);
    });
}
