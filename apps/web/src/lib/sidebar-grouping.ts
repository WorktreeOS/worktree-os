import type { DeploymentStatus, WorktreeSummary } from "./ui-api";

/* Shared sidebar activity model.
 *
 * A worktree counts as "active" when either its deployment status is
 * `running` / `running_partial`, or when the terminal-sessions map reports at
 * least one live terminal session for its path. The worktree switcher reuses
 * this predicate so it and the sidebar agree on what counts as live. */

export type TerminalCountsByPath = ReadonlyMap<string, number>;

export function isDeploymentRunning(status: DeploymentStatus): boolean {
  return status === "running" || status === "running_partial";
}

export function getTerminalCountForPath(
  counts: TerminalCountsByPath,
  path: string,
): number {
  return counts.get(path) ?? 0;
}

export function isSidebarRunningWorktree(
  wt: WorktreeSummary,
  counts: TerminalCountsByPath,
): boolean {
  if (isDeploymentRunning(wt.status)) return true;
  return getTerminalCountForPath(counts, wt.path) > 0;
}

/* A worktree "has a runtime" once it has been deployed and is anything past
 * never-started / fully stopped — so its Runtime line carries meaningful
 * status. `not_started`, `stopped`, and `unknown` have nothing to show. */
export function worktreeHasRuntime(status: DeploymentStatus): boolean {
  return (
    status !== "not_started" && status !== "stopped" && status !== "unknown"
  );
}

/* In the per-project tree a branch is expandable when it has a runtime or at
 * least one live terminal session — otherwise there is nothing under its
 * spine (see demo/side-menu-v3.html: a stopped branch with no sessions has a
 * disabled chevron and no children). */
export function branchExpandable(
  status: DeploymentStatus,
  liveSessionCount: number,
): boolean {
  return worktreeHasRuntime(status) || liveSessionCount > 0;
}
