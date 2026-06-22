import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
  type Ref,
  type SVGProps,
} from "react";
import { Link, useLocation, useNavigate } from "react-router";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowUpRight,
  ChevronDown,
  FolderGit2,
  GitBranch,
  GitBranchPlus,
  GripVertical,
  LayoutGrid,
  Monitor,
  Moon,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RotateCw,
  Settings,
  Square,
  StickyNote,
  Sun,
  Trash2,
} from "lucide-react";
import { useTheme, type ThemeMode } from "@/lib/theme";
import { useHasTouch } from "@/lib/viewport";
import { useWorktreeOpener } from "@/lib/worktree-panel-context";
import { useProjects } from "@/lib/projects-context";
import { useUiApi } from "@/lib/api-context";
import { usePublicAuth } from "@/lib/public-auth-context";
import { shouldHideSettingsNav } from "@/lib/settings-access";
import { useActiveTerminal } from "@/lib/active-terminal-context";
import {
  useAllTerminalSessions,
  useTerminalCountsMap,
} from "@/lib/terminal-sessions-context";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UiApiError, UiSessionBusyError, UiWorktreeDirtyError } from "@/lib/ui-api";
import type {
  ProjectSummary,
  WorktreeSummary,
} from "@/lib/ui-api";
import { CreateWorktreeModal } from "@/components/create-worktree-modal";
import { AddProjectModal } from "@/components/add-project-modal";
import type { TerminalSessionMetadata } from "@/lib/terminal-protocol";
import { cn } from "@/lib/utils";
import {
  getSidebarMaxWidth,
  SIDEBAR_MIN_WIDTH,
} from "@/lib/sidebar-width";
import {
  DeploymentActionModal,
  RemoveWorktreeModal,
} from "@/routes/worktree";
import { toast } from "@/components/ui/sonner";
import { StatusDot, statusDotVariant } from "@/components/ui/status-dot";
import { ProjectSwitcher } from "@/components/ui/project-switcher";
import { worktreeLabel } from "@/lib/sidebar-labels";
import {
  applyProjectOrder,
  readProjectOrder,
  writeProjectOrder,
} from "@/lib/sidebar-project-order";
import {
  applyWorktreeOrder,
  pruneWorktreeOrder,
  readWorktreeOrder,
  writeWorktreeOrder,
} from "@/lib/sidebar-worktree-order";
import {
  projectOwningPath,
  readActiveProjectId,
  resolveActiveProjectId,
  writeActiveProjectId,
} from "@/lib/sidebar-active-project";
import {
  activeScopeSummary,
  groupActiveWorktrees,
  readSidebarScope,
  writeSidebarScope,
  type SidebarScope,
} from "@/lib/sidebar-scope";
import {
  groupSessionsByAttention,
  type AttentionGroupKey,
  type AttentionResult,
} from "@/lib/sidebar-attention";
import type { ProjectTileIdentity } from "@/lib/project-identity";
import { projectTile } from "@/lib/project-identity";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StreamSessionRow } from "@/components/ui/stream-session-row";
import { AttentionGroupHeader } from "@/components/ui/attention-group-header";
import { NewSessionLauncher } from "@/components/ui/new-session-launcher";

/* Sessions attention groups in render order + the filter union. */
const STREAM_GROUPS: ReadonlyArray<{ key: AttentionGroupKey; label: string }> = [
  { key: "needsYou", label: "Needs you" },
  { key: "unread", label: "Unread" },
  { key: "working", label: "Working" },
  { key: "idle", label: "Idle" },
];
type StreamFilter = "all" | AttentionGroupKey;

/** Last path segment — a stable label/identity for a session whose worktree is
 * no longer in the project list (defensive; normally every path resolves). */
function pathBasename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

const BAND_COLLAPSED_STORAGE_KEY = "wos.sidebar.bandCollapsed";

function readBandCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(BAND_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeBandCollapsed(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (value) window.localStorage.setItem(BAND_COLLAPSED_STORAGE_KEY, "true");
    else window.localStorage.removeItem(BAND_COLLAPSED_STORAGE_KEY);
  } catch {
    /* ignore quota / privacy mode */
  }
}

/* Nested-sortable collision detection: a drag only collides with droppables of
 * its own kind (`project:` / `worktree:`), so the project list and the
 * active-now project groups never fight over the drop target (D5 risk). */
const railCollisionDetection: CollisionDetection = (args) => {
  const id = String(args.active.id);
  const prefix = id.slice(0, id.indexOf(":") + 1);
  return closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter((c) =>
      String(c.id).startsWith(prefix),
    ),
  });
};

function clampMenuPosition(x: number, y: number) {
  const pad = 8;
  const w = 220;
  const h = 240;
  return {
    x: Math.min(Math.max(x, pad), window.innerWidth - w - pad),
    y: Math.min(y, window.innerHeight - h - pad),
  };
}

function isRemovingWorktree(wt: WorktreeSummary): boolean {
  return (
    wt.activeOperation?.kind === "worktree-remove" &&
    wt.activeOperation.status === "running"
  );
}

/* Order worktrees within a project for the band: removing rows sink to the
 * bottom, failed rows float to the top (they need eyes), then the source
 * worktree, then original order. */
function sortWorktreesForSidebar(
  worktrees: WorktreeSummary[],
): WorktreeSummary[] {
  const rank = (wt: WorktreeSummary): number => {
    if (isRemovingWorktree(wt)) return 3;
    if (wt.status === "failed") return 0;
    if (wt.isSource) return 1;
    return 2;
  };
  return worktrees
    .map((wt, index) => ({ wt, index }))
    .sort((a, b) => {
      const ra = rank(a.wt);
      const rb = rank(b.wt);
      if (ra !== rb) return ra - rb;
      return a.index - b.index;
    })
    .map((entry) => entry.wt);
}

interface ContextMenuState {
  worktree: WorktreeSummary;
  x: number;
  y: number;
}

interface MenuItem {
  action: WorktreeAction;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  enabled: boolean;
  destructive?: boolean;
}

type WorktreeAction =
  | "open"
  | "rename"
  | "note"
  | "start"
  | "restart"
  | "stop"
  | "remove"
  | "newterminal";

interface ActionAvailability {
  rename: boolean;
  note: boolean;
  start: boolean;
  restart: boolean;
  stop: boolean;
  remove: boolean;
}

function actionAvailability(wt: WorktreeSummary): ActionAvailability {
  const isBusy =
    !!wt.activeOperation && wt.activeOperation.status === "running";
  const isNotStarted = wt.status === "not_started";
  return {
    rename: !isBusy,
    note: !isBusy,
    start: isNotStarted && !isBusy,
    restart: !isNotStarted && !isBusy,
    stop: !isNotStarted && !isBusy,
    remove: !wt.isSource && !isBusy,
  };
}

interface LifecycleItem {
  action: WorktreeAction;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}

/* The state-aware lifecycle items for a worktree's actions menu (mirrors the
 * demo's per-state menu): not-started → Start; running / partial → Restart +
 * Stop; stopped → Start; failed → Retry. Only available actions are returned;
 * disabling is left to the caller for metadata edits. */
