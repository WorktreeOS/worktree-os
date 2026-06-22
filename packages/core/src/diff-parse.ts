import type {
  DiffFile,
  DiffFileStatus,
  DiffHunk,
  DiffLine,
  DiffLineKind,
  DiffSet,
} from "./diff-types";
import type { GitNameStatusEntry, GitNumstatEntry } from "./git";

interface ParseInput {
  raw: string;
  numstat: GitNumstatEntry[];
  nameStatus: GitNameStatusEntry[];
}

interface RawFileSection {
  oldPath: string | null;
  newPath: string | null;
  /** True when git emitted `Binary files ... differ`. */
  binary: boolean;
  /** True when no `+++ ` line ever appeared (mode-only changes etc.). */
  textless: boolean;
  /** Whether the patch declared the file as deleted/new via `deleted file mode`/`new file mode`. */
  declaredDeleted: boolean;
  declaredNew: boolean;
  /** Whether a `--- a/...` (or `--- /dev/null`) line was parsed. */
  sawOldHeader: boolean;
  /** Whether a `+++ b/...` (or `+++ /dev/null`) line was parsed. */
  sawNewHeader: boolean;
  hunks: RawHunkSection[];
}

interface RawHunkSection {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header?: string;
  lines: string[];
}

/**
 * Build a structured `DiffSet` from `git diff` raw text plus its `--numstat` /
 * `--name-status` companions. Stable ids are derived from file paths and hunk
 * coordinates so UI selection state survives across re-fetches that produce the
 * same snapshot.
 */
export function buildDiffSet(input: ParseInput): DiffSet {
  const sections = parseRawDiff(input.raw);
  const numstatByPath = indexNumstat(input.numstat);
  const nameStatusByPath = indexNameStatus(input.nameStatus);

  const files: DiffFile[] = sections.map((section) => {
    const oldPath = section.oldPath;
    const newPath = section.newPath;
    const keyPath = newPath ?? oldPath ?? "";
    const numstat =
      numstatByPath.get(keyPath) ??
      (oldPath ? numstatByPath.get(oldPath) : undefined);
    const nameStatus =
      nameStatusByPath.get(keyPath) ??
      (oldPath ? nameStatusByPath.get(oldPath) : undefined);

    const status = resolveStatus(section, nameStatus);
    const { additions, deletions } = countAdditionsDeletions(section, numstat);
    const id = makeFileId(status, oldPath, newPath);
    const hunks: DiffHunk[] = section.hunks.map((h, idx) =>
      buildHunk(id, idx, h),
    );
    const isText = !section.binary && hunks.length > 0;
    const file: DiffFile = {
      id,
      status,
      ...(oldPath ? { oldPath } : {}),
      ...(newPath ? { newPath } : {}),
      additions,
      deletions,
      binary: section.binary,
      isText,
      hunks,
    };
    return file;
  });

  // Files reported by --name-status that produced no patch section (e.g. mode
  // change only) — surface them as non-text rows so the sidebar shows them.
  const seen = new Set(files.map((f) => f.id));
  for (const ns of input.nameStatus) {
    const status = mapNameStatusToFileStatus(ns.status);
    const id = makeFileId(status, ns.oldPath, ns.newPath);
    if (seen.has(id)) continue;
    const ns2 = ns;
    const numstat =
      numstatByPath.get(ns2.newPath ?? "") ??
      (ns2.oldPath ? numstatByPath.get(ns2.oldPath) : undefined);
    const additions = numstat?.additions ?? 0;
    const deletions = numstat?.deletions ?? 0;
    const file: DiffFile = {
      id,
      status,
      ...(ns2.oldPath ? { oldPath: ns2.oldPath } : {}),
      ...(ns2.newPath ? { newPath: ns2.newPath } : {}),
      additions: additions ?? 0,
      deletions: deletions ?? 0,
      binary: numstat ? numstat.additions === null && numstat.deletions === null : false,
      isText: false,
      hunks: [],
    };
    files.push(file);
    seen.add(id);
  }

  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);
  return {
    raw: input.raw,
    additions,
    deletions,
    changedFiles: files.length,
    files,
  };
}

