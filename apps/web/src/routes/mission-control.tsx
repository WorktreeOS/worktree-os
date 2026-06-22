import { useEffect, useMemo, useRef, useState } from "react";
import { useOutletContext } from "react-router";
import { FolderGit2 } from "lucide-react";

import type { SidebarOutletContext } from "@/routes/layout";
import { SidebarToggle } from "@/components/ui/sidebar-toggle";
import { useProjects } from "@/lib/projects-context";
import { useUiApi } from "@/lib/api-context";
import { useAllTerminalSessions } from "@/lib/terminal-sessions-context";
import { worktreeLabel } from "@/lib/sidebar-labels";
import { toPaneModel, type PaneModel } from "@/lib/mission-control/pane-model";
import {
  SnapshotStreamClient,
  type SnapshotFrame,
} from "@/lib/mission-control/snapshot-stream";
import {
  CADENCE_OPTIONS_MS,
  readCadenceMs,
  writeCadenceMs,
} from "@/lib/mission-control/settings";
import { SnapshotPane } from "@/components/ui/snapshot-pane";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { MissionControlFocus } from "@/components/mission-control-focus";
import { HomeEmptyState, HomeOverview } from "@/routes/home";

/** The wall always renders panes proportionally (fixed-height, aspect-true). */
const WALL_GEOMETRY = "proportional" as const;
/** Pane card height (px). */
const CARD_HEIGHT = 286;

interface PaneEntry {
  pane: PaneModel;
  projectName: string;
  projectId: string | null;
  branchLabel: string;
}

interface ProjectGroup {
  key: string;
  name: string;
  entries: PaneEntry[];
}

function basename(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  return normalized.split("/").pop() || normalized || "worktree";
}

type Filter = "all" | "waiting" | "agents" | { project: string };

export function MissionControlRoute() {
  const sessionsByPath = useAllTerminalSessions();
  const { projects } = useProjects();

  // path → { project, branch } lookup for pane chrome and grouping.
  const pathMeta = useMemo(() => {
    const map = new Map<
      string,
      { projectName: string; projectId: string; branchLabel: string }
    >();
    for (const project of projects) {
      for (const wt of project.worktrees) {
        map.set(wt.path, {
          projectName: project.displayName,
          projectId: project.id,
          branchLabel: worktreeLabel(wt),
        });
      }
    }
    return map;
  }, [projects]);

  // Flatten every live session across all worktrees into a stable pane list.
  const entries = useMemo<PaneEntry[]>(() => {
    const out: PaneEntry[] = [];
    for (const [path, sessions] of sessionsByPath) {
      const meta = pathMeta.get(path);
      for (const session of sessions) {
        out.push({
          pane: toPaneModel(session, meta?.branchLabel ?? basename(path)),
          projectName: meta?.projectName ?? "Unassigned",
          projectId: meta?.projectId ?? null,
          branchLabel: meta?.branchLabel ?? basename(path),
        });
      }
    }
    // Awaiting-input first (the thing that needs attention), then by created.
    out.sort((a, b) => {
      if (a.pane.awaitingInput !== b.pane.awaitingInput) {
        return a.pane.awaitingInput ? -1 : 1;
      }
      return a.pane.session.createdAt.localeCompare(b.pane.session.createdAt);
    });
    return out;
  }, [sessionsByPath, pathMeta]);

  const liveCount = entries.length;
  const waitingCount = useMemo(
    () => entries.filter((e) => e.pane.awaitingInput).length,
    [entries],
  );

  return liveCount === 0 ? (
    <MissionControlEmpty />
  ) : (
    <MissionControlWall entries={entries} waitingCount={waitingCount} />
  );
}