function menuLifecycle(
  wt: WorktreeSummary,
  avail: ActionAvailability,
): LifecycleItem[] {
  if (wt.status === "not_started") {
    return avail.start
      ? [{ action: "start", label: "Start", icon: Play }]
      : [];
  }
  const out: LifecycleItem[] = [];
  if (avail.restart) {
    if (wt.status === "failed") {
      out.push({ action: "restart", label: "Retry", icon: RotateCw });
    } else if (wt.status === "stopped" || wt.status === "stopping") {
      out.push({ action: "restart", label: "Start", icon: Play });
    } else {
      out.push({ action: "restart", label: "Restart", icon: RotateCw });
    }
  }
  const live =
    wt.status === "running" ||
    wt.status === "running_partial" ||
    wt.status === "checking" ||
    wt.status === "pending";
  if (live && avail.stop) {
    out.push({ action: "stop", label: "Stop", icon: Square });
  }
  return out;
}

interface SidebarProps {
  open: boolean;
  isDesktop: boolean;
  onClose: () => void;
  /* Render the rail content inside the mobile bottom-sheet navigator: fill the
   * sheet, drop the fixed drawer chrome (positioning, border, slide transform)
   * and the identity header, since the sheet supplies its own grabber. */
  embedded?: boolean;
  /* Desktop rail width in px, owned by the app shell. Applied only in desktop
   * non-embedded mode; the embedded mobile navigator ignores it and keeps its
   * sheet-owned layout. */
  width?: number;
  /* Live drag update with the proposed raw width; the shell clamps + stores. */
  onWidthChange?: (rawWidth: number) => void;
  /* Drag finished — the shell persists the current width. */
  onWidthCommit?: () => void;
}

