import type {
  WorktreeFileContentResponse,
  WorktreeFileEntry,
  WorktreeFileTreeResponse,
} from "./ui-api";

/**
 * Per-directory loading status held by the file explorer for a worktree.
 * Used to render loading spinners and error states without re-fetching on
 * every render.
 */
export type DirectoryStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | {
      kind: "loaded";
      entries: WorktreeFileEntry[];
      loadedAt: number;
    }
  | { kind: "error"; message: string };

export interface DirectoryNode {
  /** Relative POSIX-style directory path under the worktree root ("" for root). */
  dir: string;
  status: DirectoryStatus;
  expanded: boolean;
}

/** Pure file-explorer state for a single worktree. */
export interface FileExplorerState {
  /** Absolute worktree root currently scoped to this state. */
  worktreePath: string;
  /**
   * Directory nodes keyed by their relative path. The root directory always
   * exists with an empty `dir` key once loading starts.
   */
  directories: Record<string, DirectoryNode>;
  /** Currently selected file (relative path), or `null` when none. */
  selectedFile: string | null;
  /** Most recently loaded content for the selected file. */
  selectedContent: WorktreeFileContentResponse | null;
  /** Editor draft text when the user has typed changes. */
  draft: string | null;
  /** Last-known mtime guard for the open file, after the last successful read/save. */
  mtimeGuard: number | null;
  /** When true, the selected file content is being fetched. */
  selectedLoading: boolean;
  /** Selected file error/unsupported state, if any. */
  selectedError:
    | null
    | { kind: "unsupported"; reason: "binary" | "too-large"; message: string }
    | { kind: "not-found"; message: string }
    | { kind: "conflict"; message: string; currentMtimeMs?: number }
    | { kind: "error"; message: string };
}

export function createEmptyFileExplorerState(
  worktreePath: string,
): FileExplorerState {
  return {
    worktreePath,
    directories: {},
    selectedFile: null,
    selectedContent: null,
    draft: null,
    mtimeGuard: null,
    selectedLoading: false,
    selectedError: null,
  };
}

/**
 * Returns true when the user has unsaved edits to the selected file. A draft
 * is dirty when it differs from the most recently loaded content.
 */
export function isDirty(state: FileExplorerState): boolean {
  if (state.draft === null) return false;
  if (!state.selectedContent) return false;
  return state.draft !== state.selectedContent.content;
}

/** Sort entries with directories first, then case-insensitive by name. */
export function sortEntries(
  entries: ReadonlyArray<WorktreeFileEntry>,
): WorktreeFileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/** Mark a directory as loading; preserves any previously loaded entries. */
export function markDirectoryLoading(
  state: FileExplorerState,
  dir: string,
): FileExplorerState {
  const prev = state.directories[dir];
  const next: DirectoryNode = {
    dir,
    expanded: prev?.expanded ?? false,
    status: { kind: "loading" },
  };
  return {
    ...state,
    directories: { ...state.directories, [dir]: next },
  };
}

/** Store a successful directory listing and expand the node. */
export function applyDirectoryListing(
  state: FileExplorerState,
  response: WorktreeFileTreeResponse,
  now: number = Date.now(),
): FileExplorerState {
  const next: DirectoryNode = {
    dir: response.dir,
    expanded: true,
    status: {
      kind: "loaded",
      entries: sortEntries(response.entries),
      loadedAt: now,
    },
  };
  return {
    ...state,
    directories: { ...state.directories, [response.dir]: next },
  };
}

export function applyDirectoryError(
  state: FileExplorerState,
  dir: string,
  message: string,
): FileExplorerState {
  const prev = state.directories[dir];
  const next: DirectoryNode = {
    dir,
    expanded: prev?.expanded ?? false,
    status: { kind: "error", message },
  };
  return {
    ...state,
    directories: { ...state.directories, [dir]: next },
  };
}

