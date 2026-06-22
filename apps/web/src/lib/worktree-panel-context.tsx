import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate, type NavigateOptions } from "react-router";

import { useIsCompactViewport } from "@/lib/viewport";
import type { WorktreeTab } from "@/lib/worktree-tabs";
import {
  decideWorktreeOpen,
  worktreeRouteUrl,
  type WorktreeOpenEntry,
} from "@/lib/worktree-open";

/**
 * Ephemeral selection for the right-docked worktree panel. The selected path is
 * plain in-memory React state — it survives in-app route changes (the provider
 * sits above the router outlet) and resets on a full reload. Selection is
 * intentionally **not** in the URL; the panel width preference is persisted
 * separately (see `panel-width.ts`).
 */
export interface WorktreePanelState {
  /** Open worktree path, or null when the panel is closed. */
  path: string | null;
  /** One-shot initial tab to select when the panel opens (e.g. `runtime`). */
  tab?: WorktreeTab;
  /** Open the panel for `path`, optionally on a specific tab. */
  open: (path: string, tab?: WorktreeTab) => void;
  /** Close the panel and return the center content to full width. */
  close: () => void;
  /** Clear the one-shot initial tab once the view has applied it. */
  clearTab: () => void;
}

const WorktreePanelContext = createContext<WorktreePanelState | null>(null);

export function WorktreePanelProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState<string | null>(null);
  const [tab, setTab] = useState<WorktreeTab | undefined>(undefined);

  const open = useCallback((nextPath: string, nextTab?: WorktreeTab) => {
    setPath(nextPath);
    setTab(nextTab);
  }, []);
  const close = useCallback(() => {
    setPath(null);
    setTab(undefined);
  }, []);
  const clearTab = useCallback(() => setTab(undefined), []);

  const value = useMemo<WorktreePanelState>(
    () => ({ path, tab, open, close, clearTab }),
    [path, tab, open, close, clearTab],
  );

  return (
    <WorktreePanelContext.Provider value={value}>
      {children}
    </WorktreePanelContext.Provider>
  );
}

export function useWorktreePanel(): WorktreePanelState {
  const ctx = useContext(WorktreePanelContext);
  if (!ctx) {
    throw new Error(
      "useWorktreePanel must be used within a WorktreePanelProvider",
    );
  }
  return ctx;
}

export interface OpenWorktreeOptions {
  /** Session id to focus, for `terminal` entry points. */
  terminalSessionId?: string;
  /** Extra options forwarded to `navigate` (e.g. board `from` state). */
  navigateOptions?: NavigateOptions;
  /**
   * Force the landing tab for `worktree` / `runtime` opens, overriding the
   * persisted "last tab" (e.g. the board opens worktrees on `overview`).
   */
  tab?: WorktreeTab;
}

/**
 * Single entry point for opening a worktree from anywhere in the app. Applies
 * the navigation rule (`decideWorktreeOpen`) plus the touch override: on touch
 * (`< lg`) viewports there is no split-pane, so worktree-centric opens go to the
 * full-screen `/worktree` route (the existing mobile worktree chrome) instead of
 * the docked panel.
 */
export function useWorktreeOpener(): (
  entry: WorktreeOpenEntry,
  path: string,
  opts?: OpenWorktreeOptions,
) => void {
  const panel = useWorktreePanel();
  const navigate = useNavigate();
  const location = useLocation();
  const compact = useIsCompactViewport();

  return useCallback(
    (entry, path, opts) => {
      // Touch: no docked panel — worktree-centric opens render full-screen.
      if (compact && entry !== "terminal") {
        const tab = opts?.tab ?? (entry === "runtime" ? "runtime" : undefined);
        navigate(
          worktreeRouteUrl(path, tab ? { panel: tab } : undefined),
          opts?.navigateOptions,
        );
        return;
      }
      const decision = decideWorktreeOpen({
        entry,
        path,
        pathname: location.pathname,
        terminalSessionId: opts?.terminalSessionId,
        tab: opts?.tab,
      });
      if (decision.kind === "navigate") {
        navigate(decision.url, opts?.navigateOptions);
      } else {
        panel.open(path, decision.tab);
      }
    },
    [panel, navigate, location.pathname, compact],
  );
}
