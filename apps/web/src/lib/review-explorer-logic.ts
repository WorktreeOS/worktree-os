import type { DiffFile, ReviewDiffResponse } from "./ui-api";

/**
 * Pure logic for the Review tab's changed-files explorer. Merges the daemon's
 * separate `staged` / `unstaged` diff sets into one `Changes` list, derives each
 * file's staged state, totals, reviewed progress, the tri-state `All staged`
 * control, and the 5-cell diff-bar split. No React, no DOM — unit-tested per the
 * web no-render-tests convention.
 */

/** Whether a changed file is fully staged, fully unstaged, or partially staged. */
export type ChangeStagedState = "staged" | "unstaged" | "partial";

export interface ChangeEntry {
  /** Stable path key for the row (rename → destination path). */
  path: string;
  /** Representative diff file for the detail pane (working tree preferred). */
  file: DiffFile;
  /** Derived staging state from set membership. */
  staged: ChangeStagedState;
  /** Combined additions across the file's staged + unstaged occurrences. */
  additions: number;
  /** Combined deletions across the file's staged + unstaged occurrences. */
  deletions: number;
  /** File change status of the representative file. */
  status: DiffFile["status"];
}

function keyOf(file: DiffFile): string {
  return file.newPath ?? file.oldPath ?? file.id;
}

/**
 * Merge the `staged` and `unstaged` diff sets into one ordered `Changes` list.
 * A file present in both sets is reported as `partial` (staged, with a dash
 * hint); v1 stages/unstages the whole file. Sorted by path for stable order.
 */
export function mergeChanges(review: ReviewDiffResponse | null): ChangeEntry[] {
  if (!review) return [];
  const byPath = new Map<string, { staged?: DiffFile; unstaged?: DiffFile }>();
  for (const f of review.staged.files) {
    const k = keyOf(f);
    const e = byPath.get(k) ?? {};
    e.staged = f;
    byPath.set(k, e);
  }
  for (const f of review.unstaged.files) {
    const k = keyOf(f);
    const e = byPath.get(k) ?? {};
    e.unstaged = f;
    byPath.set(k, e);
  }
  const entries: ChangeEntry[] = [];
  for (const [path, { staged, unstaged }] of byPath) {
    const file = unstaged ?? staged!;
    const stagedState: ChangeStagedState =
      staged && unstaged ? "partial" : staged ? "staged" : "unstaged";
    entries.push({
      path,
      file,
      staged: stagedState,
      additions: (staged?.additions ?? 0) + (unstaged?.additions ?? 0),
      deletions: (staged?.deletions ?? 0) + (unstaged?.deletions ?? 0),
      status: file.status,
    });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

/** Whether the change's stage checkbox should render as checked (has any
 * staged content — a `partial` file is checked with a dash hint). */
export function isStaged(entry: ChangeEntry): boolean {
  return entry.staged === "staged" || entry.staged === "partial";
}

/** Whether the whole file is staged with nothing left in the working tree. A
 * `partial` file is NOT fully staged — it still has unstaged hunks. */
export function isFullyStaged(entry: ChangeEntry): boolean {
  return entry.staged === "staged";
}

export interface ChangeTotals {
  files: number;
  additions: number;
  deletions: number;
  stagedCount: number;
}

export function changeTotals(entries: ChangeEntry[]): ChangeTotals {
  let additions = 0;
  let deletions = 0;
  let stagedCount = 0;
  for (const e of entries) {
    additions += e.additions;
    deletions += e.deletions;
    if (isStaged(e)) stagedCount += 1;
  }
  return { files: entries.length, additions, deletions, stagedCount };
}

export type TriState = "all" | "some" | "none";

/**
 * Tri-state of the `All staged` header control. `all` requires every file to be
 * FULLY staged — a `partial` file (staged + unstaged hunks) keeps the control in
 * `some`, so activating it can stage the remaining hunks.
 */
export function allStagedState(entries: ChangeEntry[]): TriState {
  if (entries.length === 0) return "none";
  const anyStaged = entries.filter(isStaged).length;
  if (anyStaged === 0) return "none";
  if (entries.every(isFullyStaged)) return "all";
  return "some";
}

/**
 * Which files the `All staged` control should act on, and the direction: when
 * not everything is fully staged, stage every not-fully-staged file (this stages
 * the remaining hunks of `partial` files too); when all are fully staged,
 * unstage everything.
 */
export function allStagedAction(entries: ChangeEntry[]): {
  action: "stage" | "unstage";
  paths: string[];
} {
  const state = allStagedState(entries);
  if (state === "all") {
    return { action: "unstage", paths: entries.map((e) => e.path) };
  }
  return {
    action: "stage",
    paths: entries.filter((e) => !isFullyStaged(e)).map((e) => e.path),
  };
}

export interface ReviewedProgress {
  reviewed: number;
  total: number;
}

export function reviewedProgress(
  entries: ChangeEntry[],
  reviewed: ReadonlySet<string>,
): ReviewedProgress {
  let n = 0;
  for (const e of entries) if (reviewed.has(e.path)) n += 1;
  return { reviewed: n, total: entries.length };
}

export type DiffBarCell = "g" | "r" | "o";

const DIFF_BAR_SEGMENTS = 5;

/**
 * Split 5 cells between additions (green) and deletions (red), mirroring the
 * additions/deletions ratio. Neutral cells fill when there is no change.
 */
export function diffBarCells(
  additions: number,
  deletions: number,
): DiffBarCell[] {
  const total = additions + deletions;
  if (total <= 0) return Array<DiffBarCell>(DIFF_BAR_SEGMENTS).fill("o");
  let g = Math.round((additions / total) * DIFF_BAR_SEGMENTS);
  if (additions > 0 && g === 0) g = 1;
  if (additions === 0) g = 0;
  let r = DIFF_BAR_SEGMENTS - g;
  if (deletions === 0) r = 0;
  const cells: DiffBarCell[] = [];
  for (let i = 0; i < g; i += 1) cells.push("g");
  for (let i = 0; i < r; i += 1) cells.push("r");
  while (cells.length < DIFF_BAR_SEGMENTS) cells.push("o");
  return cells.slice(0, DIFF_BAR_SEGMENTS);
}
