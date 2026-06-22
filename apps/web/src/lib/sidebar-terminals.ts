import type { TerminalSessionMetadata } from "./terminal-protocol";

/* Per-worktree session lookup for the rail's worktree tree (see
 * demo/side-menu-v3.html). Each expanded branch pulls its own live sessions by
 * path from the all-sessions snapshot; the previous project → worktree →
 * session grouping (the flat Terminals view) is gone. A pure helper so the
 * lookup is unit-testable without the React tree. */

export type SessionsByPath = ReadonlyMap<
  string,
  ReadonlyArray<TerminalSessionMetadata>
>;

const EMPTY: ReadonlyArray<TerminalSessionMetadata> = [];

/** The live sessions for one worktree path, or an empty list when none. */
export function sessionsForWorktree(
  sessionsByPath: SessionsByPath,
  path: string,
): ReadonlyArray<TerminalSessionMetadata> {
  return sessionsByPath.get(path) ?? EMPTY;
}
