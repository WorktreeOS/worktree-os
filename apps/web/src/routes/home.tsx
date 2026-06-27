import { Link, useOutletContext } from "react-router";
import { FolderGit2, GitBranch, Terminal as TerminalIcon } from "lucide-react";

import type { SidebarOutletContext } from "@/routes/layout";
import { SidebarToggle } from "@/components/ui/sidebar-toggle";
import { useProjects } from "@/lib/projects-context";
import type {
  DeploymentStatus,
  ProjectSummary,
  WorktreeSummary,
} from "@/lib/ui-api";
import { worktreeLabel } from "@/lib/sidebar-labels";
import { projectRunningCount } from "@/lib/sidebar-active-project";
import {
  applyWorktreeOrder,
  readWorktreeOrder,
} from "@/lib/sidebar-worktree-order";
import { useTerminalSessions } from "@/lib/terminal-sessions-context";
import { terminalAgent, terminalLabel } from "@/lib/terminal-agents";
import type { TerminalSessionMetadata } from "@/lib/terminal-protocol";
import { formatRelativeTime } from "@/lib/utils";
import { StatusDot, statusDotVariant } from "@/components/ui/status-dot";
import { Ic } from "@/components/ui/inline-code";
import wosMark from "@/assets/wos-mark-transparent.png";

export function HomeRoute() {
  const { projects, loading } = useProjects();
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
        <span className="status-dot status-dot--info status-dot--pulse" />
        <span className="font-mono text-[11px] uppercase tracking-[0.22em]">
          loading projects…
        </span>
      </div>
    );
  }
  if (projects.length === 0) {
    return <HomeEmptyState />;
  }
  return <HomeOverview projects={projects} />;
}

/* No-projects onboarding state. Extracted so Mission Control can reuse the
 * exact same composition as its empty state when nothing is registered. */
export function HomeEmptyState() {
  return (
    <div className="reveal flex h-full flex-col items-center justify-center gap-6 px-6 text-center">
      <div className="relative">
        {/* Large decorative typographic mark. */}
        <div className="select-none font-mono text-[12rem] leading-none font-bold tracking-tighter text-foreground/[0.04]">
          WorktreeOS
        </div>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3">
          <div className="relative grid h-20 w-20 place-items-center rounded-xl border border-[color:color-mix(in_oklch,var(--signal-active)_35%,transparent)] bg-[color:var(--signal-active-soft)]">
            <img
              src={wosMark}
              alt=""
              className="h-[4.5rem] w-[4.5rem] object-contain"
              aria-hidden="true"
            />
          </div>
          <div className="text-[28px] font-semibold tracking-tight">
            WorktreeOS
          </div>
          <div className="font-mono text-[10.5px] uppercase tracking-[0.3em] text-muted-foreground">
            local deploy console
          </div>
        </div>
      </div>
      <p className="max-w-md text-sm text-muted-foreground">
        Local control panel for{" "}
        <span className="text-foreground">WorktreeOS</span>. Add a project in the
        left panel, or run{" "}
        <code className="rounded-sm border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[12px] text-foreground">
          wos up
        </code>{" "}
        in any worktree — it will appear here automatically.
      </p>
      <div className="flex flex-col items-center gap-1.5 pt-2 font-mono text-[10.5px] uppercase tracking-[0.22em] text-muted-foreground/70">
        <div className="flex items-center gap-3">
          <span className="h-px w-12 bg-border" />
          <span>system ready</span>
          <span className="h-px w-12 bg-border" />
        </div>
        <div className="flex items-center gap-2">
          <span className="status-dot status-dot--active" />
          <span>waiting for input</span>
        </div>
      </div>
    </div>
  );
}

/* HomeOverview — the cross-project home dashboard. The left rail is scoped to a
 * single active project, so the home route restores the all-project view: one
 * scannable section per registered project, each listing its worktrees as
 * read-oriented navigation rows. Lifecycle, terminal, rename/note, and
 * context-menu actions deliberately stay on the sidebar / worktree detail
 * surfaces — selecting a worktree here just opens its workspace. */
