import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  AlertCircle,
  Folder,
  GitBranch,
  Loader2,
  Plus,
} from "lucide-react";

import { useUiApi } from "@/lib/api-context";
import {
  UiApiError,
  type DirectoryListResponse,
  type DirectorySuggestion,
} from "@/lib/ui-api";
import {
  deriveDirPath,
  deriveQuery,
  filterSuggestions,
  normalizeForValidation,
  parentDirOf,
} from "@/lib/add-project-logic";
import { Button } from "@/components/ui/button";
import { ModalShell } from "@/components/ui/modal-shell";
import { cn } from "@/lib/utils";

/* AddProjectModal — v3 modal that replaces the inline sidebar add-project
 * field with a path autocomplete combobox.
 *
 * Combobox model:
 *   - The text input always holds an absolute path.
 *   - `dirPath` derives from the input: when the input ends in `/`, that is
 *     the directory whose children we list; otherwise, the parent directory
 *     of the input is the listed directory.
 *   - Selecting a suggestion replaces the input with `<suggestion>/`, which
 *     triggers a new directory list for the next segment.
 *
 * Validation:
 *   - We validate the trimmed input through `/projects/validate` only when
 *     the user submits the form. Invalid paths surface a blocking error and
 *     do not call `/projects`; valid paths (including ones with a non-blocking
 *     warning) proceed to the existing `/projects` POST endpoint. */

interface AddProjectModalProps {
  onCancel: () => void;
  onAdded: () => Promise<void> | void;
}

interface DirectoryState {
  /** Directory path whose children are listed. */
  path: string;
  /** Latest entries; empty while loading. */
  entries: DirectorySuggestion[];
  loading: boolean;
  /** Most recent error from the directory list call, if any. */
  error: string | null;
}

