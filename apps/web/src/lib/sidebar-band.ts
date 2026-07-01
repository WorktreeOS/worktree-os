import { closestCenter, type CollisionDetection } from "@dnd-kit/core";
import type { WorktreeSummary } from "./ui-api";

/* Small pure helpers shared by the rail's controller (sidebar.tsx) and both
 * body variants (sidebar-v3-body.tsx / sidebar-v4-body.tsx) — kept here
 * rather than in either body file so neither has to import from the other. */

export function isRemovingWorktree(wt: WorktreeSummary): boolean {
  return (
    wt.activeOperation?.kind === "worktree-remove" &&
    wt.activeOperation.status === "running"
  );
}

/* Nested-sortable collision detection: a drag only collides with droppables of
 * its own kind (`project:` / `worktree:`), so the project list and the
 * active-now project groups never fight over the drop target (D5 risk). */
export const railCollisionDetection: CollisionDetection = (args) => {
  const id = String(args.active.id);
  const prefix = id.slice(0, id.indexOf(":") + 1);
  return closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter((c) =>
      String(c.id).startsWith(prefix),
    ),
  });
};