export function collapseDirectory(
  state: FileExplorerState,
  dir: string,
): FileExplorerState {
  const prev = state.directories[dir];
  if (!prev) return state;
  return {
    ...state,
    directories: {
      ...state.directories,
      [dir]: { ...prev, expanded: false },
    },
  };
}

export function toggleDirectory(
  state: FileExplorerState,
  dir: string,
): FileExplorerState {
  const prev = state.directories[dir];
  if (!prev) return state;
  return {
    ...state,
    directories: {
      ...state.directories,
      [dir]: { ...prev, expanded: !prev.expanded },
    },
  };
}

/**
 * Begin loading content for a file. Clears any prior draft/content/error so
 * the editor does not flash stale text from the previously selected file.
 */
export function beginSelectFile(
  state: FileExplorerState,
  file: string,
): FileExplorerState {
  return {
    ...state,
    selectedFile: file,
    selectedContent: null,
    draft: null,
    mtimeGuard: null,
    selectedLoading: true,
    selectedError: null,
  };
}

export function applyFileContent(
  state: FileExplorerState,
  content: WorktreeFileContentResponse,
): FileExplorerState {
  if (state.selectedFile !== content.file) return state;
  return {
    ...state,
    selectedContent: content,
    draft: content.content,
    mtimeGuard: content.mtimeMs,
    selectedLoading: false,
    selectedError: null,
  };
}

export function applyFileError(
  state: FileExplorerState,
  file: string,
  err: NonNullable<FileExplorerState["selectedError"]>,
): FileExplorerState {
  if (state.selectedFile !== file) return state;
  return {
    ...state,
    selectedContent: null,
    draft: null,
    mtimeGuard: null,
    selectedLoading: false,
    selectedError: err,
  };
}

export function updateDraft(
  state: FileExplorerState,
  draft: string,
): FileExplorerState {
  if (!state.selectedFile) return state;
  return { ...state, draft };
}

/**
 * Apply a successful save: refresh metadata, clear dirty state, and bump the
 * mtime guard to the freshly written value.
 */
export function applySaveSuccess(
  state: FileExplorerState,
  result: { file: string; size: number; mtimeMs: number },
): FileExplorerState {
  if (state.selectedFile !== result.file || !state.selectedContent) {
    return state;
  }
  const newContent: WorktreeFileContentResponse = {
    ...state.selectedContent,
    size: result.size,
    mtimeMs: result.mtimeMs,
    content: state.draft ?? state.selectedContent.content,
  };
  return {
    ...state,
    selectedContent: newContent,
    draft: newContent.content,
    mtimeGuard: result.mtimeMs,
    selectedError: null,
  };
}

/**
 * Reset all state when the worktree path changes. Returns a fresh empty
 * state for the new worktree.
 */
export function resetForWorktree(
  state: FileExplorerState,
  nextWorktreePath: string,
): FileExplorerState {
  if (state.worktreePath === nextWorktreePath) return state;
  return createEmptyFileExplorerState(nextWorktreePath);
}

/** Map of common file extensions to Monaco language identifiers. */
const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cc: "cpp",
  hh: "cpp",
  cs: "csharp",
  php: "php",
  sql: "sql",
  xml: "xml",
  svg: "xml",
  dockerfile: "dockerfile",
};

const LANGUAGE_BY_BASENAME: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  gemfile: "ruby",
  rakefile: "ruby",
};

/**
 * Infer a Monaco language id from a file path. Returns `"plaintext"` when no
 * mapping is found. Comparison is case-insensitive on the extension and
 * basename.
 */
export function inferMonacoLanguage(filePath: string): string {
  const lastSlash = Math.max(
    filePath.lastIndexOf("/"),
    filePath.lastIndexOf("\\"),
  );
  const base = filePath.slice(lastSlash + 1).toLowerCase();
  const lower = LANGUAGE_BY_BASENAME[base];
  if (lower) return lower;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "plaintext";
  const ext = base.slice(dot + 1);
  return LANGUAGE_BY_EXT[ext] ?? "plaintext";
}