export function Sidebar({
  open,
  isDesktop,
  onClose,
  embedded = false,
  width,
  onWidthChange,
  onWidthCommit,
}: SidebarProps) {
  const { projects, loading, error, refresh } = useProjects();
  const api = useUiApi();
  const { state: authState } = usePublicAuth();
  const settingsHidden = shouldHideSettingsNav(authState);
  const location = useLocation();
  const navigate = useNavigate();
  const openWorktree = useWorktreeOpener();
  // Density/affordance flag — distinct from layout. `isDesktop` (width) keeps
  // the rail visible as a fixed left rail; this drives touch-sized rows and
  // inline (non-hover) actions whenever the device has touch input, so a wide
  // touchscreen desktop gets reachable hit targets instead of mis-taps and
  // hover-only controls that never reveal under a finger.
  const hasTouch = useHasTouch();
  const touchAffordances = !isDesktop || hasTouch;
  const activePath =
    location.pathname === "/worktree"
      ? new URLSearchParams(location.search).get("path")
      : null;
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deploymentModal, setDeploymentModal] = useState<{
    worktree: WorktreeSummary;
    mode: "start" | "restart";
  } | null>(null);
  const [removeModal, setRemoveModal] = useState<WorktreeSummary | null>(null);
  const [createModalProject, setCreateModalProject] =
    useState<ProjectSummary | null>(null);
  const [actionPending, setActionPending] = useState<boolean>(false);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renamePending, setRenamePending] = useState<boolean>(false);
  const [notingPath, setNotingPath] = useState<string | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [notePending, setNotePending] = useState<boolean>(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    () => readActiveProjectId(),
  );
  const [scope, setScope] = useState<SidebarScope>(() => readSidebarScope());
  const [streamFilter, setStreamFilter] = useState<StreamFilter>("all");
  const [showAddProjectModal, setShowAddProjectModal] = useState(false);
  const [bandCollapsed, setBandCollapsed] = useState<boolean>(() =>
    readBandCollapsed(),
  );
  // Personal, per-browser ordering projected over canonical data at render time
  // (the contexts keep emitting createdAt / registration order; these survive
  // the 2.5s resync and reloads). See lib/sidebar-project-order + -worktree-order.
  const [projectOrder, setProjectOrder] = useState<string[]>(() =>
    readProjectOrder(),
  );
  const [worktreeOrder, setWorktreeOrder] = useState<string[]>(() =>
    readWorktreeOrder(),
  );

  const { activeSessionId } = useActiveTerminal();
  const terminalCounts = useTerminalCountsMap();
  const allSessions = useAllTerminalSessions();

  // Board-style sensors: a 5px activation distance so a tap/click on a row is
  // never read as a drag, plus keyboard sortable support.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const activeProjectId = resolveActiveProjectId({
    persistedId: selectedProjectId,
    activePath,
    projects,
  });
  const activeProject =
    projects.find((p) => p.id === activeProjectId) ?? null;
  const visibleWorktrees = activeProject
    ? sortWorktreesForSidebar(activeProject.worktrees)
    : [];
  // Project the user's manual worktree arrangement over the canonical sort
  // (drag authors it in project scope; Active-now honors it read-only).
  const orderedVisibleWorktrees = applyWorktreeOrder(
    visibleWorktrees,
    worktreeOrder,
  );

  // Cross-project "Active now" scope summary for the project switcher anchor.
  const activeGroups = groupActiveWorktrees(projects, terminalCounts);
  const activeSummary = activeScopeSummary(activeGroups);
  // Every project that has worktrees, in the global order — the band's
  // Active-now inventory (full, including idle worktrees the stream can't show).
  const orderedBandProjects = applyProjectOrder(projects, projectOrder).filter(
    (p) => p.worktrees.length > 0,
  );

  // Index every worktree by path so a stream row resolves its project identity
  // tile + worktree label, then flatten the live-session snapshot filtered by
  // the active scope (Active now = all projects; a project = only its
  // worktrees) and group it by attention. Pure derivations off the same
  // snapshot the band reads — no new data.
  const pathIndex = useMemo(() => {
    const map = new Map<
      string,
      { project: ProjectSummary; worktree: WorktreeSummary }
    >();
    for (const project of projects) {
      for (const wt of project.worktrees) {
        map.set(wt.path, { project, worktree: wt });
      }
    }
    return map;
  }, [projects]);

  const streamSessions = useMemo(() => {
    const out: TerminalSessionMetadata[] = [];
    for (const [path, list] of allSessions) {
      if (scope === "project") {
        const owner = pathIndex.get(path);
        if (!owner || owner.project.id !== activeProjectId) continue;
      }
      for (const s of list) out.push(s);
    }
    return out;
  }, [allSessions, scope, pathIndex, activeProjectId]);

  const attention = useMemo(
    () => groupSessionsByAttention(streamSessions),
    [streamSessions],
  );

  const reorderWorktrees = (
    currentPaths: string[],
    fromPath: string,
    toPath: string,
  ) => {
    const oldIndex = currentPaths.indexOf(fromPath);
    const newIndex = currentPaths.indexOf(toPath);
    if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;
    const movedPaths = arrayMove(currentPaths, oldIndex, newIndex);
    setWorktreeOrder((prev) => {
      // Single flat array across projects; only the relative order of *this*
      // project's paths matters (per-project projection filters the rest), so
      // re-append them in their new order.
      const projectSet = new Set(currentPaths);
      const next = [...prev.filter((p) => !projectSet.has(p)), ...movedPaths];
      writeWorktreeOrder(next);
      return next;
    });
  };

  const reorderProjects = (activeProjectId: string, overProjectId: string) => {
    // Reorder within the *full* project list so projects not currently shown in
    // the band keep their relative positions in the global order.
    const fullIds = applyProjectOrder(projects, projectOrder).map((p) => p.id);
    const oldIndex = fullIds.indexOf(activeProjectId);
    const newIndex = fullIds.indexOf(overProjectId);
    if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;
    const next = arrayMove(fullIds, oldIndex, newIndex);
    writeProjectOrder(next);
    setProjectOrder(next);
  };

  // One drag-end router for both band scopes. Sortable ids are namespaced
  // (`project:` / `worktree:`); the prefix selects the reorder and mixed drags
  // are a no-op (D5).
  const onRailDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const a = String(active.id);
    const o = String(over.id);
    if (a.startsWith("project:") && o.startsWith("project:")) {
      reorderProjects(a.slice("project:".length), o.slice("project:".length));
      return;
    }
    if (a.startsWith("worktree:") && o.startsWith("worktree:")) {
      reorderWorktrees(
        orderedVisibleWorktrees.map((w) => w.path),
        a.slice("worktree:".length),
        o.slice("worktree:".length),
      );
    }
  };

  const selectScope = useCallback((next: SidebarScope) => {
    setScope(next);
    writeSidebarScope(next);
  }, []);

  const toggleBandCollapse = useCallback(() => {
    setBandCollapsed((prev) => {
      const next = !prev;
      writeBandCollapsed(next);
      return next;
    });
  }, []);

  const selectProject = useCallback(
    (projectId: string) => {
      const switching = projectId !== activeProjectId;
      setSelectedProjectId(projectId);
      writeActiveProjectId(projectId);
      selectScope("project");
      // Switching projects clears the open worktree — its detail belongs to
      // the previous project — and drops to the project-scoped empty
      // placeholder. From the all-projects home there is no worktree to clear,
      // so we stay put and only re-scope the rail.
      if (
        switching &&
        (location.pathname === "/worktree" || location.pathname === "/select")
      ) {
        navigate(`/select?project=${encodeURIComponent(projectId)}`);
      }
    },
    [activeProjectId, location.pathname, navigate, selectScope],
  );

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [contextMenu]);

  // Prune selection / worktree order that references state that no longer
  // exists. Wait until at least one project has loaded so nothing is dropped
  // before data arrives.
  useEffect(() => {
    if (projects.length === 0) return;
    const knownPaths = new Set(
      projects.flatMap((p) => p.worktrees.map((wt) => wt.path)),
    );
    setSelectedProjectId((prev) => {
      if (!prev || projects.some((p) => p.id === prev)) return prev;
      writeActiveProjectId(null);
      return null;
    });
    setWorktreeOrder((prev) => {
      const next = pruneWorktreeOrder(prev, knownPaths);
      if (next.length === prev.length) return prev;
      writeWorktreeOrder(next);
      return next;
    });
  }, [projects]);

  // Active project follows worktree selection: navigating to a worktree in
  // another project makes that project active (and persists the choice). Keyed
  // on the path we last followed so an explicit switcher pick — which changes
  // `selectedProjectId` while the open worktree is unchanged — is not reverted.
  const followedPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (activePath === followedPathRef.current) return;
    const owning = projectOwningPath(projects, activePath);
    if (!owning) return; // projects not loaded yet; retry once they are
    followedPathRef.current = activePath;
    if (owning.id !== selectedProjectId) {
      setSelectedProjectId(owning.id);
      writeActiveProjectId(owning.id);
    }
  }, [activePath, projects, selectedProjectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowAddProjectModal(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const translateActionError = (e: unknown): string => {
    if (e instanceof UiSessionBusyError) return "Session is already busy with another operation.";
    if (e instanceof UiApiError) return e.message;
    return (e as Error).message;
  };

  const submitUp = async (wt: WorktreeSummary, force: boolean) => {
    setActionPending(true);
    setActionError(null);
    try {
      await api.submitUp(wt.path, force);
      await refresh();
    } catch (e) {
      setActionError(translateActionError(e));
    } finally {
      setActionPending(false);
    }
  };

  const submitDown = async (wt: WorktreeSummary) => {
    setActionPending(true);
    setActionError(null);
    try {
      await api.submitDown(wt.path);
      await refresh();
    } catch (e) {
      setActionError(translateActionError(e));
    } finally {
      setActionPending(false);
    }
  };

  const submitRemove = async (
    wt: WorktreeSummary,
    discardChanges: boolean,
  ): Promise<"succeeded" | "dirty" | "failed"> => {
    setActionPending(true);
    setActionError(null);
    try {
      await api.submitWorktreeRemove(wt.path, discardChanges);
      await refresh();
      if (activePath === wt.path) {
        navigate("/", { replace: true });
      }
      toast.success("Worktree removed", {
        description: worktreeLabel(wt),
      });
      return "succeeded";
    } catch (e) {
      if (e instanceof UiWorktreeDirtyError) return "dirty";
      const message = translateActionError(e);
      setActionError(message);
      toast.error("Failed to remove worktree", {
        description: message,
      });
      return "failed";
    } finally {
      setActionPending(false);
    }
  };

  const requestRemove = async (wt: WorktreeSummary) => {
    const outcome = await submitRemove(wt, false);
    if (outcome === "dirty") setRemoveModal(wt);
  };

  /* Attaching from the rail navigates to the session's worktree, where the
   * terminal panel lives. The clicked session id rides along as a `terminal`
   * query param so the worktree route opens that exact session, not just the
   * worktree's default terminal. */
  const attachSession = (worktreePath: string, sessionId?: string) => {
    const params = new URLSearchParams({ path: worktreePath });
    if (sessionId) params.set("terminal", sessionId);
    navigate(`/worktree?${params.toString()}`);
    if (!isDesktop) onClose();
  };

  const killSession = async (id: string) => {
    try {
      await api.terminateTerminalLayerSession(id);
      // The terminal-sessions context refreshes on the `terminal.exited`
      // event, so the row drops out without an explicit reload here.
    } catch (e) {
      toast.error("Failed to kill terminal", {
        description: translateActionError(e),
      });
    }
  };

  /* Quick terminal creation: spin up a fresh session for the worktree and open
   * it focused. Used by the stream's `New here` and the band's `New session
   * here`; the new session surfaces in the stream above. */
  const createTerminal = async (worktreePath: string) => {
    try {
      const { session } = await api.createTerminalLayerSession({ worktreePath });
      attachSession(worktreePath, session.id);
    } catch (e) {
      toast.error("Failed to create terminal", {
        description: translateActionError(e),
      });
    }
  };

  const openWorktreePage = (worktreePath: string) => {
    openWorktree("worktree", worktreePath);
    if (!isDesktop) onClose();
  };

  const runRowAction = (action: WorktreeAction, wt: WorktreeSummary) => {
    const avail = actionAvailability(wt);
    if (action === "open") {
      openWorktreePage(wt.path);
      return;
    }
    if (action === "newterminal") {
      void createTerminal(wt.path);
      return;
    }
    if (action === "rename") {
      if (!avail.rename) return;
      setRenameError(null);
      setRenamingPath(wt.path);
      return;
    }
    if (action === "note") {
      if (!avail.note) return;
      setNoteError(null);
      setNotingPath(wt.path);
      return;
    }
    if (action === "start") {
      if (!avail.start) return;
      setDeploymentModal({ worktree: wt, mode: "start" });
      return;
    }
    if (action === "restart") {
      if (!avail.restart) return;
      setDeploymentModal({ worktree: wt, mode: "restart" });
      return;
    }
    if (action === "stop") {
      if (!avail.stop) return;
      void submitDown(wt);
      return;
    }
    if (action === "remove") {
      if (!avail.remove) return;
      void requestRemove(wt);
    }
  };

  const onContextMenuItem = (action: WorktreeAction, wt: WorktreeSummary) => {
    setContextMenu(null);
    runRowAction(action, wt);
  };

  const openWorktreeMenu = (wt: WorktreeSummary, x: number, y: number) => {
    setContextMenu({ worktree: wt, ...clampMenuPosition(x, y) });
  };

  const cancelRename = () => {
    setRenamingPath(null);
    setRenameError(null);
    setRenamePending(false);
  };

  const submitRename = async (wt: WorktreeSummary, nextName: string) => {
    const trimmed = nextName.trim();
    if (trimmed.length === 0) {
      setRenameError("Name must not be empty.");
      return;
    }
    if (trimmed === (wt.displayName ?? "")) {
      cancelRename();
      return;
    }
    setRenamePending(true);
    setRenameError(null);
    try {
      await api.submitWorktreeRename({ path: wt.path, displayName: trimmed });
      await refresh();
      setRenamingPath(null);
    } catch (e) {
      setRenameError(translateActionError(e));
    } finally {
      setRenamePending(false);
    }
  };

  const cancelNote = () => {
    setNotingPath(null);
    setNoteError(null);
    setNotePending(false);
  };

  const submitNote = async (wt: WorktreeSummary, nextNote: string) => {
    const trimmed = nextNote.trim();
    if (trimmed === (wt.note ?? "")) {
      cancelNote();
      return;
    }
    setNotePending(true);
    setNoteError(null);
    try {
      await api.submitWorktreeNote({ path: wt.path, note: trimmed });
      await refresh();
      setNotingPath(null);
    } catch (e) {
      setNoteError(translateActionError(e));
    } finally {
      setNotePending(false);
    }
  };

  const bandShared: BandRowSharedProps = {
    touch: touchAffordances,
    onOpen: openWorktreePage,
    onNewSession: (wt) => runRowAction("newterminal", wt),
    onOpenMenu: openWorktreeMenu,
    renamingPath,
    renamePending,
    renameError,
    onRenameSubmit: submitRename,
    onRenameCancel: cancelRename,
    notingPath,
    notePending,
    noteError,
    onNoteSubmit: submitNote,
    onNoteCancel: cancelNote,
  };

  // The right-edge drag handle is desktop-only: the mobile bottom-sheet
  // navigator (embedded) keeps its sheet-owned layout and never resizes.
  const desktopResizable =
    isDesktop && !embedded && width != null && onWidthChange != null;

  return (
    <aside
      data-open={open}
      data-testid="sidebar"
      className={cn(
        "flex h-full flex-col select-none bg-sidebar text-sidebar-foreground",
        embedded
          ? "min-h-0 w-full flex-1"
          : cn(
              "z-40 shrink-0 border-r border-sidebar-border transition-transform duration-200 ease-out",
              // Desktop applies a live inline width; otherwise keep the fixed rail.
              !desktopResizable && "w-[16rem]",
              isDesktop ? "relative" : "fixed inset-y-0 left-0 shadow-xl",
              !open &&
                (isDesktop ? "hidden" : "pointer-events-none -translate-x-full"),
            ),
      )}
      style={desktopResizable ? { width: `${width}px` } : undefined}
    >
      {/* scope switcher: names the current scope (a project or Active now)
       * and lists every scope to pick — Active now on top, then projects */}
      {projects.length > 0 && (
        <div className="shrink-0">
          <ProjectSwitcher
            projects={projects}
            projectOrder={projectOrder}
            activeProject={activeProject}
            scope={scope}
            activeSummary={activeSummary}
            touch={touchAffordances}
            onSelect={selectProject}
            onSelectActiveNow={() => selectScope("active-now")}
            onAddProject={() => setShowAddProjectModal(true)}
          />
        </div>
      )}

      {/* Attention filter bar + the New-session launcher. Fixed above the
       * scrollable stream (matches demo/sidebar-worktree-band-v3.html). */}
      {projects.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 px-2 pt-2">
          <SegmentedControl
            variant="filter"
            countTone="neutral"
            size={touchAffordances ? "touch" : "default"}
            ariaLabel="Filter sessions by attention"
            data-testid="rail-stream-filter"
            value={streamFilter}
            onChange={(v) => setStreamFilter(v as StreamFilter)}
            className="min-w-0 flex-1 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            options={[
              { value: "all", label: "All", count: attention.counts.total },
              {
                value: "needsYou",
                label: "Needs you",
                count: attention.counts.needsYou,
              },
              { value: "unread", label: "Unread", count: attention.counts.unread },
              {
                value: "working",
                label: "Working",
                count: attention.counts.working,
              },
              { value: "idle", label: "Idle", count: attention.counts.idle },
            ]}
          />
          <NewSessionLauncher
            projects={projects}
            projectOrder={projectOrder}
            touch={touchAffordances}
            onCreate={createTerminal}
          />
        </div>
      )}

      {actionError && (
        <div className="mx-3 mt-2 rounded-lg bg-[color:var(--bad-soft)] px-2.5 py-1.5 text-[11px] text-[color:var(--bad)]">
          {actionError}
        </div>
      )}

      <div className="sidebar-scroll flex-1 overflow-y-auto px-2 pb-2 pt-1.5">
        {error && (
          <div className="mb-2 rounded-lg bg-[color:var(--bad-soft)] px-2.5 py-1.5 text-[11px] text-[color:var(--bad)]">
            {error}
          </div>
        )}

        {loading && projects.length === 0 && !error && <SidebarSkeleton />}

        {!loading && projects.length === 0 && !error && (
          <SidebarEmpty onAdd={() => setShowAddProjectModal(true)} />
        )}

        {projects.length > 0 && (
          <>
            <SessionsStream
              attention={attention}
              filter={streamFilter}
              scopeLabel={
                scope === "project" ? activeProject?.displayName : undefined
              }
              touch={touchAffordances}
              activeSessionId={activeSessionId}
              resolve={(path) => {
                const owner = pathIndex.get(path);
                return owner
                  ? {
                      tile: projectTile(owner.project),
                      worktreeName: worktreeLabel(owner.worktree),
                    }
                  : {
                      tile: projectTile({
                        id: path,
                        displayName: pathBasename(path),
                      }),
                      worktreeName: pathBasename(path),
                    };
              }}
              onAttach={attachSession}
              onNewHere={createTerminal}
              onKill={killSession}
            />

            <WorktreeBand
              scope={scope}
              collapsed={bandCollapsed}
              onToggleCollapse={toggleBandCollapse}
              activeProject={activeProject}
              projectWorktrees={orderedVisibleWorktrees}
              bandProjects={orderedBandProjects}
              worktreeOrder={worktreeOrder}
              activePath={activePath}
              sensors={sensors}
              onDragEnd={onRailDragEnd}
              shared={bandShared}
              onCreateWorktree={(project) => setCreateModalProject(project)}
            />
          </>
        )}
      </div>

      <RailFooter
        settingsHidden={settingsHidden}
        isDesktop={isDesktop}
        onNavigate={() => {
          if (!isDesktop) onClose();
        }}
      />

      {contextMenu && (
        <WorktreeContextMenu
          state={contextMenu}
          onAction={onContextMenuItem}
          onClose={() => setContextMenu(null)}
        />
      )}

      {deploymentModal && (
        <DeploymentActionModal
          mode={deploymentModal.mode}
          submitting={actionPending}
          onCancel={() => setDeploymentModal(null)}
          onConfirm={async (force) => {
            const wt = deploymentModal.worktree;
            setDeploymentModal(null);
            await submitUp(wt, force);
          }}
        />
      )}

      {removeModal && (
        <RemoveWorktreeModal
          path={removeModal.path}
          submitting={actionPending}
          onCancel={() => setRemoveModal(null)}
          onConfirm={async () => {
            const wt = removeModal;
            setRemoveModal(null);
            await submitRemove(wt, true);
          }}
        />
      )}

      {createModalProject && (
        <CreateWorktreeModal
          project={createModalProject}
          onCancel={() => setCreateModalProject(null)}
          onCreated={async (targetPath) => {
            setCreateModalProject(null);
            await refresh();
            // A freshly created worktree is worktree-centric: dock the panel
            // (desktop) or open full-screen (touch).
            openWorktree("worktree", targetPath);
          }}
        />
      )}

      {showAddProjectModal && (
        <AddProjectModal
          onCancel={() => setShowAddProjectModal(false)}
          onAdded={async () => {
            await refresh();
            setShowAddProjectModal(false);
          }}
        />
      )}

      {desktopResizable && (
        <SidebarResizeHandle
          width={width!}
          onWidthChange={onWidthChange!}
          onWidthCommit={onWidthCommit}
        />
      )}
    </aside>
  );
}

