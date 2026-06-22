import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DiffFile, DiffHunk, DiffLine } from "@/lib/ui-api";
import { collapseDiffContext, type DiffRow } from "@/lib/review-sidebar-logic";
import {
  buildPlainTextLines,
  highlightDiffFile,
  loadLanguageSupportForPath,
  type HighlightedFragment,
  type HighlightedLines,
} from "@/lib/review-syntax-highlight";
import { segmentWordDiff, type WordSegment } from "@/lib/word-diff";

export type DiffLayout = "inline" | "split";

const STATUS_WORD: Record<DiffFile["status"], string> = {
  added: "added",
  deleted: "deleted",
  modified: "modified",
  renamed: "renamed",
  copied: "copied",
  "type-changed": "type changed",
  unknown: "changed",
};

const STATUS_DOT: Record<DiffFile["status"], string> = {
  added: "var(--good)",
  deleted: "var(--bad)",
  modified: "var(--warn)",
  renamed: "var(--ink-2)",
  copied: "var(--ink-2)",
  "type-changed": "var(--ink-2)",
  unknown: "var(--muted-foreground)",
};

function useFileHighlight(file: DiffFile): HighlightedLines {
  const plain = useMemo(() => buildPlainTextLines(file), [file]);
  const [highlighted, setHighlighted] = useState<HighlightedLines | null>(null);
  useEffect(() => {
    if (file.binary || !file.isText) {
      setHighlighted(null);
      return;
    }
    let cancelled = false;
    setHighlighted(null);
    void loadLanguageSupportForPath(file.newPath, file.oldPath).then(
      (support) => {
        if (cancelled || !support) return;
        setHighlighted(highlightDiffFile(file, support));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [file]);
  return highlighted ?? plain;
}

function PathCopyButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  }, [path]);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={copied ? "Path copied" : "Copy file path"}
      title={copied ? "Copied" : "Copy path"}
      data-testid="diff-detail-copy"
      className="inline-grid size-[22px] place-items-center rounded-md text-[color:var(--muted-foreground)] hover:bg-[color:var(--hover)] hover:text-[color:var(--ink)]"
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  );
}

/**
 * Single-file diff detail pane. Renders the file header (status word, path,
 * `+N` / `−N`, copy path, Mark reviewed) and the inline or split diff body,
 * reusing the shared CodeMirror highlight and `collapseDiffContext`. Read-only.
 */
