// Pure helpers for the Kanban board. Kept free of React and node-only imports
// so they can be unit-tested and bundled for the browser. `orderBetween`
// mirrors `@worktreeos/core/worktree-board` (duplicated to avoid pulling
// node-only core code into the web bundle).

import type {
  ProjectSummary,
  WorkflowStatusDto,
  WorktreeSummary,
} from "./ui-api";

/** Synthetic id for the implicit leading "No status" column. */
export const NO_STATUS_COLUMN_ID = "__no_status__";

const ORDER_STEP = 1;

/** Fractional order strictly between two neighbors (mirrors core). */
export function orderBetween(
  before: number | undefined,
  after: number | undefined,
): number {
  if (before === undefined && after === undefined) return 0;
  if (before === undefined) return (after as number) - ORDER_STEP;
  if (after === undefined) return before + ORDER_STEP;
  return (before + after) / 2;
}

export interface BoardCard {
  worktree: WorktreeSummary;
  projectId: string;
  projectName: string;
}

export interface BoardColumn {
  /** Status id, or `NO_STATUS_COLUMN_ID` for the unassigned column. */
  id: string;
  name: string;
  /** Status color; undefined for the No status column. */
  color?: string;
  cards: BoardCard[];
}

function compareCards(a: BoardCard, b: BoardCard): number {
  const oa = a.worktree.workflowOrder;
  const ob = b.worktree.workflowOrder;
  if (oa !== undefined && ob !== undefined && oa !== ob) return oa - ob;
  if (oa !== undefined && ob === undefined) return -1;
  if (oa === undefined && ob !== undefined) return 1;
  // Stable tie-break so a column with equal/absent orders renders consistently.
  return a.worktree.path.localeCompare(b.worktree.path);
}

/**
 * Build board columns from the project list and the status catalog. A leading
 * "No status" column collects unassigned worktrees (and any whose status id is
 * not in the catalog — i.e. stale assignments). Cards within a column are
 * sorted by fractional order, tie-broken by path.
 */
export function buildBoardColumns(
  projects: ProjectSummary[],
  statuses: WorkflowStatusDto[],
  filterProjectId?: string | null,
): BoardColumn[] {
  const noStatus: BoardColumn = {
    id: NO_STATUS_COLUMN_ID,
    name: "No status",
    cards: [],
  };
  const columns: BoardColumn[] = [noStatus];
  const byId = new Map<string, BoardColumn>();
  for (const s of [...statuses].sort((a, b) => a.order - b.order)) {
    const col: BoardColumn = { id: s.id, name: s.name, color: s.color, cards: [] };
    columns.push(col);
    byId.set(s.id, col);
  }
  for (const project of projects) {
    if (filterProjectId && project.id !== filterProjectId) continue;
    for (const worktree of project.worktrees) {
      const card: BoardCard = {
        worktree,
        projectId: project.id,
        projectName: project.displayName,
      };
      const sid = worktree.workflowStatusId;
      const col = sid ? byId.get(sid) : undefined;
      (col ?? noStatus).cards.push(card);
    }
  }
  for (const col of columns) col.cards.sort(compareCards);
  return columns;
}

/** All distinct projects that have at least one worktree, for the filter. */
export function boardProjectOptions(
  projects: ProjectSummary[],
): Array<{ id: string; name: string }> {
  return projects
    .filter((p) => p.worktrees.length > 0)
    .map((p) => ({ id: p.id, name: p.displayName }));
}

/**
 * Compute the fractional order for inserting a card at `insertIndex` within a
 * column whose cards (excluding the dragged card) are `siblings`, already
 * sorted by order.
 */
export function computeDropOrder(
  siblings: BoardCard[],
  insertIndex: number,
): number {
  const before = siblings[insertIndex - 1]?.worktree.workflowOrder;
  const after = siblings[insertIndex]?.worktree.workflowOrder;
  return orderBetween(before, after);
}
