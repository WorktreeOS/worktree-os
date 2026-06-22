import { useCallback, useRef } from "react";

import { PANEL_MIN_WIDTH } from "@/lib/panel-width";
import type { WorktreeTab } from "@/lib/worktree-tabs";
import { WorktreeView } from "@/routes/worktree/worktree-view";

/**
 * Right-docked worktree panel host. A resizable split-pane sibling of the center
 * content (not an overlay): the resize handle on its left edge grows the panel
 * with leftward pointer travel. The worktree detail renders inside as the
 * host-agnostic `WorktreeView` in compact density — which surfaces the host's
 * expand (⤢) / close (✕) controls inline in its single compact header row, so
 * the panel adds no second header band. Desktop-only — touch opens go
 * full-screen instead (see `useWorktreeOpener`).
 */
export function WorktreePanel({
  path,
  tab,
  width,
  maxWidth,
  onWidthChange,
  onWidthCommit,
  onClose,
  onExpand,
  onClearTab,
}: {
  path: string;
  tab?: WorktreeTab;
  width: number;
  /** Accessible max for the resize handle's value range (shell-clamped). */
  maxWidth: number;
  onWidthChange: (rawWidth: number) => void;
  onWidthCommit: () => void;
  onClose: () => void;
  onExpand: () => void;
  onClearTab: () => void;
}) {
  return (
    <aside
      data-testid="worktree-panel"
      aria-label="Worktree detail panel"
      className="relative flex h-full min-h-0 shrink-0 flex-col border-l border-[color:var(--hair-2)] bg-[color:var(--surface)]"
      style={{ width }}
    >
      <WorktreePanelResizeHandle
        width={width}
        maxWidth={maxWidth}
        onWidthChange={onWidthChange}
        onWidthCommit={onWidthCommit}
      />

      <div className="flex min-h-0 flex-1 flex-col">
        <WorktreeView
          host="panel"
          path={path}
          onClose={onClose}
          onExpand={onExpand}
          requestedPanel={tab ?? null}
          onConsumePanel={onClearTab}
        />
      </div>
    </aside>
  );
}

/**
 * Left-edge separator that resizes the docked panel. Mirrors the rail's
 * `SidebarResizeHandle` (pointer capture, live width up, persist on release) but
 * inverted: the panel grows as the pointer travels left (`startWidth − delta`).
 * Live width changes flow up to the shell, which clamps; the shell persists on
 * release.
 */
function WorktreePanelResizeHandle({
  width,
  maxWidth,
  onWidthChange,
  onWidthCommit,
}: {
  width: number;
  maxWidth: number;
  onWidthChange: (rawWidth: number) => void;
  onWidthCommit: () => void;
}) {
  const startRef = useRef<{ x: number; width: number } | null>(null);
  const dragging = useRef(false);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      startRef.current = { x: e.clientX, width };
      dragging.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      document.body.style.userSelect = "none";
    },
    [width],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current || !startRef.current) return;
      // Right-docked: leftward pointer travel (negative delta) grows the panel.
      const delta = e.clientX - startRef.current.x;
      onWidthChange(startRef.current.width - delta);
    },
    [onWidthChange],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      dragging.current = false;
      startRef.current = null;
      document.body.style.userSelect = "";
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* not captured */
      }
      onWidthCommit();
    },
    [onWidthCommit],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize worktree panel"
      aria-valuemin={PANEL_MIN_WIDTH}
      aria-valuemax={Math.round(maxWidth)}
      aria-valuenow={Math.round(width)}
      data-testid="worktree-panel-resize-handle"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="absolute left-0 top-0 z-20 h-full w-1 cursor-col-resize bg-transparent transition-colors hover:bg-[color:var(--hair-2)]"
      style={{ touchAction: "none" }}
    />
  );
}