export function DiffDetail({
  file,
  layout,
  reviewed,
  onToggleReviewed,
  variant = "pane",
}: {
  file: DiffFile;
  layout: DiffLayout;
  reviewed: boolean;
  onToggleReviewed: () => void;
  /** `pane`: standalone scrollable detail. `stacked`: one section in the
   * all-files unified view, with a sticky header and a non-scrolling body. */
  variant?: "pane" | "stacked";
}) {
  const highlightedLines = useFileHighlight(file);
  const path = file.newPath ?? file.oldPath ?? "(unknown)";
  const subtitle =
    file.status === "renamed" && file.oldPath && file.newPath
      ? `${file.oldPath} → ${file.newPath}`
      : null;
  const stacked = variant === "stacked";

  return (
    <div
      data-testid="diff-detail"
      data-file-id={file.id}
      className={cn(
        stacked
          ? "flex flex-col border-b border-[color:var(--hair)] last:border-b-0"
          : "flex min-h-0 min-w-0 flex-1 flex-col",
      )}
    >
      <div
        className={cn(
          "flex shrink-0 items-center gap-2.5 border-b border-[color:var(--hair)] px-3.5 py-2.5",
          stacked &&
            "sticky top-0 z-[1] bg-[color:var(--surface)]/95 backdrop-blur",
        )}
      >
        <span
          className="inline-flex items-center gap-1.5 text-[12px] text-[color:var(--ink-2)]"
          data-testid="diff-detail-status"
        >
          <span
            aria-hidden
            className="inline-block size-[7px] rounded-full"
            style={{ background: STATUS_DOT[file.status] }}
          />
          {STATUS_WORD[file.status]}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-[color:var(--ink)]"
          title={subtitle ?? path}
        >
          {path}
        </span>
        <span className="shrink-0 font-mono text-[11.5px] tabular-nums">
          {file.additions > 0 && (
            <span className="text-[color:var(--good)]">+{file.additions}</span>
          )}
          {file.deletions > 0 && (
            <span className="ml-1 text-[color:var(--bad)]">−{file.deletions}</span>
          )}
        </span>
        <PathCopyButton path={path} />
        <button
          type="button"
          onClick={onToggleReviewed}
          aria-pressed={reviewed}
          data-testid="diff-detail-reviewed"
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px]",
            reviewed
              ? "text-[color:var(--good)]"
              : "text-[color:var(--muted-foreground)] hover:bg-[color:var(--hover)] hover:text-[color:var(--ink)]",
          )}
          title={reviewed ? "Reviewed (v)" : "Mark reviewed (v)"}
        >
          <Check className="size-[13px]" />
          {reviewed ? "Reviewed" : "Mark reviewed"}
        </button>
      </div>

      <div
        className={cn(!stacked && "min-h-0 flex-1 overflow-auto")}
        data-testid="diff-detail-body"
      >
        {file.binary || !file.isText ? (
          <NonTextRow file={file} />
        ) : layout === "split" ? (
          file.hunks.map((hunk) => (
            <SplitHunk
              key={hunk.id}
              hunk={hunk}
              highlightedLines={highlightedLines}
            />
          ))
        ) : (
          file.hunks.map((hunk) => (
            <InlineHunk
              key={hunk.id}
              hunk={hunk}
              highlightedLines={highlightedLines}
            />
          ))
        )}
      </div>
    </div>
  );
}

function NonTextRow({ file }: { file: DiffFile }) {
  let label = "Binary file";
  if (file.status === "renamed") label = "File renamed";
  else if (file.status === "type-changed") label = "File type changed";
  else if (!file.isText && !file.binary) label = "Diff unavailable";
  return (
    <div
      data-testid="diff-detail-non-text"
      className="px-3.5 py-2.5 font-mono text-[12px] text-[color:var(--muted-foreground)]"
    >
      {label}
    </div>
  );
}

function HunkHeader({ hunk }: { hunk: DiffHunk }) {
  return (
    <div className="bg-[color:var(--shell)] px-3.5 py-1 font-mono text-[10.5px] text-[color:var(--muted-foreground)]">
      @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
      {hunk.header ? ` ${hunk.header}` : ""}
    </div>
  );
}

function InlineHunk({
  hunk,
  highlightedLines,
}: {
  hunk: DiffHunk;
  highlightedLines: HighlightedLines;
}) {
  const rows = useMemo(() => collapseDiffContext(hunk.lines), [hunk.lines]);
  const pairs = useMemo(() => wordDiffPairs(hunk.lines), [hunk.lines]);
  return (
    <div className="border-t border-[color:var(--hair)] first:border-t-0">
      <HunkHeader hunk={hunk} />
      <div className="font-mono text-[12px]">
        {rows.map((row, idx) =>
          row.kind === "collapsed" ? (
            <CollapsedRow key={`c-${idx}`} count={row.count} cols={1} />
          ) : (
            <InlineLine
              key={row.line.id}
              line={row.line}
              fragments={highlightedLines.get(row.line.id)}
              words={pairs.get(row.line.id)}
            />
          ),
        )}
      </div>
    </div>
  );
}

