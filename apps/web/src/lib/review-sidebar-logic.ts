import type { DiffLine } from "./ui-api";

export const REVIEW_WIDTH_STORAGE_KEY = "wos.review-sidebar.width";
export const REVIEW_MIN_WIDTH = 320;
export const REVIEW_DEFAULT_WIDTH = 480;
/** Width reserved for the services list + minimum logs column. */
export const REVIEW_RESERVED_LAYOUT = 720;
export const CONTEXT_THRESHOLD = 6;
export const COLLAPSED_HEAD_TAIL = 3;
/** How many changed files the Review sidebar shows per page. */
export const REVIEW_FILES_PER_PAGE = 10;

export interface ReviewVisibleRange {
  /** Inclusive 0-based start index into the active `DiffSet.files`. */
  startIndex: number;
  /** Exclusive 0-based end index into the active `DiffSet.files`. */
  endIndex: number;
  /** 1-based display position of the first visible file. */
  startDisplay: number;
  /** 1-based display position of the last visible file. */
  endDisplay: number;
}

export function getReviewPageCount(
  totalFiles: number,
  perPage: number = REVIEW_FILES_PER_PAGE,
): number {
  if (totalFiles <= 0 || perPage <= 0) return 1;
  return Math.max(1, Math.ceil(totalFiles / perPage));
}

export function clampReviewPage(
  page: number,
  totalFiles: number,
  perPage: number = REVIEW_FILES_PER_PAGE,
): number {
  const pages = getReviewPageCount(totalFiles, perPage);
  if (!Number.isFinite(page) || page < 0) return 0;
  return Math.min(Math.max(0, Math.floor(page)), pages - 1);
}

export function getReviewVisibleRange(
  page: number,
  totalFiles: number,
  perPage: number = REVIEW_FILES_PER_PAGE,
): ReviewVisibleRange {
  if (totalFiles <= 0 || perPage <= 0) {
    return { startIndex: 0, endIndex: 0, startDisplay: 0, endDisplay: 0 };
  }
  const safePage = clampReviewPage(page, totalFiles, perPage);
  const startIndex = safePage * perPage;
  const endIndex = Math.min(startIndex + perPage, totalFiles);
  return {
    startIndex,
    endIndex,
    startDisplay: startIndex + 1,
    endDisplay: endIndex,
  };
}

/** Find the page number that contains the file at `index`. */
export function getPageForFileIndex(
  index: number,
  perPage: number = REVIEW_FILES_PER_PAGE,
): number {
  if (index < 0 || perPage <= 0) return 0;
  return Math.floor(index / perPage);
}

export function clampReviewWidth(raw: number, viewport: number): number {
  const upper = Math.max(REVIEW_MIN_WIDTH, viewport - REVIEW_RESERVED_LAYOUT);
  if (!Number.isFinite(raw)) {
    return Math.min(REVIEW_DEFAULT_WIDTH, upper);
  }
  return Math.min(Math.max(raw, REVIEW_MIN_WIDTH), upper);
}

export function readStoredReviewWidth(
  storage?: Pick<Storage, "getItem"> | null,
): number | null {
  const store =
    storage ??
    (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return null;
  try {
    const raw = store.getItem(REVIEW_WIDTH_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function persistReviewWidth(
  width: number,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  const store =
    storage ??
    (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return;
  try {
    store.setItem(REVIEW_WIDTH_STORAGE_KEY, String(Math.round(width)));
  } catch {
    /* storage unavailable */
  }
}

export type DiffRow =
  | { kind: "collapsed"; count: number }
  | { kind: "line"; line: DiffLine };

/**
 * Collapse long runs of unchanged context lines into single `collapsed` rows.
 * Runs at the very start/end of a hunk are collapsed without a head/tail so the
 * hunk does not waste rows showing context the diff already implies.
 */
export function collapseDiffContext(lines: readonly DiffLine[]): DiffRow[] {
  if (lines.length === 0) return [];
  const out: DiffRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.kind !== "context") {
      out.push({ kind: "line", line });
      i += 1;
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j]!.kind === "context") j += 1;
    const runLength = j - i;
    if (runLength <= CONTEXT_THRESHOLD) {
      for (let k = i; k < j; k += 1) {
        out.push({ kind: "line", line: lines[k]! });
      }
    } else {
      const isFirstRun = i === 0;
      const isLastRun = j === lines.length;
      const head = isFirstRun ? 0 : COLLAPSED_HEAD_TAIL;
      const tail = isLastRun ? 0 : COLLAPSED_HEAD_TAIL;
      for (let k = i; k < i + head; k += 1) {
        out.push({ kind: "line", line: lines[k]! });
      }
      out.push({ kind: "collapsed", count: runLength - head - tail });
      for (let k = j - tail; k < j; k += 1) {
        out.push({ kind: "line", line: lines[k]! });
      }
    }
    i = j;
  }
  return out;
}
