import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";

import { StatusDot, type StatusDotVariant } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";

/* RuntimeSummaryLine — the deliberate demotion of runtime on the work dossier
 * (see demo/worktree-page-v3.html `.runtime`): a single bordered line carrying
 * a status dot + word, a few quiet facts (service count, a representative
 * exposed address, deploy freshness), and a handoff affordance into the Runtime
 * panel (`Open Runtime` / `Start in Runtime`). The central document SHALL NOT
 * render service rows, ports, tunnels, logs, or controls — those live in the
 * Runtime panel, and the contrast against this one line is the whole point. An
 * optional `meta` renders as a quiet line beneath the box. */

interface RuntimeSummaryLineProps {
  dotVariant: StatusDotVariant;
  /** Leading status word, e.g. `running`, `stopped`, `not started`. */
  status: string;
  /** Quiet facts shown after the status word, separated by `·`. */
  facts?: ReactNode[];
  actionLabel: string;
  onAction: () => void;
  /** Quiet runtime-meta line rendered beneath the box (config, freshness…). */
  meta?: ReactNode;
  className?: string;
  testId?: string;
}

export function RuntimeSummaryLine({
  dotVariant,
  status,
  facts = [],
  actionLabel,
  onAction,
  meta,
  className,
  testId,
}: RuntimeSummaryLineProps) {
  return (
    <>
      <div
        data-testid={testId}
        className={cn(
          "flex items-center gap-2.5 rounded-[11px] border border-[color:var(--hair-2)] px-3.5 py-[11px] text-[13.5px] text-[color:var(--ink-2)]",
          className,
        )}
      >
        <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <StatusDot variant={dotVariant} />
          <b className="font-semibold text-[color:var(--ink)]">{status}</b>
          {facts.map((fact, i) => (
            <span key={i} className="inline-flex items-center gap-2">
              <span aria-hidden className="text-[color:var(--muted-foreground)]">
                ·
              </span>
              {fact}
            </span>
          ))}
        </span>
        <button
          type="button"
          onClick={onAction}
          data-testid="runtime-summary-action"
          className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-[12.5px] font-medium text-[color:var(--ink)] underline-offset-2 hover:underline"
        >
          {actionLabel}
          <ArrowRight className="size-[13px]" strokeWidth={1.75} />
        </button>
      </div>
      {meta ? (
        <p className="m-0 mt-2 text-[12.5px] text-[color:var(--muted-foreground)]">
          {meta}
        </p>
      ) : null}
    </>
  );
}
