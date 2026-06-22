import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { useUiApi } from "@/lib/api-context";
import { useHasTouch } from "@/lib/viewport";
import { Button } from "@/components/ui/button";
import { TerminalView } from "@/components/worktree-terminal";
import { terminalLabel } from "@/lib/terminal-agents";
import {
  persistQuickActionsVisible,
  persistTouchOverride,
  readStoredCursorBlink,
  readStoredFontSize,
  readStoredQuickActionsVisible,
  readStoredScrollback,
  readStoredTouchOverride,
  resolveTouchTerminalMode,
  type TouchTerminalOverride,
} from "@/lib/touch-terminal";
import type { TerminalSessionMetadata } from "@/lib/terminal-protocol";

/**
 * Mission Control Focus overlay — the only place the wall mounts a terminal
 * emulator. Performs a full interactive attach by reusing `TerminalView` (which
 * owns `XtermViewport` + the WebSocket `TerminalConnection`). Attaching clears
 * the session's unread marker through the existing terminal-layer behaviour.
 */
export function MissionControlFocus({
  session,
  projectName,
  branchLabel,
  onClose,
}: {
  session: TerminalSessionMetadata;
  projectName: string;
  branchLabel: string;
  onClose: () => void;
}) {
  const api = useUiApi();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Mirror the worktree terminal's touch detection so the focus overlay shows
  // the same on-screen quick actions / Write composer and keyboard-safe sizing
  // on phones and tablets. Canonical copy lives in WorktreeTerminalSection.
  const [coarsePointer, setCoarsePointer] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerWidth,
  );
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const mql = window.matchMedia("(pointer: coarse)");
    const onPointer = (e: MediaQueryListEvent) => setCoarsePointer(e.matches);
    setCoarsePointer(mql.matches);
    if (mql.addEventListener) mql.addEventListener("change", onPointer);
    else mql.addListener(onPointer);
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener("change", onPointer);
      else mql.removeListener(onPointer);
      window.removeEventListener("resize", onResize);
    };
  }, []);
  const hasTouch = useHasTouch();
  const [touchOverride, setTouchOverride] = useState<TouchTerminalOverride>(
    () => readStoredTouchOverride(),
  );
  const touchMode = resolveTouchTerminalMode({
    override: touchOverride,
    coarsePointer,
    viewportWidth,
  });
  const [quickActionsVisible, setQuickActionsVisible] = useState<boolean>(
    () => readStoredQuickActionsVisible() ?? true,
  );
  const updateQuickActionsVisible = (visible: boolean) => {
    setQuickActionsVisible(visible);
    persistQuickActionsVisible(visible);
  };
  const showTouchControls = () => {
    if (!touchMode) {
      setTouchOverride("force-on");
      persistTouchOverride("force-on");
    }
    updateQuickActionsVisible(true);
  };

  const label = terminalLabel(session, session.shell);

  return createPortal(
    <div
      className="dark fixed inset-0 z-50 flex flex-col bg-black/70 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`Focus ${label}`}
      data-testid="mc-focus"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="reveal mx-auto flex h-full w-full max-w-6xl flex-col overflow-hidden md:my-6 md:h-[calc(100%-3rem)] md:rounded-[14px] md:border md:border-white/10">
        <header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-black px-3 text-foreground">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 truncate text-[12.5px] font-medium">
              {label}
            </span>
            <span className="min-w-0 truncate font-mono text-[11.5px] text-muted-foreground">
              {projectName} · {branchLabel}
            </span>
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={onClose}
            data-testid="mc-focus-close"
            aria-label="Close focus"
            title="Close (Esc)"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 bg-black">
          <TerminalView
            key={session.id}
            session={session}
            api={api}
            touchMode={touchMode}
            coarsePointer={coarsePointer}
            hasTouch={hasTouch}
            quickActionsVisible={quickActionsVisible}
            onSetQuickActionsVisible={updateQuickActionsVisible}
            onShowTouchControls={showTouchControls}
            fontSize={readStoredFontSize()}
            scrollback={readStoredScrollback()}
            cursorBlink={readStoredCursorBlink()}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
