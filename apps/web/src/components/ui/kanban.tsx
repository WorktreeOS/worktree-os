import type { CSSProperties, ReactNode, Ref } from "react";

import { cn } from "@/lib/utils";
import type { DeploymentStatus } from "@/lib/ui-api";
import { StatusDot, statusDotVariant } from "@/components/ui/status-dot";

/** Quiet word for a deployment status (dot + word, never a chip). */
export function deploymentStatusWord(status: DeploymentStatus): string {
  switch (status) {
    case "running":
      return "running";
    case "running_partial":
      return "partial";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    case "stopping":
      return "stopping";
    case "checking":
      return "checking";
    case "pending":
      return "pending";
    case "not_started":
      return "not started";
    case "unknown":
    default:
      return "unknown";
  }
}

interface KanbanColumnProps {
  name: string;
  /** Status color; omitted for the No status column. */
  color?: string;
  count: number;
  children: ReactNode;
  /** Droppable ref + container styling for active drop targets. */
  containerRef?: Ref<HTMLDivElement>;
  isOver?: boolean;
  className?: string;
}

/**
 * One Kanban column: a quiet header (color dot + name + count) over a card
 * stack. Stays within quiet-workspace v3 — no filled header bar, hairline only.
 */
export function KanbanColumn({
  name,
  color,
  count,
  children,
  containerRef,
  isOver,
  className,
}: KanbanColumnProps) {
  return (
    <section
      className={cn(
        "flex w-72 shrink-0 flex-col rounded-lg border border-[color:var(--hair)] bg-[color:var(--shell)]/40",
        className,
      )}
    >
      <header className="flex items-center gap-2 px-3 py-2.5">
        {color ? (
          <span
            aria-hidden
            className="inline-block h-2 w-2 shrink-0 rounded-full"
            style={{ background: color }}
          />
        ) : (
          <span
            aria-hidden
            className="inline-block h-2 w-2 shrink-0 rounded-full"
            style={{ boxShadow: "inset 0 0 0 1.5px var(--hair-2)" }}
          />
        )}
        <span className="text-[13px] font-semibold text-[color:var(--ink)]">
          {name}
        </span>
        <span className="ml-auto text-[12px] tabular-nums text-[color:var(--ink-2)]">
          {count}
        </span>
      </header>
      <div
        ref={containerRef}
        className={cn(
          "flex min-h-24 flex-1 flex-col gap-2 rounded-b-lg px-2 pb-2 transition-colors",
          isOver && "bg-[color:var(--hover)]",
        )}
      >
        {children}
      </div>
    </section>
  );
}

interface KanbanCardProps {
  projectName: string;
  branchLabel: string;
  status: DeploymentStatus;
  /** Workflow status color rendered as a thin leading accent. Omitted = none. */
  accentColor?: string;
  additions?: number;
  deletions?: number;
  ageLabel?: string;
  onOpen?: () => void;
  /** dnd-kit passthrough (sortable wrapper). */
  rootRef?: Ref<HTMLDivElement>;
  style?: CSSProperties;
  dragHandleProps?: Record<string, unknown>;
  isDragging?: boolean;
  className?: string;
}

/**
 * One worktree card. A white document tile with a hairline border. The
 * workflow status color appears only as a thin leading accent; deployment
 * health is the existing dot + word — never a filled chip.
 */
export function KanbanCard({
  projectName,
  branchLabel,
  status,
  accentColor,
  additions,
  deletions,
  ageLabel,
  onOpen,
  rootRef,
  style,
  dragHandleProps,
  isDragging,
  className,
}: KanbanCardProps) {
  const hasDiff =
    (additions !== undefined && additions > 0) ||
    (deletions !== undefined && deletions > 0);
  return (
    <div
      ref={rootRef}
      style={{
        ...style,
        ...(accentColor ? { borderLeftColor: accentColor } : {}),
      }}
      data-board-card
      onClick={onOpen}
      {...dragHandleProps}
      className={cn(
        "group relative cursor-pointer touch-none select-none rounded-md border border-[color:var(--hair)] border-l-2 bg-[color:var(--surface)] px-3 py-2 text-left shadow-sm transition-shadow hover:shadow focus-ring",
        !accentColor && "border-l-[color:var(--hair-2)]",
        isDragging && "opacity-60",
        className,
      )}
    >
      <div className="truncate text-[11px] uppercase tracking-wide text-[color:var(--ink-2)]">
        {projectName}
      </div>
      <div className="mt-0.5 truncate font-[family-name:var(--font-mono)] text-[13px] text-[color:var(--ink)]">
        {branchLabel}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 text-[12px] text-[color:var(--ink-2)]">
        <StatusDot variant={statusDotVariant(status)} size={7} />
        <span>{deploymentStatusWord(status)}</span>
        {hasDiff && (
          <span className="ml-1">
            {additions !== undefined && additions > 0 && (
              <span className="text-[color:var(--good)]">+{additions}</span>
            )}
            {deletions !== undefined && deletions > 0 && (
              <span className="ml-1 text-[color:var(--bad)]">−{deletions}</span>
            )}
          </span>
        )}
        {ageLabel && <span className="ml-auto">{ageLabel}</span>}
      </div>
    </div>
  );
}
