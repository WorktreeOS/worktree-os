import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  File as FileIcon,
  FolderClosed,
  FolderOpen,
  Loader2,
  RefreshCw,
  Save,
} from "lucide-react";
import { useContentWidth } from "@/lib/viewport";
import { SetiFileIcon } from "@/components/ui/seti-icon";
import { getSetiFileIcon } from "@/lib/seti-icons";
import "@/lib/monaco-setup";
import * as monaco from "monaco-editor";
import { useUiApi } from "@/lib/api-context";
import {
  applyDirectoryError,
  applyDirectoryListing,
  applyFileContent,
  applyFileError,
  applySaveSuccess,
  beginSelectFile,
  createEmptyFileExplorerState,
  inferMonacoLanguage,
  isDirty,
  markDirectoryLoading,
  toggleDirectory,
  updateDraft,
  type FileExplorerState,
} from "@/lib/file-explorer-logic";
import {
  UiApiError,
  type WorktreeFileEntry,
  type WorktreeFileErrorBody,
} from "@/lib/ui-api";
import { cn } from "@/lib/utils";

/**
 * Below this content width the tree and editor stop sitting side by side and
 * collapse into a single master-detail column (phones, narrow viewports): the
 * tree fills the width, tapping a file swaps to the editor, and a back control
 * returns to the tree.
 */
const FILE_EXPLORER_STACK_PX = 560;

/**
 * Files tab body for the worktree detail page, rendered full-width when the
 * Files tab is active. Owns the file tree, the Monaco editor, dirty state, save
 * flow, and the unsupported/conflict error surface.
 */
