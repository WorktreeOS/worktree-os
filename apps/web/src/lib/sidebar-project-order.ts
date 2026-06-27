/* Global project ordering. The display order is now **server-authoritative**:
 * each project carries a persisted `order` (see `project-registry.ts`), the rail
 * drag-reorder writes it through `PATCH /ui/v1/projects/:id`, and the project
 * list arrives already sorted. `applyProjectOrder` stays a render-time
 * projection so callers can reorder optimistically by passing the current
 * server-derived id order; with an empty id list it returns the
 * (server-ordered) projects unchanged.
 *
 * The legacy per-browser `localStorage` order is read once on upgrade to seed
 * the server (`migrateProjectOrderToServer`), then cleared. `readProjectOrder` /
 * `writeProjectOrder` remain for that migration and its tests.
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

/** Remove the legacy localStorage project order (after migrating it to the
 * server). */
export function clearProjectOrder(
  storage?: Pick<Storage, "removeItem"> | null,
): void {
  const store =
    storage ??
    (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return;
  try {
    store.removeItem(PROJECT_ORDER_STORAGE_KEY);
  } catch {
    /* ignore privacy mode */
  }
}

/**
 * One-time migration: if a legacy localStorage project order exists, replay it
 * to the server so the new server-authoritative `order` matches the user's
 * previously-dragged arrangement, then clear the localStorage key. Stored ids
 * lead (in their stored sequence); any project not in the stored list keeps its
 * current server order after them. Applies sequentially in ascending target
 * index so each `reorder` (a fractional insert) composes. Returns `true` when a
 * migration was performed. No-op (returns `false`) when there is nothing stored.
 */
export async function migrateProjectOrderToServer(opts: {
  projects: ReadonlyArray<{ id: string; order: number }>;
  reorder: (id: string, order: number) => Promise<unknown>;
  storage?: (Pick<Storage, "getItem"> & Pick<Storage, "removeItem">) | null;
}): Promise<boolean> {
  const stored = readProjectOrder(opts.storage);
  if (stored.length === 0) return false;
  const ids = new Set(opts.projects.map((p) => p.id));
  const lead = stored.filter((id) => ids.has(id));
  const rest = [...opts.projects]
    .sort((a, b) => a.order - b.order)
    .map((p) => p.id)
    .filter((id) => !lead.includes(id));
  const desired = [...lead, ...rest];
  for (let i = 0; i < desired.length; i++) {
    await opts.reorder(desired[i]!, i);
  }
  clearProjectOrder(opts.storage);
  return true;
}
