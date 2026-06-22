/* Personal, per-browser ordering for projects. Authored by drag-and-drop in
 * the rail's `active-now` scope, then honored (read-only) by the project
 * switcher dropdown and the Home page — a single global project order. The
 * canonical project list stays authoritative (`projects-context` keeps
 * registration order); this is a render-time projection over it, persisted in
 * localStorage like the terminal order.
 *
 * Defensive parse mirrors `pinned-worktrees.ts`; the storage param stays
 * injectable like `panel-width.ts` so read/write are unit-testable. */

export const PROJECT_ORDER_STORAGE_KEY = "wos.sidebar.projectOrder";

export function readProjectOrder(
  storage?: Pick<Storage, "getItem"> | null,
): string[] {
  const store =
    storage ??
    (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return [];
  try {
    const raw = store.getItem(PROJECT_ORDER_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

export function writeProjectOrder(
  value: ReadonlyArray<string>,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  const store =
    storage ??
    (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return;
  try {
    store.setItem(PROJECT_ORDER_STORAGE_KEY, JSON.stringify([...value]));
  } catch {
    /* ignore quota / privacy mode */
  }
}

/* Project the canonical (registration-ordered) projects onto the stored order:
 * projects whose id is in `orderedIds` come first in that order, then any
 * remaining project (newly registered or never reordered) in its incoming
 * registration order. Stale ids in `orderedIds` are tolerated and skipped. */
export function applyProjectOrder<T extends { id: string }>(
  projects: ReadonlyArray<T>,
  orderedIds: ReadonlyArray<string>,
): T[] {
  if (orderedIds.length === 0) return [...projects];
  const byId = new Map(projects.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const known: T[] = [];
  for (const id of orderedIds) {
    const p = byId.get(id);
    if (p && !seen.has(id)) {
      known.push(p);
      seen.add(id);
    }
  }
  const unknown = projects.filter((p) => !seen.has(p.id));
  return [...known, ...unknown];
}