/**
 * Narrow right-edge separator that resizes the desktop rail. Pointer capture
 * keeps the drag stable when the cursor leaves the 1px hit area; text selection
 * is suppressed while dragging. Live width changes flow up to the shell (which
 * clamps); the shell persists on release. The left rail grows with rightward
 * pointer travel.
 */
function SidebarResizeHandle({
  width,
  onWidthChange,
  onWidthCommit,
}: {
  width: number;
  onWidthChange: (rawWidth: number) => void;
  onWidthCommit?: () => void;
}) {
  const startRef = useRef<{ x: number; width: number } | null>(null);
  const dragging = useRef(false);
  // Viewport-derived maximum for the accessible value range. Computed once on
  // render; the shell reclamps the real width on viewport change.
  const max = getSidebarMaxWidth(
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      startRef.current = { x: e.clientX, width };
      dragging.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      document.body.style.userSelect = "none";
    },
    [width],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current || !startRef.current) return;
      const delta = e.clientX - startRef.current.x;
      onWidthChange(startRef.current.width + delta);
    },
    [onWidthChange],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      dragging.current = false;
      startRef.current = null;
      document.body.style.userSelect = "";
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* not captured */
      }
      onWidthCommit?.();
    },
    [onWidthCommit],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={max}
      aria-valuenow={Math.round(width)}
      data-testid="sidebar-resize-handle"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="absolute right-0 top-0 z-20 h-full w-1 cursor-col-resize bg-transparent transition-colors hover:bg-[color:var(--hair-2)]"
      style={{ touchAction: "none" }}
    />
  );
}

