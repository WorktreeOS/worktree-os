import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Check,
  ChevronsUpDown,
  GitBranch,
  GitFork,
  Search,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";

import { ModalShell } from "@/components/ui/modal-shell";
import { MatchHighlight } from "@/components/ui/match-highlight";
import { useProjects } from "@/lib/projects-context";
import { useTerminalCountsMap } from "@/lib/terminal-sessions-context";
import { readPinnedWorktrees } from "@/lib/pinned-worktrees";
import {
  buildSwitcherRows,
  groupSwitcherRows,
  searchSwitcherRows,
  type SwitcherRow,
} from "@/lib/worktree-switcher";
import { cn } from "@/lib/utils";

/* In-context worktree switcher.
 *
 * `WorktreeSwitcherTrigger` is a compact button that identifies the current
 * worktree and opens the sheet. `WorktreeSwitcherSheet` is a touch-friendly
 * modal/bottom-sheet that lists worktrees prioritized for the active set —
 * running/terminal-active first, then pinned, then the current project, then
 * everything else — and lets the user search and switch without leaving the
 * worktree surface. Selecting the current worktree just closes the sheet;
 * selecting another delegates navigation to the route via `onSelect`. */

export function WorktreeSwitcherTrigger({
  label,
  onClick,
  compact = false,
}: {
  /** Display label of the currently selected worktree. */
  label: string;
  onClick: () => void;
  /** Icon-only rendering for tight chrome (e.g. the fullscreen panel header). */
  compact?: boolean;
}) {
  if (compact) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label="Switch worktree"
        title="Switch worktree"
        data-testid="worktree-switcher-trigger"
        className="inline-grid h-7 w-7 place-items-center rounded-md border border-transparent text-[color:var(--muted-foreground)] transition-colors hover:bg-[color:var(--hover)] hover:text-[color:var(--ink)] focus-ring [&_svg]:size-[15px]"
      >
        <ChevronsUpDown strokeWidth={1.75} />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Switch worktree"
      data-testid="worktree-switcher-trigger"
      className="inline-flex max-w-[55vw] items-center gap-1.5 rounded-md border border-[color:var(--hair-2)] bg-[color:var(--surface)] px-2 py-1 text-[color:var(--ink)] transition-colors hover:bg-[color:var(--hover)] focus-ring"
    >
      <span className="truncate font-mono text-[12.5px]">{label}</span>
      <ChevronsUpDown
        className="h-3.5 w-3.5 shrink-0 text-[color:var(--muted-foreground)]"
        strokeWidth={1.75}
      />
    </button>
  );
}

export function WorktreeSwitcherSheet({
  currentPath,
  onSelect,
  onClose,
}: {
  /** Absolute path of the currently selected worktree. */
  currentPath: string;
  /** Called with the chosen worktree path (including the current one). */
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const { projects } = useProjects();
  const terminalCounts = useTerminalCountsMap();
  // The pinned set is owned by the sidebar; read it once when the sheet opens.
  const [pinnedPaths] = useState(() => readPinnedWorktrees());
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const rows = useMemo(
    () =>
      buildSwitcherRows(projects, {
        currentPath,
        pinnedPaths,
        terminalCounts,
      }),
    [projects, currentPath, pinnedPaths, terminalCounts],
  );
  const filtered = useMemo(
    () => searchSwitcherRows(rows, query),
    [rows, query],
  );
  const groups = useMemo(
    () => (filtered === null ? groupSwitcherRows(rows) : null),
    [filtered, rows],
  );

  return (
    <ModalShell
      testId="worktree-switcher"
      ariaLabel="Switch worktree"
      submitting={false}
      onCancel={onClose}
      fullHeight
    >
      <div className="flex h-full min-h-0 flex-col md:h-auto">
        <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--hair)] px-4 py-3">
          <Search
            className="h-4 w-4 shrink-0 text-[color:var(--muted-foreground)]"
            strokeWidth={1.75}
          />
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder="Search worktrees…"
            aria-label="Search worktrees"
            data-testid="worktree-switcher-search"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                if (query) setQuery("");
                else onClose();
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-[color:var(--ink)] placeholder:text-[color:var(--muted-foreground)] focus:outline-none"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              data-testid="worktree-switcher-clear"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              className="grid h-5 w-5 shrink-0 place-items-center rounded text-[color:var(--muted-foreground)] hover:text-[color:var(--ink)]"
            >
              <X className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            data-testid="worktree-switcher-close"
            className="shrink-0 rounded-md px-1.5 py-1 text-[13px] text-[color:var(--muted-foreground)] transition-colors hover:text-[color:var(--ink)] focus-ring"
          >
            Cancel
          </button>
        </div>

        <div
          className="min-h-0 flex-1 overflow-auto px-2 py-2 md:max-h-[60vh] md:flex-none"
          data-testid="worktree-switcher-list"
        >
          {filtered !== null ? (
            filtered.length === 0 ? (
              <EmptyState>No worktrees match “{query.trim()}”</EmptyState>
            ) : (
              <ul className="flex flex-col">
                {filtered.map((row) => (
                  <SwitcherRowButton
                    key={row.path}
                    row={row}
                    query={query}
                    onSelect={onSelect}
                  />
                ))}
              </ul>
            )
          ) : groups ? (
            <>
              <SwitcherGroup title="Active" rows={groups.active} onSelect={onSelect} />
              <SwitcherGroup title="Pinned" rows={groups.pinned} onSelect={onSelect} />
              <SwitcherGroup
                title="This project"
                rows={groups.currentProject}
                onSelect={onSelect}
              />
              <SwitcherGroup
                title="All worktrees"
                rows={groups.others}
                onSelect={onSelect}
              />
              {rows.length === 0 && <EmptyState>No worktrees yet</EmptyState>}
            </>
          ) : null}
        </div>
      </div>
    </ModalShell>
  );
}

