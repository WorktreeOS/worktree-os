/* Personal, per-browser record of which worktree tree nodes the user has
 * manually collapsed in the v4 rail body (see lib/sidebar-tree.ts). Every
 * worktree is open by default; this stores only the exceptions, so an empty
 * value means "everything open" and needs no entry. The storage param stays
 * injectable like sidebar-worktree-order.ts so read/write are unit-testable. */

export const SIDEBAR_TREE_COLLAPSED_STORAGE_KEY = "wos.sidebar.tree.collapsed";

export function readCollapsedWorktrees(
  storage?: Pick<Storage, "getItem"> | null,
): Set<string> {
  const store =
    storage ??
    (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return new Set();
  try {
    const raw = store.getItem(SIDEBAR_TREE_COLLAPSED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set();
  }
}

export function writeCollapsedWorktrees(
  value: ReadonlySet<string>,
  storage?: Pick<Storage, "setItem" | "removeItem"> | null,
): void {
  const store =
    storage ??
    (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return;
  try {
    if (value.size === 0) {
      store.removeItem(SIDEBAR_TREE_COLLAPSED_STORAGE_KEY);
    } else {
      store.setItem(
        SIDEBAR_TREE_COLLAPSED_STORAGE_KEY,
        JSON.stringify([...value]),
      );
    }
  } catch {
    /* ignore quota / privacy mode */
  }
}