/* WorktreeContextMenu — the worktree actions menu, opened from a band row's `⋯`
 * overflow button and from a right-click on the row. Mirrors the demo's
 * `.wtrow__menu`: Open worktree · New session here · Rename · Add note ·
 * (state-aware lifecycle) · Remove. Reuses `runRowAction` for every item. */
function WorktreeContextMenu({
  state,
  onAction,
  onClose,
}: {
  state: ContextMenuState;
  onAction: (action: WorktreeAction, wt: WorktreeSummary) => void;
  onClose: () => void;
}) {
  const wt = state.worktree;
  const avail = actionAvailability(wt);
  const allSections: MenuItem[][] = [
    [
      { action: "open", label: "Open worktree", icon: ArrowUpRight, enabled: true },
      {
        action: "newterminal",
        label: "New session here",
        icon: Plus,
        enabled: true,
      },
    ],
    [
      { action: "rename", label: "Rename…", icon: Pencil, enabled: avail.rename },
      {
        action: "note",
        label: wt.note ? "Edit note…" : "Add note…",
        icon: StickyNote,
        enabled: avail.note,
      },
    ],
    menuLifecycle(wt, avail).map((item) => ({ ...item, enabled: true })),
    wt.isSource
      ? []
      : [
          {
            action: "remove",
            label: "Remove worktree",
            icon: Trash2,
            enabled: avail.remove,
            destructive: true,
          },
        ],
  ];
  const sections = allSections.filter((s) => s.length > 0);

  return (
    <div
      role="menu"
      data-testid="worktree-context-menu"
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.stopPropagation()}
      style={{ top: state.y, left: state.x }}
      className="fixed z-50 min-w-[200px] overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-lg"
    >
      <div className="px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
        {worktreeLabel(wt)}
      </div>
      {sections.map((section, sIdx) => (
        <div
          key={sIdx}
          className={sIdx > 0 ? "mt-1 border-t border-border/60 pt-1" : undefined}
        >
          {section.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.action + item.label}
                type="button"
                role="menuitem"
                disabled={!item.enabled}
                data-testid={`worktree-context-${item.action}`}
                onClick={() => onAction(item.action, wt)}
                className={cn(
                  "group flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] transition-colors",
                  item.enabled
                    ? item.destructive
                      ? "text-[color:var(--bad)] hover:bg-[color:var(--bad-soft)]"
                      : "hover:bg-accent hover:text-accent-foreground"
                    : "text-muted-foreground/40",
                )}
              >
                <Icon
                  className={cn(
                    "h-3.5 w-3.5",
                    item.enabled && !item.destructive && "text-[color:var(--ink)]",
                  )}
                  strokeWidth={1.75}
                />
                <span className="flex-1">{item.label}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* ============================ Worktrees band ============================ */

interface BandRowSharedProps {
  touch: boolean;
  /** Worktree-centric open: docks the panel (desktop) or navigates full-screen. */
  onOpen: (path: string) => void;
  /** Quick `New session here` — create a terminal in this worktree and attach. */
  onNewSession: (wt: WorktreeSummary) => void;
  /** Open the actions menu (from `⋯` or right-click) at a clamped position. */
  onOpenMenu: (wt: WorktreeSummary, x: number, y: number) => void;
  renamingPath: string | null;
  renamePending: boolean;
  renameError: string | null;
  onRenameSubmit: (wt: WorktreeSummary, nextName: string) => void;
  onRenameCancel: () => void;
  notingPath: string | null;
  notePending: boolean;
  noteError: string | null;
  onNoteSubmit: (wt: WorktreeSummary, nextNote: string) => void;
  onNoteCancel: () => void;
}

/* WorktreeBand — the collapsible worktree inventory + management surface below
 * the session stream (canonical: demo/sidebar-worktree-band-v3.html). In
 * project scope it is a flat, drag-reorderable list; in Active-now scope it
 * groups every project's full inventory under per-project headers (worktree
 * order read-only there; project groups are drag-reorderable). */
function WorktreeBand({
  scope,
  collapsed,
  onToggleCollapse,
  activeProject,
  projectWorktrees,
  bandProjects,
  worktreeOrder,
  activePath,
  sensors,
  onDragEnd,
  shared,
  onCreateWorktree,
}: {
  scope: SidebarScope;
  collapsed: boolean;
  onToggleCollapse: () => void;
  activeProject: ProjectSummary | null;
  projectWorktrees: WorktreeSummary[];
  bandProjects: ProjectSummary[];
  worktreeOrder: ReadonlyArray<string>;
  activePath: string | null;
  sensors: ReturnType<typeof useSensors>;
  onDragEnd: (e: DragEndEvent) => void;
  shared: BandRowSharedProps;
  onCreateWorktree: (project: ProjectSummary) => void;
}) {
  const count =
    scope === "project"
      ? projectWorktrees.length
      : bandProjects.reduce((n, p) => n + p.worktrees.length, 0);

  return (
    <div className="mt-2.5 border-t border-[color:var(--hair)] pt-0.5">
      <BandHeader
        count={count}
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
        createAction={
          scope === "project" && activeProject
            ? {
                label: `New worktree in ${activeProject.displayName}`,
                disabled: activeProject.stale,
                onClick: () => onCreateWorktree(activeProject),
              }
            : undefined
        }
      />

      {!collapsed &&
        (scope === "project" ? (
          <DndContext
            sensors={sensors}
            collisionDetection={railCollisionDetection}
            onDragEnd={onDragEnd}
          >
            <SortableContext
              items={projectWorktrees.map((wt) => `worktree:${wt.path}`)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="flex flex-col">
                {projectWorktrees.map((wt) => (
                  <SortableWorktreeBandRow
                    key={wt.path}
                    {...shared}
                    worktree={wt}
                    isActive={activePath === wt.path}
                  />
                ))}
                {projectWorktrees.length === 0 && (
                  <li className="px-2 py-1 text-[12px] text-muted-foreground/55">
                    no worktrees
                  </li>
                )}
              </ul>
            </SortableContext>
          </DndContext>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={railCollisionDetection}
            onDragEnd={onDragEnd}
          >
            <SortableContext
              items={bandProjects.map((p) => `project:${p.id}`)}
              strategy={verticalListSortingStrategy}
            >
              {bandProjects.map((project) => (
                <BandProjectGroup
                  key={project.id}
                  project={project}
                  touch={shared.touch}
                  onCreateWorktree={() => onCreateWorktree(project)}
                >
                  <ul className="flex flex-col">
                    {applyWorktreeOrder(
                      sortWorktreesForSidebar(project.worktrees),
                      worktreeOrder,
                    ).map((wt) => (
                      <WorktreeBandRow
                        key={wt.path}
                        {...shared}
                        worktree={wt}
                        isActive={activePath === wt.path}
                      />
                    ))}
                  </ul>
                </BandProjectGroup>
              ))}
              {bandProjects.length === 0 && (
                <div className="px-2 py-1 text-[12px] text-muted-foreground/55">
                  no worktrees
                </div>
              )}
            </SortableContext>
          </DndContext>
        ))}
    </div>
  );
}

/* BandHeader — the band's collapsible section header: a chevron + label +
 * count toggle, with an optional `New worktree` action on the right. */
function BandHeader({
  count,
  collapsed,
  onToggleCollapse,
  createAction,
}: {
  count: number;
  collapsed: boolean;
  onToggleCollapse: () => void;
  createAction?: { label: string; disabled?: boolean; onClick: () => void };
}) {
  return (
    <div className="flex items-center gap-1.5 px-2 pb-1 pt-2">
      <button
        type="button"
        aria-expanded={!collapsed}
        data-testid="sidebar-band-toggle"
        onClick={onToggleCollapse}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <ChevronDown
          className={cn(
            "size-3 shrink-0 text-muted-foreground/55 transition-transform duration-150",
            collapsed && "-rotate-90",
          )}
          strokeWidth={1.75}
          aria-hidden
        />
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/55">
          Worktrees
        </span>
        {count > 0 && (
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground/45">
            {count}
          </span>
        )}
      </button>
      {createAction && (
        <button
          type="button"
          onClick={createAction.onClick}
          disabled={createAction.disabled}
          title={createAction.label}
          aria-label={createAction.label}
          data-testid="sidebar-create-worktree"
          className="grid size-[22px] place-items-center rounded-md text-muted-foreground/55 transition-colors hover:bg-[color:var(--surface)] hover:text-[color:var(--ink)] hover:shadow-[inset_0_0_0_1px_var(--hair-2)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:shadow-none"
        >
          <GitBranchPlus className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
}

/* BandProjectGroup — one project's slice of the Active-now band: a quiet,
 * drag-reorderable folder header (folder icon + name + worktree count + a
 * per-project `New worktree`) followed by that project's full inventory. */
function BandProjectGroup({
  project,
  touch,
  onCreateWorktree,
  children,
}: {
  project: ProjectSummary;
  touch: boolean;
  onCreateWorktree: () => void;
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
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid="sidebar-band-group"
      data-project-id={project.id}
      className={cn(
        "mb-px border-t border-[color:var(--hair)] pt-1 first-of-type:border-t-0 first-of-type:pt-0",
        isDragging && "opacity-60",
      )}
    >
      <div className="group/phead relative flex items-center">
        <span
          {...attributes}
          {...listeners}
          data-testid="sidebar-project-grip"
          aria-label="Reorder project"
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "flex cursor-grab touch-none items-center justify-center text-[color:var(--muted-foreground)] active:cursor-grabbing",
            touch
              ? "h-10 w-4 shrink-0"
              : "absolute inset-y-0 left-0 z-10 w-3.5 -translate-x-[8px] opacity-0 group-hover/phead:opacity-100",
          )}
        >
          <GripVertical
            className={touch ? "size-[15px]" : "size-3.5"}
            strokeWidth={1.75}
            aria-hidden
          />
        </span>
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 px-2",
            touch ? "h-10" : "h-[29px]",
          )}
        >
          <FolderGit2
            className={cn(
              "shrink-0 text-[color:var(--muted-foreground)]",
              touch ? "size-[15px]" : "size-[13px]",
            )}
            strokeWidth={1.75}
            aria-hidden
          />
          <span
            className={cn(
              "min-w-0 flex-1 truncate font-semibold text-[color:var(--ink-2)]",
              touch ? "text-[13.5px]" : "text-[11.5px]",
            )}
          >
            {project.displayName}
          </span>
          <span
            className={cn(
              "shrink-0 font-mono tabular-nums text-muted-foreground/45",
              touch ? "text-[12px]" : "text-[10.5px]",
            )}
          >
            {project.worktrees.length}
          </span>
          <button
            type="button"
            onClick={onCreateWorktree}
            disabled={project.stale}
            title={`New worktree in ${project.displayName}`}
            aria-label={`New worktree in ${project.displayName}`}
            data-testid="sidebar-create-worktree"
            className="grid size-[22px] shrink-0 place-items-center rounded-md text-muted-foreground/55 transition-colors hover:bg-[color:var(--surface)] hover:text-[color:var(--ink)] hover:shadow-[inset_0_0_0_1px_var(--hair-2)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:shadow-none"
          >
            <GitBranchPlus className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </div>
      </div>
      {children}
    </div>
  );
}

interface WorktreeBandRowProps extends BandRowSharedProps {
  worktree: WorktreeSummary;
  isActive: boolean;
  /** Sortable wiring (project scope only). Omit for a non-draggable row. */
  rootRef?: Ref<HTMLLIElement>;
  style?: CSSProperties;
  dragHandleProps?: Record<string, unknown>;
  isDragging?: boolean;
}

/* WorktreeBandRow — one flat worktree row in the band: status dot + Geist-Mono
 * name + `root` badge, with a `⋯` overflow opening the worktree actions menu.
 * The whole row is the open target. No expansion — sessions live in the stream
 * above, runtime in the worktree dossier. Mirrors `.wtrow` in
 * demo/sidebar-worktree-band-v3.html. */
function WorktreeBandRow({
  worktree: wt,
  isActive,
  touch,
  onOpen,
  onNewSession,
  onOpenMenu,
  renamingPath,
  renamePending,
  renameError,
  onRenameSubmit,
  onRenameCancel,
  notingPath,
  notePending,
  noteError,
  onNoteSubmit,
  onNoteCancel,
  rootRef,
  style,
  dragHandleProps,
  isDragging = false,
}: WorktreeBandRowProps) {
  if (notingPath === wt.path) {
    return (
      <WorktreeNoteRow
        wt={wt}
        pending={notePending}
        error={noteError}
        onSubmit={(note) => onNoteSubmit(wt, note)}
        onCancel={onNoteCancel}
      />
    );
  }
  if (renamingPath === wt.path) {
    return (
      <WorktreeRenameRow
        wt={wt}
        pending={renamePending}
        error={renameError}
        onSubmit={(name) => onRenameSubmit(wt, name)}
        onCancel={onRenameCancel}
      />
    );
  }

  const removing = isRemovingWorktree(wt);

  const row = (
    <div
      data-testid="sidebar-worktree-row"
      data-worktree-path={wt.path}
      data-removing={removing ? "true" : "false"}
      data-source={wt.isSource ? "true" : undefined}
      data-active={isActive ? "true" : undefined}
      onClick={() => onOpen(wt.path)}
      onContextMenu={(e) => {
        e.preventDefault();
        onOpenMenu(wt, e.clientX, e.clientY);
      }}
      className={cn(
        "group/row relative grid cursor-pointer items-center gap-2.5 rounded-[9px]",
        "grid-cols-[7px_1fr_auto]",
        touch ? "h-12 pl-2 pr-1.5" : "h-[34px] pl-2 pr-1",
        isActive ? "bg-sidebar-active" : "hover:bg-sidebar-hover",
        removing && "opacity-45",
      )}
    >
      {dragHandleProps && (
        <span
          {...dragHandleProps}
          data-testid="sidebar-worktree-grip"
          aria-label="Reorder worktree"
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "flex cursor-grab touch-none items-center justify-center text-[color:var(--muted-foreground)] active:cursor-grabbing",
            touch
              ? "w-4 shrink-0"
              : "absolute inset-y-0 left-0 z-10 w-3 -translate-x-[10px] opacity-0 group-hover/row:opacity-100",
          )}
        >
          <GripVertical
            className={touch ? "size-[15px]" : "size-3.5"}
            strokeWidth={1.75}
            aria-hidden
          />
        </span>
      )}

      <StatusDot
        variant={statusDotVariant(wt.status)}
        size={touch ? 9 : 7}
      />

      <button
        type="button"
        data-testid="sidebar-worktree-open"
        onClick={(e) => {
          e.stopPropagation();
          onOpen(wt.path);
        }}
        title={wt.isSource ? `Root worktree — ${wt.path}` : wt.path}
        className="flex min-w-0 cursor-pointer items-center gap-2 text-left focus-ring"
      >
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-mono",
            touch ? "text-[14px]" : "text-[12.5px]",
            isActive
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
        {/* Quick `New session here` — revealed on hover (desktop), always shown
            on touch. The full action set stays in the `⋯` menu. */}
        <button
          type="button"
          title="New session here"
          aria-label="New session here"
          data-testid="sidebar-worktree-new-session"
          onClick={(e) => {
            e.stopPropagation();
            onNewSession(wt);
          }}
          className={cn(
            "cursor-pointer place-items-center rounded-md text-[color:var(--muted-foreground)] transition-colors",
            "hover:bg-[color:var(--surface)] hover:text-[color:var(--ink)] hover:shadow-[inset_0_0_0_1px_var(--hair-2)]",
            touch
              ? "grid size-9 [&_svg]:size-[18px]"
              : "grid size-6 opacity-0 group-hover/row:opacity-100 [&_svg]:size-[15px]",
          )}
        >
          <Plus strokeWidth={1.75} />
        </button>

        <button
          type="button"
          title="Worktree actions"
          aria-label="Worktree actions"
          data-testid="sidebar-worktree-more"
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            onOpenMenu(wt, r.right - 4, r.bottom + 4);
          }}
          className={cn(
            "cursor-pointer place-items-center rounded-md text-[color:var(--muted-foreground)] transition-colors",
            "hover:bg-[color:var(--surface)] hover:text-[color:var(--ink)] hover:shadow-[inset_0_0_0_1px_var(--hair-2)]",
            touch
              ? "grid size-9 [&_svg]:size-[19px]"
              : "grid size-6 opacity-0 group-hover/row:opacity-100 [&_svg]:size-[15px]",
          )}
        >
          <MoreHorizontal strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );

  const rowWithNote = wt.note ? (
    <Tooltip>
      <TooltipTrigger asChild>{row}</TooltipTrigger>
      <TooltipContent side="right" className="max-w-[260px] whitespace-pre-wrap">
        {wt.note}
      </TooltipContent>
    </Tooltip>
  ) : (
    row
  );

  return (
    <li
      ref={rootRef}
      style={style}
      data-testid="sidebar-worktree-node"
      className={cn("mb-px", isDragging && "opacity-60")}
    >
      {rowWithNote}
    </li>
  );
}

