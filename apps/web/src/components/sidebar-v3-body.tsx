import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";
import { DndContext, useSensors, type DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronDown,
  FolderGit2,
  GitBranch,
  GitBranchPlus,
  GripVertical,
  MoreHorizontal,
  Plus,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { StatusDot, statusDotVariant } from "@/components/ui/status-dot";
import { AttentionGroupHeader } from "@/components/ui/attention-group-header";
import { StreamSessionRow } from "@/components/ui/stream-session-row";
import { worktreeLabel } from "@/lib/sidebar-labels";
import { isRemovingWorktree, railCollisionDetection } from "@/lib/sidebar-band";
import { cn } from "@/lib/utils";
import type { ProjectSummary, WorktreeSummary } from "@/lib/ui-api";
import type { ActiveScopeGroup, SidebarScope } from "@/lib/sidebar-scope";
import {
  STREAM_GROUPS,
  type AttentionResult,
  type StreamFilter,
} from "@/lib/sidebar-attention";
import type { WorktreeTileIdentity } from "@/lib/project-identity";

/* The v3 rail body — a flat attention stream (SessionsStream) followed by a
 * flat worktree inventory (WorktreeBand), canonical
 * demo/sidebar-worktree-band-v3.html. Presentation only; every value here
 * comes from useSidebarController in sidebar.tsx. */

export interface SidebarV3BodyProps {
  attention: AttentionResult;
  streamFilter: StreamFilter;
  scope: SidebarScope;
  activeProject: ProjectSummary | null;
  touch: boolean;
  activeSessionId: string | null;
  resolveSessionIdentity: (path: string) => {
    tile: WorktreeTileIdentity;
    worktreeName: string;
    projectName?: string;
  };
  onAttach: (worktreePath: string, sessionId?: string) => void;
  onNewHere: (worktreePath: string) => void;
  onKill: (id: string) => void;
  bandCollapsed: boolean;
  onToggleBandCollapse: () => void;
  orderedVisibleWorktrees: WorktreeSummary[];
  orderedBandProjects: ActiveScopeGroup[];
  activePath: string | null;
  sensors: ReturnType<typeof useSensors>;
  onRailDragEnd: (e: DragEndEvent) => void;
  bandShared: BandRowSharedProps;
  onCreateWorktree: (project: ProjectSummary) => void;
}

export function SidebarV3Body({
  attention,
  streamFilter,
  scope,
  activeProject,
  touch,
  activeSessionId,
  resolveSessionIdentity,
  onAttach,
  onNewHere,
  onKill,
  bandCollapsed,
  onToggleBandCollapse,
  orderedVisibleWorktrees,
  orderedBandProjects,
  activePath,
  sensors,
  onRailDragEnd,
  bandShared,
  onCreateWorktree,
}: SidebarV3BodyProps) {
  return (
    <>
      <SessionsStream
        attention={attention}
        filter={streamFilter}
        scopeLabel={
          scope === "project" ? activeProject?.displayName : undefined
        }
        // Active-now mixes projects, so the rows surface their project
        // context; in a single project the scope already names it.
        showProject={scope === "active-now"}
        touch={touch}
        activeSessionId={activeSessionId}
        resolve={resolveSessionIdentity}
        onAttach={onAttach}
        onNewHere={onNewHere}
        onKill={onKill}
      />

      <WorktreeBand
        scope={scope}
        collapsed={bandCollapsed}
        onToggleCollapse={onToggleBandCollapse}
        activeProject={activeProject}
        projectWorktrees={orderedVisibleWorktrees}
        bandProjects={orderedBandProjects}
        activePath={activePath}
        sensors={sensors}
        onDragEnd={onRailDragEnd}
        shared={bandShared}
        onCreateWorktree={onCreateWorktree}
      />
    </>
  );
}

/* SessionsStream — the rail's live-session body: sessions grouped by attention
 * (Needs you / Unread / Working / Idle), each group rendered with a header + a
 * flat list of StreamSessionRows. The active filter collapses the stream to one
 * group (All shows every non-empty group). Presentation only. */
function SessionsStream({
  attention,
  filter,
  scopeLabel,
  showProject,
  touch,
  activeSessionId,
  resolve,
  onAttach,
  onNewHere,
  onKill,
}: {
  attention: AttentionResult;
  filter: StreamFilter;
  scopeLabel?: string;
  showProject: boolean;
  touch: boolean;
  activeSessionId: string | null;
  resolve: (path: string) => {
    tile: WorktreeTileIdentity;
    worktreeName: string;
    projectName?: string;
  };
  onAttach: (worktreePath: string, sessionId?: string) => void;
  onNewHere: (worktreePath: string) => void;
  onKill: (id: string) => void;
}) {
  if (attention.counts.total === 0) {
    return (
      <div
        data-testid="rail-stream-empty"
        className="px-2 py-6 text-center text-[12.5px] text-muted-foreground/70"
      >
        No live sessions{scopeLabel ? ` in ${scopeLabel}` : ""}
      </div>
    );
  }

  const groups = STREAM_GROUPS.filter(({ key }) => {
    if (attention.groups[key].length === 0) return false;
    if (filter !== "all" && filter !== key) return false;
    return true;
  });

  if (groups.length === 0) {
    return (
      <div className="px-2 py-6 text-center text-[12px] text-muted-foreground/55">
        Nothing here
      </div>
    );
  }

  return (
    <div data-testid="rail-stream">
      {groups.map(({ key, label }) => {
        const list = attention.groups[key];
        return (
          <div key={key}>
            <AttentionGroupHeader
              variant={key}
              label={label}
              count={list.length}
            />
            {list.map((session) => {
              const { tile, worktreeName, projectName } = resolve(
                session.worktreePath,
              );
              return (
                <StreamSessionRow
                  key={session.id}
                  session={session}
                  tile={tile}
                  worktreeName={worktreeName}
                  projectName={projectName}
                  showProject={showProject}
                  active={session.id === activeSessionId}
                  touch={touch}
                  onAttach={() => onAttach(session.worktreePath, session.id)}
                  onNewHere={() => onNewHere(session.worktreePath)}
                  onKill={() => onKill(session.id)}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

export interface BandRowSharedProps {
  touch: boolean;
  /** Worktree-centric open: docks the panel (desktop) or navigates full-screen. */
  onOpen: (path: string) => void;
  /** Quick `New session here` — create a terminal in this worktree and attach. */
  onNewSession: (wt: WorktreeSummary) => void;
  /** Open the actions menu (from `⋯` or right-click) at a clamped position. */
  onOpenMenu: (wt: WorktreeSummary, x: number, y: number) => void;
  renamingPath: string | null;
  renamePending: boolean;
  renameError: string | null;
  onRenameSubmit: (wt: WorktreeSummary, nextName: string) => void;
  onRenameCancel: () => void;
  notingPath: string | null;
  notePending: boolean;
  noteError: string | null;
  onNoteSubmit: (wt: WorktreeSummary, nextNote: string) => void;
  onNoteCancel: () => void;
}

/* WorktreeBand — the collapsible worktree inventory + management surface below
 * the session stream (canonical: demo/sidebar-worktree-band-v3.html). In
 * project scope it is a flat, drag-reorderable list; in Active-now scope it
 * groups every project's full inventory under per-project headers (worktree
 * order read-only there; project groups are drag-reorderable). */
function WorktreeBand({
  scope,
  collapsed,
  onToggleCollapse,
  activeProject,
  projectWorktrees,
  bandProjects,
  activePath,
  sensors,
  onDragEnd,
  shared,
  onCreateWorktree,
}: {
  scope: SidebarScope;
  collapsed: boolean;
  onToggleCollapse: () => void;
  activeProject: ProjectSummary | null;
  projectWorktrees: WorktreeSummary[];
  bandProjects: ActiveScopeGroup[];
  activePath: string | null;
  sensors: ReturnType<typeof useSensors>;
  onDragEnd: (e: DragEndEvent) => void;
  shared: BandRowSharedProps;
  onCreateWorktree: (project: ProjectSummary) => void;
}) {
  const count =
    scope === "project"
      ? projectWorktrees.length
      : bandProjects.reduce((n, g) => n + g.worktrees.length, 0);

  return (
    <div className="mt-2.5 border-t border-[color:var(--hair)] pt-0.5">
      <BandHeader
        count={count}
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
        createAction={
          scope === "project" && activeProject
            ? {
                label: `New worktree in ${activeProject.displayName}`,
                disabled: activeProject.stale,
                onClick: () => onCreateWorktree(activeProject),
              }
            : undefined
        }
      />

      {!collapsed &&
        (scope === "project" ? (
          <DndContext
            sensors={sensors}
            collisionDetection={railCollisionDetection}
            onDragEnd={onDragEnd}
          >
            <SortableContext
              items={projectWorktrees.map((wt) => `worktree:${wt.path}`)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="flex flex-col">
                {projectWorktrees.map((wt) => (
                  <SortableWorktreeBandRow
                    key={wt.path}
                    {...shared}
                    worktree={wt}
                    isActive={activePath === wt.path}
                  />
                ))}
                {projectWorktrees.length === 0 && (
                  <li className="px-2 py-1 text-[12px] text-muted-foreground/55">
                    no worktrees
                  </li>
                )}
              </ul>
            </SortableContext>
          </DndContext>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={railCollisionDetection}
            onDragEnd={onDragEnd}
          >
            <SortableContext
              items={bandProjects.map((g) => `project:${g.project.id}`)}
              strategy={verticalListSortingStrategy}
            >
              {bandProjects.map(({ project, worktrees }) => (
                <BandProjectGroup
                  key={project.id}
                  project={project}
                  touch={shared.touch}
                  onCreateWorktree={() => onCreateWorktree(project)}
                >
                  <ul className="flex flex-col">
                    {worktrees.map((wt) => (
                      <WorktreeBandRow
                        key={wt.path}
                        {...shared}
                        worktree={wt}
                        isActive={activePath === wt.path}
                      />
                    ))}
                  </ul>
                </BandProjectGroup>
              ))}
              {bandProjects.length === 0 && (
                <div className="px-2 py-1 text-[12px] text-muted-foreground/55">
                  no worktrees
                </div>
              )}
            </SortableContext>
          </DndContext>
        ))}
    </div>
  );
}

/* BandHeader — the band's collapsible section header: a chevron + label +
 * count toggle, with an optional `New worktree` action on the right. */
function BandHeader({
  count,
  collapsed,
  onToggleCollapse,
  createAction,
}: {
  count: number;
  collapsed: boolean;
  onToggleCollapse: () => void;
  createAction?: { label: string; disabled?: boolean; onClick: () => void };
}) {
  return (
    <div className="flex items-center gap-1.5 px-2 pb-1 pt-2">
      <button
        type="button"
        aria-expanded={!collapsed}
        data-testid="sidebar-band-toggle"
        onClick={onToggleCollapse}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <ChevronDown
          className={cn(
            "size-3 shrink-0 text-muted-foreground/55 transition-transform duration-150",
            collapsed && "-rotate-90",
          )}
          strokeWidth={1.75}
          aria-hidden
        />
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/55">
          Worktrees
        </span>
        {count > 0 && (
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground/45">
            {count}
          </span>
        )}
      </button>
      {createAction && (
        <button
          type="button"
          onClick={createAction.onClick}
          disabled={createAction.disabled}
          title={createAction.label}
          aria-label={createAction.label}
          data-testid="sidebar-create-worktree"
          className="grid size-[22px] place-items-center rounded-md text-muted-foreground/55 transition-colors hover:bg-[color:var(--surface)] hover:text-[color:var(--ink)] hover:shadow-[inset_0_0_0_1px_var(--hair-2)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:shadow-none"
        >
          <GitBranchPlus className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
}

/* BandProjectGroup — one project's slice of the Active-now band: a quiet,
 * drag-reorderable folder header (folder icon + name + worktree count + a
 * per-project `New worktree`) followed by that project's full inventory. */
function BandProjectGroup({
  project,
  touch,
  onCreateWorktree,
  children,
}: {
  project: ProjectSummary;
  touch: boolean;
  onCreateWorktree: () => void;
  children: ReactNode;
}) {
  const {
    setNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: `project:${project.id}` });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid="sidebar-band-group"
      data-project-id={project.id}
      className={cn(
        "mb-px border-t border-[color:var(--hair)] pt-1 first-of-type:border-t-0 first-of-type:pt-0",
        isDragging && "opacity-60",
      )}
    >
      <div className="group/phead relative flex items-center">
        <span
          {...attributes}
          {...listeners}
          data-testid="sidebar-project-grip"
          aria-label="Reorder project"
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "flex cursor-grab touch-none items-center justify-center text-[color:var(--muted-foreground)] active:cursor-grabbing",
            touch
              ? "h-10 w-4 shrink-0"
              : "absolute inset-y-0 left-0 z-10 w-3.5 -translate-x-[8px] opacity-0 group-hover/phead:opacity-100",
          )}
        >
          <GripVertical
            className={touch ? "size-[15px]" : "size-3.5"}
            strokeWidth={1.75}
            aria-hidden
          />
        </span>
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 px-2",
            touch ? "h-10" : "h-[29px]",
          )}
        >
          <FolderGit2
            className={cn(
              "shrink-0 text-[color:var(--muted-foreground)]",
              touch ? "size-[15px]" : "size-[13px]",
            )}
            strokeWidth={1.75}
            aria-hidden
          />
          <span
            className={cn(
              "min-w-0 flex-1 truncate font-semibold text-[color:var(--ink-2)]",
              touch ? "text-[13.5px]" : "text-[11.5px]",
            )}
          >
            {project.displayName}
          </span>
          <span
            className={cn(
              "shrink-0 font-mono tabular-nums text-muted-foreground/45",
              touch ? "text-[12px]" : "text-[10.5px]",
            )}
          >
            {project.worktrees.length}
          </span>
          <button
            type="button"
            onClick={onCreateWorktree}
            disabled={project.stale}
            title={`New worktree in ${project.displayName}`}
            aria-label={`New worktree in ${project.displayName}`}
            data-testid="sidebar-create-worktree"
            className="grid size-[22px] shrink-0 place-items-center rounded-md text-muted-foreground/55 transition-colors hover:bg-[color:var(--surface)] hover:text-[color:var(--ink)] hover:shadow-[inset_0_0_0_1px_var(--hair-2)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:shadow-none"
          >
            <GitBranchPlus className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </div>
      </div>
      {children}
    </div>
  );
}

interface WorktreeBandRowProps extends BandRowSharedProps {
  worktree: WorktreeSummary;
  isActive: boolean;
  /** Sortable wiring (project scope only). Omit for a non-draggable row. */
  rootRef?: Ref<HTMLLIElement>;
  style?: CSSProperties;
  dragHandleProps?: Record<string, unknown>;
  isDragging?: boolean;
}

/* WorktreeBandRow — one flat worktree row in the band: status dot + Geist-Mono
 * name + `root` badge, with a `⋯` overflow opening the worktree actions menu.
 * The whole row is the open target. No expansion — sessions live in the stream
 * above, runtime in the worktree dossier. Mirrors `.wtrow` in
 * demo/sidebar-worktree-band-v3.html. */
function WorktreeBandRow({
  worktree: wt,
  isActive,
  touch,
  onOpen,
  onNewSession,
  onOpenMenu,
  renamingPath,
  renamePending,
  renameError,
  onRenameSubmit,
  onRenameCancel,
  notingPath,
  notePending,
  noteError,
  onNoteSubmit,
  onNoteCancel,
  rootRef,
  style,
  dragHandleProps,
  isDragging = false,
}: WorktreeBandRowProps) {
  if (notingPath === wt.path) {
    return (
      <WorktreeNoteRow
        wt={wt}
        pending={notePending}
        error={noteError}
        onSubmit={(note) => onNoteSubmit(wt, note)}
        onCancel={onNoteCancel}
      />
    );
  }
  if (renamingPath === wt.path) {
    return (
      <WorktreeRenameRow
        wt={wt}
        pending={renamePending}
        error={renameError}
        onSubmit={(name) => onRenameSubmit(wt, name)}
        onCancel={onRenameCancel}
      />
    );
  }

  const removing = isRemovingWorktree(wt);

  const row = (
    <div
      data-testid="sidebar-worktree-row"
      data-worktree-path={wt.path}
      data-removing={removing ? "true" : "false"}
      data-source={wt.isSource ? "true" : undefined}
      data-active={isActive ? "true" : undefined}
      onClick={() => onOpen(wt.path)}
      onContextMenu={(e) => {
        e.preventDefault();
        onOpenMenu(wt, e.clientX, e.clientY);
      }}
      className={cn(
        "group/row relative grid cursor-pointer items-center gap-2.5 rounded-[9px]",
        "grid-cols-[7px_1fr_auto]",
        touch ? "h-12 pl-2 pr-1.5" : "h-[34px] pl-2 pr-1",
        isActive ? "bg-sidebar-active" : "hover:bg-sidebar-hover",
        removing && "opacity-45",
      )}
    >
      {dragHandleProps && (
        <span
          {...dragHandleProps}
          data-testid="sidebar-worktree-grip"
          aria-label="Reorder worktree"
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "flex cursor-grab touch-none items-center justify-center text-[color:var(--muted-foreground)] active:cursor-grabbing",
            touch
              ? "w-4 shrink-0"
              : "absolute inset-y-0 left-0 z-10 w-3 -translate-x-[10px] opacity-0 group-hover/row:opacity-100",
          )}
        >
          <GripVertical
            className={touch ? "size-[15px]" : "size-3.5"}
            strokeWidth={1.75}
            aria-hidden
          />
        </span>
      )}

      <StatusDot
        variant={statusDotVariant(wt.status)}
        size={touch ? 9 : 7}
      />

      <button
        type="button"
        data-testid="sidebar-worktree-open"
        onClick={(e) => {
          e.stopPropagation();
          onOpen(wt.path);
        }}
        title={wt.isSource ? `Root worktree — ${wt.path}` : wt.path}
        className="flex min-w-0 cursor-pointer items-center gap-2 text-left focus-ring"
      >
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-mono",
            touch ? "text-[13.5px]" : "text-[12px]",
            isActive
              ? "font-medium text-[color:var(--ink)]"
              : "text-[color:var(--ink-2)]",
            removing &&
              "text-muted-foreground/70 line-through decoration-[color:var(--bad)]/55",
          )}
        >
          {worktreeLabel(wt)}
        </span>
        {wt.isSource && (
          <span className="shrink-0 text-[9.5px] font-semibold tracking-[0.03em] text-[color:var(--muted-foreground)]">
            root
          </span>
        )}
      </button>

      <div className="flex items-center gap-0.5">
        {/* Quick `New session here` — revealed on hover (desktop), always shown
            on touch. The full action set stays in the `⋯` menu. */}
        <button
          type="button"
          title="New session here"
          aria-label="New session here"
          data-testid="sidebar-worktree-new-session"
          onClick={(e) => {
            e.stopPropagation();
            onNewSession(wt);
          }}
          className={cn(
            "cursor-pointer place-items-center rounded-md text-[color:var(--muted-foreground)] transition-colors",
            "hover:bg-[color:var(--surface)] hover:text-[color:var(--ink)] hover:shadow-[inset_0_0_0_1px_var(--hair-2)]",
            touch
              ? "grid size-9 [&_svg]:size-[18px]"
              : "grid size-6 opacity-0 group-hover/row:opacity-100 [&_svg]:size-[15px]",
          )}
        >
          <Plus strokeWidth={1.75} />
        </button>

        <button
          type="button"
          title="Worktree actions"
          aria-label="Worktree actions"
          data-testid="sidebar-worktree-more"
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            onOpenMenu(wt, r.right - 4, r.bottom + 4);
          }}
          className={cn(
            "cursor-pointer place-items-center rounded-md text-[color:var(--muted-foreground)] transition-colors",
            "hover:bg-[color:var(--surface)] hover:text-[color:var(--ink)] hover:shadow-[inset_0_0_0_1px_var(--hair-2)]",
            touch
              ? "grid size-9 [&_svg]:size-[19px]"
              : "grid size-6 opacity-0 group-hover/row:opacity-100 [&_svg]:size-[15px]",
          )}
        >
          <MoreHorizontal strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );

  const rowWithNote = wt.note ? (
    <Tooltip>
      <TooltipTrigger asChild>{row}</TooltipTrigger>
      <TooltipContent side="right" className="max-w-[260px] whitespace-pre-wrap">
        {wt.note}
      </TooltipContent>
    </Tooltip>
  ) : (
    row
  );

  return (
    <li
      ref={rootRef}
      style={style}
      data-testid="sidebar-worktree-node"
      className={cn("mb-px", isDragging && "opacity-60")}
    >
      {rowWithNote}
    </li>
  );
}

/* Project-scope wrapper that makes a `WorktreeBandRow` draggable over
 * `worktree:<path>` items. Active-now renders the plain row (worktree order is
 * honored read-only there). */
function SortableWorktreeBandRow(props: WorktreeBandRowProps) {
  const {
    setNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: `worktree:${props.worktree.path}` });
  return (
    <WorktreeBandRow
      {...props}
      rootRef={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      dragHandleProps={{ ...attributes, ...listeners }}
      isDragging={isDragging}
    />
  );
}

/* ============================ Editing rows ============================ */

export function WorktreeRenameRow({
  wt,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  wt: WorktreeSummary;
  pending: boolean;
  error: string | null;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const initial = wt.displayName ?? worktreeLabel(wt);
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <li>
      <div
        data-testid="sidebar-worktree-rename"
        data-worktree-path={wt.path}
        className="flex flex-col gap-1 rounded-lg px-2 py-[6px]"
      >
        <div className="flex items-center gap-2.5">
          <span className="inline-flex w-4 shrink-0 items-center justify-center">
            <GitBranch
              className="size-[15px] text-[color:var(--muted-foreground)]"
              strokeWidth={1.75}
            />
          </span>
          <input
            ref={inputRef}
            type="text"
            value={value}
            disabled={pending}
            data-testid="sidebar-worktree-rename-input"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onSubmit(value);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onCancel();
              }
            }}
            className="min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 py-0.5 text-[13px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        {error && (
          <div
            data-testid="sidebar-worktree-rename-error"
            className="pl-[26px] text-[11px] text-[color:var(--bad)]"
          >
            {error}
          </div>
        )}
      </div>
    </li>
  );
}

export function WorktreeNoteRow({
  wt,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  wt: WorktreeSummary;
  pending: boolean;
  error: string | null;
  onSubmit: (note: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(wt.note ?? "");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <li>
      <div
        data-testid="sidebar-worktree-note"
        data-worktree-path={wt.path}
        className="flex flex-col gap-1 rounded-lg px-2 py-[6px]"
      >
        <div className="flex items-start gap-2.5">
          <span className="mt-1 inline-flex w-4 shrink-0 items-center justify-center">
            <GitBranch
              className="size-[15px] text-[color:var(--muted-foreground)]"
              strokeWidth={1.75}
            />
          </span>
          <textarea
            ref={inputRef}
            rows={2}
            value={value}
            disabled={pending}
            placeholder="Add a note…"
            data-testid="sidebar-worktree-note-input"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSubmit(value);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onCancel();
              }
            }}
            className="min-w-0 flex-1 resize-none rounded-sm border border-border bg-background px-1.5 py-0.5 text-[13px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        {error && (
          <div
            data-testid="sidebar-worktree-note-error"
            className="pl-[26px] text-[11px] text-[color:var(--bad)]"
          >
            {error}
          </div>
        )}
      </div>
    </li>
  );
}
