import { ChevronDown } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

/* SplitButton — pair of buttons sharing one hairline outline.
 * Left side is the primary action, right side opens a menu (chevron).
 * Used for `Stop ▾` in the worktree action row. */

type SplitButtonProps = {
  children: ReactNode;
  onClick?: ComponentProps<"button">["onClick"];
  onMenuClick?: ComponentProps<"button">["onClick"];
  disabled?: boolean;
  menuDisabled?: boolean;
  menuLabel?: string;
  tone?: "default" | "danger";
  className?: string;
  "data-testid"?: string;
};

function SplitButton({
  children,
  onClick,
  onMenuClick,
  disabled,
  menuDisabled,
  menuLabel = "Open menu",
  tone = "default",
  className,
  "data-testid": testId,
}: SplitButtonProps) {
  const toneText = tone === "danger" ? "text-[color:var(--bad)]" : "text-[color:var(--ink)]";

  return (
    <div
      data-slot="split-button"
      data-testid={testId}
      className={cn(
        "inline-flex items-stretch h-[30px] rounded-lg overflow-hidden",
        "bg-[color:var(--surface)] border border-[color:var(--hair-2)]",
        "transition-[background-color] duration-150",
        className,
      )}
    >
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cn(
          "inline-flex items-center gap-1.5 px-3 text-[13px] font-medium cursor-pointer bg-transparent border-0",
          toneText,
          "hover:bg-[color:var(--hover)] disabled:opacity-50 disabled:pointer-events-none",
        )}
      >
        {children}
      </button>
      <span className="w-px self-stretch bg-[color:var(--hair-2)]" aria-hidden />
      <button
        type="button"
        onClick={onMenuClick}
        disabled={menuDisabled ?? disabled}
        aria-label={menuLabel}
        className={cn(
          "inline-grid place-items-center px-2 cursor-pointer bg-transparent border-0",
          "text-[color:var(--muted-foreground)] hover:bg-[color:var(--hover)] hover:text-[color:var(--ink)]",
          "disabled:opacity-50 disabled:pointer-events-none",
        )}
      >
        <ChevronDown className="size-[13px]" />
      </button>
    </div>
  );
}

export { SplitButton };
export type { SplitButtonProps };
