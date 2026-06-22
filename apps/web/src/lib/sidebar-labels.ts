import type { WorktreeSummary } from "@/lib/ui-api";

/**
 * Resolve the worktree label shown in the sidebar. Prefers the persisted
 * display name; falls back to branch, short HEAD, or absolute path.
 */
export function worktreeLabel(wt: WorktreeSummary): string {
  if (wt.displayName && wt.displayName.length > 0) return wt.displayName;
  if (wt.branch) return wt.branch;
  if (wt.head) return wt.head.slice(0, 7);
  return wt.path;
}
