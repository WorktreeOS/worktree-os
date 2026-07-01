import {
  classifySessionAttention,
  orderSessionsForTreeNode,
  type AttentionGroupKey,
  type StreamFilter,
} from "./sidebar-attention";
import type { TerminalSessionMetadata } from "./terminal-protocol";
import type { WorktreeSummary } from "./ui-api";

/* Pure worktree-tree assembly for the v4 rail body (see
 * demo/sidebar-worktree-tree-v4.html): each worktree becomes a node, its live
 * sessions become children. No React here — the tree shape and filter
 * semantics are unit-testable on their own, same convention as
 * lib/sidebar-attention.ts and lib/sidebar-scope.ts. */

export interface WorktreeTreeSessionNode {
  session: TerminalSessionMetadata;
  attention: AttentionGroupKey;
}

export interface WorktreeTreeNode {
  worktree: WorktreeSummary;
  /** Equal to `worktree.path` — the tree's stable identity key. */
  key: string;
  /** Sessions to render under this node, already filtered + ordered. */
  sessions: WorktreeTreeSessionNode[];
  /** Whether the node's children are expanded — open by default, unless the
   * user manually collapsed this worktree (see `collapsedPaths` below). */
  isOpen: boolean;
  isActive: boolean;
}

export interface BuildWorktreeTreeInput {
  worktrees: ReadonlyArray<WorktreeSummary>;
  /** Live sessions for the current scope, keyed by worktree path. */
  sessionsByPath: ReadonlyMap<string, ReadonlyArray<TerminalSessionMetadata>>;
  filter: StreamFilter;
  activeWorktreePath: string | null;
  /**
   * Worktree paths the user has manually collapsed — sticky until they
   * reopen it (new attention arriving later does not reopen it, matching the
   * canonical demo). Every worktree not in this set is open by default. */
  collapsedPaths: ReadonlySet<string>;
}

/** Build the visible worktree tree for the current scope + filter. Ported
 * one-to-one from the demo's `worktreeNode()` / `sessionMatches()`: filter
 * 'all' shows everything; any other filter keeps only sessions of that
 * attention category and drops worktrees with no match — except filter
 * 'idle', which also keeps worktrees with zero sessions at all (rendered as
 * "No sessions yet · Start worktree" by the presentation layer). */
export function buildWorktreeTreeNodes(
  input: BuildWorktreeTreeInput,
): WorktreeTreeNode[] {
  const { worktrees, sessionsByPath, filter, activeWorktreePath, collapsedPaths } =
    input;
  const nodes: WorktreeTreeNode[] = [];

  for (const worktree of worktrees) {
    const rawSessions = sessionsByPath.get(worktree.path) ?? [];
    const allSessionNodes: WorktreeTreeSessionNode[] = orderSessionsForTreeNode(
      rawSessions,
    ).map((session) => ({
      session,
      attention: classifySessionAttention(session),
    }));

    const visibleSessionNodes =
      filter === "all"
        ? allSessionNodes
        : allSessionNodes.filter((n) => n.attention === filter);

    if (filter !== "all" && visibleSessionNodes.length === 0) {
      const keepEmptyIdle = filter === "idle" && rawSessions.length === 0;
      if (!keepEmptyIdle) continue;
    }

    const isActive = worktree.path === activeWorktreePath;
    const isOpen = !collapsedPaths.has(worktree.path);

    nodes.push({
      worktree,
      key: worktree.path,
      sessions: visibleSessionNodes,
      isOpen,
      isActive,
    });
  }

  return nodes;
}
