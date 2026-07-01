import { useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { DndContext, useSensors, type DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronRight,
  GitBranchPlus,
  GripVertical,
  MoreHorizontal,
  Plus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { worktreeLabel } from "@/lib/sidebar-labels";
import { isRemovingWorktree, railCollisionDetection } from "@/lib/sidebar-band";
import { projectTile } from "@/lib/project-identity";
import { ProjectTile } from "@/components/ui/project-tile";
import { TerminalSessionRow } from "@/components/ui/terminal-session-row";
import type { ProjectSummary, WorktreeSummary } from "@/lib/ui-api";
import type { ActiveScopeGroup, SidebarScope } from "@/lib/sidebar-scope";
import type { StreamFilter } from "@/lib/sidebar-attention";
import type { TerminalSessionMetadata } from "@/lib/terminal-protocol";
import { buildWorktreeTreeNodes, type WorktreeTreeNode } from "@/lib/sidebar-tree";
import {
  readCollapsedWorktrees,
  writeCollapsedWorktrees,
} from "@/lib/sidebar-tree-collapsed";
import {
  WorktreeNoteRow,
  WorktreeRenameRow,
  type BandRowSharedProps,
} from "@/components/sidebar-v3-body";

/* The v4 rail body — a worktree tree: each worktree is a node you unfold to
 * reveal its live sessions, canonical demo/sidebar-worktree-tree-v4.html.
 * Every worktree is open by default; a manual collapse is remembered
 * per-device (lib/sidebar-tree-collapsed.ts) and stays sticky — new
 * attention arriving later does not reopen a worktree the user closed. No
 * session-count badge and no health dot on the worktree row, by design. */

export interface SidebarV4BodyProps {
  scope: SidebarScope;
  activeProject: ProjectSummary | null;
  orderedVisibleWorktrees: WorktreeSummary[];
  /** Active-now groups, pre-filtered by the caller to worktrees that have a
   * live terminal or a running deployment — Active now is an activity view,
   * not the project's full inventory (unlike v3's Worktrees band). */
  orderedBandProjects: ActiveScopeGroup[];
  scopedSessionsByPath: ReadonlyMap<string, ReadonlyArray<TerminalSessionMetadata>>;
  streamFilter: StreamFilter;
  activePath: string | null;
  activeSessionId: string | null;
  touch: boolean;
  sensors: ReturnType<typeof useSensors>;
  onRailDragEnd: (e: DragEndEvent) => void;
  bandShared: BandRowSharedProps;
  onAttach: (worktreePath: string, sessionId?: string) => void;
  onKill: (id: string) => void;
  onStartWorktree: (wt: WorktreeSummary) => void;
  onCreateWorktree: (project: ProjectSummary) => void;
  onSelectProject: (projectId: string) => void;
}

/** Shared row-level props threaded into every worktree tree node regardless
 * of scope or drag wiring. */
interface TreeNodeSharedProps {
  touch: boolean;
  bandShared: BandRowSharedProps;
  activeSessionId: string | null;
  onAttach: (worktreePath: string, sessionId?: string) => void;
  onKill: (id: string) => void;
  onToggleOpen: (path: string, currentlyOpen: boolean) => void;
  onStartWorktree: (wt: WorktreeSummary) => void;
}

export function SidebarV4Body({
  scope,
  activeProject,
  orderedVisibleWorktrees,
  orderedBandProjects,
  scopedSessionsByPath,
  streamFilter,
  activePath,
  activeSessionId,
  touch,
  sensors,
  onRailDragEnd,
  bandShared,
  onAttach,
  onKill,
  onStartWorktree,
  onCreateWorktree,
  onSelectProject,
}: SidebarV4BodyProps) {
  // Every worktree is open by default; this remembers only the ones the user
  // manually collapsed, persisted per-device so it survives a reload.
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() =>
    readCollapsedWorktrees(),
  );
  const toggleOpen = (path: string, currentlyOpen: boolean) => {
    setCollapsedPaths((prev) => {
      const next = new Set(prev);
      if (currentlyOpen) next.add(path);
      else next.delete(path);
      writeCollapsedWorktrees(next);
      return next;
    });
  };

  const shared: TreeNodeSharedProps = {
    touch,
    bandShared,
    activeSessionId,
    onAttach,
    onKill,
    onToggleOpen: toggleOpen,
    onStartWorktree,
  };

  if (scope === "project") {
    const nodes = buildWorktreeTreeNodes({
      worktrees: orderedVisibleWorktrees,
      sessionsByPath: scopedSessionsByPath,
      filter: streamFilter,
      activeWorktreePath: activePath,
      collapsedPaths,
    });

    return (
      <>
        <DndContext
          sensors={sensors}
          collisionDetection={railCollisionDetection}
          onDragEnd={onRailDragEnd}
        >
          <SortableContext
            items={nodes.map((n) => `worktree:${n.key}`)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="flex flex-col">
              {nodes.map((node) => (
                <SortableWorktreeTreeNode key={node.key} node={node} {...shared} />
              ))}
              {nodes.length === 0 && (
                <li className="px-2 py-1 text-[12px] text-muted-foreground/55">
                  no worktrees
                </li>
              )}
            </ul>
          </SortableContext>
        </DndContext>

        {activeProject && (
          <button
            type="button"
            onClick={() => onCreateWorktree(activeProject)}
            disabled={activeProject.stale}
            data-testid="sidebar-tree-new-worktree"
            className="mt-1.5 flex h-8 w-full items-center gap-2 rounded-[9px] border border-dashed border-[color:var(--hair-2)] px-2 text-[12px] text-muted-foreground/70 transition-colors hover:border-muted-foreground hover:bg-sidebar-hover hover:text-[color:var(--ink-2)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <GitBranchPlus className="size-3.5" strokeWidth={1.75} />
            New worktree in {activeProject.displayName}
          </button>
        )}
      </>
    );
  }

  // Active-now: group by project, each group's own worktree tree — a filter
  // that leaves a project with no matching nodes drops that project's group
  // entirely (mirrors the demo's active-now render loop).
  const groups = orderedBandProjects
    .map(({ project, worktrees }) => ({
      project,
      nodes: buildWorktreeTreeNodes({
        worktrees,
        sessionsByPath: scopedSessionsByPath,
        filter: streamFilter,
        activeWorktreePath: activePath,
        collapsedPaths,
      }),
    }))
    .filter((g) => g.nodes.length > 0 || streamFilter === "all");

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={railCollisionDetection}
      onDragEnd={onRailDragEnd}
    >
      <SortableContext
        items={groups.map((g) => `project:${g.project.id}`)}
        strategy={verticalListSortingStrategy}
      >
        {groups.map(({ project, nodes }) => (
          <TreeProjectGroup
            key={project.id}
            project={project}
            touch={touch}
            onSelect={() => onSelectProject(project.id)}
          >
            <ul className="flex flex-col">
              {nodes.map((node) => (
                <WorktreeTreeNodeRow key={node.key} node={node} {...shared} />
              ))}
            </ul>
          </TreeProjectGroup>
        ))}
        {groups.length === 0 && (
          <div className="px-2 py-1 text-[12px] text-muted-foreground/55">
            no worktrees
          </div>
        )}
      </SortableContext>
    </DndContext>
  );
}

/* TreeProjectGroup — one project's slice of the Active-now tree: a quiet,
 * drag-reorderable header (project tile + name, clickable to switch into that
 * project's scope — mirrors the demo's `.group-head`), followed by that
 * project's own worktree tree. No `New worktree` action here — Active now is
 * a live-activity view, not a place to create branches (that lives in
 * project scope's dashed row). */
function TreeProjectGroup({
  project,
  touch,
  onSelect,
  children,
}: {
  project: ProjectSummary;
  touch: boolean;
  onSelect: () => void;
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
  const tile = projectTile(project);
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid="sidebar-tree-project-group"
      data-project-id={project.id}
      className={cn(
        "mb-1 border-t border-[color:var(--hair)] pt-1.5 first-of-type:border-t-0 first-of-type:pt-0",
        isDragging && "opacity-60",
      )}
    >
      <div className="group/tphead relative flex items-center">
        <span
          {...attributes}
          {...listeners}
          data-testid="sidebar-tree-project-grip"
          aria-label="Reorder project"
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "flex cursor-grab touch-none items-center justify-center text-[color:var(--muted-foreground)] active:cursor-grabbing",
            touch
              ? "h-9 w-4 shrink-0"
              : "absolute inset-y-0 left-0 z-10 w-3.5 -translate-x-[8px] opacity-0 group-hover/tphead:opacity-100",
          )}
        >
          <GripVertical
            className={touch ? "size-[15px]" : "size-3.5"}
            strokeWidth={1.75}
            aria-hidden
          />
        </span>
        <button
          type="button"
          onClick={onSelect}
          title={`Open ${project.displayName}`}
          data-testid="sidebar-tree-project-open"
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left transition-colors hover:bg-sidebar-hover",
            touch ? "h-9" : "h-7",
          )}
        >
          <ProjectTile
            monogram={tile.monogram}
            colorVar={tile.colorVar}
            size={touch ? 20 : 18}
          />
          <span
            className={cn(
              "min-w-0 flex-1 truncate font-semibold text-[color:var(--ink-2)]",
              touch ? "text-[13.5px]" : "text-[11.5px]",
            )}
          >
            {project.displayName}
          </span>
        </button>
      </div>
      {children}
    </div>
  );
}