function InlineLine({
  line,
  fragments,
  words,
}: {
  line: DiffLine;
  fragments: HighlightedFragment[] | undefined;
  words: WordSegment[] | undefined;
}) {
  if (line.kind === "no-newline") {
    return (
      <div className="bg-[color:var(--shell)] px-3.5 py-0.5 text-[11px] text-[color:var(--muted-foreground)]">
        \ No newline at end of file
      </div>
    );
  }
  const tone =
    line.kind === "add"
      ? "bg-[color:color-mix(in_oklch,var(--good)_9%,transparent)]"
      : line.kind === "delete"
        ? "bg-[color:color-mix(in_oklch,var(--bad)_9%,transparent)]"
        : "";
  const marker = line.kind === "add" ? "+" : line.kind === "delete" ? "−" : " ";
  const markerCls =
    line.kind === "add"
      ? "text-[color:var(--good)]"
      : line.kind === "delete"
        ? "text-[color:var(--bad)]"
        : "text-[color:var(--muted-foreground)]/60";
  return (
    <div className={cn("grid grid-cols-[44px_44px_1fr]", tone)}>
      <span className="select-none border-r border-[color:var(--hair)] px-2 text-right text-[10px] tabular-nums text-[color:var(--muted-foreground)]/70">
        {line.oldLine ?? ""}
      </span>
      <span className="select-none border-r border-[color:var(--hair)] px-2 text-right text-[10px] tabular-nums text-[color:var(--muted-foreground)]/70">
        {line.newLine ?? ""}
      </span>
      <span className="whitespace-pre px-2 py-0.5">
        <span className={cn("mr-1 select-none font-bold", markerCls)}>
          {marker}
        </span>
        <LineContent line={line} fragments={fragments} words={words} />
      </span>
    </div>
  );
}

/** One side-by-side row: matched delete (left) and add (right), or context. */
type SplitRow =
  | { kind: "collapsed"; count: number }
  | { kind: "full"; line: DiffLine }
  | { kind: "pair"; left?: DiffLine; right?: DiffLine };

function buildSplitRows(rows: DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i += 1) {
      out.push({ kind: "pair", left: dels[i], right: adds[i] });
    }
    dels = [];
    adds = [];
  };
  for (const row of rows) {
    if (row.kind === "collapsed") {
      flush();
      out.push({ kind: "collapsed", count: row.count });
      continue;
    }
    const line = row.line;
    if (line.kind === "delete") {
      dels.push(line);
    } else if (line.kind === "add") {
      adds.push(line);
    } else {
      flush();
      out.push({ kind: "full", line });
    }
  }
  flush();
  return out;
}

