import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { useUiApi } from "@/lib/api-context";
import { useProjects } from "@/lib/projects-context";
import { useStatusCatalog } from "@/lib/status-catalog-context";
import type { WorkflowStatusDto } from "@/lib/ui-api";
import { Section } from "../shared";

/** Count worktrees assigned to each status across all projects. */
function useAssignmentCounts(): Map<string, number> {
  const { projects } = useProjects();
  return useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of projects) {
      for (const wt of p.worktrees) {
        const id = wt.workflowStatusId;
        if (!id) continue;
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    return counts;
  }, [projects]);
}

function StatusRow({
  status,
  index,
  total,
  assignedCount,
  onChanged,
}: {
  status: WorkflowStatusDto;
  index: number;
  total: number;
  assignedCount: number;
  onChanged: () => void;
}) {
  const api = useUiApi();
  const [name, setName] = useState(status.name);
  const [pending, setPending] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setPending(true);
    try {
      await fn();
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  const commitName = () => {
    const trimmed = name.trim();
    if (trimmed === status.name || trimmed.length === 0) {
      setName(status.name);
      return;
    }
    void run(() => api.updateStatus(status.id, { name: trimmed }));
  };

  const onDelete = () => {
    if (assignedCount > 0) {
      const ok = window.confirm(
        `Delete "${status.name}"? ${assignedCount} ${
          assignedCount === 1 ? "worktree" : "worktrees"
        } will move to No status.`,
      );
      if (!ok) return;
    }
    void run(() => api.deleteStatus(status.id));
  };

  return (
    <div
      className="flex items-center gap-2 py-2.5"
      data-testid={`settings-status-row-${status.id}`}
    >
      <input
        type="color"
        aria-label={`${status.name} color`}
        value={status.color}
        disabled={pending}
        onChange={(e) =>
          void run(() => api.updateStatus(status.id, { color: e.target.value }))
        }
        className="size-6 shrink-0 cursor-pointer rounded border border-[color:var(--hair-2)] bg-transparent p-0"
      />
      <input
        type="text"
        value={name}
        disabled={pending}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="min-w-0 flex-1 rounded-md border border-[color:var(--hair-2)] bg-[color:var(--surface)] px-2 py-1 text-[13.5px] text-[color:var(--ink)] focus-ring"
      />
      <span className="w-20 shrink-0 text-right text-[12px] tabular-nums text-[color:var(--muted-foreground)]">
        {assignedCount > 0 ? `${assignedCount} used` : "—"}
      </span>
      <IconButton
        size="sm"
        aria-label="Move up"
        disabled={pending || index === 0}
        onClick={() =>
          void run(() => api.updateStatus(status.id, { order: index - 1 }))
        }
      >
        <ArrowUp />
      </IconButton>
      <IconButton
        size="sm"
        aria-label="Move down"
        disabled={pending || index === total - 1}
        onClick={() =>
          void run(() => api.updateStatus(status.id, { order: index + 2 }))
        }
      >
        <ArrowDown />
      </IconButton>
      <IconButton
        size="sm"
        aria-label="Delete status"
        disabled={pending}
        onClick={onDelete}
      >
        {pending ? <Loader2 className="animate-spin" /> : <Trash2 />}
      </IconButton>
    </div>
  );
}

function AddStatusRow({ onChanged }: { onChanged: () => void }) {
  const api = useUiApi();
  const [name, setName] = useState("");
  const [color, setColor] = useState("#6b7280");
  const [pending, setPending] = useState(false);

  const add = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setPending(true);
    try {
      await api.createStatus(trimmed, color);
      setName("");
      setColor("#6b7280");
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex items-center gap-2 py-3">
      <input
        type="color"
        aria-label="New status color"
        value={color}
        onChange={(e) => setColor(e.target.value)}
        className="size-6 shrink-0 cursor-pointer rounded border border-[color:var(--hair-2)] bg-transparent p-0"
      />
      <input
        type="text"
        value={name}
        placeholder="New status name…"
        disabled={pending}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void add();
        }}
        data-testid="settings-status-new-name"
        className="min-w-0 flex-1 rounded-md border border-[color:var(--hair-2)] bg-[color:var(--surface)] px-2 py-1 text-[13.5px] text-[color:var(--ink)] focus-ring"
      />
      <Button
        size="sm"
        variant="solid"
        disabled={pending || name.trim().length === 0}
        onClick={() => void add()}
        data-testid="settings-status-add"
      >
        {pending ? <Loader2 className="animate-spin" /> : <Plus />}
        Add
      </Button>
    </div>
  );
}

/**
 * Manage the global workflow status catalog: create, rename, recolor, reorder,
 * and delete statuses. Self-contained — it calls the status endpoints directly
 * and is not part of the daemon settings save/dirty flow. Deleting a status
 * that has assigned worktrees confirms first; on delete those worktrees move to
 * No status.
 */
export function StatusesPage() {
  const { statuses, refresh } = useStatusCatalog();
  const counts = useAssignmentCounts();

  return (
    <Section title="Workflow statuses" id="settings-section-statuses">
      <div className="py-1 text-[12.5px] text-[color:var(--muted-foreground)]">
        Columns on the board. Statuses can be created, renamed, recolored,
        reordered, and deleted — there are no transition rules.
      </div>
      {statuses.map((status, index) => (
        <StatusRow
          key={status.id}
          status={status}
          index={index}
          total={statuses.length}
          assignedCount={counts.get(status.id) ?? 0}
          onChanged={() => void refresh()}
        />
      ))}
      <AddStatusRow onChanged={() => void refresh()} />
    </Section>
  );
}