export function FileExplorerPanel({
  worktreePath,
}: {
  worktreePath: string;
}) {
  const api = useUiApi();
  const [state, setState] = useState<FileExplorerState>(() =>
    createEmptyFileExplorerState(worktreePath),
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Which pane the single-column (stacked) layout shows. Ignored while the
  // surface is wide enough to render the tree and editor side by side.
  const [mobileView, setMobileView] = useState<"tree" | "editor">("tree");

  // Measure the explorer body so the layout follows its own width rather than
  // the viewport — handles phones and narrow surfaces alike.
  const { ref: bodyRef, width: bodyWidth } = useContentWidth();
  const stacked = bodyWidth > 0 && bodyWidth < FILE_EXPLORER_STACK_PX;

  // Reset state whenever the worktree changes.
  useEffect(() => {
    setState(createEmptyFileExplorerState(worktreePath));
    setSaving(false);
    setSaveError(null);
    setMobileView("tree");
  }, [worktreePath]);

  const loadDirectory = useCallback(
    async (dir: string) => {
      setState((prev) => markDirectoryLoading(prev, dir));
      try {
        const res = await api.getWorktreeFileTree(worktreePath, dir);
        setState((prev) => applyDirectoryListing(prev, res));
      } catch (e) {
        const message = (e as Error).message;
        setState((prev) => applyDirectoryError(prev, dir, message));
      }
    },
    [api, worktreePath],
  );

  // Load the root directory on first mount / worktree change.
  useEffect(() => {
    void loadDirectory("");
  }, [loadDirectory]);

  const loadFile = useCallback(
    async (file: string) => {
      setState((prev) => beginSelectFile(prev, file));
      setSaveError(null);
      try {
        const res = await api.getWorktreeFileContent(worktreePath, file);
        setState((prev) => applyFileContent(prev, res));
      } catch (e) {
        const body = (e as UiApiError).body as
          | WorktreeFileErrorBody
          | undefined;
        if (body?.error === "unsupported-file" && body.reason) {
          setState((prev) =>
            applyFileError(prev, file, {
              kind: "unsupported",
              reason: body.reason!,
              message: body.message,
            }),
          );
          return;
        }
        if (body?.error === "not-found") {
          setState((prev) =>
            applyFileError(prev, file, {
              kind: "not-found",
              message: body.message,
            }),
          );
          return;
        }
        setState((prev) =>
          applyFileError(prev, file, {
            kind: "error",
            message: (e as Error).message,
          }),
        );
      }
    },
    [api, worktreePath],
  );

  const onSelectEntry = useCallback(
    (entry: WorktreeFileEntry) => {
      if (entry.kind === "directory") {
        const node = state.directories[entry.path];
        if (node && node.status.kind === "loaded") {
          setState((prev) => toggleDirectory(prev, entry.path));
          return;
        }
        // Optimistically mark expanded by toggling first (no-op if absent),
        // then fetch the listing — applyDirectoryListing sets expanded=true.
        void loadDirectory(entry.path);
        return;
      }
      // Reveal the editor in stacked mode even when re-tapping the open file.
      setMobileView("editor");
      if (state.selectedFile === entry.path) return;
      void loadFile(entry.path);
    },
    [loadDirectory, loadFile, state.directories, state.selectedFile],
  );

  const onRefresh = useCallback(() => {
    void loadDirectory("");
    // Reload any other previously loaded directories so the tree stays fresh.
    for (const node of Object.values(state.directories)) {
      if (node.dir === "" || node.status.kind !== "loaded") continue;
      void loadDirectory(node.dir);
    }
    if (state.selectedFile) void loadFile(state.selectedFile);
  }, [loadDirectory, loadFile, state.directories, state.selectedFile]);

  const onSave = useCallback(async () => {
    if (
      !state.selectedFile ||
      state.draft === null ||
      state.mtimeGuard === null
    ) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await api.saveWorktreeFileContent({
        path: worktreePath,
        file: state.selectedFile,
        content: state.draft,
        expectedMtimeMs: state.mtimeGuard,
      });
      setState((prev) => applySaveSuccess(prev, res));
    } catch (e) {
      const body = (e as UiApiError).body as
        | WorktreeFileErrorBody
        | undefined;
      if (body?.error === "conflict") {
        setState((prev) =>
          applyFileError(prev, state.selectedFile!, {
            kind: "conflict",
            message: body.message,
            ...(body.currentMtimeMs !== undefined
              ? { currentMtimeMs: body.currentMtimeMs }
              : {}),
          }),
        );
      } else {
        setSaveError((e as Error).message);
      }
    } finally {
      setSaving(false);
    }
  }, [api, state.draft, state.mtimeGuard, state.selectedFile, worktreePath]);

  const onRefreshSelected = useCallback(() => {
    if (state.selectedFile) void loadFile(state.selectedFile);
  }, [loadFile, state.selectedFile]);

  const dirty = isDirty(state);
  const conflict =
    state.selectedError && state.selectedError.kind === "conflict"
      ? state.selectedError
      : null;

  const showTree = !stacked || mobileView === "tree";
  const showEditor = !stacked || mobileView === "editor";

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="file-explorer-panel"
      data-stacked={stacked ? "true" : undefined}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 bg-card/40 px-2.5">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-muted-foreground">
          files
        </span>
        <span className="truncate font-mono text-[11px] text-muted-foreground/80">
          {worktreePath}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          aria-label="Refresh file tree"
          title="Refresh"
          data-testid="file-explorer-refresh"
          className="ml-auto grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-ring"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>
      <div ref={bodyRef} className="flex min-h-0 min-w-0 flex-1">
        {showTree && (
          <FileTreePane
            state={state}
            stacked={stacked}
            onSelectEntry={onSelectEntry}
          />
        )}
        {showEditor && (
          <div
            className={cn(
              "flex min-h-0 min-w-0 flex-1 flex-col",
              !stacked && "border-l border-border/60",
            )}
          >
            <FileEditorPane
              state={state}
              dirty={dirty}
              saving={saving}
              saveError={saveError}
              conflict={conflict}
              onChange={(text) => setState((prev) => updateDraft(prev, text))}
              onSave={onSave}
              onRefreshSelected={onRefreshSelected}
              onBack={stacked ? () => setMobileView("tree") : undefined}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function FileTreePane({
  state,
  stacked,
  onSelectEntry,
}: {
  state: FileExplorerState;
  stacked: boolean;
  onSelectEntry: (entry: WorktreeFileEntry) => void;
}) {
  const root = state.directories[""];
  return (
    <nav
      aria-label="Worktree files"
      className={cn(
        "flex min-h-0 shrink-0 flex-col overflow-y-auto bg-card/20",
        stacked
          ? "w-full"
          : "w-[42%] min-w-[200px] max-w-[360px]",
      )}
      data-testid="file-explorer-tree"
    >
      {!root || root.status.kind === "idle" || root.status.kind === "loading" ? (
        <DirectoryLoading />
      ) : root.status.kind === "error" ? (
        <DirectoryError message={root.status.message} />
      ) : (
        <ul className="flex flex-col py-1 text-[12.5px]">
          {root.status.entries.map((entry) => (
            <FileTreeNode
              key={entry.path}
              entry={entry}
              state={state}
              depth={0}
              stacked={stacked}
              selectedPath={state.selectedFile}
              onSelectEntry={onSelectEntry}
            />
          ))}
        </ul>
      )}
    </nav>
  );
}

function FileTreeNode({
  entry,
  state,
  depth,
  stacked,
  selectedPath,
  onSelectEntry,
}: {
  entry: WorktreeFileEntry;
  state: FileExplorerState;
  depth: number;
  stacked: boolean;
  selectedPath: string | null;
  onSelectEntry: (entry: WorktreeFileEntry) => void;
}) {
  const isDir = entry.kind === "directory";
  const node = isDir ? state.directories[entry.path] : undefined;
  const expanded = node?.expanded === true;
  const loading = node?.status.kind === "loading";
  const selected = !isDir && selectedPath === entry.path;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelectEntry(entry)}
        data-testid={
          isDir ? "file-tree-directory" : "file-tree-file"
        }
        data-path={entry.path}
        data-selected={selected ? "true" : undefined}
        className={cn(
          "flex w-full items-center gap-1.5 px-2 text-left font-mono text-[12.5px] transition-colors",
          // Roomier tap target when the panel is stacked into one column.
          stacked ? "py-2" : "py-1",
          selected
            ? "bg-accent text-foreground"
            : "text-foreground/80 hover:bg-accent/60 hover:text-foreground",
        )}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
      >
        {isDir ? (
          loading ? (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
          ) : expanded ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="inline-block w-3 shrink-0" aria-hidden />
        )}
        {isDir ? (
          expanded ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <FolderClosed className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )
        ) : (
          <FileTypeIcon name={entry.name} />
        )}
        <span className="truncate">{entry.name}</span>
        <GitDecoration entry={entry} />
      </button>
      {isDir && expanded && node?.status.kind === "loaded" && (
        <ul>
          {node.status.entries.map((child) => (
            <FileTreeNode
              key={child.path}
              entry={child}
              state={state}
              depth={depth + 1}
              stacked={stacked}
              selectedPath={selectedPath}
              onSelectEntry={onSelectEntry}
            />
          ))}
          {node.status.entries.length === 0 && (
            <li
              className="px-2 py-1 text-[11px] text-muted-foreground"
              style={{ paddingLeft: `${24 + (depth + 1) * 12}px` }}
            >
              empty
            </li>
          )}
        </ul>
      )}
      {isDir && expanded && node?.status.kind === "error" && (
        <div
          className="px-2 py-1 text-[11px] text-[color:var(--bad,#c5403b)]"
          style={{ paddingLeft: `${24 + (depth + 1) * 12}px` }}
        >
          {node.status.message}
        </div>
      )}
    </li>
  );
}