/** Empty state: the cross-project overview (or onboarding when no projects). */
function MissionControlEmpty() {
  const { projects, loading } = useProjects();
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
        <span className="status-dot status-dot--info status-dot--pulse" />
        <span className="font-mono text-[11px] uppercase tracking-[0.22em]">
          loading…
        </span>
      </div>
    );
  }
  if (projects.length === 0) return <HomeEmptyState />;
  return <HomeOverview projects={projects} />;
}

function MissionControlWall({
  entries,
  waitingCount,
}: {
  entries: PaneEntry[];
  waitingCount: number;
}) {
  const api = useUiApi();
  const [filter, setFilter] = useState<Filter>("all");
  const [cadenceMs, setCadenceMs] = useState<number>(() => readCadenceMs());
  const [frames, setFrames] = useState<ReadonlyMap<string, SnapshotFrame>>(
    new Map(),
  );
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // Distinct projects present among live sessions (for the project filter).
  const projectOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of entries) {
      if (e.projectId) seen.set(e.projectId, e.projectName);
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [entries]);

  const filtered = useMemo(() => {
    if (filter === "all") return entries;
    if (filter === "waiting") return entries.filter((e) => e.pane.awaitingInput);
    if (filter === "agents") return entries.filter((e) => e.pane.agent !== null);
    return entries.filter((e) => e.projectId === filter.project);
  }, [entries, filter]);

  // Group the filtered panes by project. Group order follows first appearance
  // in the (awaiting-first) sorted list, so a project with a blocked agent
  // floats to the top.
  const groups = useMemo<ProjectGroup[]>(() => {
    const byKey = new Map<string, ProjectGroup>();
    const order: string[] = [];
    for (const entry of filtered) {
      const key = entry.projectId ?? "—";
      let group = byKey.get(key);
      if (!group) {
        group = { key, name: entry.projectName, entries: [] };
        byKey.set(key, group);
        order.push(key);
      }
      group.entries.push(entry);
    }
    return order.map((k) => byKey.get(k)!);
  }, [filtered]);

  const visibleIds = useMemo(() => filtered.map((e) => e.pane.id), [filtered]);
  const visibleIdsKey = visibleIds.join(",");

  // One snapshot-stream client for the whole wall; recreated only if the api
  // identity changes (it is stable). Frames are coalesced to one render/frame.
  const clientRef = useRef<SnapshotStreamClient | null>(null);
  useEffect(() => {
    const client = new SnapshotStreamClient(
      (ids, cadence) => api.terminalSnapshotStreamUrl(ids, cadence),
      (latest) => setFrames(new Map(latest)),
    );
    clientRef.current = client;
    return () => {
      client.close();
      clientRef.current = null;
    };
  }, [api]);

  // (Re)subscribe whenever the visible set or cadence changes.
  useEffect(() => {
    clientRef.current?.subscribe(visibleIds, cadenceMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleIdsKey, cadenceMs]);

  const updateCadence = (ms: number) => {
    setCadenceMs(ms);
    writeCadenceMs(ms);
  };

  const focused = useMemo(
    () => filtered.find((e) => e.pane.id === focusedId) ?? null,
    [filtered, focusedId],
  );

  const filterValue =
    typeof filter === "object" ? `project:${filter.project}` : filter;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="mission-control">
      <MissionControlBar
        filterValue={filterValue}
        waitingCount={waitingCount}
        onFilter={setFilter}
        projectOptions={projectOptions}
        cadenceMs={cadenceMs}
        onCadence={updateCadence}
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 py-4 md:px-6">
        {filtered.length === 0 ? (
          <div
            className="flex h-full items-center justify-center text-[13px] text-[color:var(--muted-foreground)]"
            data-testid="mc-no-matches"
          >
            Nothing matches this filter.
          </div>
        ) : (
          <div className="flex flex-col gap-7">
            {groups.map((group) => (
              <section
                key={group.key}
                data-testid="mc-project-group"
                data-project-id={group.key}
                className="flex flex-col gap-2.5"
              >
                <div className="flex items-center gap-2">
                  <FolderGit2
                    className="size-[15px] shrink-0 text-[color:var(--muted-foreground)]"
                    strokeWidth={1.75}
                    aria-hidden
                  />
                  <h2 className="m-0 text-[14px] font-semibold tracking-[-0.01em] text-[color:var(--ink)]">
                    {group.name}
                  </h2>
                  <span className="text-[12px] text-[color:var(--muted-foreground)]">
                    {group.entries.length}{" "}
                    {group.entries.length === 1 ? "session" : "sessions"}
                  </span>
                </div>
                <div
                  className="grid gap-3"
                  style={{
                    gridTemplateColumns:
                      "repeat(auto-fill, minmax(300px, 1fr))",
                  }}
                >
                  {group.entries.map((entry) => (
                    <div key={entry.pane.id} style={{ height: CARD_HEIGHT }}>
                      <SnapshotPane
                        pane={entry.pane}
                        frame={frames.get(entry.pane.id)}
                        geometry={WALL_GEOMETRY}
                        projectName={entry.projectName}
                        branchLabel={entry.branchLabel}
                        onFocus={() => setFocusedId(entry.pane.id)}
                      />
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
      {focused && (
        <MissionControlFocus
          session={focused.pane.session}
          projectName={focused.projectName}
          branchLabel={focused.branchLabel}
          onClose={() => setFocusedId(null)}
        />
      )}
    </div>
  );
}

function MissionControlBar({
  filterValue,
  waitingCount,
  onFilter,
  projectOptions,
  cadenceMs,
  onCadence,
}: {
  filterValue: string;
  waitingCount: number;
  onFilter: (filter: Filter) => void;
  projectOptions: { id: string; name: string }[];
  cadenceMs: number;
  onCadence: (ms: number) => void;
}) {
  const isProjectFilter = filterValue.startsWith("project:");
  const segmentValue = isProjectFilter ? "" : filterValue;
  // Rail collapse/expand lives in the page header (desktop), mirroring worktree.
  const sidebar = useOutletContext<SidebarOutletContext | null>();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[color:var(--hair)] px-4 py-2.5 md:px-6">
      {sidebar && (
        <SidebarToggle
          sidebarOpen={sidebar.sidebarOpen}
          onToggle={sidebar.toggleSidebar}
          className="-ml-1"
        />
      )}
      <SegmentedControl
        variant="filter"
        ariaLabel="Filter sessions"
        data-testid="mc-filter"
        value={segmentValue}
        onChange={(v) => onFilter(v as Filter)}
        options={[
          { value: "all", label: "All" },
          { value: "waiting", label: "Waiting", count: waitingCount || undefined },
          { value: "agents", label: "Agents" },
        ]}
      />
      {projectOptions.length > 0 && (
        <MiniSelect
          ariaLabel="Filter by project"
          testId="mc-filter-project"
          value={isProjectFilter ? filterValue.slice("project:".length) : ""}
          onChange={(v) => onFilter(v ? { project: v } : "all")}
          options={[
            { value: "", label: "All projects" },
            ...projectOptions.map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
      )}
      <div className="ml-auto flex items-center gap-3">
        <MiniSelect
          ariaLabel="Snapshot cadence"
          testId="mc-cadence"
          value={String(cadenceMs)}
          onChange={(v) => onCadence(Number(v))}
          options={CADENCE_OPTIONS_MS.map((ms) => ({
            value: String(ms),
            label: ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`,
          }))}
        />
      </div>
    </div>
  );
}

/** Compact hairline-framed native select in the v3 language. */
function MiniSelect({
  value,
  onChange,
  options,
  ariaLabel,
  testId,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  ariaLabel: string;
  testId?: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      data-testid={testId}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-[26px] rounded-lg border border-[color:var(--hair-2)] bg-[color:var(--surface)] px-2 text-[12px] text-[color:var(--ink-2)] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:color-mix(in_oklch,var(--ink)_50%,transparent)]"
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
