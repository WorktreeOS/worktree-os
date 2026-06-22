/**
 * Pure word-level intra-line diff. Segments a changed line pair (one deletion,
 * one addition) into emphasis runs so the diff detail can highlight exactly what
 * changed within the line. Falls back to `null` (caller keeps the CodeMirror
 * token highlight) when the lines are identical, share nothing, or are too long
 * to diff cheaply.
 */

export interface WordSegment {
  text: string;
  /** True when this run differs between the two lines. */
  emphasis: boolean;
}

export interface WordDiffResult {
  /** Segments for the removed (old) line. */
  removed: WordSegment[];
  /** Segments for the added (new) line. */
  added: WordSegment[];
}

/** Upper bound on tokens per line before we bail out to avoid O(n·m) blowup. */
const MAX_TOKENS = 400;

/** Split a line into alternating word / non-word tokens. */
export function tokenizeLine(line: string): string[] {
  const matches = line.match(/(\s+|\w+|[^\s\w]+)/g);
  return matches ?? [];
}

/** Longest common subsequence of two token arrays (indices into each). */
function lcs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/** Coalesce adjacent same-emphasis segments. */
function coalesce(segments: WordSegment[]): WordSegment[] {
  const out: WordSegment[] = [];
  for (const seg of segments) {
    if (seg.text.length === 0) continue;
    const last = out[out.length - 1];
    if (last && last.emphasis === seg.emphasis) {
      last.text += seg.text;
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}

export function segmentWordDiff(
  oldLine: string,
  newLine: string,
): WordDiffResult | null {
  if (oldLine === newLine) return null;
  const a = tokenizeLine(oldLine);
  const b = tokenizeLine(newLine);
  if (a.length === 0 || b.length === 0) return null;
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return null;

  const common = lcs(a, b);
  if (common.length === 0) return null;

  const removed: WordSegment[] = [];
  const added: WordSegment[] = [];
  let ai = 0;
  let bi = 0;
  for (const [ci, cj] of common) {
    for (; ai < ci; ai += 1) removed.push({ text: a[ai]!, emphasis: true });
    for (; bi < cj; bi += 1) added.push({ text: b[bi]!, emphasis: true });
    removed.push({ text: a[ci]!, emphasis: false });
    added.push({ text: b[cj]!, emphasis: false });
    ai = ci + 1;
    bi = cj + 1;
  }
  for (; ai < a.length; ai += 1) removed.push({ text: a[ai]!, emphasis: true });
  for (; bi < b.length; bi += 1) added.push({ text: b[bi]!, emphasis: true });

  return { removed: coalesce(removed), added: coalesce(added) };
}
