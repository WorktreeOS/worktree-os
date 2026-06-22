import { Check, CheckCircle2, Circle, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  allStagedState,
  changeTotals,
  diffBarCells,
  isStaged,
  reviewedProgress,
  type ChangeEntry,
} from "@/lib/review-explorer-logic";

const STATUS_CHAR: Record<ChangeEntry["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  "type-changed": "T",
  unknown: "?",
};

const STATUS_CLASS: Record<ChangeEntry["status"], string> = {
  added: "text-[color:var(--good)]",
  modified: "text-[color:var(--warn)]",
  deleted: "text-[color:var(--bad)]",
  renamed: "text-[color:var(--ink-2)]",
  copied: "text-[color:var(--ink-2)]",
  "type-changed": "text-[color:var(--ink-2)]",
  unknown: "text-[color:var(--muted-foreground)]",
};

function splitPath(path: string): { dir: string; name: string } {
  const idx = path.lastIndexOf("/");
  if (idx === -1) return { dir: "", name: path };
  return { dir: path.slice(0, idx + 1), name: path.slice(idx + 1) };
}

/**
 * The Review tab's changed-files explorer: a `Changes` header (totals, tri-state
 * `All staged`, reviewed progress) over a scrollable list of change rows (stage
 * checkbox, status glyph, path, `+N` / `−N`, 5-cell diff bar, reviewed glyph).
 * Presentational — staging / selection / reviewed actions are owned by the
 * parent route surface.
 */
