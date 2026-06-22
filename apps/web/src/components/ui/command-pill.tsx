import { RefreshCcw } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { IconButton } from "./icon-button";

/* CommandPill — `/cmd <arg>` row with amber-orange prefix and a right-side
 * metadata + refresh icon. Acts as the top-of-document marker that this
 * surface is the live state of a specific command. */

type CommandPillProps = {
  name: string;             /* "/worktree-start" — includes leading slash */
  args?: ReactNode;         /* "shop-checkout-v2" — plain text or chips */
  meta?: ReactNode;         /* "11:42" or "in progress · 00:47" */
  action?: ReactNode;       /* override the right-side icon */
  onRefresh?: () => void;
  refreshLabel?: string;
  refreshDisabled?: boolean;
  className?: string;
  "data-testid"?: string;
};

function CommandPill({
  name,
  args,
  meta,
  action,
  onRefresh,
  refreshLabel = "Re-run command",
  refreshDisabled,
  className,
  "data-testid": testId,
}: CommandPillProps) {
  return (
    <div
      data-slot="command-pill"
      data-testid={testId}
      className={cn(
        "flex items-center gap-2.5 rounded-[10px] px-3.5 py-2.5",
        "bg-[color:var(--surface)] border border-[color:var(--hair-2)]",
        "font-mono text-[13px]",
        className,
      )}
    >
      <span className="font-medium text-[color:var(--accent-cmd)]">{name}</span>
      {args !== undefined && args !== null ? (
        <span className="text-[color:var(--ink)]">{args}</span>
      ) : null}
      <span className="ml-auto inline-flex items-center gap-1 text-[color:var(--muted-foreground)]">
        {meta !== undefined && meta !== null ? (
          <span className="text-[11.5px] tabular-nums">{meta}</span>
        ) : null}
        {action !== undefined && action !== null
          ? action
          : onRefresh
            ? (
                <IconButton
                  size="sm"
                  onClick={onRefresh}
                  disabled={refreshDisabled}
                  aria-label={refreshLabel}
                >
                  <RefreshCcw />
                </IconButton>
              )
            : null}
      </span>
    </div>
  );
}

export { CommandPill };
export type { CommandPillProps };
