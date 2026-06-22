import { ChevronDown, Mic, Plus } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/* Composer — bottom-of-document slash-command bar. Visual stub for v3:
 * the input is non-functional (aria-disabled). Real slash-command wiring
 * lands in a follow-up change. */

type ComposerProps = {
  placeholder?: string;
  model?: string;            /* "WorktreeOS 2.5" — rendered in the model pill */
  modelLabel?: string;
  modelStrong?: string;
  rightSlot?: ReactNode;     /* override or extend the right cluster */
  onPlusClick?: () => void;
  onMicClick?: () => void;
  className?: string;
  "data-testid"?: string;
};

function Composer({
  placeholder = "Run command…",
  model = "WorktreeOS",
  modelStrong = "2.5",
  modelLabel = "Switch model",
  rightSlot,
  onPlusClick,
  onMicClick,
  className,
  "data-testid": testId,
}: ComposerProps) {
  return (
    <div
      data-slot="composer"
      data-testid={testId}
      aria-disabled
      className={cn(
        "flex items-center gap-2 rounded-[10px] py-1.5 pl-1.5 pr-2",
        "bg-[color:var(--surface)] border border-[color:var(--hair-2)]",
        className,
      )}
    >
      <button
        type="button"
        onClick={onPlusClick}
        aria-label="Add attachment or context"
        className={cn(
          "inline-grid place-items-center size-[28px] rounded-[7px]",
          "bg-[color:var(--surface)] border border-[color:var(--hair-2)]",
          "text-[color:var(--muted-foreground)] cursor-pointer",
          "hover:bg-[color:var(--hover)] hover:text-[color:var(--ink)]",
        )}
      >
        <Plus className="size-[14px]" />
      </button>
      <div
        className="flex-1 h-7 flex items-center text-[13.5px] text-[color:var(--muted-foreground)] select-none"
        aria-label={placeholder}
      >
        {placeholder}
      </div>
      <div className="inline-flex items-center gap-1.5 text-[12.5px] text-[color:var(--muted-foreground)] pr-1">
        {rightSlot ?? (
          <>
            <button
              type="button"
              aria-label={modelLabel}
              className={cn(
                "inline-flex items-center gap-1 px-2 py-1 rounded-md cursor-pointer",
                "hover:bg-[color:var(--hover)]",
              )}
            >
              <span>{model}</span>
              <span className="text-[color:var(--ink)] font-medium">{modelStrong}</span>
              <ChevronDown className="size-3" />
            </button>
            <button
              type="button"
              onClick={onMicClick}
              aria-label="Dictate"
              className={cn(
                "inline-grid place-items-center size-[28px] rounded-full cursor-pointer",
                "bg-[color:var(--ink)] text-[color:var(--surface)]",
                "hover:brightness-[0.96]",
              )}
            >
              <Mic className="size-[13px]" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export { Composer };
export type { ComposerProps };