export function AddProjectModal({ onCancel, onAdded }: AddProjectModalProps) {
  const api = useUiApi();
  const [input, setInput] = useState("/");
  const [open, setOpen] = useState(true);
  const [activeIndex, setActiveIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitWarning, setSubmitWarning] = useState<string | null>(null);
  const [directory, setDirectory] = useState<DirectoryState>({
    path: "",
    entries: [],
    loading: false,
    error: null,
  });

  const inputRef = useRef<HTMLInputElement | null>(null);
  const dirRequestId = useRef(0);

  const dirPath = useMemo(() => deriveDirPath(input), [input]);
  // Query is derived against the directory the daemon actually listed, so an
  // exact directory match shows all children while a partial segment filters
  // the parent's children.
  const query = useMemo(
    () => deriveQuery(input, directory.path),
    [input, directory.path],
  );
  const visibleEntries = useMemo(
    () => filterSuggestions(directory.entries, query),
    [directory.entries, query],
  );

  useEffect(() => {
    if (!dirPath) {
      setDirectory({ path: "", entries: [], loading: false, error: null });
      return;
    }
    const requestId = ++dirRequestId.current;
    // Keep the previously listed entries/path visible while loading when the
    // new candidate will resolve to the same directory (the listed dir itself
    // or its parent), so an exact-vs-fallback transition does not flash a
    // stale filter against the wrong listing.
    setDirectory((prev) => {
      const keep =
        prev.path === dirPath || prev.path === parentDirOf(dirPath);
      return {
        path: prev.path,
        entries: keep ? prev.entries : [],
        loading: true,
        error: null,
      };
    });
    let cancelled = false;
    (async () => {
      try {
        const res: DirectoryListResponse = await api.listDirectories(dirPath);
        if (cancelled || requestId !== dirRequestId.current) return;
        setDirectory({
          path: res.path,
          entries: res.entries,
          loading: false,
          error: null,
        });
        setActiveIndex(0);
      } catch (e) {
        if (cancelled || requestId !== dirRequestId.current) return;
        const message =
          e instanceof UiApiError ? e.message : (e as Error).message;
        setDirectory({
          path: dirPath,
          entries: [],
          loading: false,
          error: message,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, dirPath]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const acceptSuggestion = useCallback((entry: DirectorySuggestion) => {
    setInput(entry.path.endsWith("/") ? entry.path : `${entry.path}/`);
    setOpen(true);
    setActiveIndex(0);
    inputRef.current?.focus();
  }, []);

  const onInputChange = (next: string) => {
    setInput(next);
    setOpen(true);
    setSubmitError(null);
    setSubmitWarning(null);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = normalizeForValidation(input);
    if (trimmed.length === 0) {
      setSubmitError("Provide an absolute path");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setSubmitWarning(null);
    try {
      const validation = await api.validateProjectPath(trimmed);
      if (!validation.valid) {
        setSubmitError(validation.message ?? "Path is not a Git worktree");
        setSubmitting(false);
        return;
      }
      if (validation.warning) {
        setSubmitWarning(validation.warning.message);
      }
      await api.addProject({ path: trimmed });
      await onAdded();
    } catch (e) {
      const message =
        e instanceof UiApiError ? e.message : (e as Error).message;
      setSubmitError(message);
      setSubmitting(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      if (visibleEntries.length === 0) return;
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => (i + 1) % visibleEntries.length);
      return;
    }
    if (e.key === "ArrowUp") {
      if (visibleEntries.length === 0) return;
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) =>
        i <= 0 ? visibleEntries.length - 1 : i - 1,
      );
      return;
    }
    if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
      return;
    }
    if (e.key === "Tab" && !e.shiftKey) {
      // Accept the focused suggestion and descend into it, mirroring Enter
      // without submitting the form. Fall through to default focus movement
      // when there is nothing to complete.
      if (open && visibleEntries.length > 0) {
        e.preventDefault();
        const entry = visibleEntries[activeIndex] ?? visibleEntries[0]!;
        acceptSuggestion(entry);
      }
      return;
    }
    if (e.key === "Enter") {
      if (open && visibleEntries.length > 0) {
        e.preventDefault();
        const entry = visibleEntries[activeIndex] ?? visibleEntries[0]!;
        acceptSuggestion(entry);
      }
      // Otherwise fall through to default form submit.
    }
  };

  const trimmedPath = normalizeForValidation(input);
  const submitDisabled = submitting || trimmedPath.length === 0;

  return (
    <ModalShell
      testId="add-project-modal"
      ariaLabel="Add project"
      submitting={submitting}
      onCancel={onCancel}
    >
      <form onSubmit={onSubmit}>
        <header className="px-6 pt-6 pb-4 border-b border-[color:var(--hair)]">
          <span className="text-[11.5px] font-medium uppercase tracking-[0.18em] text-[color:var(--muted-foreground)]">
            Add project
          </span>
          <h2 className="mt-1.5 text-[20px] font-semibold tracking-[-0.01em] text-[color:var(--ink)]">
            Register a Git worktree
          </h2>
          <p className="mt-1.5 text-[13px] text-[color:var(--muted-foreground)]">
            Pick or paste the absolute path to a repository or worktree. WorktreeOS
            registers the primary worktree and surfaces every sibling.
          </p>
        </header>
        <div className="px-6 py-5 flex flex-col gap-3 max-h-[60vh] overflow-auto">
          <label htmlFor="add-project-path" className="flex flex-col gap-1.5">
            <span className="font-mono text-[12px] text-[color:var(--muted-foreground)]">
              path
            </span>
            <div className="flex items-center gap-2 rounded-[8px] border border-[color:var(--hair-2)] bg-[color:var(--surface)] px-3 py-2 focus-within:ring-1 focus-within:ring-[color:var(--ink)]/30">
              <Folder className="h-3.5 w-3.5 text-[color:var(--muted-foreground)]" />
              <input
                ref={inputRef}
                id="add-project-path"
                type="text"
                value={input}
                onChange={(e) => onInputChange(e.target.value)}
                onFocus={() => setOpen(true)}
                onKeyDown={onKeyDown}
                placeholder="/path/to/repo"
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                aria-autocomplete="list"
                aria-expanded={open}
                aria-controls="add-project-suggestions"
                disabled={submitting}
                className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-[color:var(--ink)] placeholder:text-[color:var(--muted-foreground)] focus:outline-none"
                data-testid="add-project-path-input"
              />
              {directory.loading && (
                <Loader2
                  className="h-3.5 w-3.5 animate-spin text-[color:var(--muted-foreground)]"
                  aria-label="Loading"
                />
              )}
            </div>
          </label>

          {open && (
            <SuggestionList
              dirPath={directory.path}
              loading={directory.loading}
              error={directory.error}
              entries={visibleEntries}
              activeIndex={activeIndex}
              onSelect={acceptSuggestion}
              onHover={setActiveIndex}
            />
          )}

          {submitWarning && !submitError && (
            <div
              className="flex items-start gap-2 rounded-[8px] border border-[color:var(--hair-2)] bg-[color:var(--chip-bg)] px-3 py-2 text-[13px] text-[color:var(--ink-2)]"
              data-testid="add-project-submit-warning"
            >
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--warn)]" />
              <span>{submitWarning}</span>
            </div>
          )}

          {submitError && (
            <div
              className="flex items-start gap-2 rounded-[8px] border border-[color:var(--bad-border)] bg-[color:var(--bad-soft)] px-3 py-2 text-[13px] text-[color:var(--bad)]"
              data-testid="add-project-submit-error"
            >
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{submitError}</span>
            </div>
          )}
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-[color:var(--hair)] px-6 py-3.5">
          <Button
            type="button"
            variant="default"
            disabled={submitting}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="solid"
            disabled={submitDisabled}
            data-testid="add-project-confirm"
          >
            {submitting ? <Loader2 className="animate-spin" /> : <Plus />}
            Add project
          </Button>
        </footer>
      </form>
    </ModalShell>
  );
}

interface SuggestionListProps {
  dirPath: string;
  loading: boolean;
  error: string | null;
  entries: DirectorySuggestion[];
  activeIndex: number;
  onSelect: (entry: DirectorySuggestion) => void;
  onHover: (index: number) => void;
}

function SuggestionList({
  dirPath,
  loading,
  error,
  entries,
  activeIndex,
  onSelect,
  onHover,
}: SuggestionListProps) {
  if (!dirPath) return null;
  if (error) {
    return (
      <div
        className="h-[240px] overflow-auto rounded-[8px] border border-[color:var(--bad-border)] bg-[color:var(--bad-soft)] px-3 py-2 text-[13px] text-[color:var(--bad)]"
        data-testid="add-project-suggestions-error"
      >
        {error}
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div
        className="h-[240px] overflow-auto rounded-[8px] border border-[color:var(--hair-2)] bg-[color:var(--surface)] px-3 py-2 text-[13px] text-[color:var(--muted-foreground)]"
        data-testid="add-project-suggestions-empty"
      >
        {loading ? "Loading suggestions..." : `No directories under ${dirPath}`}
      </div>
    );
  }
  return (
    <ul
      id="add-project-suggestions"
      role="listbox"
      aria-label="Path suggestions"
      data-testid="add-project-suggestions"
      className="h-[240px] overflow-auto rounded-[8px] border border-[color:var(--hair-2)] bg-[color:var(--surface)]"
    >
      {entries.map((entry, index) => {
        const isActive = index === activeIndex;
        return (
          <li
            key={entry.path}
            role="option"
            aria-selected={isActive}
            data-testid="add-project-suggestion"
            data-active={isActive ? "true" : undefined}
            data-git={entry.isGitWorktree ? "true" : undefined}
            onMouseDown={(e) => {
              // Prevent input blur so focus stays in the field.
              e.preventDefault();
              onSelect(entry);
            }}
            onMouseEnter={() => onHover(index)}
            className={cn(
              "flex cursor-pointer items-center gap-2 px-3 py-2 text-[13px]",
              isActive
                ? "bg-[color:var(--hover)] text-[color:var(--ink)]"
                : "text-[color:var(--ink-2)] hover:bg-[color:var(--hover)]",
            )}
          >
            {entry.isGitWorktree ? (
              <GitBranch
                className="h-3.5 w-3.5 shrink-0 text-[color:var(--ink-2)]"
                aria-label="Git worktree"
              />
            ) : (
              <Folder className="h-3.5 w-3.5 shrink-0 text-[color:var(--muted-foreground)]" />
            )}
            <span className="min-w-0 flex-1 truncate font-mono">
              {entry.name}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
