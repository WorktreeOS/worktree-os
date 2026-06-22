import { createPortal } from "react-dom";
import { useEffect, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/* BottomSheet — the bottom-anchored sheet for the mobile navigation shell
 * (navigator, Sessions, More). It is always bottom-anchored because its
 * triggers live in the bottom navigation bar, which is `lg:hidden`. Scrim +
 * grabber, a slide-up that degrades under `prefers-reduced-motion`
 * (`bottom-sheet-in`, neutralized by the reduced-motion guard in index.css),
 * and `env(safe-area-inset-bottom)` padding so content clears the home
 * indicator. Mirrors `demo/mobile-nav.html` `.sheet`. Heavier centered dialogs
 * (deploy / remove) keep using `ModalShell`. */
export function BottomSheet({
  testId,
  ariaLabel,
  onClose,
  className,
  children,
}: {
  testId?: string;
  ariaLabel?: string;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      data-testid={testId}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={cn(
          "bottom-sheet-in flex max-h-[82%] w-full flex-col overflow-hidden",
          "rounded-t-[22px] border border-[color:var(--hair-2)] bg-[color:var(--surface)] text-[color:var(--ink)]",
          "shadow-[0_-20px_54px_-22px_rgba(0,0,0,0.45)]",
          "pb-[env(safe-area-inset-bottom)]",
          className,
        )}
      >
        <div className="flex shrink-0 justify-center pt-2.5">
          <button
            type="button"
            aria-label="Close"
            data-testid={testId ? `${testId}-grabber` : undefined}
            onClick={onClose}
            className="h-1 w-9 cursor-grab rounded-full bg-[color:var(--hair-2)]"
          />
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
