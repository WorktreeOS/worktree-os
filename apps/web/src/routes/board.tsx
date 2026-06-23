import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { toast } from "sonner";

import { useProjects } from "@/lib/projects-context";
import { useStatusCatalog } from "@/lib/status-catalog-context";
import { useUiApi } from "@/lib/api-context";
import {
  buildBoardColumns,
  boardProjectOptions,
  computeDropOrder,
  NO_STATUS_COLUMN_ID,
  type BoardCard,
  type BoardColumn,
} from "@/lib/board";
import { worktreeLabel } from "@/lib/sidebar-labels";
import { useWorktreeOpener } from "@/lib/worktree-panel-context";
import { formatRelativeTime } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { KanbanCard, KanbanColumn } from "@/components/ui/kanban";

function cardAge(card: BoardCard): string | undefined {
  return formatRelativeTime(card.worktree.lastCommitTime) ?? undefined;
}

function SortableCard({
  card,
  accentColor,
  onOpen,
}: {
  card: BoardCard;
  accentColor?: string;
  onOpen: () => void;
}) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } =
    useSortable({ id: card.worktree.path });
  return (
    <KanbanCard
      rootRef={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      dragHandleProps={{ ...attributes, ...listeners }}
      isDragging={isDragging}
      projectName={card.projectName}
      branchLabel={worktreeLabel(card.worktree)}
      status={card.worktree.status}
      accentColor={accentColor}
      additions={undefined}
      deletions={undefined}
      ageLabel={cardAge(card)}
      onOpen={onOpen}
    />
  );
}

