import { GitBranch, GitPullRequest } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/* ContextLine — monospace info strip rendered below the Composer.
 *
 *     <ContextLine branch="shop-checkout-v2" status="running" ctxPct={52} />
 *
 * Mirrors the bottom-bar of the reference: `<git-branch> <branch> · <status>`
 * on the left, `<git-pull-request> worktree · ctx <pct>%` on the right. */

type ContextLineProps = {
  branch?: string;
  worktreeNote?: ReactNode;       /* "worktree" or custom label */
  status?: ReactNode;             /* "running", "deploying", "failed" — coloured by tone */
  statusTone?: "default" | "good" | "warn" | "bad" | "accent";
  ctxPct?: number;                /* 0–100 */
  ctxLabel?: string;
  className?: string;
  "data-testid"?: string;
};

function toneClass(tone: ContextLineProps["statusTone"] = "default"): string {
  switch (tone) {
    case "good":   return "text-[color:var(--good)]";
    case "warn":   return "text-[color:var(--warn)]";
    case "bad":    return "text-[color:var(--bad)]";
    case "accent": return "text-[color:var(--accent-cmd)]";
    default:       return "text-[color:var(--muted-foreground)]";
  }
}

function ContextLine({
  branch,
  worktreeNote = "worktree",
  status,
  statusTone = "default",
  ctxPct,
  ctxLabel,
  className,
  "data-testid": testId,
}: ContextLineProps) {
  const pct = typeof ctxPct === "number" ? Math.max(0, Math.min(100, ctxPct)) : null;
  const pctText = ctxLabel ?? (pct !== null ? `ctx ${pct}%` : null);

  return (
    <div
      data-slot="context-line"
      data-testid={testId}
      className={cn(
        "flex items-center justify-between gap-3 font-mono text-[12px] text-[color:var(--muted-foreground)] tabular-nums",
        className,
      )}
    >
      <span className="inline-flex items-center gap-1.5 min-w-0 truncate">
        {branch ? (
          <>
            <GitBranch className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{branch}</span>
          </>
        ) : null}
        {status !== undefined && status !== null ? (
          <>
            <span className="opacity-40">·</span>
            <span className={cn("truncate", toneClass(statusTone))}>{status}</span>
          </>
        ) : null}
      </span>

      <span className="inline-flex items-center gap-2 shrink-0">
        <span className="inline-flex items-center gap-1.5">
          <GitPullRequest className="size-3" aria-hidden />
          <span>{worktreeNote}</span>
        </span>
        {pctText !== null ? (
          <span className="inline-flex items-center gap-1.5 ml-1.5">
            {pct !== null ? (
              <span
                className="block w-[38px] h-[4px] rounded-[2px] bg-[color:var(--chip-bg)] overflow-hidden"
                aria-hidden
              >
                <span
                  className="block h-full bg-[color:var(--ink)] rounded-[2px]"
                  style={{ width: `${pct}%` }}
                />
              </span>
            ) : null}
            <span>{pctText}</span>
          </span>
        ) : null}
      </span>
    </div>
  );
}

export { ContextLine };
export type { ContextLineProps };
