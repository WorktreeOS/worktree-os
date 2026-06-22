/* Personal, per-browser ordering for worktree nodes within a project. Authored
 * by drag-and-drop in the rail's project scope, then honored (read-only) by the
 * Active-now scope and the Home page. The canonical list stays authoritative
 * (`sortWorktreesForSidebar`: failed → source → rest, removing sunk);
 * this is a render-time projection over it: dragged worktrees keep their chosen
 * place, and any worktree not in the stored order (new, or never dragged) keeps
 * its canonical rank after them.
 *
 * The stored value is a single flat array of worktree paths across every
 * project. Per-project projection filters it to that project's paths, so
 * cross-project paths are simply ignored. Defensive parse mirrors
 * `pinned-worktrees.ts`; the storage param stays injectable like
 * `panel-width.ts` so read/write are unit-testable. */

export const WORKTREE_ORDER_STORAGE_KEY = "wos.sidebar.worktreeOrder";

export function readWorktreeOrder(
  storage?: Pick<Storage, "getItem"> | null,
): string[] {
  const store =
    storage ??
    (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return [];
  try {
    const raw = store.getItem(WORKTREE_ORDER_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

export function writeWorktreeOrder(
  value: ReadonlyArray<string>,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  const store =
    storage ??
    (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return;
  try {
    store.setItem(WORKTREE_ORDER_STORAGE_KEY, JSON.stringify([...value]));
  } catch {
    /* ignore quota / privacy mode */
  }
}

/* Project the canonical (sortWorktreesForSidebar-ordered) worktrees onto the
 * stored order: worktrees whose path is in `orderedPaths` come first in that
 * order, then any remaining worktree in its incoming canonical order. Stale /
 * cross-project paths in `orderedPaths` are tolerated and skipped. */
export function applyWorktreeOrder<T extends { path: string }>(
  worktrees: ReadonlyArray<T>,
  orderedPaths: ReadonlyArray<string>,
): T[] {
  if (orderedPaths.length === 0) return [...worktrees];
  const byPath = new Map(worktrees.map((w) => [w.path, w]));
  const seen = new Set<string>();
  const known: T[] = [];
  for (const p of orderedPaths) {
    const w = byPath.get(p);
    if (w && !seen.has(p)) {
      known.push(w);
      seen.add(p);
    }
  }
  const unknown = worktrees.filter((w) => !seen.has(w.path));
  return [...known, ...unknown];
}

/* Drop paths that no longer correspond to a known worktree, preserving order.
 * No write side-effect — the caller persists if the result differs. */
export function pruneWorktreeOrder(
  orderedPaths: ReadonlyArray<string>,
  knownPaths: ReadonlySet<string>,
): string[] {
  return orderedPaths.filter((p) => knownPaths.has(p));
}
