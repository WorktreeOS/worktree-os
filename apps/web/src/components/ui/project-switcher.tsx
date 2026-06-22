import { useEffect, useRef, useState } from "react";
import {
  Activity,
  Check,
  ChevronsUpDown,
  FolderGit2,
  FolderPlus,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { ProjectSummary } from "@/lib/ui-api";
import { projectRunningCount } from "@/lib/sidebar-active-project";
import { applyProjectOrder } from "@/lib/sidebar-project-order";
import {
  activeScopeSummaryText,
  type ActiveScopeSummary,
  type SidebarScope,
} from "@/lib/sidebar-scope";
import { StatusDot, statusDotVariant } from "@/components/ui/status-dot";

/* ProjectSwitcher — the rail's single scope control (see
 * demo/sidebar-v3/index.html). The anchor names the current scope: either one
 * project (folder-git icon + `N worktrees · M running`) or the cross-project
 * `Active now` view (activity icon + `N live worktrees · M projects`).
 * Clicking opens a popover with `Active now` as a first-class entry above the
 * project list, then every registered project with a per-project health
 * glance, plus an `Add project…` row. Reuses the outside-click / Escape
 * pattern from the rail's ThemePopover. On touch the popover widens to full
 * rail width with larger hit targets. */

function projectSummaryText(project: ProjectSummary): string {
  const count = project.worktrees.length;
  const running = projectRunningCount(project);
  const worktrees = `${count} ${count === 1 ? "worktree" : "worktrees"}`;
  return running > 0 ? `${worktrees} · ${running} running` : `${worktrees} · idle`;
}

interface ProjectSwitcherProps {
  projects: ReadonlyArray<ProjectSummary>;
  /** Global project order (authored in the rail's Active-now scope). Honored
   * read-only here — the switcher offers no drag affordance. */
  projectOrder: ReadonlyArray<string>;
  activeProject: ProjectSummary | null;
  scope: SidebarScope;
  activeSummary: ActiveScopeSummary;
  touch: boolean;
  onSelect: (projectId: string) => void;
  onSelectActiveNow: () => void;
  onAddProject: () => void;
}

export function ProjectSwitcher({
  projects,
  projectOrder,
  activeProject,
  scope,
  activeSummary,
  touch,
  onSelect,
  onSelectActiveNow,
  onAddProject,
}: ProjectSwitcherProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const activeNow = scope === "active-now";
  const orderedProjects = applyProjectOrder(projects, projectOrder);

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

  if (!activeProject) return null;

  const AnchorIcon = activeNow ? Activity : FolderGit2;
  const anchorName = activeNow ? "Active now" : activeProject.displayName;
  const anchorSub = activeNow
    ? activeScopeSummaryText(activeSummary)
    : projectSummaryText(activeProject);

  return (
    <div
      ref={wrapperRef}
      data-testid="sidebar-project-switcher"
      className={cn("relative z-30 px-2", touch ? "pb-0.5 pt-3" : "pb-0.5 pt-2.5")}
    >
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid="sidebar-project-switcher-anchor"
        data-scope={scope}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-[10px] border border-[color:var(--hair-2)] bg-[color:var(--surface)] text-left transition-[border-color,box-shadow]",
          "hover:border-[color:var(--muted-foreground)] hover:shadow-[0_1px_2px_rgb(0_0_0_/_0.05)]",
          open && "border-[color:var(--muted-foreground)] shadow-[0_1px_2px_rgb(0_0_0_/_0.05)]",
          touch ? "px-3 py-2.5" : "px-2.5 py-2",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "grid shrink-0 place-items-center rounded-lg bg-[color:var(--chip-bg)] text-[color:var(--ink-2)]",
            touch ? "size-[34px]" : "size-7",
          )}
        >
          <AnchorIcon className={touch ? "size-[18px]" : "size-[15px]"} strokeWidth={1.75} />
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span
            className={cn(
              "block truncate font-semibold tracking-tight text-[color:var(--ink)]",
              touch ? "text-[15px]" : "text-[13.5px]",
            )}
          >
            {anchorName}
          </span>
          <span
            className={cn(
              "flex items-center gap-1.5 truncate text-[color:var(--muted-foreground)]",
              touch ? "text-[12.5px]" : "text-[11.5px]",
            )}
          >
            {activeNow && activeSummary.worktrees > 0 && (
              <StatusDot variant="run" size={5} />
            )}
            <span className="truncate">{anchorSub}</span>
          </span>
        </span>
        <ChevronsUpDown
          className="size-[15px] shrink-0 text-[color:var(--muted-foreground)]"
          strokeWidth={1.75}
          aria-hidden
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Rail scope"
          data-testid="sidebar-project-switcher-pop"
          className="absolute left-2 right-2 top-[calc(100%-2px)] z-30 rounded-xl border border-[color:var(--hair-2)] bg-[color:var(--surface)] p-1.5 shadow-lg"
        >
          <button
            type="button"
            role="option"
            aria-selected={activeNow}
            data-testid="sidebar-scope-active-now"
            data-active={activeNow ? "true" : undefined}
            onClick={() => {
              onSelectActiveNow();
              setOpen(false);
            }}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-lg text-left transition-colors hover:bg-[color:var(--hover)]",
              activeNow && "bg-[color:var(--hover)]",
              touch ? "px-2.5 py-2.5" : "px-2.5 py-2",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "grid shrink-0 place-items-center rounded-md bg-[color:var(--chip-bg)]",
                activeNow
                  ? "text-[color:var(--ink-2)]"
                  : "text-[color:var(--muted-foreground)]",
                touch ? "size-8" : "size-[26px]",
              )}
            >
              <Activity className={touch ? "size-4" : "size-3.5"} strokeWidth={1.75} />
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span
                className={cn(
                  "block truncate font-medium text-[color:var(--ink)]",
                  touch ? "text-[15px]" : "text-[13px]",
                )}
              >
                Active now
              </span>
              <span
                className={cn(
                  "flex items-center gap-1.5 truncate text-[color:var(--muted-foreground)]",
                  touch ? "text-[12px]" : "text-[11px]",
                )}
              >
                {activeSummary.worktrees > 0 && <StatusDot variant="run" size={5} />}
                <span className="truncate">
                  {activeScopeSummaryText(activeSummary)}
                </span>
              </span>
            </span>
            {activeNow && (
              <Check
                className="size-3.5 shrink-0 text-[color:var(--ink)]"
                strokeWidth={1.75}
                aria-hidden
              />
            )}
          </button>
          <div className="mx-1 my-1.5 h-px bg-[color:var(--hair)]" />
          <div className="px-2.5 pb-1.5 pt-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[color:var(--muted-foreground)]">
            Projects
          </div>
          {orderedProjects.map((project) => {
            const isActive = !activeNow && project.id === activeProject.id;
            return (
              <button
                key={project.id}
                type="button"
                role="option"
                aria-selected={isActive}
                data-testid="sidebar-project-option"
                data-project-id={project.id}
                data-active={isActive ? "true" : undefined}
                onClick={() => {
                  onSelect(project.id);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg text-left transition-colors hover:bg-[color:var(--hover)]",
                  isActive && "bg-[color:var(--hover)]",
                  touch ? "px-2.5 py-2.5" : "px-2.5 py-2",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "grid shrink-0 place-items-center rounded-md bg-[color:var(--chip-bg)] text-[color:var(--muted-foreground)]",
                    isActive && "text-[color:var(--ink-2)]",
                    touch ? "size-8" : "size-[26px]",
                  )}
                >
                  <FolderGit2 className={touch ? "size-4" : "size-3.5"} strokeWidth={1.75} />
                </span>
                <span className="min-w-0 flex-1 leading-tight">
                  <span
                    className={cn(
                      "block truncate font-medium text-[color:var(--ink)]",
                      touch ? "text-[15px]" : "text-[13px]",
                    )}
                  >
                    {project.displayName}
                  </span>
                  <span
                    className={cn(
                      "block truncate text-[color:var(--muted-foreground)]",
                      touch ? "text-[12px]" : "text-[11px]",
                    )}
                  >
                    {projectSummaryText(project)}
                  </span>
                </span>
                {isActive ? (
                  <Check
                    className="size-3.5 shrink-0 text-[color:var(--ink)]"
                    strokeWidth={1.75}
                    aria-hidden
                  />
                ) : (
                  <span className="inline-flex shrink-0 items-center gap-[3px]" aria-hidden>
                    {project.worktrees.slice(0, 4).map((wt) => (
                      <StatusDot
                        key={wt.path}
                        variant={statusDotVariant(wt.status)}
                        size={6}
                      />
                    ))}
                  </span>
                )}
              </button>
            );
          })}
          <div className="mx-1 my-1.5 h-px bg-[color:var(--hair)]" />
          <button
            type="button"
            role="option"
            data-testid="sidebar-add-project"
            onClick={() => {
              onAddProject();
              setOpen(false);
            }}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-lg text-left text-[color:var(--ink-2)] transition-colors hover:bg-[color:var(--hover)]",
              touch ? "px-2.5 py-2.5" : "px-2.5 py-2",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "grid shrink-0 place-items-center rounded-md text-[color:var(--muted-foreground)]",
                touch ? "size-8" : "size-[26px]",
              )}
            >
              <FolderPlus className={touch ? "size-4" : "size-3.5"} strokeWidth={1.75} />
            </span>
            <span className={cn(touch ? "text-[15px]" : "text-[13px]")}>
              Add project…
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