function SwitcherGroup({
  title,
  rows,
  onSelect,
}: {
  title: string;
  rows: SwitcherRow[];
  onSelect: (path: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="mb-1" data-testid={`worktree-switcher-group-${title}`}>
      <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2.5">
        <span className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-[color:var(--muted-foreground)]">
          {title}
        </span>
        <span className="text-[10px] tabular-nums text-[color:var(--muted-foreground)]/70">
          {rows.length}
        </span>
      </div>
      <ul className="flex flex-col">
        {rows.map((row) => (
          <SwitcherRowButton
            key={row.path}
            row={row}
            query=""
            onSelect={onSelect}
          />
        ))}
      </ul>
    </div>
  );
}

function SwitcherRowButton({
  row,
  query,
  onSelect,
}: {
  row: SwitcherRow;
  query: string;
  onSelect: (path: string) => void;
}) {
  const Icon = row.isSource ? GitFork : GitBranch;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(row.path)}
        data-testid="worktree-switcher-row"
        data-worktree-path={row.path}
        data-current={row.isCurrent ? "true" : undefined}
        aria-current={row.isCurrent ? "true" : undefined}
        title={row.path}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
          row.isCurrent
            ? "bg-[color:var(--hover)] text-[color:var(--ink)]"
            : "text-[color:var(--ink-2)] hover:bg-[color:var(--hover)] hover:text-[color:var(--ink)]",
        )}
      >
        <span className={cn("status-dot", dotTone(row))} aria-hidden />
        <Icon
          className="h-3.5 w-3.5 shrink-0 text-[color:var(--muted-foreground)]"
          strokeWidth={1.75}
        />
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate font-mono text-[12.5px]">
            <MatchHighlight text={row.label} query={query} />
          </span>
          <span className="truncate text-[10.5px] text-[color:var(--muted-foreground)]">
            <MatchHighlight text={row.projectName} query={query} />
          </span>
        </span>
        {row.terminalCount > 0 && (
          <span
            className="inline-flex shrink-0 items-center gap-0.5 text-[11px] tabular-nums text-[color:var(--muted-foreground)]"
            title={`${row.terminalCount} live terminal${
              row.terminalCount === 1 ? "" : "s"
            }`}
          >
            <TerminalIcon className="h-3 w-3" strokeWidth={1.75} />
            {row.terminalCount}
          </span>
        )}
        {row.isCurrent && (
          <Check
            className="h-4 w-4 shrink-0 text-[color:var(--ink)]"
            strokeWidth={1.75}
            data-testid="worktree-switcher-current"
          />
        )}
      </button>
    </li>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      className="px-3 py-8 text-center text-[13px] text-[color:var(--muted-foreground)]"
      data-testid="worktree-switcher-empty"
    >
      {children}
    </div>
  );
}

/** Leading status dot tone mirroring the worktree's deployment/active state. */
function dotTone(row: SwitcherRow): string {
  switch (row.status) {
    case "running":
    case "running_partial":
      return "status-dot--running";
    case "failed":
      return "status-dot--error";
    case "pending":
    case "checking":
    case "stopping":
      return "status-dot--warn";
    default:
      return row.isActive ? "status-dot--active" : "";
  }
}