function SplitHunk({
  hunk,
  highlightedLines,
}: {
  hunk: DiffHunk;
  highlightedLines: HighlightedLines;
}) {
  const collapsed = useMemo(() => collapseDiffContext(hunk.lines), [hunk.lines]);
  const rows = useMemo(() => buildSplitRows(collapsed), [collapsed]);
  const words = useMemo(() => wordDiffPairs(hunk.lines), [hunk.lines]);
  return (
    <div className="border-t border-[color:var(--hair)] first:border-t-0">
      <HunkHeader hunk={hunk} />
      <div className="font-mono text-[12px]">
        {rows.map((row, idx) => {
          if (row.kind === "collapsed") {
            return <CollapsedRow key={`c-${idx}`} count={row.count} cols={2} />;
          }
          if (row.kind === "full") {
            const line = row.line;
            if (line.kind === "no-newline") {
              return (
                <div
                  key={`nl-${idx}`}
                  className="bg-[color:var(--shell)] px-3.5 py-0.5 text-[11px] text-[color:var(--muted-foreground)]"
                >
                  \ No newline at end of file
                </div>
              );
            }
            const frags = highlightedLines.get(line.id);
            return (
              <div
                key={line.id}
                className="grid grid-cols-[38px_1fr_38px_1fr]"
              >
                <SplitGutter n={line.oldLine} />
                <SplitCell
                  line={line}
                  fragments={frags}
                  words={undefined}
                  side="context"
                />
                <SplitGutter n={line.newLine} />
                <SplitCell
                  line={line}
                  fragments={frags}
                  words={undefined}
                  side="context"
                />
              </div>
            );
          }
          const left = row.left;
          const right = row.right;
          return (
            <div key={`p-${idx}`} className="grid grid-cols-[38px_1fr_38px_1fr]">
              <SplitGutter n={left?.oldLine} />
              {left ? (
                <SplitCell
                  line={left}
                  fragments={highlightedLines.get(left.id)}
                  words={words.get(left.id)}
                  side="delete"
                />
              ) : (
                <span className="bg-[color:var(--shell)]/40" />
              )}
              <SplitGutter n={right?.newLine} />
              {right ? (
                <SplitCell
                  line={right}
                  fragments={highlightedLines.get(right.id)}
                  words={words.get(right.id)}
                  side="add"
                />
              ) : (
                <span className="bg-[color:var(--shell)]/40" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SplitGutter({ n }: { n: number | undefined }) {
  return (
    <span className="select-none border-r border-[color:var(--hair)] px-1.5 text-right text-[10px] tabular-nums text-[color:var(--muted-foreground)]/70">
      {n ?? ""}
    </span>
  );
}

function SplitCell({
  line,
  fragments,
  words,
  side,
}: {
  line: DiffLine;
  fragments: HighlightedFragment[] | undefined;
  words: WordSegment[] | undefined;
  side: "add" | "delete" | "context";
}) {
  const tone =
    side === "add"
      ? "bg-[color:color-mix(in_oklch,var(--good)_9%,transparent)]"
      : side === "delete"
        ? "bg-[color:color-mix(in_oklch,var(--bad)_9%,transparent)]"
        : "";
  return (
    <span className={cn("whitespace-pre px-2 py-0.5", tone)}>
      <LineContent line={line} fragments={fragments} words={words} />
    </span>
  );
}

function CollapsedRow({ count, cols }: { count: number; cols: 1 | 2 }) {
  return (
    <div
      data-testid="review-collapsed-row"
      className={cn(
        "bg-[color:var(--shell)] px-3.5 py-1 text-center text-[11px] text-[color:var(--muted-foreground)]",
        cols === 2 && "col-span-full",
      )}
    >
      {count} unmodified lines
    </div>
  );
}

/** Pre-compute word-diff segments for paired delete/add lines in a hunk. */
function wordDiffPairs(lines: readonly DiffLine[]): Map<string, WordSegment[]> {
  const map = new Map<string, WordSegment[]>();
  for (let i = 0; i < lines.length; i += 1) {
    const a = lines[i]!;
    const b = lines[i + 1];
    if (a.kind === "delete" && b && b.kind === "add") {
      const seg = segmentWordDiff(a.content, b.content);
      if (seg) {
        map.set(a.id, seg.removed);
        map.set(b.id, seg.added);
      }
    }
  }
  return map;
}

function LineContent({
  line,
  fragments,
  words,
}: {
  line: DiffLine;
  fragments: HighlightedFragment[] | undefined;
  words: WordSegment[] | undefined;
}) {
  // Word-diff emphasis takes precedence when available (changed line pairs);
  // otherwise fall back to CodeMirror token fragments, then plain text.
  if (words && words.length > 0) {
    return (
      <>
        {words.map((seg, idx) =>
          seg.emphasis ? (
            <span
              key={idx}
              className="rounded-[2px] bg-[color:color-mix(in_oklch,var(--ink)_12%,transparent)]"
            >
              {seg.text}
            </span>
          ) : (
            <span key={idx}>{seg.text}</span>
          ),
        )}
      </>
    );
  }
  if (!fragments || fragments.length === 0) {
    return <>{line.content}</>;
  }
  return (
    <>
      {fragments.map((fragment, idx) =>
        fragment.className ? (
          <span key={idx} className={fragment.className}>
            {fragment.text}
          </span>
        ) : (
          <span key={idx}>{fragment.text}</span>
        ),
      )}
    </>
  );
}
