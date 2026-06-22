import { useEffect, useRef, useState } from "react";
import { GitBranch, Plus } from "lucide-react";

import { cn } from "@/lib/utils";
import type { ProjectSummary } from "@/lib/ui-api";
import { applyProjectOrder } from "@/lib/sidebar-project-order";
import { projectTile } from "@/lib/project-identity";
import { ProjectTile } from "@/components/ui/project-tile";
import { worktreeLabel } from "@/lib/sidebar-labels";

/* NewSessionLauncher — the rail's global New-session control for Sessions mode
 * (see demo/sidebar-stream-v3.html). A `+` button opens a popover to pick a
 * target worktree (grouped by project); selecting one creates a plain terminal
 * there and attaches. The agent picker from the demo is deferred (Non-goal):
 * createTerminalLayerSession takes only { worktreePath }, so the MVP launches a
 * shell. Reuses the outside-click / Escape pattern from ProjectSwitcher. */

interface NewSessionLauncherProps {
  projects: ReadonlyArray<ProjectSummary>;
  projectOrder: ReadonlyArray<string>;
  touch: boolean;
  /** Create a plain terminal in this worktree and attach. */
  onCreate: (worktreePath: string) => void;
}

export function NewSessionLauncher({
  projects,
  projectOrder,
  touch,
  onCreate,
}: NewSessionLauncherProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const orderedProjects = applyProjectOrder(projects, projectOrder).filter(
    (p) => p.worktrees.length > 0,
  );

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title="New session"
        aria-label="New session"
        data-testid="rail-new-session"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "grid shrink-0 place-items-center rounded-[9px] border border-[color:var(--hair-2)] bg-[color:var(--surface)] text-[color:var(--ink)] transition-colors",
          "hover:border-[color:var(--ink)] hover:bg-[color:var(--ink)] hover:text-[color:var(--surface)]",
          open && "border-[color:var(--ink)] bg-[color:var(--ink)] text-[color:var(--surface)]",
          touch ? "size-10" : "size-7",
        )}
      >
        <Plus className={touch ? "size-[18px]" : "size-4"} strokeWidth={1.75} aria-hidden />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="New session in"
          data-testid="rail-new-session-pop"
          className="absolute right-0 top-[calc(100%+4px)] z-40 max-h-[60vh] w-[244px] overflow-y-auto rounded-xl border border-[color:var(--hair-2)] bg-[color:var(--surface)] p-1.5 shadow-lg"
        >
          <div className="px-2 pb-1 pt-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[color:var(--muted-foreground)]">
            New session in
          </div>
          {orderedProjects.length === 0 ? (
            <div className="px-2 py-2 text-[12px] text-[color:var(--muted-foreground)]">
              No worktrees yet
            </div>
          ) : (
            orderedProjects.map((project) => {
              const tile = projectTile(project);
              return (
                <div key={project.id} className="pb-1">
                  <div className="flex items-center gap-2 px-2 pb-0.5 pt-1.5">
                    <ProjectTile
                      monogram={tile.monogram}
                      colorVar={tile.colorVar}
                      size={18}
                    />
                    <span className="min-w-0 truncate text-[12px] font-medium text-[color:var(--ink)]">
                      {project.displayName}
                    </span>
                  </div>
                  {project.worktrees.map((wt) => (
                    <button
                      key={wt.path}
                      type="button"
                      role="menuitem"
                      data-testid="rail-new-session-worktree"
                      data-worktree-path={wt.path}
                      onClick={() => {
                        onCreate(wt.path);
                        setOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg pl-7 pr-2 text-left transition-colors hover:bg-[color:var(--hover)]",
                        touch ? "py-2" : "py-1.5",
                      )}
                    >
                      <GitBranch
                        className="size-3.5 shrink-0 text-[color:var(--muted-foreground)]"
                        strokeWidth={1.75}
                        aria-hidden
                      />
                      <span className="min-w-0 truncate font-mono text-[12px] text-[color:var(--ink-2)]">
                        {worktreeLabel(wt)}
                      </span>
                    </button>
                  ))}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
