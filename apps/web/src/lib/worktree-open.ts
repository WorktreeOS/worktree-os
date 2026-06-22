import type { WorktreeTab } from "@/lib/worktree-tabs";

/**
 * Pure navigation decision for opening a worktree, encoding the
 * worktree-open navigation rule and the single-instance invariant for the heavy
 * worktree detail view (4s polling + unified-events subscription).
 *
 * - `terminal` entry points (attach/new terminal) always open the full-screen
 *   `/worktree` route — the terminal needs full width.
 * - `worktree` / `runtime` entry points open the docked panel, *unless* the
 *   active route is already the full-screen `/worktree` route (path is swapped
 *   there) or the `/select` "no worktree selected" placeholder (docking beside an
 *   empty placeholder is meaningless, so the selection takes over the center).
 *
 * This keeps at most one worktree detail view mounted: the panel is suppressed
 * by the shell while on `/worktree`, and this helper never asks for a panel from
 * that route.
 */

export const WORKTREE_ROUTE_PATH = "/worktree";

/** The project-scoped "no worktree selected" placeholder route. */
export const SELECT_ROUTE_PATH = "/select";

export type WorktreeOpenEntry = "worktree" | "runtime" | "terminal";

export type WorktreeOpenDecision =
  | { kind: "panel"; tab?: WorktreeTab }
  | { kind: "navigate"; url: string };

export interface WorktreeOpenInput {
  entry: WorktreeOpenEntry;
  path: string;
  /** The current `location.pathname`. */
  pathname: string;
  /** Terminal session id to focus, for `terminal` entry points. */
  terminalSessionId?: string;
  /**
   * Explicit tab to land on for `worktree` / `runtime` entries, overriding the
   * persisted "last tab". Callers use this to force a destination (e.g. the
   * board opens worktrees on `overview`). When omitted, `worktree` keeps the
   * last tab and `runtime` defaults to the Runtime tab.
   */
  tab?: WorktreeTab;
}

/** Build a full-screen `/worktree` URL for `path`, optionally selecting a tab. */
export function worktreeRouteUrl(
  path: string,
  extra?: { terminal?: string; panel?: string },
): string {
  const params = new URLSearchParams({ path });
  if (extra?.terminal) params.set("terminal", extra.terminal);
  if (extra?.panel) params.set("panel", extra.panel);
  return `${WORKTREE_ROUTE_PATH}?${params.toString()}`;
}

export function decideWorktreeOpen(
  input: WorktreeOpenInput,
): WorktreeOpenDecision {
  const { entry, path, pathname, terminalSessionId } = input;

  // Terminal-centric: always full-screen, carrying the focused session id.
  if (entry === "terminal") {
    return {
      kind: "navigate",
      url: worktreeRouteUrl(path, { terminal: terminalSessionId }),
    };
  }

  // Target tab for worktree / runtime entries: an explicit override wins,
  // otherwise runtime lands on Runtime and worktree keeps the last tab.
  const tab = input.tab ?? (entry === "runtime" ? "runtime" : undefined);

  // Take over the full-screen route when already on it (swap the path, keeping
  // the single-instance invariant) or when on the `/select` placeholder (the
  // selection should fill the empty center, not dock a panel beside it). An
  // explicit/runtime tab rides along as the `panel` handoff so the destination
  // lands on it, matching the panel-open behaviour.
  if (pathname === WORKTREE_ROUTE_PATH || pathname === SELECT_ROUTE_PATH) {
    return {
      kind: "navigate",
      url: worktreeRouteUrl(path, tab ? { panel: tab } : undefined),
    };
  }

  // Worktree / runtime elsewhere: open the docked panel.
  return { kind: "panel", tab };
}