interface WorktreeTreeNodeRowProps extends TreeNodeSharedProps {
  node: WorktreeTreeNode;
  /** Sortable wiring (project scope only). Omit for a non-draggable row. */
  rootRef?: Ref<HTMLLIElement>;
  style?: CSSProperties;
  dragHandleProps?: Record<string, unknown>;
  isDragging?: boolean;
}

/* WorktreeTreeNodeRow — one worktree node: caret + Geist-Mono name + `root`
 * badge + hover `+`/`⋯`, expanding to its live sessions (or an empty-state
 * row) as children. Mirrors `.wt` / `.wt-row` / `.wt-kids` in
 * demo/sidebar-worktree-tree-v4.html. No health dot, no status word, no
 * session count — the tree structure and attention layering carry the
 * signal instead. */
function WorktreeTreeNodeRow({
  node,
  touch,
  bandShared,
  activeSessionId,
  onAttach,
  onKill,
  onToggleOpen,
  onStartWorktree,
  rootRef,
  style,
  dragHandleProps,
  isDragging = false,
}: WorktreeTreeNodeRowProps) {
  const { worktree: wt } = node;

  if (bandShared.notingPath === wt.path) {
    return (
      <WorktreeNoteRow
        wt={wt}
        pending={bandShared.notePending}
        error={bandShared.noteError}
        onSubmit={(note) => bandShared.onNoteSubmit(wt, note)}
        onCancel={bandShared.onNoteCancel}
      />
    );
  }
  if (bandShared.renamingPath === wt.path) {
    return (
      <WorktreeRenameRow
        wt={wt}
        pending={bandShared.renamePending}
        error={bandShared.renameError}
        onSubmit={(name) => bandShared.onRenameSubmit(wt, name)}
        onCancel={bandShared.onRenameCancel}
      />
    );
  }

  const removing = isRemovingWorktree(wt);

  return (
    <li
      ref={rootRef}
      style={style}
      data-testid="sidebar-tree-worktree-node"
      className={cn("mb-px", isDragging && "opacity-60")}
    >
      <div
        data-testid="sidebar-tree-worktree-row"
        data-worktree-path={wt.path}
        data-removing={removing ? "true" : "false"}
        data-source={wt.isSource ? "true" : undefined}
        data-active={node.isActive ? "true" : undefined}
        onClick={() => bandShared.onOpen(wt.path)}
        onContextMenu={(e) => {
          e.preventDefault();
          bandShared.onOpenMenu(wt, e.clientX, e.clientY);
        }}
        className={cn(
          "group/trow relative grid cursor-pointer items-center gap-2 rounded-[9px]",
          "grid-cols-[16px_1fr_auto]",
          touch ? "h-12 pl-1 pr-1.5" : "h-[34px] pl-0.5 pr-1",
          node.isActive ? "bg-sidebar-active" : "hover:bg-sidebar-hover",
          removing && "opacity-45",
        )}
      >
        {dragHandleProps && (
          <span
            {...dragHandleProps}
            data-testid="sidebar-tree-worktree-grip"
            aria-label="Reorder worktree"
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "flex cursor-grab touch-none items-center justify-center text-[color:var(--muted-foreground)] active:cursor-grabbing",
              touch
                ? "w-4 shrink-0"
                : "absolute inset-y-0 left-0 z-10 w-3 -translate-x-[10px] opacity-0 group-hover/trow:opacity-100",
            )}
          >
            <GripVertical
              className={touch ? "size-[15px]" : "size-3.5"}
              strokeWidth={1.75}
              aria-hidden
            />
          </span>
        )}

        <button
          type="button"
          aria-expanded={node.isOpen}
          aria-label={node.isOpen ? "Collapse worktree" : "Expand worktree"}
          data-testid="sidebar-tree-worktree-toggle"
          onClick={(e) => {
            e.stopPropagation();
            onToggleOpen(wt.path, node.isOpen);
          }}
          className="grid size-4 shrink-0 place-items-center rounded text-[color:var(--muted-foreground)] transition-colors hover:text-[color:var(--ink)]"
        >
          <ChevronRight
            className={cn(
              "size-3 transition-transform",
              node.isOpen && "rotate-90",
            )}
            strokeWidth={2}
          />
        </button>

        <button
          type="button"
          data-testid="sidebar-tree-worktree-open"
          onClick={(e) => {
            e.stopPropagation();
            bandShared.onOpen(wt.path);
          }}
          title={wt.isSource ? `Root worktree — ${wt.path}` : wt.path}
          className="flex min-w-0 cursor-pointer items-center gap-2 text-left focus-ring"
        >
          <span
            className={cn(
              "min-w-0 flex-1 truncate font-mono",
              touch ? "text-[13.5px]" : "text-[12px]",
              node.isActive
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
          {/* `⋯` appears to the left, hover-only (desktop) / always shown on
              touch — mirrors the demo's `.wt-more`. */}
          <button
            type="button"
            title="Worktree actions"
            aria-label="Worktree actions"
            data-testid="sidebar-tree-worktree-more"
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              bandShared.onOpenMenu(wt, r.right - 4, r.bottom + 4);
            }}
            className={cn(
              "cursor-pointer place-items-center rounded-md text-[color:var(--muted-foreground)] transition-colors",
              "hover:bg-[color:var(--surface)] hover:text-[color:var(--ink)] hover:shadow-[inset_0_0_0_1px_var(--hair-2)]",
              touch
                ? "grid size-9 [&_svg]:size-[19px]"
                : "grid size-6 opacity-0 group-hover/trow:opacity-100 [&_svg]:size-[15px]",
            )}
          >
            <MoreHorizontal strokeWidth={1.75} />
          </button>

          {/* `+` stays pinned at the very edge — quiet at rest, full strength
              on hover (desktop) / always shown on touch, per the demo's
              `.wt-add`. */}
          <button
            type="button"
            title="New session here"
            aria-label="New session here"
            data-testid="sidebar-tree-worktree-new-session"
            onClick={(e) => {
              e.stopPropagation();
              bandShared.onNewSession(wt);
            }}
            className={cn(
              "cursor-pointer place-items-center rounded-md text-[color:var(--muted-foreground)] transition-colors",
              "hover:bg-[color:var(--surface)] hover:text-[color:var(--ink)] hover:shadow-[inset_0_0_0_1px_var(--hair-2)]",
              touch
                ? "grid size-9 opacity-50 [&_svg]:size-[18px]"
                : "grid size-6 opacity-50 group-hover/trow:opacity-100 [&_svg]:size-[15px]",
            )}
          >
            <Plus strokeWidth={1.75} />
          </button>
        </div>
      </div>

      {node.isOpen && (
        <ul
          data-testid="sidebar-tree-worktree-children"
          className="relative mb-[3px] mt-px pl-6 before:absolute before:bottom-4 before:left-[15px] before:top-0 before:w-px before:bg-[color:var(--hair-2)] before:content-['']"
        >
          {node.sessions.length === 0 ? (
            <li className="flex h-[30px] items-center gap-1.5 px-1.5 text-[11.5px] text-[color:var(--muted-foreground)]">
              <span>No sessions yet</span>
              <span>·</span>
              {wt.status === "not_started" ? (
                <button
                  type="button"
                  onClick={() => onStartWorktree(wt)}
                  className="font-medium text-[color:var(--good)] hover:underline"
                >
                  Start worktree
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => bandShared.onNewSession(wt)}
                  className="font-medium text-[color:var(--good)] hover:underline"
                >
                  New session
                </button>
              )}
            </li>
          ) : (
            node.sessions.map(({ session }) => (
              <li
                key={session.id}
                className="relative before:absolute before:-left-[11px] before:top-[17px] before:h-px before:w-[9px] before:bg-[color:var(--hair-2)] before:content-['']"
              >
                <TerminalSessionRow
                  session={session}
                  touch={touch}
                  active={session.id === activeSessionId}
                  onAttach={() => onAttach(wt.path, session.id)}
                  onKill={() => onKill(session.id)}
                />
              </li>
            ))
          )}
        </ul>
      )}
    </li>
  );
}

/* Project-scope wrapper that makes a `WorktreeTreeNodeRow` draggable over
 * `worktree:<path>` items — mirrors `SortableWorktreeBandRow` in
 * sidebar-v3-body.tsx. Active-now renders the plain row (worktree order is
 * read-only there; only the project groups are drag-reorderable). */
function SortableWorktreeTreeNode({
  node,
  ...shared
}: { node: WorktreeTreeNode } & TreeNodeSharedProps) {
  const {
    setNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: `worktree:${node.key}` });
  return (
    <WorktreeTreeNodeRow
      node={node}
      {...shared}
      rootRef={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      dragHandleProps={{ ...attributes, ...listeners }}
      isDragging={isDragging}
    />
  );
}
