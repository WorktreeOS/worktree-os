import { useSearchParams } from "react-router";
import { GitBranch } from "lucide-react";

import { useProjects } from "@/lib/projects-context";
import {
  readActiveProjectId,
  resolveActiveProjectId,
} from "@/lib/sidebar-active-project";

/* SelectWorktreeRoute — the project-scoped empty placeholder shown after a
 * project switch clears the open worktree. The rail is scoped to one active
 * project, so this names that project and points back at the rail to pick a
 * worktree. Read-only by design: no all-projects overview (that is the home
 * route) and no lifecycle controls. The active project is carried in the
 * `?project=` param so re-switching while here updates the copy, falling back
 * to the persisted rail selection on a bare URL. */
export function SelectWorktreeRoute() {
  const { projects } = useProjects();
  const [searchParams] = useSearchParams();
  const activeId = resolveActiveProjectId({
    persistedId: searchParams.get("project") ?? readActiveProjectId(),
    activePath: null,
    projects,
  });
  const project = projects.find((p) => p.id === activeId) ?? null;

  return (
    <div
      data-testid="select-worktree"
      className="reveal flex h-full flex-col items-center justify-center gap-4 px-6 text-center"
    >
      <span
        aria-hidden
        className="grid size-12 place-items-center rounded-full border border-[color:var(--hair-2)] text-[color:var(--muted-foreground)]"
      >
        <GitBranch className="size-5" strokeWidth={1.75} />
      </span>
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-[17px] font-semibold tracking-[-0.01em] text-[color:var(--ink)]">
          No worktree selected
        </h1>
        <p className="m-0 max-w-sm text-[13.5px] text-[color:var(--muted-foreground)]">
          {project ? (
            <>
              Pick a worktree from{" "}
              <span className="text-[color:var(--ink-2)]">
                {project.displayName}
              </span>{" "}
              in the left panel.
            </>
          ) : (
            "Pick a worktree from the left panel."
          )}
        </p>
      </div>
    </div>
  );
}
