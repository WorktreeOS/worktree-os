import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { IconButton } from "@/components/ui/icon-button";
import { ProjectColorPicker } from "@/components/ui/project-color-picker";
import { useUiApi } from "@/lib/api-context";
import { useProjects } from "@/lib/projects-context";
import { useAllTerminalSessions } from "@/lib/terminal-sessions-context";
import type { ProjectSummary } from "@/lib/ui-api";
import { Section } from "../shared";

/** Count live terminal/agent sessions across a project's worktrees. */
function useLiveSessionCounts(): Map<string, number> {
  const sessionsByPath = useAllTerminalSessions();
  const { projects } = useProjects();
  return useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of projects) {
      let n = 0;
      for (const wt of p.worktrees) {
        n += sessionsByPath.get(wt.path)?.length ?? 0;
      }
      counts.set(p.id, n);
    }
    return counts;
  }, [projects, sessionsByPath]);
}

function ProjectRow({
  project,
  index,
  total,
  liveSessions,
  onChanged,
}: {
  project: ProjectSummary;
  index: number;
  total: number;
  liveSessions: number;
  onChanged: () => void;
}) {
  const api = useUiApi();
  const [name, setName] = useState(project.displayName);
  const [pending, setPending] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

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
    if (trimmed === project.displayName || trimmed.length === 0) {
      setName(project.displayName);
      return;
    }
    void run(() => api.updateProject(project.id, { displayName: trimmed }));
  };

  const onDelete = () => {
    const detail =
      liveSessions > 0
        ? ` It has ${liveSessions} live ${
            liveSessions === 1 ? "session" : "sessions"
          }.`
        : "";
    const ok = window.confirm(
      `Remove "${project.displayName}" from WorktreeOS?${detail} This forgets the project here; your worktrees and files on disk are left untouched.`,
    );
    if (!ok) return;
    void run(() => api.deleteProject(project.id));
  };

  return (
    <div
      className="flex flex-col gap-2 py-2.5"
      data-testid={`settings-project-row-${project.id}`}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={`${project.displayName} color`}
          aria-expanded={pickerOpen}
          disabled={pending}
          onClick={() => setPickerOpen((v) => !v)}
          data-testid={`settings-project-swatch-${project.id}`}
          className="size-6 shrink-0 cursor-pointer rounded-md ring-1 ring-inset ring-black/10 transition-transform hover:scale-110 disabled:opacity-50"
          style={{ background: `var(--p-${project.colorSlot + 1})` }}
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
          {liveSessions > 0 ? `${liveSessions} live` : "—"}
        </span>
        <IconButton
          size="sm"
          aria-label="Move up"
          disabled={pending || index === 0}
          onClick={() =>
            void run(() => api.updateProject(project.id, { order: index - 1 }))
          }
        >
          <ArrowUp />
        </IconButton>
        <IconButton
          size="sm"
          aria-label="Move down"
          disabled={pending || index === total - 1}
          onClick={() =>
            void run(() => api.updateProject(project.id, { order: index + 2 }))
          }
        >
          <ArrowDown />
        </IconButton>
        <IconButton
          size="sm"
          aria-label="Remove project"
          disabled={pending}
          onClick={onDelete}
        >
          {pending ? <Loader2 className="animate-spin" /> : <Trash2 />}
        </IconButton>
      </div>
      {pickerOpen && (
        <ProjectColorPicker
          value={project.colorSlot}
          disabled={pending}
          className="pl-8"
          onSelect={(slot) => {
            setPickerOpen(false);
            if (slot === project.colorSlot) return;
            void run(() => api.updateProject(project.id, { colorSlot: slot }));
          }}
        />
      )}
    </div>
  );
}

/**
 * Manage registered projects: recolor (swatch grid), rename, reorder, and
 * remove. Self-contained — it calls the project endpoints directly and is not
 * part of the daemon settings save/dirty flow. Removing a project forgets it
 * from WorktreeOS; it never deletes on-disk worktrees, branches, or containers.
 */
export function ProjectsPage() {
  const { projects, refresh } = useProjects();
  const liveCounts = useLiveSessionCounts();
  const ordered = useMemo(
    () => [...projects].sort((a, b) => a.order - b.order),
    [projects],
  );

  return (
    <Section title="Projects" id="settings-section-projects">
      <div className="py-1 text-[12.5px] text-[color:var(--muted-foreground)]">
        Projects in the rail. Recolor from the curated palette, rename, reorder,
        or remove — removing only forgets a project here; your worktrees and
        files on disk are left untouched.
      </div>
      {ordered.length === 0 ? (
        <div className="py-3 text-[13px] text-[color:var(--muted-foreground)]">
          No projects yet. Add one from the rail’s scope menu.
        </div>
      ) : (
        ordered.map((project, index) => (
          <ProjectRow
            key={project.id}
            project={project}
            index={index}
            total={ordered.length}
            liveSessions={liveCounts.get(project.id) ?? 0}
            onChanged={() => void refresh()}
          />
        ))
      )}
    </Section>
  );
}