export function ReviewExplorer({
  changes,
  activeId,
  viewed,
  staging,
  onSelect,
  onToggleStage,
  onToggleAllStaged,
  onToggleReviewed,
}: {
  changes: ChangeEntry[];
  activeId: string | null;
  viewed: ReadonlySet<string>;
  staging: ReadonlySet<string>;
  onSelect: (path: string) => void;
  onToggleStage: (entry: ChangeEntry) => void;
  onToggleAllStaged: () => void;
  onToggleReviewed: (path: string) => void;
}) {
  const totals = changeTotals(changes);
  const allState = allStagedState(changes);
  const progress = reviewedProgress(changes, viewed);
  const reviewedPct =
    progress.total === 0 ? 0 : Math.round((100 * progress.reviewed) / progress.total);

  return (
    <div
      data-testid="review-explorer"
      className="grid min-h-0 grid-rows-[auto_1fr] border-r border-[color:var(--hair)] bg-[color:var(--shell)]"
    >
      <div className="flex flex-col gap-2 border-b border-[color:var(--hair)] px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-semibold text-[color:var(--ink)]">
            Changes
          </span>
          <span className="flex-1" />
          <span className="font-mono text-[11.5px] tabular-nums">
            <span className="text-[color:var(--good)]" data-testid="review-explorer-add">
              +{totals.additions}
            </span>
            <span
              className="ml-1 text-[color:var(--bad)]"
              data-testid="review-explorer-del"
            >
              −{totals.deletions}
            </span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggleAllStaged}
            data-testid="review-stage-all"
            data-state={allState}
            disabled={changes.length === 0}
            className="inline-flex items-center gap-1.5 text-[11.5px] text-[color:var(--ink-2)] disabled:opacity-50"
          >
            <TriStateBox state={allState} />
            All staged
          </button>
          <span className="flex-1" />
          <span
            className="inline-flex items-center gap-1.5 text-[11px] text-[color:var(--muted-foreground)]"
            data-testid="review-reviewed-progress"
          >
            {progress.reviewed} reviewed
            <span className="h-[4px] w-[46px] overflow-hidden rounded-full bg-[color:var(--hair-2)]">
              <span
                className="block h-full rounded-full bg-[color:var(--ink-2)] transition-[width] duration-200"
                style={{ width: `${reviewedPct}%` }}
              />
            </span>
          </span>
        </div>
      </div>

      <div className="min-h-0 overflow-auto p-1.5" data-testid="review-explorer-list">
        {changes.length === 0 ? (
          <div
            data-testid="review-explorer-empty"
            className="flex flex-col items-center gap-2 px-3 py-8 text-center"
          >
            <Check className="size-4 text-[color:var(--good)]" />
            <span className="text-[12.5px] text-[color:var(--ink-2)]">
              working tree clean
            </span>
          </div>
        ) : (
          changes.map((entry) => (
            <ExplorerRow
              key={entry.path}
              entry={entry}
              active={entry.path === activeId}
              viewed={viewed.has(entry.path)}
              staging={staging.has(entry.path)}
              onSelect={() => onSelect(entry.path)}
              onToggleStage={() => onToggleStage(entry)}
              onToggleReviewed={() => onToggleReviewed(entry.path)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function TriStateBox({ state }: { state: "all" | "some" | "none" }) {
  const filled = state !== "none";
  return (
    <span
      aria-hidden
      className={cn(
        "inline-grid size-[15px] place-items-center rounded-[4px] border",
        filled
          ? "border-[color:var(--ink)] bg-[color:var(--ink)] text-[color:var(--surface)]"
          : "border-[color:var(--hair-2)] bg-[color:var(--surface)]",
      )}
    >
      {state === "all" && <Check className="size-[10px]" />}
      {state === "some" && <Minus className="size-[10px]" />}
    </span>
  );
}

function ExplorerRow({
  entry,
  active,
  viewed,
  staging,
  onSelect,
  onToggleStage,
  onToggleReviewed,
}: {
  entry: ChangeEntry;
  active: boolean;
  viewed: boolean;
  staging: boolean;
  onSelect: () => void;
  onToggleStage: () => void;
  onToggleReviewed: () => void;
}) {
  const staged = isStaged(entry);
  const { dir, name } = splitPath(entry.path);
  const cells = diffBarCells(entry.additions, entry.deletions);
  return (
    <div
      data-testid="review-explorer-row"
      data-path={entry.path}
      data-active={active ? "true" : "false"}
      data-viewed={viewed ? "true" : "false"}
      onClick={onSelect}
      className={cn(
        "relative grid cursor-pointer grid-cols-[auto_auto_1fr_auto] items-center gap-2.5 rounded-lg px-2 py-[7px] max-lg:py-2.5",
        "hover:bg-[color:var(--hover)]",
        active &&
          "bg-[color:var(--surface)] shadow-[inset_0_0_0_1px_var(--hair-2)] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[2.5px] before:rounded-full before:bg-[color:var(--ink)] before:content-['']",
        viewed && "opacity-[0.72] hover:opacity-100",
      )}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleStage();
        }}
        aria-pressed={staged}
        aria-label={staged ? "Unstage file" : "Stage file"}
        data-testid="review-stage-checkbox"
        data-staged={staged ? "true" : "false"}
        disabled={staging}
        className={cn(
          "inline-grid size-[16px] max-lg:size-[20px] place-items-center rounded-[4px] border shrink-0 disabled:opacity-50",
          staged
            ? "border-[color:var(--ink)] bg-[color:var(--ink)] text-[color:var(--surface)]"
            : "border-[color:var(--hair-2)] bg-[color:var(--surface)]",
          entry.staged === "partial" && "opacity-80",
        )}
      >
        {staged &&
          (entry.staged === "partial" ? (
            <Minus className="size-[10px]" />
          ) : (
            <Check className="size-[10px]" />
          ))}
      </button>
      <span
        className={cn(
          "w-3 text-center font-mono text-[11px] font-semibold",
          STATUS_CLASS[entry.status],
        )}
        title={entry.status}
      >
        {STATUS_CHAR[entry.status]}
      </span>
      <span
        className={cn(
          "min-w-0 truncate text-[12.5px] leading-[1.35]",
          viewed ? "text-[color:var(--muted-foreground)]" : "text-[color:var(--ink-2)]",
        )}
        title={entry.path}
      >
        {dir && <span className="text-[color:var(--muted-foreground)]">{dir}</span>}
        <b
          className={cn(
            "font-semibold text-[color:var(--ink)]",
            viewed && "font-medium text-[color:var(--muted-foreground)] line-through",
          )}
        >
          {name}
        </b>
      </span>
      <span className="inline-flex items-center gap-2">
        <span className="font-mono text-[10.5px] tabular-nums">
          <span className="text-[color:var(--good)]">+{entry.additions}</span>
          <span className="ml-1 text-[color:var(--bad)]">−{entry.deletions}</span>
        </span>
        <span aria-hidden className="inline-flex gap-[1.5px]">
          {cells.map((c, i) => (
            <span
              key={i}
              className={cn(
                "inline-block h-[9px] w-[5px] rounded-[1.5px]",
                c === "g" && "bg-[color:var(--good)]",
                c === "r" && "bg-[color:var(--bad)]",
                c === "o" && "bg-[color:var(--hair-2)]",
              )}
            />
          ))}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleReviewed();
          }}
          aria-pressed={viewed}
          aria-label={viewed ? "Reviewed" : "Mark reviewed"}
          title={viewed ? "Reviewed" : "Mark reviewed (v)"}
          data-testid="review-row-reviewed"
          className={cn(
            "inline-grid w-4 max-lg:size-7 max-lg:rounded-md place-items-center",
            viewed
              ? "text-[color:var(--good)]"
              : "text-[color:var(--muted-foreground)]/60 hover:text-[color:var(--ink)]",
          )}
        >
          {viewed ? (
            <CheckCircle2 className="size-[13px]" />
          ) : (
            <Circle className="size-[13px]" />
          )}
        </button>
      </span>
    </div>
  );
}
