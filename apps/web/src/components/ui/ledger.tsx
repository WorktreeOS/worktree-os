import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/* Ledger — a quiet label/value grid used for the branch posture spine on the
 * worktree work dossier (see demo/worktree-page-v3.html `.ledger`). Labels sit
 * in a muted left column; values wrap in the `--ink-2` right column. Callers
 * pass only the rows that have backing data, so empty facts simply do not
 * render. No chips, no borders — the surrounding section header carries weight. */

export interface LedgerRow {
  label: ReactNode;
  value: ReactNode;
}

export function Ledger({
  rows,
  className,
}: {
  rows: LedgerRow[];
  className?: string;
}) {
  if (rows.length === 0) return null;
  return (
    <dl
      data-testid="ledger"
      className={cn(
        "m-0 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-[22px] gap-y-1 text-[13.5px]",
        className,
      )}
    >
      {rows.map((row, i) => (
        <div key={i} className="contents">
          <dt className="text-[color:var(--muted-foreground)]">{row.label}</dt>
          <dd className="m-0 flex min-w-0 flex-wrap items-baseline gap-2 text-[color:var(--ink-2)]">
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