/**
 * Derives a single status letter and diff-color token from a porcelain XY
 * code: `??`→U (untracked, `--good`), `A`→A (added, `--good`), `D`→D (deleted,
 * `--bad`), anything else→M (modified/conflict, `--warn`).
 */
function gitStatusLetter(
  code: string,
): { letter: string; color: string } | null {
  if (!code) return null;
  const x = code.charAt(0);
  const y = code.charAt(1);
  if (x === "?" || y === "?") {
    return { letter: "U", color: "var(--good,#15803D)" };
  }
  if (x === "A" || y === "A") {
    return { letter: "A", color: "var(--good,#15803D)" };
  }
  if (x === "D" || y === "D") {
    return { letter: "D", color: "var(--bad,#c5403b)" };
  }
  return { letter: "M", color: "var(--warn,#C2410C)" };
}

function GitDecoration({ entry }: { entry: WorktreeFileEntry }) {
  if (entry.kind === "directory") {
    if (!entry.changedCount || entry.changedCount <= 0) return null;
    return (
      <span
        className="ml-auto shrink-0 pl-1.5 text-[11px] text-muted-foreground"
        data-testid="file-tree-changed-count"
      >
        {entry.changedCount}
      </span>
    );
  }
  const status = gitStatusLetter(entry.gitStatus ?? "");
  if (!status) return null;
  return (
    <span
      className="ml-auto shrink-0 pl-1.5 text-[11px] font-medium"
      style={{ color: status.color }}
      data-testid="file-tree-status-letter"
    >
      {status.letter}
    </span>
  );
}