function buildHunk(fileId: string, index: number, raw: RawHunkSection): DiffHunk {
  const id = `${fileId}#${raw.oldStart}-${raw.oldLines}-${raw.newStart}-${raw.newLines}-${index}`;
  const lines: DiffLine[] = [];
  let oldCursor = raw.oldStart;
  let newCursor = raw.newStart;
  for (let i = 0; i < raw.lines.length; i += 1) {
    const raw0 = raw.lines[i] ?? "";
    if (raw0.startsWith("\\")) {
      lines.push({
        id: `${id}:${i}`,
        kind: "no-newline",
        content: raw0.replace(/^\\ ?/, ""),
      });
      continue;
    }
    const marker = raw0.charAt(0);
    const content = raw0.slice(1);
    let kind: DiffLineKind = "context";
    let oldLine: number | undefined;
    let newLine: number | undefined;
    if (marker === "+") {
      kind = "add";
      newLine = newCursor;
      newCursor += 1;
    } else if (marker === "-") {
      kind = "delete";
      oldLine = oldCursor;
      oldCursor += 1;
    } else {
      kind = "context";
      oldLine = oldCursor;
      newLine = newCursor;
      oldCursor += 1;
      newCursor += 1;
    }
    lines.push({
      id: `${id}:${i}`,
      kind,
      ...(oldLine !== undefined ? { oldLine } : {}),
      ...(newLine !== undefined ? { newLine } : {}),
      content,
    });
  }
  return {
    id,
    oldStart: raw.oldStart,
    oldLines: raw.oldLines,
    newStart: raw.newStart,
    newLines: raw.newLines,
    ...(raw.header ? { header: raw.header } : {}),
    lines,
  };
}

function countAdditionsDeletions(
  section: RawFileSection,
  numstat: GitNumstatEntry | undefined,
): { additions: number; deletions: number } {
  if (numstat && numstat.additions !== null && numstat.deletions !== null) {
    return { additions: numstat.additions, deletions: numstat.deletions };
  }
  let additions = 0;
  let deletions = 0;
  for (const hunk of section.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
  }
  return { additions, deletions };
}

function resolveStatus(
  section: RawFileSection,
  nameStatus: GitNameStatusEntry | undefined,
): DiffFileStatus {
  if (nameStatus) return mapNameStatusToFileStatus(nameStatus.status);
  if (section.declaredNew) return "added";
  if (section.declaredDeleted) return "deleted";
  if (section.oldPath && section.newPath && section.oldPath !== section.newPath) {
    return "renamed";
  }
  return "modified";
}

function mapNameStatusToFileStatus(raw: string): DiffFileStatus {
  if (!raw) return "unknown";
  const code = raw.charAt(0).toUpperCase();
  if (code === "A") return "added";
  if (code === "D") return "deleted";
  if (code === "M") return "modified";
  if (code === "R") return "renamed";
  if (code === "C") return "copied";
  if (code === "T") return "type-changed";
  return "unknown";
}

function makeFileId(
  status: DiffFileStatus,
  oldPath: string | null | undefined,
  newPath: string | null | undefined,
): string {
  if (status === "renamed" || status === "copied") {
    return `${status}:${oldPath ?? ""}->${newPath ?? ""}`;
  }
  return `${status}:${newPath ?? oldPath ?? ""}`;
}

function indexNumstat(
  entries: GitNumstatEntry[],
): Map<string, GitNumstatEntry> {
  const map = new Map<string, GitNumstatEntry>();
  for (const e of entries) {
    if (e.newPath) map.set(e.newPath, e);
    if (e.oldPath) map.set(e.oldPath, e);
  }
  return map;
}

function indexNameStatus(
  entries: GitNameStatusEntry[],
): Map<string, GitNameStatusEntry> {
  const map = new Map<string, GitNameStatusEntry>();
  for (const e of entries) {
    if (e.newPath) map.set(e.newPath, e);
    if (e.oldPath) map.set(e.oldPath, e);
  }
  return map;
}

/**
 * Lower-level raw diff splitter. Exposed for tests; production code goes
 * through `buildDiffSet`.
 */
