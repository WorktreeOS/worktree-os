import { LanguageDescription, type LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import type { DiffFile, DiffLine } from "./ui-api";

export interface HighlightedFragment {
  text: string;
  /** CodeMirror token class names. Empty string means plain text. */
  className: string;
}

export type HighlightedLines = Map<string, HighlightedFragment[]>;

interface SideEntry {
  id: string;
  content: string;
}

/**
 * Match a CodeMirror language description by file path. Uses the changed file's
 * `newPath` first and falls back to `oldPath` (e.g. for deleted files).
 */
export function findLanguageDescriptionForPath(
  newPath: string | undefined,
  oldPath: string | undefined,
): LanguageDescription | null {
  const candidates = [newPath, oldPath].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  for (const candidate of candidates) {
    const match = LanguageDescription.matchFilename(languages, candidate);
    if (match) return match;
  }
  return null;
}

/**
 * Resolve a CodeMirror `LanguageSupport` for the given file paths. Returns
 * `null` when no language matches the path or when loading fails.
 */
export async function loadLanguageSupportForPath(
  newPath: string | undefined,
  oldPath: string | undefined,
): Promise<LanguageSupport | null> {
  const desc = findLanguageDescriptionForPath(newPath, oldPath);
  if (!desc) return null;
  try {
    if (desc.support) return desc.support;
    return await desc.load();
  } catch {
    return null;
  }
}

/**
 * Build per-line plain-text fragments for the textual lines of a diff file.
 * Used as a stable fallback before highlighted tokens resolve or when no
 * language matches the file path.
 */
export function buildPlainTextLines(file: DiffFile): HighlightedLines {
  const out: HighlightedLines = new Map();
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "no-newline") continue;
      out.set(line.id, [{ text: line.content, className: "" }]);
    }
  }
  return out;
}

/**
 * Highlight a single side of a textual file. Lines are concatenated with `\n`,
 * parsed via the provided CodeMirror language, and token ranges are sliced
 * back into per-line fragments. The result is written into `out`.
 */
function highlightSide(
  sideLines: SideEntry[],
  support: LanguageSupport,
  out: HighlightedLines,
): void {
  if (sideLines.length === 0) return;

  const text = sideLines.map((l) => l.content).join("\n");
  const tree = support.language.parser.parse(text);

  type Token = { from: number; to: number; className: string };
  const tokens: Token[] = [];
  let lastEnd = 0;
  highlightTree(tree, classHighlighter, (from, to, classes) => {
    if (from > lastEnd) {
      tokens.push({ from: lastEnd, to: from, className: "" });
    }
    tokens.push({ from, to, className: classes });
    lastEnd = to;
  });
  if (lastEnd < text.length) {
    tokens.push({ from: lastEnd, to: text.length, className: "" });
  }

  let lineStart = 0;
  let tokenIdx = 0;
  for (const line of sideLines) {
    const lineEnd = lineStart + line.content.length;
    const fragments: HighlightedFragment[] = [];
    while (tokenIdx < tokens.length && tokens[tokenIdx]!.to <= lineStart) {
      tokenIdx += 1;
    }
    for (let i = tokenIdx; i < tokens.length; i += 1) {
      const tok = tokens[i]!;
      if (tok.from >= lineEnd) break;
      const fragFrom = Math.max(tok.from, lineStart);
      const fragTo = Math.min(tok.to, lineEnd);
      if (fragTo > fragFrom) {
        fragments.push({
          text: text.slice(fragFrom, fragTo),
          className: tok.className,
        });
      }
    }
    if (fragments.length === 0 && line.content.length > 0) {
      fragments.push({ text: line.content, className: "" });
    }
    out.set(line.id, fragments);
    lineStart = lineEnd + 1;
  }
}

/**
 * Highlight every textual line of `file` using `support`. Returns a fresh map
 * from `DiffLine.id` to fragment list. Falls back to plain-text fragments for
 * `no-newline` lines (those are not rendered as code).
 */
export function highlightDiffFile(
  file: DiffFile,
  support: LanguageSupport,
): HighlightedLines {
  const out: HighlightedLines = new Map();

  const oldSide: SideEntry[] = [];
  const newSide: SideEntry[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "no-newline") continue;
      if (line.kind === "delete") {
        oldSide.push({ id: line.id, content: line.content });
      } else if (line.kind === "add") {
        newSide.push({ id: line.id, content: line.content });
      } else {
        oldSide.push({ id: line.id, content: line.content });
        newSide.push({ id: line.id, content: line.content });
      }
    }
  }

  highlightSide(oldSide, support, out);
  highlightSide(newSide, support, out);

  return out;
}

/** Returns true when this diff line should be rendered as highlighted code. */
export function isHighlightableLine(line: DiffLine): boolean {
  return line.kind !== "no-newline";
}