/* Project-scope wrapper that makes a `WorktreeBandRow` draggable over
 * `worktree:<path>` items. Active-now renders the plain row (worktree order is
 * honored read-only there). */
function SortableWorktreeBandRow(props: WorktreeBandRowProps) {
  const {
    setNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: `worktree:${props.worktree.path}` });
  return (
    <WorktreeBandRow
      {...props}
      rootRef={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      dragHandleProps={{ ...attributes, ...listeners }}
      isDragging={isDragging}
    />
  );
}

/* ============================ Editing rows ============================ */

function WorktreeRenameRow({
  wt,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  wt: WorktreeSummary;
  pending: boolean;
  error: string | null;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const initial = wt.displayName ?? worktreeLabel(wt);
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <li>
      <div
        data-testid="sidebar-worktree-rename"
        data-worktree-path={wt.path}
        className="flex flex-col gap-1 rounded-lg px-2 py-[6px]"
      >
        <div className="flex items-center gap-2.5">
          <span className="inline-flex w-4 shrink-0 items-center justify-center">
            <GitBranch
              className="size-[15px] text-[color:var(--muted-foreground)]"
              strokeWidth={1.75}
            />
          </span>
          <input
            ref={inputRef}
            type="text"
            value={value}
            disabled={pending}
            data-testid="sidebar-worktree-rename-input"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onSubmit(value);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onCancel();
              }
            }}
            className="min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 py-0.5 text-[13px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        {error && (
          <div
            data-testid="sidebar-worktree-rename-error"
            className="pl-[26px] text-[11px] text-[color:var(--bad)]"
          >
            {error}
          </div>
        )}
      </div>
    </li>
  );
}