function FileTypeIcon({ name }: { name: string }) {
  // SetiFileIcon returns null only when the theme has no mapping at all
  // (effectively impossible since `_default` exists). The lucide fallback
  // keeps the row's icon column from collapsing in that edge case.
  if (getSetiFileIcon(name)) return <SetiFileIcon path={name} />;
  return <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}

function DirectoryLoading() {
  return (
    <div
      className="flex items-center gap-2 px-3 py-3 text-[11.5px] text-muted-foreground"
      data-testid="file-tree-loading"
    >
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      <span>Loading…</span>
    </div>
  );
}

function DirectoryError({ message }: { message: string }) {
  return (
    <div
      className="flex items-start gap-2 px-3 py-3 text-[11.5px] text-[color:var(--bad,#c5403b)]"
      data-testid="file-tree-error"
    >
      <AlertCircle className="mt-[1px] h-3.5 w-3.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

function FileEditorPane({
  state,
  dirty,
  saving,
  saveError,
  conflict,
  onChange,
  onSave,
  onRefreshSelected,
  onBack,
}: {
  state: FileExplorerState;
  dirty: boolean;
  saving: boolean;
  saveError: string | null;
  conflict:
    | (NonNullable<FileExplorerState["selectedError"]> & { kind: "conflict" })
    | null;
  onChange: (text: string) => void;
  onSave: () => void;
  onRefreshSelected: () => void;
  /** When set, the editor is the detail view of a stacked layout and shows a
   * back control to return to the tree. */
  onBack?: () => void;
}) {
  if (!state.selectedFile) {
    return (
      <EmptyEditor>
        <p>Select a file from the tree to view or edit its contents.</p>
      </EmptyEditor>
    );
  }
  if (state.selectedLoading) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {onBack && <StackedBackHeader onBack={onBack}>{state.selectedFile}</StackedBackHeader>}
        <EmptyEditor>
          <Loader2 className="h-4 w-4 animate-spin" />
          <p>Loading {state.selectedFile}…</p>
        </EmptyEditor>
      </div>
    );
  }
  if (state.selectedError) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {onBack && <StackedBackHeader onBack={onBack} />}
        <UnsupportedOrErrorBody
          path={state.selectedFile}
          error={state.selectedError}
          onRefresh={onRefreshSelected}
        />
      </div>
    );
  }
  return (
    <>
      <EditorToolbar
        path={state.selectedFile}
        dirty={dirty}
        saving={saving}
        canSave={dirty && !saving}
        onSave={onSave}
        onRefresh={onRefreshSelected}
        onBack={onBack}
      />
      {saveError && (
        <div
          className="border-b border-[color:var(--bad,#c5403b)]/30 bg-[color:var(--bad,#c5403b)]/10 px-3 py-1.5 text-[11.5px] text-[color:var(--bad,#c5403b)]"
          data-testid="file-editor-save-error"
        >
          {saveError}
        </div>
      )}
      {conflict && (
        <div
          className="border-b border-[color:var(--warn,#b07a14)]/40 bg-[color:var(--warn,#b07a14)]/10 px-3 py-1.5 text-[11.5px] text-[color:var(--warn,#b07a14)]"
          data-testid="file-editor-conflict"
        >
          {conflict.message} —
          <button
            type="button"
            onClick={onRefreshSelected}
            className="ml-1 underline underline-offset-2 hover:text-foreground"
          >
            refresh and discard local edits
          </button>
        </div>
      )}
      <MonacoEditor
        path={state.selectedFile}
        value={state.draft ?? state.selectedContent?.content ?? ""}
        onChange={onChange}
        wordWrap={onBack ? "on" : "off"}
      />
    </>
  );
}

function EmptyEditor({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-[12.5px] text-muted-foreground">
      {children}
    </div>
  );
}

/** Back-to-tree control for the stacked (single-column) editor view. */
function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      aria-label="Back to files"
      title="Back to files"
      data-testid="file-editor-back"
      className="-ml-1 grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-ring"
    >
      <ChevronLeft className="h-4 w-4" />
    </button>
  );
}

/** Header bar for the stacked editor when there is no full toolbar (loading /
 * error states): just a back control and an optional file path. */
function StackedBackHeader({
  onBack,
  children,
}: {
  onBack: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 bg-card/40 px-3">
      <BackButton onBack={onBack} />
      {children && (
        <span className="truncate font-mono text-[11.5px] text-foreground">
          {children}
        </span>
      )}
    </div>
  );
}

