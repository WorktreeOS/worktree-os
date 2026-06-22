import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { wosHome } from "./paths";

export const BOARD_FILENAME = "board.json";

/**
 * A worktree's placement on the Kanban board: which workflow status column it
 * sits in and its fractional order within that column. Stored globally and
 * keyed by absolute worktree path so a single column can mix worktrees from
 * different projects and still sort coherently.
 */
export interface WorktreeBoardAssignment {
  statusId: string;
  order: number;
}

export interface WorktreeBoardFile {
  version: 1;
  assignments: Record<string, WorktreeBoardAssignment>;
}

export class WorktreeBoardError extends Error {}

/** Default gap between appended cards. */
export const ORDER_STEP = 1;

/**
 * Minimum gap between adjacent fractional orders before a column should be
 * renormalized. Float precision is ample for normal use; this guards against
 * pathological repeated mid-point inserts into the same slot.
 */
export const ORDER_MIN_GAP = 1e-6;

/**
 * Compute a fractional order that sorts strictly between two neighbors.
 *
 * - both undefined → `0` (first card in an empty column)
 * - only `after` → `after - ORDER_STEP` (insert at the head)
 * - only `before` → `before + ORDER_STEP` (append at the tail)
 * - both → their midpoint
 */
export function orderBetween(
  before: number | undefined,
  after: number | undefined,
): number {
  if (before === undefined && after === undefined) return 0;
  if (before === undefined) return (after as number) - ORDER_STEP;
  if (after === undefined) return before + ORDER_STEP;
  return (before + after) / 2;
}

/** Order for appending after the current maximum order in a column. */
export function appendOrder(maxExisting: number | undefined): number {
  return orderBetween(maxExisting, undefined);
}

/**
 * True when any two adjacent orders (once sorted ascending) are closer than
 * `ORDER_MIN_GAP`, signalling that the column's orders should be renormalized
 * to clean integers.
 */
export function needsNormalization(orders: number[]): boolean {
  const sorted = [...orders].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! - sorted[i - 1]! < ORDER_MIN_GAP) return true;
  }
  return false;
}

export function boardFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(wosHome(env), BOARD_FILENAME);
}

export interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  filePath?: string;
}

/**
 * Load the global board store. Returns an empty store when no `board.json`
 * exists. Malformed or stale entries are skipped rather than failing the read,
 * so a partially corrupt file never breaks the board.
 */
export async function loadBoard(
  opts: LoadOptions = {},
): Promise<WorktreeBoardFile> {
  const path = opts.filePath ?? boardFilePath(opts.env);
  const file = Bun.file(path);
  if (!(await file.exists())) return { version: 1, assignments: {} };
  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch (e) {
    throw new WorktreeBoardError(
      `failed to parse ${path}: ${(e as Error).message}`,
    );
  }
  return { version: 1, assignments: sanitizeAssignments(parsed) };
}

function sanitizeAssignments(
  parsed: unknown,
): Record<string, WorktreeBoardAssignment> {
  if (!parsed || typeof parsed !== "object") return {};
  const root = parsed as Partial<WorktreeBoardFile>;
  const raw = root.assignments;
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, WorktreeBoardAssignment> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== "string" || k.length === 0) continue;
    if (!v || typeof v !== "object") continue;
    const a = v as Partial<WorktreeBoardAssignment>;
    if (typeof a.statusId !== "string" || a.statusId.length === 0) continue;
    if (typeof a.order !== "number" || !Number.isFinite(a.order)) continue;
    out[resolve(k)] = { statusId: a.statusId, order: a.order };
  }
  return out;
}

export async function saveBoard(
  board: WorktreeBoardFile,
  opts: LoadOptions = {},
): Promise<void> {
  const path = opts.filePath ?? boardFilePath(opts.env);
  await mkdir(dirname(path), { recursive: true });
  const payload: WorktreeBoardFile = {
    version: 1,
    assignments: board.assignments,
  };
  await Bun.write(path, JSON.stringify(payload, null, 2) + "\n");
}

/** Read a worktree's assignment, if any. */
export function getAssignment(
  board: WorktreeBoardFile,
  worktreePath: string,
): WorktreeBoardAssignment | undefined {
  return board.assignments[resolve(worktreePath)];
}

/** Persist a worktree's status assignment and order. */
export async function setAssignment(
  worktreePath: string,
  statusId: string,
  order: number,
  opts: LoadOptions = {},
): Promise<WorktreeBoardFile> {
  if (typeof statusId !== "string" || statusId.length === 0) {
    throw new WorktreeBoardError("statusId is required");
  }
  if (typeof order !== "number" || !Number.isFinite(order)) {
    throw new WorktreeBoardError("order must be a finite number");
  }
  const board = await loadBoard(opts);
  const next: WorktreeBoardFile = {
    version: 1,
    assignments: { ...board.assignments, [resolve(worktreePath)]: { statusId, order } },
  };
  await saveBoard(next, opts);
  return next;
}

/** Remove a worktree's assignment, marking it unassigned ("no status"). */
export async function clearAssignment(
  worktreePath: string,
  opts: LoadOptions = {},
): Promise<WorktreeBoardFile> {
  const board = await loadBoard(opts);
  const key = resolve(worktreePath);
  if (!(key in board.assignments)) return board;
  const assignments = { ...board.assignments };
  delete assignments[key];
  const next: WorktreeBoardFile = { version: 1, assignments };
  await saveBoard(next, opts);
  return next;
}

/**
 * Move every worktree assigned to `statusId` back to unassigned. Used when a
 * status is deleted so its cards land in the "no status" column rather than
 * referencing a removed status.
 */
export async function reassignStatusToUnassigned(
  statusId: string,
  opts: LoadOptions = {},
): Promise<WorktreeBoardFile> {
  const board = await loadBoard(opts);
  const assignments: Record<string, WorktreeBoardAssignment> = {};
  let changed = false;
  for (const [k, v] of Object.entries(board.assignments)) {
    if (v.statusId === statusId) {
      changed = true;
      continue;
    }
    assignments[k] = v;
  }
  if (!changed) return board;
  const next: WorktreeBoardFile = { version: 1, assignments };
  await saveBoard(next, opts);
  return next;
}