function WorktreeNoteRow({
  wt,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  wt: WorktreeSummary;
  pending: boolean;
  error: string | null;
  onSubmit: (note: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(wt.note ?? "");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <li>
      <div
        data-testid="sidebar-worktree-note"
        data-worktree-path={wt.path}
        className="flex flex-col gap-1 rounded-lg px-2 py-[6px]"
      >
        <div className="flex items-start gap-2.5">
          <span className="mt-1 inline-flex w-4 shrink-0 items-center justify-center">
            <GitBranch
              className="size-[15px] text-[color:var(--muted-foreground)]"
              strokeWidth={1.75}
            />
          </span>
          <textarea
            ref={inputRef}
            rows={2}
            value={value}
            disabled={pending}
            placeholder="Add a note…"
            data-testid="sidebar-worktree-note-input"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSubmit(value);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onCancel();
              }
            }}
            className="min-w-0 flex-1 resize-none rounded-sm border border-border bg-background px-1.5 py-0.5 text-[13px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        {error && (
          <div
            data-testid="sidebar-worktree-note-error"
            className="pl-[26px] text-[11px] text-[color:var(--bad)]"
          >
            {error}
          </div>
        )}
      </div>
    </li>
  );
}

function SidebarEmpty({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="px-2 py-6 text-center">
      <p className="text-[12px] text-muted-foreground/55">No projects yet</p>
      <button
        type="button"
        onClick={onAdd}
        className="mt-2 text-[12px] text-foreground/70 underline-offset-2 hover:underline"
      >
        Add a worktree path
      </button>
    </div>
  );
}

