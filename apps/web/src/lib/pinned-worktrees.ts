/* Shared persistence for sidebar-pinned worktrees. The pinned set is owned by
 * the sidebar but also read by the in-context worktree switcher so both
 * surfaces prioritize the same worktrees. Keep the storage key and parsing in
 * one place so they never drift. */

export const PINNED_STORAGE_KEY = "wos.sidebar.pinnedWorktrees";

export function readPinnedWorktrees(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(PINNED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set();
  }
}

export function writePinnedWorktrees(value: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify([...value]));
  } catch {
    /* ignore quota / privacy mode */
  }
}