function BoardColumnView({
  column,
  onOpen,
}: {
  column: BoardColumn;
  onOpen: (card: BoardCard) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  return (
    <KanbanColumn
      name={column.name}
      color={column.color}
      count={column.cards.length}
      containerRef={setNodeRef}
      isOver={isOver}
    >
      <SortableContext
        items={column.cards.map((c) => c.worktree.path)}
        strategy={verticalListSortingStrategy}
      >
        {column.cards.map((card) => (
          <SortableCard
            key={card.worktree.path}
            card={card}
            accentColor={column.color}
            onOpen={() => onOpen(card)}
          />
        ))}
      </SortableContext>
      {column.cards.length === 0 && (
        <p className="px-1 py-3 text-[12px] text-[color:var(--ink-2)]">
          No worktrees
        </p>
      )}
    </KanbanColumn>
  );
}

export function BoardRoute() {
  const { projects, loading } = useProjects();
  const { statuses } = useStatusCatalog();
  const api = useUiApi();
  const openWorktree = useWorktreeOpener();
  const [filterProjectId, setFilterProjectId] = useState<string | null>(null);

  const serverColumns = useMemo(
    () => buildBoardColumns(projects, statuses, filterProjectId),
    [projects, statuses, filterProjectId],
  );
  const [columns, setColumns] = useState<BoardColumn[]>(serverColumns);
  useEffect(() => {
    setColumns(serverColumns);
  }, [serverColumns]);

  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const projectOptions = useMemo(
    () => boardProjectOptions(projects),
    [projects],
  );

  const onOpenCard = useCallback(
    (card: BoardCard) => {
      // Worktree-centric open: the board is the one surface that docks the
      // panel (desktop), so it opts in via `allowPanel`. On touch it navigates
      // full-screen instead (the `from` state powers the back-link). Always land
      // on the Overview dossier, not the last-used tab (terminal).
      openWorktree("worktree", card.worktree.path, {
        tab: "overview",
        allowPanel: true,
        navigateOptions: { state: { from: "/board" } },
      });
    },
    [openWorktree],
  );

  const activeCard = useMemo(() => {
    if (!activeId) return null;
    for (const col of columns) {
      const found = col.cards.find((c) => c.worktree.path === activeId);
      if (found) return { card: found, color: col.color };
    }
    return null;
  }, [activeId, columns]);

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));

  const onDragEnd = async (e: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;
    const activePath = String(active.id);
    const overId = String(over.id);

    const fromColIdx = columns.findIndex((c) =>
      c.cards.some((card) => card.worktree.path === activePath),
    );
    if (fromColIdx < 0) return;
    const draggedCard = columns[fromColIdx]!.cards.find(
      (c) => c.worktree.path === activePath,
    )!;

    // The drop target is either a column container or a card within a column.
    let toColIdx = columns.findIndex((c) => c.id === overId);
    if (toColIdx < 0) {
      toColIdx = columns.findIndex((c) =>
        c.cards.some((card) => card.worktree.path === overId),
      );
    }
    if (toColIdx < 0) return;
    const toColumn = columns[toColIdx]!;

    const targetFiltered = toColumn.cards.filter(
      (c) => c.worktree.path !== activePath,
    );
    let insertIndex = targetFiltered.findIndex(
      (c) => c.worktree.path === overId,
    );
    if (insertIndex < 0) insertIndex = targetFiltered.length;

    const statusId = toColumn.id === NO_STATUS_COLUMN_ID ? null : toColumn.id;
    const newOrder = computeDropOrder(targetFiltered, insertIndex);

    // No-op: dropped back in the same column with no neighbor change.
    if (
      fromColIdx === toColIdx &&
      draggedCard.worktree.workflowOrder === newOrder
    ) {
      return;
    }

    // Optimistic local update; the projects refetch (board event) reconciles.
    const movedCard: BoardCard = {
      ...draggedCard,
      worktree: {
        ...draggedCard.worktree,
        workflowStatusId: statusId ?? undefined,
        workflowOrder: statusId === null ? undefined : newOrder,
      },
    };
    setColumns((prev) =>
      prev.map((col, i) => {
        const cards = col.cards.filter(
          (c) => c.worktree.path !== activePath,
        );
        if (i === toColIdx) {
          return {
            ...col,
            cards: [
              ...cards.slice(0, insertIndex),
              movedCard,
              ...cards.slice(insertIndex),
            ],
          };
        }
        return { ...col, cards };
      }),
    );

    try {
      await api.setWorktreeStatus(
        activePath,
        statusId,
        statusId === null ? undefined : newOrder,
      );
    } catch (err) {
      toast.error(`Could not move worktree: ${(err as Error).message}`);
      setColumns(serverColumns);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-[color:var(--hair)] px-5">
        <h1 className="shrink-0 text-[15px] font-semibold text-[color:var(--ink)]">
          Board
        </h1>
        {projectOptions.length > 1 && (
          <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
            <FilterChip
              active={filterProjectId === null}
              onClick={() => setFilterProjectId(null)}
            >
              All projects
            </FilterChip>
            {projectOptions.map((p) => (
              <FilterChip
                key={p.id}
                active={filterProjectId === p.id}
                onClick={() => setFilterProjectId(p.id)}
              >
                {p.name}
              </FilterChip>
            ))}
          </div>
        )}
      </div>

      {loading && columns.every((c) => c.cards.length === 0) ? (
        <p className="px-5 py-6 text-sm text-[color:var(--ink-2)]">Loading…</p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        >
          <div className="flex flex-1 gap-3 overflow-x-auto px-5 py-4">
            {columns.map((column) => (
              <BoardColumnView
                key={column.id}
                column={column}
                onOpen={onOpenCard}
              />
            ))}
          </div>
          <DragOverlay>
            {activeCard ? (
              <KanbanCard
                projectName={activeCard.card.projectName}
                branchLabel={worktreeLabel(activeCard.card.worktree)}
                status={activeCard.card.worktree.status}
                accentColor={activeCard.color}
                ageLabel={cardAge(activeCard.card)}
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "shrink-0 whitespace-nowrap rounded-full border px-2.5 py-1 text-[12px] transition-colors focus-ring",
        active
          ? "border-transparent bg-[color:var(--ink)] text-[color:var(--surface)]"
          : "border-[color:var(--hair-2)] text-[color:var(--ink-2)] hover:bg-[color:var(--hover)]",
      )}
    >
      {children}
    </button>
  );
}