function EditorToolbar({
  path,
  dirty,
  saving,
  canSave,
  onSave,
  onRefresh,
  onBack,
}: {
  path: string;
  dirty: boolean;
  saving: boolean;
  canSave: boolean;
  onSave: () => void;
  onRefresh: () => void;
  onBack?: () => void;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 bg-card/40 px-3">
      {onBack && <BackButton onBack={onBack} />}
      <span
        className="truncate font-mono text-[11.5px] text-foreground"
        title={path}
      >
        {path}
      </span>
      {dirty && (
        <span
          className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-[color:var(--warn,#b07a14)]"
          data-testid="file-editor-dirty"
          aria-label="Unsaved changes"
        />
      )}
      <button
        type="button"
        onClick={onRefresh}
        aria-label="Refresh file"
        title="Refresh file"
        data-testid="file-editor-refresh"
        className="ml-auto grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-ring"
      >
        <RefreshCw className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={!canSave}
        data-testid="file-editor-save"
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 font-mono text-[11px] uppercase tracking-[0.18em] transition-colors focus-ring",
          canSave
            ? "text-foreground hover:bg-accent"
            : "text-muted-foreground/60",
        )}
      >
        {saving ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Save className="h-3 w-3" />
        )}
        Save
      </button>
    </div>
  );
}

function UnsupportedOrErrorBody({
  path,
  error,
  onRefresh,
}: {
  path: string;
  error: NonNullable<FileExplorerState["selectedError"]>;
  onRefresh: () => void;
}) {
  let title = "Cannot open file";
  if (error.kind === "unsupported") {
    title =
      error.reason === "binary"
        ? "Binary file is not editable"
        : "File is too large to edit";
  } else if (error.kind === "not-found") {
    title = "File not found";
  } else if (error.kind === "conflict") {
    title = "File changed on disk";
  }
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
      data-testid="file-editor-unsupported"
      data-error-kind={error.kind}
    >
      <AlertCircle className="h-5 w-5 text-[color:var(--warn,#b07a14)]" />
      <div className="font-medium text-foreground">{title}</div>
      <div className="font-mono text-[11.5px] text-muted-foreground">
        {path}
      </div>
      <p className="max-w-sm text-[12.5px] text-muted-foreground">
        {error.message}
      </p>
      <button
        type="button"
        onClick={onRefresh}
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 font-mono text-[11px] uppercase tracking-[0.18em] text-foreground transition-colors hover:bg-accent"
      >
        <RefreshCw className="h-3 w-3" /> Reload
      </button>
    </div>
  );
}

/**
 * Monaco editor wrapper. The editor and model are recreated whenever the file
 * path changes so language inference and language-aware features stay in sync
 * without leaking models between files. The component owns disposal of both.
 */
function MonacoEditor({
  path,
  value,
  onChange,
  wordWrap = "off",
}: {
  path: string;
  value: string;
  onChange: (text: string) => void;
  wordWrap?: "on" | "off";
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const language = useMemo(() => inferMonacoLanguage(path), [path]);

  useEffect(() => {
    if (!containerRef.current) return;
    const model = monaco.editor.createModel(value, language);
    modelRef.current = model;
    const editor = monaco.editor.create(containerRef.current, {
      model,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontFamily:
        "var(--font-mono), Geist Mono, ui-monospace, SFMono-Regular, monospace",
      fontSize: 13,
      tabSize: 2,
      wordWrap,
    });
    editorRef.current = editor;
    const sub = editor.onDidChangeModelContent(() => {
      const text = editor.getValue();
      onChangeRef.current(text);
    });
    return () => {
      sub.dispose();
      editor.dispose();
      model.dispose();
      editorRef.current = null;
      modelRef.current = null;
    };
    // Recreate editor+model whenever the file path or language changes so
    // the language switch is not retroactive on an existing model.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, language]);

  // Sync external value changes (e.g. refresh, save) without resetting the
  // editor when the user is typing — only update when values diverge.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const current = editor.getValue();
    if (current !== value) {
      editor.setValue(value);
    }
  }, [value]);

  // Toggle line wrapping live when the layout switches between stacked
  // (mobile-friendly wrap) and side-by-side, without recreating the editor.
  useEffect(() => {
    editorRef.current?.updateOptions({ wordWrap });
  }, [wordWrap]);

  return (
    <div
      ref={containerRef}
      className="min-h-0 min-w-0 flex-1"
      data-testid="file-editor-monaco"
    />
  );
}
