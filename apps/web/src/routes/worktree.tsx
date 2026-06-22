import { useCallback } from "react";
import { useSearchParams } from "react-router";

import { WorktreeView } from "@/routes/worktree/worktree-view";

// Re-export the worktree modals + selection type from their new home so existing
// consumers (the rail) keep importing them from `@/routes/worktree`.
export {
  RemoveWorktreeModal,
  DeploymentActionModal,
  type DeploymentActionSelection,
} from "@/routes/worktree/worktree-view";

/**
 * Thin full-screen `/worktree` route wrapper. Reads the worktree `path` plus the
 * one-shot `terminal` (focus a session) and legacy `panel` (select a tab) params
 * from the URL, hands them to the host-agnostic `WorktreeView` as the page host,
 * and clears each one-shot once the view has applied it.
 */
export function WorktreeRoute() {
  const [searchParams, setSearchParams] = useSearchParams();
  const path = searchParams.get("path") ?? "";
  const terminalParam = searchParams.get("terminal");
  const panelParam = searchParams.get("panel");

  const consumeTerminal = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("terminal");
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  const consumePanel = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("panel");
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  return (
    <WorktreeView
      host="page"
      path={path}
      requestedTerminal={terminalParam}
      requestedPanel={panelParam}
      onConsumeTerminal={consumeTerminal}
      onConsumePanel={consumePanel}
    />
  );
}
