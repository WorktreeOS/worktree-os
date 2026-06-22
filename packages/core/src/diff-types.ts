export type DiffFileStatus =
  | "added"
  | "deleted"
  | "modified"
  | "renamed"
  | "copied"
  | "type-changed"
  | "unknown";

export type DiffLineKind = "context" | "add" | "delete" | "no-newline";

export interface DiffLine {
  /** Stable id within the parent hunk. */
  id: string;
  kind: DiffLineKind;
  /** Old-side line number when applicable. */
  oldLine?: number;
  /** New-side line number when applicable. */
  newLine?: number;
  /** Raw line content without the leading `+`/`-`/` ` marker. */
  content: string;
}

export interface DiffHunk {
  /** Stable id within the parent file. */
  id: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Optional context tail after the `@@ ... @@` (function name, etc.). */
  header?: string;
  lines: DiffLine[];
}

export interface DiffFile {
  /** Stable id derived from status + paths. */
  id: string;
  status: DiffFileStatus;
  oldPath?: string;
  newPath?: string;
  additions: number;
  deletions: number;
  /** True when git reports the file as binary or non-text. */
  binary: boolean;
  /** Whether the file produced parsable text hunks. */
  isText: boolean;
  hunks: DiffHunk[];
}

export interface DiffSet {
  /** Raw patch text exactly as `git diff` produced it. */
  raw: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: DiffFile[];
}

export interface ReviewDiffResponse {
  /** Sum of `staged.additions + unstaged.additions`. */
  totalAdditions: number;
  /** Sum of `staged.deletions + unstaged.deletions`. */
  totalDeletions: number;
  /** Distinct changed files across both sets. */
  totalChangedFiles: number;
  staged: DiffSet;
  unstaged: DiffSet;
}
