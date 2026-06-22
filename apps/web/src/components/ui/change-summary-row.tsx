import { cn } from "@/lib/utils";

/* ChangeSummaryRow — one changed file in the dossier's Branch & changes
 * preview (see demo/worktree-page-v3.html `.change`): a monospace path, the
 * `+N` / `−M` counts in the `--good` / `--bad` text colours, and a 5-cell diff
 * bar whose green/red split mirrors the additions/deletions ratio. Purely
 * presentational — the parent gates this on Review diff data that is already
 * loaded, so rendering it never triggers a new request. */

const SEGMENTS = 5;

type Cell = "g" | "r" | "o";

/** Split SEGMENTS cells between additions (green) and deletions (red),
 * leaving neutral cells when there is no change at all. */
function diffBar(additions: number, deletions: number): Cell[] {
  const total = additions + deletions;
  if (total <= 0) return Array<Cell>(SEGMENTS).fill("o");
  let g = Math.round((additions / total) * SEGMENTS);
  if (additions > 0 && g === 0) g = 1;
  if (additions === 0) g = 0;
  let r = SEGMENTS - g;
  if (deletions === 0) r = 0;
  const cells: Cell[] = [];
  for (let i = 0; i < g; i++) cells.push("g");
  for (let i = 0; i < r; i++) cells.push("r");
  while (cells.length < SEGMENTS) cells.push("o");
  return cells.slice(0, SEGMENTS);
}

export function ChangeSummaryRow({
  path,
  additions,
  deletions,
  className,
}: {
  path: string;
  additions: number;
  deletions: number;
  className?: string;
}) {
  const cells = diffBar(additions, deletions);
  return (
    <div
      data-testid="change-summary-row"
      data-path={path}
      className={cn(
        "grid grid-cols-[1fr_auto_auto] items-center gap-3.5 border-t border-[color:var(--hair)] py-[9px] first:border-t-0",
        className,
      )}
    >
      <span
        className="truncate font-mono text-[12.5px] text-[color:var(--ink-2)]"
        title={path}
      >
        {path}
      </span>
      <span className="inline-flex gap-1.5 font-mono text-[12px] tabular-nums">
        {additions > 0 ? (
          <span className="text-[color:var(--good)]">+{additions}</span>
        ) : null}
        {deletions > 0 ? (
          <span className="text-[color:var(--bad)]">−{deletions}</span>
        ) : null}
      </span>
      <span aria-hidden className="inline-flex gap-0.5">
        {cells.map((c, i) => (
          <span
            key={i}
            className={cn(
              "inline-block h-[9px] w-[5px] rounded-[1px]",
              c === "g" && "bg-[color:var(--good)]",
              c === "r" && "bg-[color:var(--bad)]",
              c === "o" && "bg-[color:var(--hair-2)]",
            )}
          />
        ))}
      </span>
    </div>
  );
}