export function HomeOverview({ projects }: { projects: ProjectSummary[] }) {
  // Honor the global project / worktree order authored in the rail (read-only
  // here — Home offers no drag affordance). Project order is server-authoritative.
  const orderedProjects = [...projects].sort((a, b) => a.order - b.order);
  const worktreeOrder = readWorktreeOrder();
  // Rail collapse/expand lives in the page header (desktop), mirroring worktree.
  const sidebar = useOutletContext<SidebarOutletContext | null>();
  return (
    <div
      data-testid="home-overview"
      className="reveal mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-10 md:px-10"
    >
      <header className="flex items-start gap-2">
        {sidebar && (
          <SidebarToggle
            sidebarOpen={sidebar.sidebarOpen}
            onToggle={sidebar.toggleSidebar}
            className="-ml-1 mt-0.5"
          />
        )}
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="m-0 text-[22px] font-semibold tracking-[-0.01em] text-[color:var(--ink)]">
            Projects
          </h1>
          <p className="m-0 text-[13.5px] text-[color:var(--muted-foreground)]">
            {projects.length} {projects.length === 1 ? "project" : "projects"} ·
            open a worktree to jump into its workspace
          </p>
        </div>
      </header>

      {orderedProjects.map((project) => (
        <ProjectOverviewSection
          key={project.id}
          project={project}
          worktreeOrder={worktreeOrder}
        />
      ))}
    </div>
  );
}

/** Quiet `N worktrees · M running` / `· idle` summary, mirroring the rail's
 * project-switcher copy without importing its private helper. */
function projectSummaryText(project: ProjectSummary): string {
  const count = project.worktrees.length;
  const running = projectRunningCount(project);
  const worktrees = `${count} ${count === 1 ? "worktree" : "worktrees"}`;
  return running > 0 ? `${worktrees} · ${running} running` : `${worktrees} · idle`;
}

/** Worktree-row deployment glance: a quiet status word beside the StatusDot.
 * Presentation only — the home overview never controls deployment lifecycle. */
function statusWord(status: DeploymentStatus): string {
  switch (status) {
    case "running":
      return "running";
    case "running_partial":
      return "partial";
    case "checking":
      return "checking";
    case "pending":
      return "deploying";
    case "stopping":
      return "stopping";
    case "stopped":
      return "stopped";
    case "failed":
      return "failed";
    case "not_started":
      return "not started";
    default:
      return "unknown";
  }
}

function ProjectOverviewSection({
  project,
  worktreeOrder,
}: {
  project: ProjectSummary;
  worktreeOrder: ReadonlyArray<string>;
}) {
  const orderedWorktrees = applyWorktreeOrder(project.worktrees, worktreeOrder);
  return (
    <section
      data-testid="home-project-section"
      data-project-id={project.id}
      className="flex flex-col gap-1.5"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-2">
          <FolderGit2
            className="size-[15px] shrink-0 text-[color:var(--muted-foreground)]"
            strokeWidth={1.75}
            aria-hidden
          />
          <h2 className="m-0 text-[15px] font-semibold tracking-[-0.01em] text-[color:var(--ink)]">
            {project.displayName}
          </h2>
        </span>
        <Ic tone="dim" className="truncate text-[11.5px]">
          {project.sourcePath}
        </Ic>
        <span className="text-[12.5px] text-[color:var(--muted-foreground)]">
          {projectSummaryText(project)}
        </span>
        {project.stale && (
          <span
            data-testid="home-project-stale"
            className="text-[12px] text-[color:var(--warn)]"
          >
            stale
          </span>
        )}
      </div>

      {project.error && (
        <div
          data-testid="home-project-error"
          className="text-[12px] text-[color:var(--bad)]"
        >
          {project.error}
        </div>
      )}

      <ul className="mt-0.5 flex flex-col border-t border-[color:var(--hair)]">
        {orderedWorktrees.map((wt) => (
          <WorktreeOverviewRow key={wt.path} worktree={wt} />
        ))}
        {project.worktrees.length === 0 && (
          <li className="px-2 py-2 text-[12.5px] text-muted-foreground/55">
            no worktrees
          </li>
        )}
      </ul>
    </section>
  );
}