export function parseRawDiff(raw: string): RawFileSection[] {
  if (raw.length === 0) return [];
  const lines = raw.split("\n");
  const sections: RawFileSection[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.startsWith("diff --git ")) {
      i += 1;
      continue;
    }
    const { oldPath: headerOld, newPath: headerNew } = parseDiffGitHeader(line);
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let declaredDeleted = false;
    let declaredNew = false;
    let binary = false;
    let textless = true;
    let sawOldHeader = false;
    let sawNewHeader = false;
    const hunks: RawHunkSection[] = [];
    i += 1;
    while (i < lines.length) {
      const cur = lines[i] ?? "";
      if (cur.startsWith("diff --git ")) break;
      if (cur.startsWith("new file mode")) {
        declaredNew = true;
        i += 1;
        continue;
      }
      if (cur.startsWith("deleted file mode")) {
        declaredDeleted = true;
        i += 1;
        continue;
      }
      if (cur.startsWith("--- ")) {
        oldPath = parseFileLine(cur.slice(4));
        sawOldHeader = true;
        i += 1;
        continue;
      }
      if (cur.startsWith("+++ ")) {
        newPath = parseFileLine(cur.slice(4));
        sawNewHeader = true;
        textless = false;
        i += 1;
        continue;
      }
      if (cur.startsWith("Binary files ")) {
        binary = true;
        textless = false;
        i += 1;
        continue;
      }
      if (cur.startsWith("@@")) {
        const parsed = parseHunkHeader(cur);
        if (parsed) {
          const hunkLines: string[] = [];
          i += 1;
          while (i < lines.length) {
            const hLine = lines[i] ?? "";
            if (hLine.startsWith("@@") || hLine.startsWith("diff --git ")) break;
            // The very last empty string produced by `split("\n")` for a
            // trailing newline must not be appended as a content line.
            if (i === lines.length - 1 && hLine.length === 0) {
              i += 1;
              break;
            }
            hunkLines.push(hLine);
            i += 1;
          }
          hunks.push({ ...parsed, lines: hunkLines });
          continue;
        }
        i += 1;
        continue;
      }
      i += 1;
    }
    // Prefer header paths when the unified `--- /+++` lines were absent
    // (mode-only changes, binary files, rename without content change). When
    // the `---`/`+++` line was processed and reported `/dev/null` (added or
    // deleted file), we deliberately keep the null so the file status stays
    // accurate.
    if (!sawOldHeader && headerOld) oldPath = headerOld;
    if (!sawNewHeader && headerNew) newPath = headerNew;
    sections.push({
      oldPath,
      newPath,
      binary,
      textless: textless && hunks.length === 0,
      declaredDeleted,
      declaredNew,
      sawOldHeader,
      sawNewHeader,
      hunks,
    });
  }
  return sections;
}

function parseDiffGitHeader(line: string): { oldPath: string | null; newPath: string | null } {
  // `diff --git a/foo b/foo` or `diff --git "a/with space" "b/with space"`.
  const rest = line.slice("diff --git ".length);
  const parts = splitDiffGitPaths(rest);
  if (parts.length !== 2) return { oldPath: null, newPath: null };
  return {
    oldPath: stripGitPrefix(parts[0]!, "a/"),
    newPath: stripGitPrefix(parts[1]!, "b/"),
  };
}

function splitDiffGitPaths(rest: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < rest.length) {
    while (i < rest.length && rest[i] === " ") i += 1;
    if (i >= rest.length) break;
    if (rest[i] === '"') {
      const end = findClosingQuote(rest, i + 1);
      if (end < 0) {
        out.push(rest.slice(i));
        break;
      }
      out.push(unquoteGitPath(rest.slice(i, end + 1)));
      i = end + 1;
      continue;
    }
    let end = i;
    while (end < rest.length && rest[end] !== " ") end += 1;
    out.push(rest.slice(i, end));
    i = end;
  }
  return out;
}

function findClosingQuote(s: string, start: number): number {
  let i = start;
  while (i < s.length) {
    if (s[i] === "\\") {
      i += 2;
      continue;
    }
    if (s[i] === '"') return i;
    i += 1;
  }
  return -1;
}

function unquoteGitPath(quoted: string): string {
  if (!quoted.startsWith('"') || !quoted.endsWith('"')) return quoted;
  return quoted.slice(1, -1).replace(/\\(.)/g, "$1");
}

function stripGitPrefix(path: string, prefix: string): string | null {
  if (path === "/dev/null") return null;
  if (path.startsWith(prefix)) return path.slice(prefix.length);
  return path;
}

function parseFileLine(rest: string): string | null {
  // Strip trailing tab+timestamp produced by `git diff` for added/deleted files.
  const tab = rest.indexOf("\t");
  let path = tab >= 0 ? rest.slice(0, tab) : rest;
  if (path.startsWith('"') && path.endsWith('"')) {
    path = unquoteGitPath(path);
  }
  if (path === "/dev/null") return null;
  if (path.startsWith("a/")) return path.slice(2);
  if (path.startsWith("b/")) return path.slice(2);
  return path;
}

function parseHunkHeader(line: string): {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header?: string;
} | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
  if (!match) return null;
  const oldStart = Number(match[1]);
  const oldLines = match[2] !== undefined ? Number(match[2]) : 1;
  const newStart = Number(match[3]);
  const newLines = match[4] !== undefined ? Number(match[4]) : 1;
  const header = (match[5] ?? "").replace(/^ /, "");
  return {
    oldStart,
    oldLines,
    newStart,
    newLines,
    ...(header ? { header } : {}),
  };
}