/* SessionsStream — the rail's live-session body: sessions grouped by attention
 * (Needs you / Unread / Working / Idle), each group rendered with a header + a
 * flat list of StreamSessionRows. The active filter collapses the stream to one
 * group (All shows every non-empty group). Presentation only. */
function SessionsStream({
  attention,
  filter,
  scopeLabel,
  touch,
  activeSessionId,
  resolve,
  onAttach,
  onNewHere,
  onKill,
}: {
  attention: AttentionResult;
  filter: StreamFilter;
  scopeLabel?: string;
  touch: boolean;
  activeSessionId: string | null;
  resolve: (path: string) => {
    tile: ProjectTileIdentity;
    worktreeName: string;
  };
  onAttach: (worktreePath: string, sessionId?: string) => void;
  onNewHere: (worktreePath: string) => void;
  onKill: (id: string) => void;
}) {
  if (attention.counts.total === 0) {
    return (
      <div
        data-testid="rail-stream-empty"
        className="px-2 py-6 text-center text-[12.5px] text-muted-foreground/70"
      >
        No live sessions{scopeLabel ? ` in ${scopeLabel}` : ""}
      </div>
    );
  }

  const groups = STREAM_GROUPS.filter(({ key }) => {
    if (attention.groups[key].length === 0) return false;
    if (filter !== "all" && filter !== key) return false;
    return true;
  });

  if (groups.length === 0) {
    return (
      <div className="px-2 py-6 text-center text-[12px] text-muted-foreground/55">
        Nothing here
      </div>
    );
  }

  return (
    <div data-testid="rail-stream">
      {groups.map(({ key, label }) => {
        const list = attention.groups[key];
        return (
          <div key={key}>
            <AttentionGroupHeader
              variant={key}
              label={label}
              count={list.length}
            />
            {list.map((session) => {
              const { tile, worktreeName } = resolve(session.worktreePath);
              return (
                <StreamSessionRow
                  key={session.id}
                  session={session}
                  tile={tile}
                  worktreeName={worktreeName}
                  active={session.id === activeSessionId}
                  touch={touch}
                  onAttach={() => onAttach(session.worktreePath, session.id)}
                  onNewHere={() => onNewHere(session.worktreePath)}
                  onKill={() => onKill(session.id)}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function SidebarSkeleton() {
  return (
    <div className="space-y-2 px-1 py-2">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="sidebar-skel h-7 rounded-md bg-sidebar-accent/80"
          style={{ animationDelay: `${i * 80}ms` }}
        />
      ))}
    </div>
  );
}

/* ============================ Profile footer ============================ */

/* RailFooter — the v3 profile footer that grounds the rail (canonical:
 * demo/sidebar-worktree-band-v3.html). Carries the identity marker and the
 * relocated navigation: Home (always), the theme control, and Settings (hidden
 * for public sessions). */
function RailFooter({
  settingsHidden,
  isDesktop,
  onNavigate,
}: {
  settingsHidden: boolean;
  isDesktop: boolean;
  onNavigate: () => void;
}) {
  const location = useLocation();
  const onClick = () => {
    if (!isDesktop) onNavigate();
  };
  return (
    <div className="flex shrink-0 items-center gap-2.5 border-t border-[color:var(--hair)] px-3 py-2.5">
      <span
        aria-hidden
        className="grid size-7 flex-none place-items-center rounded-full text-[12px] font-semibold text-white"
        style={{
          background:
            "linear-gradient(135deg, var(--accent), color-mix(in oklch, var(--accent) 60%, white))",
        }}
      >
        W
      </span>
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-[13px] font-medium text-[color:var(--ink)]">
          WorktreeOS
        </span>
        <span className="truncate text-[11.5px] text-[color:var(--muted-foreground)]">
          Local
        </span>
      </div>
      <div className="ml-auto flex items-center gap-0.5">
        <FooterIconLink
          to="/"
          icon={LayoutGrid}
          label="Home"
          testId="sidebar-projects"
          active={location.pathname === "/"}
          onClick={onClick}
        />
        <ThemePopover />
        {!settingsHidden && (
          <FooterIconLink
            to="/settings"
            icon={Settings}
            label="Settings"
            testId="sidebar-settings"
            active={location.pathname === "/settings"}
            onClick={onClick}
          />
        )}
      </div>
    </div>
  );
}

function FooterIconLink({
  to,
  icon: Icon,
  label,
  testId,
  active,
  onClick,
}: {
  to: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  testId?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Link
      to={to}
      aria-label={label}
      title={label}
      data-testid={testId}
      onClick={onClick}
      className={cn(
        "grid size-[26px] place-items-center rounded-md text-muted-foreground/60 transition-colors hover:bg-sidebar-hover hover:text-foreground focus-ring",
        active && "bg-sidebar-active text-[color:var(--ink)]",
      )}
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
    </Link>
  );
}

type ThemeOption = {
  value: ThemeMode;
  label: string;
  icon: typeof Sun;
};

const THEME_OPTIONS: readonly ThemeOption[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

const DEFAULT_THEME_OPTION: ThemeOption = {
  value: "system",
  label: "System",
  icon: Monitor,
};

function ThemePopover() {
  const { mode, setMode } = useTheme();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const current =
    THEME_OPTIONS.find((opt) => opt.value === mode) ?? DEFAULT_THEME_OPTION;
  const TriggerIcon = current.icon;

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
    <div ref={wrapperRef} className="relative flex">
      <button
        type="button"
        aria-label="Theme"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Theme: ${current.label}`}
        data-testid="sidebar-theme-toggle"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "grid h-[26px] w-[26px] cursor-pointer place-items-center rounded-md text-muted-foreground/60 transition-colors hover:bg-sidebar-hover hover:text-foreground focus-ring",
          open && "bg-sidebar-hover text-foreground",
        )}
      >
        <TriggerIcon className="h-3.5 w-3.5" strokeWidth={1.75} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Theme"
          className="absolute bottom-full right-0 z-50 mb-2 min-w-[140px] overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-lg"
        >
          {THEME_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const selected = opt.value === mode;
            return (
              <button
                key={opt.value}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                data-testid={`sidebar-theme-option-${opt.value}`}
                onClick={() => {
                  setMode(opt.value);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] transition-colors",
                  selected
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground/80 hover:bg-accent hover:text-accent-foreground",
                )}
              >
                <Icon
                  className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70"
                  strokeWidth={1.75}
                />
                <span className="flex-1">{opt.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