function WorktreeOverviewRow({ worktree: wt }: { worktree: WorktreeSummary }) {
  const sessions = useTerminalSessions(wt.path);
  return (
    <li className="border-b border-[color:var(--hair)] last:border-b-0">
      <Link
        to={`/worktree?path=${encodeURIComponent(wt.path)}`}
        data-testid="home-worktree-row"
        data-worktree-path={wt.path}
        data-source={wt.isSource ? "true" : undefined}
        title={wt.isSource ? `Root worktree — ${wt.path}` : wt.path}
        className="group flex h-9 items-center gap-2.5 rounded-lg px-2 transition-colors hover:bg-[color:var(--hover)]"
      >
        <GitBranch
          className="size-[15px] shrink-0 text-muted-foreground/70"
          strokeWidth={1.75}
          aria-hidden
        />
        <span className="min-w-0 truncate font-mono text-[12.5px] text-[color:var(--ink-2)]">
          {worktreeLabel(wt)}
        </span>
        {wt.isSource && (
          <span className="shrink-0 text-[10px] font-medium text-[color:var(--muted-foreground)]">
            root
          </span>
        )}
        <span className="ml-auto inline-flex shrink-0 items-center gap-1.5">
          <StatusDot variant={statusDotVariant(wt.status)} />
          <span className="font-mono text-[11px] text-[color:var(--muted-foreground)]">
            {statusWord(wt.status)}
          </span>
        </span>
      </Link>

      {sessions.length > 0 && (
        <ul
          data-testid="home-terminal-list"
          className="mb-1 ml-[17px] flex flex-col border-l border-[color:var(--hair)] pl-[9px]"
        >
          {sessions.map((session) => (
            <HomeTerminalRow
              key={session.id}
              worktreePath={wt.path}
              session={session}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Active command summary for a terminal session row (command + args). */
function sessionCommand(session: TerminalSessionMetadata): string {
  const cmd = session.activeCommand;
  if (!cmd) return "";
  return [cmd.command, cmd.args].filter(Boolean).join(" ").trim();
}

/* HomeTerminalRow — one live terminal/agent session under a worktree. The home
 * overview stays read-oriented, so this is navigation-only: selecting it hands
 * off to `/worktree?path=…&terminal=<id>`, which selects the Terminal tab
 * focused on that session. Kill / rename stay on the rail and worktree detail. */
function HomeTerminalRow({
  worktreePath,
  session,
}: {
  worktreePath: string;
  session: TerminalSessionMetadata;
}) {
  const agent = terminalAgent(session);
  const Icon = agent?.icon ?? TerminalIcon;
  const label = terminalLabel(session, session.shell);
  const command = sessionCommand(session);
  const age = formatRelativeTime(session.createdAt);
  return (
    <li>
      <Link
        to={`/worktree?path=${encodeURIComponent(worktreePath)}&terminal=${encodeURIComponent(session.id)}`}
        data-testid="home-terminal-row"
        data-session-id={session.id}
        className="group flex h-8 items-center gap-2 rounded-lg px-2 transition-colors hover:bg-[color:var(--hover)]"
      >
        <StatusDot variant="run" />
        <Icon
          className="size-3.5 shrink-0"
          strokeWidth={1.75}
          style={agent ? { color: agent.brand } : undefined}
          aria-hidden
        />
        <span className="max-w-[45%] shrink-0 truncate text-[12px] text-[color:var(--ink-2)]">
          {label}
        </span>
        {command ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[color:var(--muted-foreground)] before:mr-[7px] before:text-[color:var(--hair-2)] before:content-['·']">
            {command}
          </span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        {age && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-[color:var(--muted-foreground)]">
            {age}
          </span>
        )}
      </Link>
    </li>
  );
}
