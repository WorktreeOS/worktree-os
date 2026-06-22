import { createPortal } from "react-dom";
import { type CSSProperties, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { useVisualViewportHeight } from "@/lib/use-visual-viewport";

/* Bottom-sheet on small screens, centered dialog on md+. Renders the v3
 * white surface, hairline border, soft shadow. The sheet grabber appears
 * only on the mobile bottom-sheet variant.
 *
 * When `fullHeight` is set the small-screen layout becomes a top-anchored
 * full-height sheet sized to the visual viewport, so an autofocused search
 * field stays above the on-screen keyboard instead of being covered by it.
 * Callers using `fullHeight` own their own close affordance (the full-screen
 * sheet leaves no backdrop to tap on mobile). md+ keeps the centered dialog. */

export function ModalShell({
  testId,
  ariaLabel,
  submitting,
  onCancel,
  className,
  fullHeight = false,
  children,
}: {
  testId?: string;
  ariaLabel?: string;
  submitting: boolean;
  onCancel: () => void;
  className?: string;
  /** Top-anchored, keyboard-safe full-height sheet on small screens. */
  fullHeight?: boolean;
  children: ReactNode;
}) {
  const viewportHeight = useVisualViewportHeight(fullHeight);
  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-50 flex justify-center bg-black/45 backdrop-blur-sm md:items-center md:p-4",
        fullHeight ? "items-start p-0" : "items-end p-0",
      )}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      data-testid={testId}
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onCancel();
      }}
    >
      <div
        className={cn(
          "reveal w-full overflow-hidden",
          "bg-[color:var(--surface)] text-[color:var(--ink)]",
          "border border-[color:var(--hair-2)]",
          "shadow-[0_30px_60px_-28px_rgba(0,0,0,0.45)]",
          fullHeight
            ? "flex h-[var(--sheet-h,100dvh)] max-w-none flex-col rounded-none md:h-auto md:max-w-md md:rounded-[14px]"
            : "max-w-lg rounded-t-[22px] md:rounded-[14px]",
          className,
        )}
        style={
          fullHeight && viewportHeight
            ? ({ "--sheet-h": `${viewportHeight}px` } as CSSProperties)
            : undefined
        }
      >
        {!fullHeight && (
          <div className="flex justify-center pt-2.5 md:hidden">
            <div className="h-1 w-9 rounded-full bg-[color:var(--hair-2)]" />
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}
