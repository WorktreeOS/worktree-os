import {
  useEffect,
  useState,
  useCallback,
  useRef,
  useMemo,
  type ReactNode,
} from "react";
import { Link, useLocation, useNavigate, useOutletContext } from "react-router";
import type { SidebarOutletContext } from "@/routes/layout";
import { ModalShell } from "@/components/ui/modal-shell";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import {
  AlertCircle,
  ArrowLeft,
  Boxes,
  CheckCircle2,
  ChevronsUpDown,
  Copy,
  ExternalLink,
  FolderOpen,
  GitPullRequestArrow,
  House,
  Loader2,
  Maximize2,
  Menu,
  MoreHorizontal,
  PenLine,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  ScrollText,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import { WorktreeTerminalSection } from "@/components/worktree-terminal";
import { RenameTerminalModal } from "@/components/terminal/rename-terminal-modal";
import { FileExplorerPanel } from "@/components/file-explorer-panel";
import {
  ReviewPanelBody,
  useReviewState,
} from "@/components/review-sidebar";
import { SidebarToggle } from "@/components/ui/sidebar-toggle";
import {
  initialSurfaceState,
  initialWorktreeTab,
  normalizeLogsChannelForServices,
  normalizeTabForWorktreeSwitch,
  persistWorktreeTab,
  selectTab,
  selectTerminalSession,
  setLogsChannel,
  type WorktreeSurfaceState,
  type WorktreeTab,
} from "@/lib/worktree-tabs";
import { useUiApi } from "@/lib/api-context";
import { useProjects } from "@/lib/projects-context";
import {
  useTerminalCount,
  useTerminalSessions,
} from "@/lib/terminal-sessions-context";
import { terminalAgent, terminalLabel } from "@/lib/terminal-agents";
import type { TerminalSessionMetadata } from "@/lib/terminal-protocol";
import { StatusDot, statusDotVariant } from "@/components/ui/status-dot";
import { useUnifiedEvents } from "@/lib/events-context";
import {
  UiApiError,
  UiSessionBusyError,
  UiWorktreeConfigError,
  UiWorktreeDirtyError,
  type DeploymentStatus,
  type GeneratedDeploymentOptions,
  type LogChannel,
  type OperationMetadata,
  type ReviewDiffResponse,
  type WorktreeDetailResponse,
  type WorktreeUpResponse,
} from "@/lib/ui-api";
import type { DeploymentStepId, StepState } from "@/lib/unified-events";
import {
  applyStepEvent,
  deriveActiveOp,
  hasRunningOp,
  selectStepProgress,
  selectWorktreeSurface,
  type HealthcheckAttemptProgress,
  type InitStepStatus,
  type StepRecord,
  type WorktreeSurface,
} from "@/lib/worktree-view-model";
import {
  buildDeploymentSelection,
  type DeploymentActionSelection,
} from "@/lib/deployment-selection";
export { type DeploymentActionSelection };
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { IconButton } from "@/components/ui/icon-button";
import { Ic } from "@/components/ui/inline-code";
import { toast } from "@/components/ui/sonner";
import { cn, formatRelativeTime } from "@/lib/utils";
import {
  WorktreeOverview,
  representativeExposed,
  summarizeReview,
  type ReviewSummary,
} from "@/routes/worktree/worktree-overview";
import { RuntimePanelBody } from "@/routes/worktree/runtime-panel";

type ActionPending = null | "up" | "down" | "service" | "remove";

const DETAIL_REFETCH_TYPES = new Set([
  "operation.started",
  "operation.finished",
  "operation.failed",
  "worktree.deployment-status.changed",
  "compose.status.changed",
  "service.started",
  "service.stopped",
  "service.crashed",
  "service.state.changed",
  "service.discovered",
  "service.removed",
  "healthcheck.changed",
  "tunnel.opened",
  "tunnel.failed",
  "tunnel.closed",
  "tunnel.reset",
  "tunnel.dropped",
  "deployment.completed",
  "deployment.failed",
]);

export interface WorktreeViewProps {
  /** Worktree path to render (from the URL on the page host, from the ephemeral
   * panel selection on the panel host). */
  path: string;
  /** Which host renders the view: the full-screen route or the docked panel. */
  host: "page" | "panel";
  /** Panel host: ✕ control + post-remove close. Page host: undefined. */
  onClose?: () => void;
  /** Panel host: ⤢ control → promote to the full-screen route + clear panel. */
  onExpand?: () => void;
  /** One-shot terminal-session focus (page host: the `terminal` URL param). */
  requestedTerminal?: string | null;
  /** One-shot tab handoff (page host: legacy `panel` URL param; panel host:
   * the initial tab, e.g. `runtime`). */
  requestedPanel?: string | null;
  /** Clear the one-shot terminal request once it has been applied. */
  onConsumeTerminal?: () => void;
  /** Clear the one-shot panel/tab request once it has been applied. */
  onConsumePanel?: () => void;
}

/**
 * Host-agnostic worktree detail view. Owns all behavioural state (4s detail
 * polling, unified-events subscription, deployment progress, review state) and
 * renders the worktree tabs/surfaces/modals. Rendered both by the full-screen
 * `/worktree` route (page host) and by the right-docked panel host; the two
 * differ only in their surrounding chrome and how one-shots / close / expand are
 * wired (see `WorktreeViewProps`).
 */
export function WorktreeView({
  path,
  host,
  onClose,
  onExpand,
  requestedTerminal = null,
  requestedPanel = null,
  onConsumeTerminal,
  onConsumePanel,
}: WorktreeViewProps) {
  const api = useUiApi();
  const navigate = useNavigate();
  const location = useLocation();
  // Quick-jump origin: when arrived from the Kanban board, offer a one-click
  // return (page host only — the panel docks beside the board already).
  const cameFromBoard =
    host === "page" &&
    (location.state as { from?: string } | null)?.from === "/board";
  // The panel host renders outside the router `<Outlet>`, so the rail callbacks
  // are absent there; degrade to no-ops (the panel needs none of them).
  const outletContext = useOutletContext<SidebarOutletContext | null>();
  const sidebarOpen = outletContext?.sidebarOpen ?? true;
  const toggleSidebar = outletContext?.toggleSidebar ?? (() => {});
  const openNavigator = outletContext?.openNavigator ?? (() => {});
  const { refresh: refreshProjects } = useProjects();
  const [detail, setDetail] = useState<WorktreeDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<ActionPending>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState(false);
  const [actionModal, setActionModal] = useState<
    null | { mode: "start" | "restart" }
  >(null);
  const [removeModal, setRemoveModal] = useState(false);
  const [initStep, setInitStep] = useState<InitStepStatus | null>(null);
  const [stepStates, setStepStates] = useState<
    ReadonlyMap<DeploymentStepId, StepRecord>
  >(() => new Map());
  const [healthcheckAttempts, setHealthcheckAttempts] = useState<
    ReadonlyMap<string, HealthcheckAttemptProgress>
  >(() => new Map());
  // The selected worktree tab is remembered globally (across reloads and
  // worktree switches); restore it — or migrate a legacy panel value — on
  // mount. The fallback destination is the overview dossier.
  const [surface, setSurface] = useState<WorktreeSurfaceState>(() =>
    initialSurfaceState(initialWorktreeTab()),
  );
  // `moreOpen` drives the desktop top-bar overflow menu; the mobile bottom-nav
  // sheets (Sessions / More) are a separate, single-at-a-time selector.
  const [moreOpen, setMoreOpen] = useState(false);
  const [mobileSheet, setMobileSheet] = useState<null | "sessions" | "more">(
    null,
  );
  const [renamingSession, setRenamingSession] =
    useState<TerminalSessionMetadata | null>(null);

  const { state: reviewState, refresh: refreshReview } = useReviewState(
    path || null,
  );

  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      const res = await api.getWorktreeDetail(path);
      setDetail(res);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [api, path]);

  useEffect(() => {
    reload();
    const id = setInterval(reload, 4000);
    return () => clearInterval(id);
  }, [reload]);

  // Switching worktrees resets deployment-progress state (it belongs to the
  // previous worktree operation) but keeps the selected tab so the active
  // surface survives the switch. Only the previous worktree's terminal session
  // focus is cleared here; logs-channel availability for the next worktree is
  // reconciled once its detail loads.
  useEffect(() => {
    setInitStep(null);
    setStepStates(new Map());
    setHealthcheckAttempts(new Map());
    setSurface((prev) => normalizeTabForWorktreeSwitch(prev));
  }, [path]);

  // Once detail loads for the (possibly new) worktree, drop a logs channel that
  // points at a service the next worktree does not have, falling back to init.
  useEffect(() => {
    if (!detail) return;
    const serviceNames = detail.services.map((s) => s.service);
    setSurface((prev) => normalizeLogsChannelForServices(prev, serviceNames));
  }, [detail]);

  useEffect(() => {
    if (!path) return;
    void refreshReview();
  }, [path, refreshReview]);

  // Persist the selected tab globally so the destination survives reloads and
  // worktree switches.
  useEffect(() => {
    persistWorktreeTab(surface.tab);
  }, [surface.tab]);

  const events = useUnifiedEvents();
  useEffect(() => {
    if (!detail) return;
    const session = detail.worktree.sessionName;
    const unsubscribe = events.subscribe((env) => {
      if (env.sessionName !== session) return;
      if (env.type === "deployment.step") {
        const step = env.event as {
          step: DeploymentStepId;
          state: StepState;
        };
        setStepStates((prev) =>
          applyStepEvent(prev, step.step, step.state, env.timestamp),
        );
        if (step.step === "first-run-setup" || step.step === "init-script") {
          if (
            step.state === "running" ||
            step.state === "done" ||
            step.state === "failed"
          ) {
            setInitStep({ kind: step.step, state: step.state });
          }
        }
        // Clear transient attempt progress once the readiness step settles.
        if (
          step.step === "healthcheck" &&
          (step.state === "done" || step.state === "failed")
        ) {
          setHealthcheckAttempts(new Map());
        }
      }
      if (env.type === "deployment.healthcheck-attempt") {
        const a = env.event as {
          service: string;
          attempt: number;
          maxAttempts: number;
          status?: number;
          error?: string;
          matched: boolean;
        };
        setHealthcheckAttempts((prev) => {
          const next = new Map(prev);
          next.set(a.service, {
            service: a.service,
            attempt: a.attempt,
            maxAttempts: a.maxAttempts,
            status: a.status,
            error: a.error,
            matched: a.matched,
          });
          return next;
        });
      }
      if (DETAIL_REFETCH_TYPES.has(env.type)) {
        void reload();
        void refreshReview();
      }
    });
    return unsubscribe;
  }, [events, reload, refreshReview, detail]);

  const translateActionError = useCallback((e: unknown): string => {
    if (e instanceof UiWorktreeConfigError) {
      return e.message;
    }
    if (e instanceof UiSessionBusyError) {
      return "Session is already busy with another operation.";
    }
    if (e instanceof UiApiError) {
      return e.message;
    }
    return (e as Error).message;
  }, []);

  const submitUp = useCallback(
    async (
      force: boolean,
      selection: {
        services?: string[];
        target?: string;
        arguments?: Record<string, string>;
      } = {},
    ) => {
      if (!detail) return;
      // Launching is a runtime operation — switch to the Runtime tab so its
      // deployment progress is the active full-width surface.
      setSurface((prev) => selectTab(prev, "runtime"));
      setActionPending("up");
      setActionError(null);
      try {
        setInitStep(null);
        setStepStates(new Map());
        setHealthcheckAttempts(new Map());
        const upResponse: WorktreeUpResponse = await api.submitUp(
          detail.worktree.path,
          force,
          selection,
        );
        const optimisticOp: OperationMetadata = {
          operationId: upResponse.operationId,
          sessionName: upResponse.sessionName,
          kind: "up",
          status: "running",
          startedAt: upResponse.startedAt,
        };
        setDetail((prev) =>
          prev
            ? {
                ...prev,
                worktree: {
                  ...prev.worktree,
                  status: "pending",
                  activeOperation: optimisticOp,
                },
                activeOperation: optimisticOp,
              }
            : prev,
        );
        await Promise.all([reload(), refreshProjects()]);
      } catch (e) {
        setActionError(translateActionError(e));
        if (e instanceof UiWorktreeConfigError) {
          // Refresh detail so the config status section reflects the latest
          // file state after the gate rejected the request.
          void reload();
        }
      } finally {
        setActionPending(null);
      }
    },
    [api, detail, reload, refreshProjects, translateActionError],
  );

  const submitDown = useCallback(async () => {
    if (!detail) return;
    setActionPending("down");
    setActionError(null);
    // Optimistically move off the in-progress / failed surface: stopping from
    // any state aborts an in-flight deploy and tears it down, so reflect that
    // immediately instead of leaving the deploying screen up until the reload.
    setInitStep(null);
    setHealthcheckAttempts(new Map());
    setDetail((prev) =>
      prev
        ? {
            ...prev,
            worktree: {
              ...prev.worktree,
              status: "stopping",
              activeOperation: undefined,
            },
            activeOperation: undefined,
          }
        : prev,
    );
    try {
      await api.submitDown(detail.worktree.path);
      await Promise.all([reload(), refreshProjects()]);
    } catch (e) {
      setActionError(translateActionError(e));
    } finally {
      setActionPending(null);
    }
  }, [api, detail, reload, refreshProjects, translateActionError]);

  type RemoveOutcome = "succeeded" | "dirty" | "failed";

  const submitRemove = useCallback(
    async (discardChanges: boolean): Promise<RemoveOutcome> => {
      if (!detail) return "failed";
      const worktreeLabel =
        detail.worktree.branch ?? detail.worktree.path;
      setActionPending("remove");
      setActionError(null);
      try {
        await api.submitWorktreeRemove(detail.worktree.path, discardChanges);
        await refreshProjects();
        // Post-remove behaviour is host-driven: the page host navigates away,
        // the panel host closes the panel and leaves the hosting route intact.
        if (host === "panel") {
          onClose?.();
        } else {
          navigate("/", { replace: true });
        }
        toast.success("Worktree removed", {
          description: worktreeLabel,
        });
        return "succeeded";
      } catch (e) {
        if (e instanceof UiWorktreeDirtyError) {
          return "dirty";
        }
        const message = translateActionError(e);
        setActionError(message);
        toast.error("Failed to remove worktree", {
          description: message,
        });
        return "failed";
      } finally {
        setActionPending(null);
      }
    },
    [
      api,
      detail,
      host,
      onClose,
      navigate,
      refreshProjects,
      translateActionError,
    ],
  );

  const requestRemove = useCallback(async () => {
    const outcome = await submitRemove(false);
    if (outcome === "dirty") setRemoveModal(true);
  }, [submitRemove]);

  const submitServiceAction = useCallback(
    async (service: string, action: "stop" | "restart") => {
      if (!detail) return;
      setActionPending("service");
      setActionError(null);
      try {
        if (action === "stop") {
          await api.submitServiceStop(detail.worktree.path, service);
        } else {
          await api.submitServiceRestart(detail.worktree.path, service);
        }
        await reload();
      } catch (e) {
        setActionError(translateActionError(e));
      } finally {
        setActionPending(null);
      }
    },
    [api, detail, reload, translateActionError],
  );

  const copyPath = useCallback(async () => {
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      setCopiedPath(true);
      setTimeout(() => setCopiedPath(false), 1200);
    } catch {
      /* clipboard rejected */
    }
  }, [path]);

  const runtimeSurface: WorktreeSurface = useMemo(() => {
    if (!detail) return { kind: "overview" };
    return selectWorktreeSurface({ detail, initStep });
  }, [detail, initStep]);

  /* Select a worktree tab as the active full-width destination. Lazily loads
   * the review diff the first time Review is selected, so every entry point
   * (tab strip, overview buttons, mobile sheet, query params) shares one path. */
  const selectWorktreeTab = useCallback(
    (tab: WorktreeTab) => {
      setSurface((prev) => selectTab(prev, tab));
      if (tab === "review" && !reviewState.loaded && !reviewState.loading) {
        void refreshReview();
      }
    },
    [refreshReview, reviewState.loaded, reviewState.loading],
  );

  // Overview handoff to the Terminal tab: focus a specific session when given,
  // otherwise just select the tab.
  const openTerminalTab = useCallback((sessionId?: string) => {
    setSurface((prev) =>
      sessionId
        ? selectTerminalSession(prev, sessionId)
        : selectTab(prev, "terminal"),
    );
  }, []);

  const ackTerminalSession = useCallback(() => {
    setSurface((prev) => selectTerminalSession(prev, null));
  }, []);

  // Attach to a session from the mobile Sessions sheet: focus it in the
  // Terminal tab and dismiss the sheet.
  const attachSessionFromSheet = useCallback(
    (sessionId: string) => {
      openTerminalTab(sessionId);
      setMobileSheet(null);
    },
    [openTerminalTab],
  );

  // `New terminal` from the mobile Sessions sheet: spin up a fresh session and
  // open it focused.
  const createTerminalSession = useCallback(async () => {
    if (!detail) return;
    try {
      const { session } = await api.createTerminalLayerSession({
        worktreePath: detail.worktree.path,
      });
      openTerminalTab(session.id);
      setMobileSheet(null);
    } catch (e) {
      toast.error("Failed to create terminal", {
        description: translateActionError(e),
      });
    }
  }, [api, detail, openTerminalTab, translateActionError]);

  // Honor a one-shot terminal focus request (page host: the rail's `terminal`
  // URL param): select the Terminal tab focused on that session, then ask the
  // host to clear the request so it does not re-fire. Runs after the
  // worktree-switch reset effect, so this focus wins when navigating worktrees.
  useEffect(() => {
    if (!requestedTerminal) return;
    openTerminalTab(requestedTerminal);
    onConsumeTerminal?.();
  }, [requestedTerminal, openTerminalTab, onConsumeTerminal]);

  // Honor a one-shot tab request (page host: the legacy `panel` URL param /
  // Runtime handoff; panel host: the initial tab). Select the matching
  // full-width tab, then ask the host to clear the request so it does not
  // re-fire. Legacy `panel=logs` maps to Runtime with the init log channel.
  // Runs after the worktree-switch reset effect.
  useEffect(() => {
    if (!requestedPanel) return;
    if (requestedPanel === "logs") {
      setSurface((prev) => setLogsChannel(prev, "init"));
    } else {
      const tab = (
        ["overview", "runtime", "review", "files", "terminal"] as const
      ).find((t) => t === requestedPanel);
      if (tab) selectWorktreeTab(tab);
    }
    onConsumePanel?.();
  }, [requestedPanel, selectWorktreeTab, onConsumePanel]);

  const onSelectLogsChannel = useCallback((channel: LogChannel) => {
    setSurface((prev) => setLogsChannel(prev, channel));
  }, []);

  const terminalCount = useTerminalCount(detail?.worktree.path ?? "");
  const reviewDirty =
    !!reviewState.data && reviewState.data.totalChangedFiles > 0;

  if (!path) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Worktree not specified
      </div>
    );
  }
  if (loading && !detail) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="font-mono text-xs uppercase tracking-[0.2em]">
          loading…
        </span>
      </div>
    );
  }
  if (error && !detail) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-[color:var(--signal-error)]">
        <AlertCircle className="h-6 w-6" />
        <div className="text-sm font-semibold">Failed to load worktree</div>
        <div className="max-w-md font-mono text-xs text-muted-foreground">
          {error}
        </div>
        <Button variant="outline" size="sm" onClick={reload}>
          Retry
        </Button>
      </div>
    );
  }
  if (!detail) return null;

  const status = detail.worktree.status;
  const isNotStarted = status === "not_started";
  const activeOp = deriveActiveOp(detail);
  const isAnyOpRunning = hasRunningOp(status, activeOp);
  const isRemoving =
    activeOp?.kind === "worktree-remove" && activeOp.status === "running";
  const hasInitializedState =
    detail.state?.initialized === true || status !== "not_started";
  const titleLabel =
    detail.worktree.branch ??
    (detail.worktree.detached && detail.worktree.head
      ? `detached @ ${detail.worktree.head.slice(0, 7)}`
      : detail.worktree.path.split("/").pop() || detail.worktree.path);

  const canRestart = !isNotStarted && hasInitializedState && !isAnyOpRunning &&
    actionPending === null;
  const canStop = !isNotStarted && hasInitializedState && !isAnyOpRunning &&
    actionPending === null;
  const canStart = isNotStarted && !isAnyOpRunning && actionPending === null;

  const activeTab = surface.tab;
  // Mobile More sheet routes through the same tab-selection path as the rest of
  // the worktree page; the bottom bar's Overview tab handles "go back".
  const onMobileSelectTab = selectWorktreeTab;

  return (
    <div className="relative flex h-full min-h-0 flex-col pt-[env(safe-area-inset-top)] lg:pt-0">
      <MobileAppBar
        projectName={detail.projectName}
        titleLabel={titleLabel}
        status={status}
        onOpenNavigator={openNavigator}
      />

      <WorktreeTabStrip
        detail={detail}
        density={host === "panel" ? "compact" : "full"}
        onClosePanel={onClose}
        onExpandPanel={onExpand}
        titleLabel={titleLabel}
        isRemoving={isRemoving}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={toggleSidebar}
        activeTab={activeTab}
        status={status}
        reviewData={reviewState.data}
        terminalCount={terminalCount}
        onSelectTab={selectWorktreeTab}
        moreOpen={moreOpen}
        onMoreToggle={() => setMoreOpen((v) => !v)}
        onCloseMore={() => setMoreOpen(false)}
        onCopyPath={copyPath}
        copiedPath={copiedPath}
        onReload={reload}
        reloading={loading}
        onRemove={requestRemove}
        canRemove={!detail.worktree.isSource && !isAnyOpRunning &&
          actionPending === null}
      />

      {cameFromBoard && (
        <Link
          to="/board"
          data-testid="back-to-board"
          className="flex items-center gap-1.5 border-b border-[color:var(--hair)] px-4 py-1.5 text-[12px] text-[color:var(--ink-2)] transition-colors hover:text-[color:var(--ink)]"
        >
          <ArrowLeft className="size-3.5" strokeWidth={1.75} />
          Board
        </Link>
      )}

      {actionError && (
        <div className="border-b border-[color:color-mix(in_oklch,var(--signal-error)_40%,transparent)] bg-[color:var(--signal-error-soft)] px-4 py-2 text-xs text-[color:var(--signal-error)]">
          <span className="font-mono uppercase tracking-[0.18em]">error</span>
          <span className="mx-2 text-foreground/30">·</span>
          {actionError}
        </div>
      )}

      {/* The active worktree tab is the single full-width content surface. */}
      <main
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        data-testid="worktree-surface"
        data-tab={activeTab}
      >
        {activeTab === "overview" && (
          <WorktreeOverview
            detail={detail}
            reviewSummary={
              reviewState.data ? summarizeReview(reviewState.data) : null
            }
            terminalCount={terminalCount}
            onOpenRuntime={() => selectWorktreeTab("runtime")}
            onOpenReview={() => selectWorktreeTab("review")}
            onOpenFiles={() => selectWorktreeTab("files")}
            onOpenTerminal={openTerminalTab}
            onRenameSession={setRenamingSession}
            onNoteSaved={() => {
              void reload();
              void refreshProjects();
            }}
          />
        )}
        {activeTab === "runtime" && (
          <RuntimePanelBody
            detail={detail}
            surface={runtimeSurface}
            initStep={initStep}
            stepProgress={selectStepProgress(stepStates)}
            healthcheckAttempts={healthcheckAttempts}
            actionPending={actionPending}
            canStart={canStart}
            canRestart={canRestart}
            canStop={canStop}
            channel={surface.logsChannel}
            onStartSubmit={(force, selection) => submitUp(force, selection)}
            onRestart={() => setActionModal({ mode: "restart" })}
            onStop={submitDown}
            onServiceAction={submitServiceAction}
            onSelectChannel={onSelectLogsChannel}
          />
        )}
        {activeTab === "review" && (
          <ReviewPanelBody
            path={detail.worktree.path}
            worktree={detail.worktree}
            state={reviewState}
            refresh={refreshReview}
            onMutated={reload}
          />
        )}
        {activeTab === "files" && (
          <FileExplorerPanel worktreePath={detail.worktree.path} />
        )}
        {activeTab === "terminal" && (
          <div className="flex min-h-0 min-w-0 flex-1">
            <WorktreeTerminalSection
              worktreePath={detail.worktree.path}
              branchName={detail.worktree.branch}
              requestedSessionId={surface.terminalSessionId ?? undefined}
              onSessionFocused={ackTerminalSession}
            />
          </div>
        )}
      </main>

      {actionModal && (
        <DeploymentActionModal
          mode={actionModal.mode}
          submitting={actionPending === "up"}
          deploymentOptions={detail.deploymentOptions}
          onCancel={() => setActionModal(null)}
          onConfirm={async (force, selection) => {
            setActionModal(null);
            await submitUp(force, selection);
          }}
        />
      )}
      {removeModal && (
        <RemoveWorktreeModal
          path={detail.worktree.path}
          submitting={actionPending === "remove"}
          onCancel={() => setRemoveModal(false)}
          onConfirm={async () => {
            setRemoveModal(false);
            await submitRemove(true);
          }}
        />
      )}

      <MobileTabBar
        activeTab={activeTab}
        status={status}
        sessionsLive={terminalCount > 0}
        reviewDirty={reviewDirty}
        sessionsSheetOpen={mobileSheet === "sessions"}
        moreSheetOpen={mobileSheet === "more"}
        onOverview={() => selectWorktreeTab("overview")}
        onRuntime={() => onMobileSelectTab("runtime")}
        onOpenNavigator={openNavigator}
        onOpenSessions={() => setMobileSheet("sessions")}
        onOpenMore={() => setMobileSheet("more")}
      />

      {mobileSheet === "sessions" && (
        <MobileSessionsSheet
          worktreePath={detail.worktree.path}
          branchName={detail.worktree.branch}
          currentSessionId={surface.terminalSessionId ?? undefined}
          onAttach={attachSessionFromSheet}
          onNewTerminal={createTerminalSession}
          onRenameSession={setRenamingSession}
          onClose={() => setMobileSheet(null)}
        />
      )}

      {renamingSession && (
        <RenameTerminalModal
          session={renamingSession}
          fallbackLabel={detail?.worktree.branch ?? renamingSession.shell}
          onClose={() => setRenamingSession(null)}
        />
      )}

      {mobileSheet === "more" && (
        <MobileMoreSheet
          reviewSummary={
            reviewState.data ? summarizeReview(reviewState.data) : null
          }
          exposedUrl={representativeExposed(detail)?.url ?? null}
          onReview={() => {
            onMobileSelectTab("review");
            setMobileSheet(null);
          }}
          onFiles={() => {
            onMobileSelectTab("files");
            setMobileSheet(null);
          }}
          onLogs={() => {
            onMobileSelectTab("runtime");
            setMobileSheet(null);
          }}
          onClose={() => setMobileSheet(null)}
        />
      )}
    </div>
  );
}

/**
 * Quiet, text-only git posture for the worktree header: ahead/behind vs
 * upstream, uncommitted-changes count, and the last commit (short hash +
 * relative time). Renders only the segments backed by data and nothing at all
 * when none are present. v3 style: muted text, no chips.
 */
function GitStatusLine({ worktree }: { worktree: WorktreeDetailResponse["worktree"] }) {
  const segments: string[] = [];

  const ahead = worktree.aheadCount;
  const behind = worktree.behindCount;
  if (typeof ahead === "number" && typeof behind === "number" && (ahead > 0 || behind > 0)) {
    const parts: string[] = [];
    if (ahead > 0) parts.push(`↑${ahead}`);
    if (behind > 0) parts.push(`↓${behind}`);
    segments.push(parts.join(" "));
  }

  if (typeof worktree.uncommittedCount === "number" && worktree.uncommittedCount > 0) {
    segments.push(`${worktree.uncommittedCount} uncommitted`);
  }

  if (worktree.lastCommitHash) {
    const rel = formatRelativeTime(worktree.lastCommitTime);
    segments.push(rel ? `${worktree.lastCommitHash} · ${rel}` : worktree.lastCommitHash);
  }

  if (segments.length === 0) return null;

  return (
    <span
      className="hidden md:inline-flex items-center gap-1.5 truncate font-mono text-[11px] text-[color:var(--muted-foreground)]"
      title={worktree.lastCommitSubject}
      data-testid="git-status-line"
    >
      {segments.map((seg, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          {i > 0 ? <span className="text-[color:var(--muted-foreground)]/50">·</span> : null}
          {seg}
        </span>
      ))}
    </span>
  );
}

/* ====================================================================
 * Worktree header (lg+ only) — the single desktop header row. Carries quiet
 * identity on the left (project / branch + git posture), the worktree tabs
 * on the right, and the overflow menu at the far edge. Switches the single
 * full-width content surface between Overview, Runtime, Review, Files, and
 * Terminal. Review shows live `+N −N` totals; Runtime carries a local status
 * accent; Terminal shows the open-session count.
 *
 * Sits on the warm `--shell` band above the white document; the active tab is
 * a raised white chip that visually connects to the content it opens.
 * ==================================================================== */

/** Container-aware worktree chrome density. `full` is the page-host layout
 * (identity + git posture + labelled tabs); `compact` is the narrow panel-host
 * layout (no identity, icon-only tabs) and is driven by the host, not viewport
 * width, so it stays predictable and testable. */
export type WorktreeChromeDensity = "full" | "compact";

type WorktreeTabDef = {
  id: WorktreeTab;
  label: string;
  icon: ReactNode;
  testId: string;
};

const WORKTREE_TAB_DEFS: readonly WorktreeTabDef[] = [
  { id: "overview", label: "Overview", icon: <House />, testId: "worktree-tab-overview" },
  { id: "runtime", label: "Runtime", icon: <Boxes />, testId: "worktree-tab-runtime" },
  { id: "review", label: "Review", icon: <GitPullRequestArrow />, testId: "worktree-tab-review" },
  { id: "files", label: "Files", icon: <FolderOpen />, testId: "worktree-tab-files" },
  { id: "terminal", label: "Terminal", icon: <SquareTerminal />, testId: "worktree-tab-terminal" },
];

function WorktreeTabStrip({
  detail,
  density,
  onClosePanel,
  onExpandPanel,
  titleLabel,
  isRemoving,
  sidebarOpen,
  onToggleSidebar,
  activeTab,
  status,
  reviewData,
  terminalCount,
  onSelectTab,
  moreOpen,
  onMoreToggle,
  onCloseMore,
  onCopyPath,
  copiedPath,
  onReload,
  reloading,
  onRemove,
  canRemove,
}: {
  detail: WorktreeDetailResponse;
  /** Container-aware chrome: `full` for the page host, `compact` for the
   * narrow panel host (hides identity, collapses tab labels to icons). */
  density: WorktreeChromeDensity;
  /** Panel host controls, rendered inline in the compact header (never the page
   * host): ✕ closes the docked panel, ⤢ promotes it to the full-screen route. */
  onClosePanel?: () => void;
  onExpandPanel?: () => void;
  titleLabel: string;
  isRemoving: boolean;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  activeTab: WorktreeTab;
  status: DeploymentStatus;
  reviewData: ReviewDiffResponse | null;
  terminalCount: number;
  onSelectTab: (tab: WorktreeTab) => void;
  moreOpen: boolean;
  onMoreToggle: () => void;
  onCloseMore: () => void;
  onCopyPath: () => void;
  copiedPath: boolean;
  onReload: () => void;
  reloading: boolean;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const reviewDirty = !!reviewData && reviewData.totalChangedFiles > 0;
  const compact = density === "compact";
  return (
    <header
      data-testid="worktree-header"
      data-density={density}
      className={cn(
        "relative z-20 hidden h-12 shrink-0 select-none items-center gap-2 border-b border-[color:var(--hair-2)] bg-[color:var(--shell)] px-2 lg:flex",
        compact ? "lg:px-2" : "lg:px-3",
      )}
    >
      {!compact && (
        <SidebarToggle sidebarOpen={sidebarOpen} onToggle={onToggleSidebar} />
      )}

      {/* Identity: project / branch + quiet git posture, truncating first. The
       * branch title shows in both densities; compact (panel) drops the project
       * name, git posture, and removing badge to free width for the five tabs. */}
      <div className="flex min-w-0 flex-1 items-center gap-2 pl-1 leading-tight">
        {!compact && detail.projectName ? (
          <>
            <span
              className="hidden xl:inline truncate text-[13px] text-[color:var(--muted-foreground)]"
              title={detail.projectName}
            >
              {detail.projectName}
            </span>
            <span className="hidden xl:inline text-[color:var(--muted-foreground)]/50">
              /
            </span>
          </>
        ) : null}
        <span
          className="truncate font-mono text-[13.5px] font-medium text-[color:var(--ink)]"
          title={titleLabel}
        >
          {titleLabel}
        </span>
        {!compact && isRemoving && <RemovingBadge />}
        {!compact && <GitStatusLine worktree={detail.worktree} />}
      </div>

      {/* Hairline splitting identity from navigation — keeps the tab group from
       * reading as more breadcrumb (see demo/worktree-header-v4.html "After"). */}
      {!compact && (
        <span
          aria-hidden
          className="h-[22px] w-px shrink-0 self-center bg-[color:var(--hair-2)]"
        />
      )}

      <div
        role="tablist"
        aria-label="Worktree tabs"
        data-testid="worktree-tab-strip"
        className={cn(
          "flex shrink-0 items-center",
          compact ? "gap-1" : "gap-1.5",
        )}
      >
        {WORKTREE_TAB_DEFS.map((def) => (
          <WorktreeTabButton
            key={def.id}
            def={def}
            active={activeTab === def.id}
            compact={compact}
            accent={def.id === "runtime" ? runtimeTabAccent(status) : null}
            trailing={
              def.id === "review" && reviewDirty ? (
                <span
                  data-testid="worktree-tab-review-totals"
                  className="font-mono text-[11px] tabular-nums"
                >
                  <span className="text-[color:var(--good)]">
                    +{reviewData!.totalAdditions}
                  </span>
                  <span className="ml-0.5 text-[color:var(--bad)]">
                    −{reviewData!.totalDeletions}
                  </span>
                </span>
              ) : def.id === "terminal" && terminalCount > 0 ? (
                <span className="font-mono text-[11px] text-[color:var(--muted-foreground)]">
                  {terminalCount}
                </span>
              ) : null
            }
            onClick={() => onSelectTab(def.id)}
          />
        ))}
      </div>

      <MoreMenuWrapper
        moreOpen={moreOpen}
        onMoreToggle={onMoreToggle}
        onCloseMore={onCloseMore}
        onCopyPath={onCopyPath}
        copiedPath={copiedPath}
        onReload={onReload}
        reloading={reloading}
        onRemove={onRemove}
        canRemove={canRemove}
      />

      {/* Panel host controls live inline in this single compact header row, so
       * the docked panel needs no second header band. Page host (full) shows
       * neither. */}
      {compact && (onExpandPanel || onClosePanel) && (
        <div className="flex shrink-0 items-center gap-0.5 border-l border-[color:var(--hair-2)] pl-1.5">
          {onExpandPanel && (
            <IconButton
              size="sm"
              aria-label="Expand worktree to full screen"
              data-testid="worktree-panel-expand"
              onClick={onExpandPanel}
            >
              <Maximize2 strokeWidth={1.75} />
            </IconButton>
          )}
          {onClosePanel && (
            <IconButton
              size="sm"
              aria-label="Close worktree panel"
              data-testid="worktree-panel-close"
              onClick={onClosePanel}
            >
              <X strokeWidth={1.75} />
            </IconButton>
          )}
        </div>
      )}
    </header>
  );
}

function WorktreeTabButton({
  def,
  active,
  compact,
  accent,
  trailing,
  onClick,
}: {
  def: WorktreeTabDef;
  active: boolean;
  /** Compact (panel) density collapses the label to its icon so all five tabs
   * fit a narrow panel without horizontal overflow; the label stays accessible
   * via `sr-only` + `aria-label`. */
  compact: boolean;
  /** Local status accent (a CSS color); omitted when nothing needs flagging. */
  accent: string | null;
  trailing: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={def.label}
      data-testid={def.testId}
      data-active={active ? true : undefined}
      onClick={onClick}
      className={cn(
        "relative inline-flex h-[30px] items-center rounded-[8px] border text-[13px] transition-[background-color,border-color,color,box-shadow] duration-100 focus-ring",
        "[&_svg]:size-[15px] [&_svg]:shrink-0 [&_svg]:[stroke-width:1.75]",
        compact ? "gap-1 px-2" : "gap-2 px-2.5",
        active
          ? "border-[color:var(--hair-2)] bg-[color:var(--surface)] font-medium text-[color:var(--ink)] shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
          : "border-transparent text-[color:var(--muted-foreground)] hover:bg-[color:color-mix(in_oklch,var(--surface)_60%,transparent)] hover:text-[color:var(--ink)]",
      )}
    >
      <span className="relative grid place-items-center">
        {def.icon}
        {accent ? (
          <span
            aria-hidden
            data-testid={`${def.testId}-indicator`}
            className="absolute -right-1 -top-1 size-1.5 rounded-full ring-2 ring-[color:var(--shell)]"
            style={{ background: accent }}
          />
        ) : null}
      </span>
      <span className={compact ? "sr-only" : undefined}>{def.label}</span>
      {trailing}
    </button>
  );
}

function MoreMenuWrapper({
  moreOpen,
  onMoreToggle,
  onCloseMore,
  onCopyPath,
  copiedPath,
  onReload,
  reloading,
  onRemove,
  canRemove,
}: {
  moreOpen: boolean;
  onMoreToggle: () => void;
  onCloseMore: () => void;
  onCopyPath: () => void;
  copiedPath: boolean;
  onReload: () => void;
  reloading: boolean;
  onRemove: () => void;
  canRemove: boolean;
}) {
  // Wrap trigger + menu so click-outside ignores the trigger itself.
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const handler = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (wrapperRef.current.contains(e.target as Node)) return;
      onCloseMore();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [moreOpen, onCloseMore]);

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        type="button"
        onClick={onMoreToggle}
        aria-label="More actions"
        aria-expanded={moreOpen}
        aria-haspopup="menu"
        className={cn(
          "grid h-10 w-10 place-items-center rounded-md transition-colors focus-ring",
          moreOpen
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {moreOpen && (
        <div
          role="menu"
          className="absolute right-0 top-[110%] z-30 min-w-[220px] overflow-hidden rounded-md border border-border bg-popover shadow-[0_18px_50px_-22px_rgb(0_0_0/0.35)] backdrop-blur"
        >
          <MenuItem
            icon={
              copiedPath ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : (
                <Copy className="h-4 w-4" />
              )
            }
            label={copiedPath ? "Path copied" : "Copy path"}
            onClick={onCopyPath}
            keepOpen
          />
          <MenuItem
            icon={
              <RefreshCw
                className={cn("h-4 w-4", reloading && "animate-spin")}
              />
            }
            label="Refresh"
            onClick={() => {
              onReload();
              onCloseMore();
            }}
          />
          <div className="my-0.5 h-px bg-border/60" />
          <MenuItem
            icon={<Trash2 className="h-4 w-4" />}
            label="Remove worktree"
            onClick={() => {
              onRemove();
              onCloseMore();
            }}
            disabled={!canRemove}
            destructive
            testId="worktree-remove-button"
          />
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  disabled,
  destructive,
  keepOpen,
  testId,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  keepOpen?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      data-keep-open={keepOpen ? "true" : undefined}
      className={cn(
        "flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        destructive
          ? "text-[color:var(--signal-error)] hover:bg-[color:var(--signal-error-soft)]"
          : "text-foreground hover:bg-accent",
      )}
    >
      <span className="grid h-4 w-4 place-items-center">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
    </button>
  );
}

/* ====================================================================
 * Mobile chrome — phones / iPad portrait (the desktop top bar is hidden on
 *   < lg). A quiet app bar whose title chip raises the navigator, and a
 *   bottom navigation bar of worktree destinations
 *     Overview · Runtime · ☰ Menu · Sessions · More
 *   with status expressed as a local accent dot, never global bar chrome.
 *   The center Menu (black solid) opens the navigator bottom sheet; Sessions
 *   and More open their own bottom sheets. Hidden on lg+, where the docked
 *   panel and rail lead instead. Canonical reference: demo/mobile-nav.html.
 * ==================================================================== */

/* Mobile app bar: the active worktree as a tappable title chip that raises the
 * navigator (secondary to the bottom bar's center Menu). */
function MobileAppBar({
  projectName,
  titleLabel,
  status,
  onOpenNavigator,
}: {
  projectName?: string;
  titleLabel: string;
  status: DeploymentStatus;
  onOpenNavigator: () => void;
}) {
  return (
    <header className="relative z-20 flex h-[50px] shrink-0 items-center border-b border-[color:var(--hair)] bg-[color:var(--surface)] px-2 lg:hidden">
      <button
        type="button"
        onClick={onOpenNavigator}
        data-testid="mobile-appbar-title"
        aria-label="Switch worktree"
        className="-ml-1 flex min-w-0 flex-1 items-center gap-2 rounded-[9px] px-2 py-1.5 text-left transition-colors hover:bg-[color:var(--hover)] focus-ring"
      >
        {projectName ? (
          <span className="shrink-0 truncate text-[13.5px] text-[color:var(--muted-foreground)]">
            {projectName} /
          </span>
        ) : null}
        <StatusDot variant={statusDotVariant(status)} size={8} />
        <span className="min-w-0 truncate font-mono text-[13.5px] font-medium text-[color:var(--ink)]">
          {titleLabel}
        </span>
        <ChevronsUpDown
          className="size-3.5 shrink-0 text-[color:var(--muted-foreground)]"
          strokeWidth={1.75}
        />
      </button>
    </header>
  );
}

/* Local status accent for the Runtime tab: amber when partial/checking,
 * red when failed, nothing otherwise ("everything is fine" is the default). */
function runtimeTabAccent(status: DeploymentStatus): string | null {
  const variant = statusDotVariant(status);
  if (variant === "partial") return "#F59E0B";
  if (variant === "fail") return "var(--bad)";
  return null;
}

function MobileNavItem({
  icon,
  label,
  active,
  dotColor,
  onClick,
  testId,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  /** Local status accent (a CSS color); omitted when nothing needs flagging. */
  dotColor?: string | null;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      aria-label={label}
      data-testid={testId}
      data-active={active ? true : undefined}
      className={cn(
        "relative flex min-w-0 flex-1 flex-col items-center justify-center gap-1 py-1.5 transition-colors focus-ring",
        "[&_svg]:size-[18px] [&_svg]:shrink-0 [&_svg]:[stroke-width:1.75]",
        active
          ? "text-[color:var(--ink)]"
          : "text-[color:var(--muted-foreground)] hover:text-[color:var(--ink)]",
      )}
    >
      <span
        className={cn(
          "relative grid h-6 w-11 place-items-center rounded-full transition-colors",
          active && "bg-[color:var(--hover)]",
        )}
      >
        {icon}
        {dotColor ? (
          <span
            aria-hidden
            data-testid={`${testId}-indicator`}
            className="absolute right-1.5 top-0 size-2 rounded-full ring-2 ring-[color:var(--surface)]"
            style={{ background: dotColor }}
          />
        ) : null}
      </span>
      <span
        className={cn(
          "max-w-full truncate text-[10px] leading-none tracking-[-0.01em]",
          active ? "font-semibold" : "font-medium",
        )}
      >
        {label}
      </span>
    </button>
  );
}

/* Center Menu — the focal navigation verb: a black solid control (inverts via
 * `--ink` in dark) that opens the navigator. Never the amber command accent,
 * never a raised FAB. */
function MobileMenuButton({ onClick }: { onClick: () => void }) {
  return (
    <span className="flex flex-none items-center justify-center px-2 py-1.5">
      <button
        type="button"
        onClick={onClick}
        aria-label="Open navigator"
        data-testid="mobile-nav-menu"
        className="grid h-9 w-[50px] place-items-center rounded-[13px] bg-[color:var(--ink)] text-[color:var(--surface)] shadow-[0_6px_16px_-8px_rgba(0,0,0,0.5)] transition-[transform,filter] hover:brightness-110 active:scale-95 focus-ring [&_svg]:size-[22px] [&_svg]:[stroke-width:1.75]"
      >
        <Menu />
      </button>
    </span>
  );
}

function MobileTabBar({
  activeTab,
  status,
  sessionsLive,
  reviewDirty,
  sessionsSheetOpen,
  moreSheetOpen,
  onOverview,
  onRuntime,
  onOpenNavigator,
  onOpenSessions,
  onOpenMore,
}: {
  activeTab: WorktreeTab;
  status: DeploymentStatus;
  sessionsLive: boolean;
  reviewDirty: boolean;
  sessionsSheetOpen: boolean;
  moreSheetOpen: boolean;
  onOverview: () => void;
  onRuntime: () => void;
  onOpenNavigator: () => void;
  onOpenSessions: () => void;
  onOpenMore: () => void;
}) {
  return (
    <nav
      data-testid="mobile-tab-bar"
      aria-label="Worktree navigation"
      className="relative z-20 flex shrink-0 select-none items-stretch border-t border-[color:var(--hair)] bg-[color:var(--surface)]/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl [-webkit-touch-callout:none] lg:hidden"
    >
      <MobileNavItem
        icon={<House />}
        label="Overview"
        active={activeTab === "overview"}
        onClick={onOverview}
        testId="mobile-tab-overview"
      />
      <MobileNavItem
        icon={<Boxes />}
        label="Runtime"
        active={activeTab === "runtime"}
        dotColor={runtimeTabAccent(status)}
        onClick={onRuntime}
        testId="mobile-tab-runtime"
      />
      <MobileMenuButton onClick={onOpenNavigator} />
      <MobileNavItem
        icon={<SquareTerminal />}
        label="Sessions"
        active={sessionsSheetOpen}
        dotColor={sessionsLive ? "var(--good)" : null}
        onClick={onOpenSessions}
        testId="mobile-tab-sessions"
      />
      <MobileNavItem
        icon={<MoreHorizontal />}
        label="More"
        active={moreSheetOpen}
        dotColor={reviewDirty ? "var(--ink-2)" : null}
        onClick={onOpenMore}
        testId="mobile-tab-more"
      />
    </nav>
  );
}

/* Sessions destination — the worktree's live agent/terminal sessions with
 * agent-aware glyphs, attach on tap, and a New terminal row. Folds in the
 * former long-press session picker. */
function MobileSessionsSheet({
  worktreePath,
  branchName,
  currentSessionId,
  onAttach,
  onNewTerminal,
  onRenameSession,
  onClose,
}: {
  worktreePath: string;
  branchName?: string;
  currentSessionId?: string;
  onAttach: (sessionId: string) => void;
  onNewTerminal: () => void;
  onRenameSession: (session: TerminalSessionMetadata) => void;
  onClose: () => void;
}) {
  const sessions = useTerminalSessions(worktreePath);
  return (
    <BottomSheet
      testId="mobile-sessions-sheet"
      ariaLabel="Worktree sessions"
      onClose={onClose}
    >
      <div className="flex min-h-0 flex-col px-2 pb-3">
        <div className="flex items-center gap-2 px-3 pb-1 pt-2">
          <span className="text-[15px] font-semibold text-[color:var(--ink)]">
            Sessions
          </span>
          {sessions.length > 0 ? (
            <span className="font-mono text-[11px] text-[color:var(--muted-foreground)]">
              {sessions.length}
            </span>
          ) : null}
        </div>
        <div className="min-h-0 overflow-auto" data-testid="mobile-sessions-list">
          {sessions.length === 0 ? (
            <p className="px-3 py-2 text-[13.5px] text-[color:var(--muted-foreground)]">
              No open terminals in this worktree.
            </p>
          ) : (
            sessions.map((session) => (
              <MobileSessionRow
                key={session.id}
                session={session}
                branchName={branchName}
                current={session.id === currentSessionId}
                onAttach={() => onAttach(session.id)}
                onRename={() => onRenameSession(session)}
              />
            ))
          )}
          <button
            type="button"
            data-testid="mobile-sessions-new"
            onClick={onNewTerminal}
            className="flex w-full items-center gap-3 rounded-[12px] px-3 py-3 text-left text-[color:var(--ink-2)] transition-colors hover:bg-[color:var(--hover)] focus-ring"
          >
            <span className="grid size-[18px] shrink-0 place-items-center text-[color:var(--muted-foreground)] [&_svg]:size-[17px]">
              <Plus strokeWidth={1.75} />
            </span>
            <span className="text-[14.5px]">New terminal</span>
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}

function MobileSessionRow({
  session,
  branchName,
  current,
  onAttach,
  onRename,
}: {
  session: TerminalSessionMetadata;
  branchName?: string;
  current: boolean;
  onAttach: () => void;
  onRename: () => void;
}) {
  const agent = terminalAgent(session);
  const Icon = agent?.icon ?? SquareTerminal;
  const exited = session.status === "exited";
  const command = session.activeCommand?.command;
  const subtitle = exited
    ? "exited"
    : command
      ? command.split("/").pop() ?? command
      : branchName ?? "shell";
  return (
    <div
      data-testid="mobile-session-row"
      aria-current={current ? "true" : undefined}
      className="flex w-full items-center gap-1 rounded-[12px] pr-2 transition-colors hover:bg-[color:var(--hover)] [&_svg]:size-[17px]"
    >
      <button
        type="button"
        onClick={onAttach}
        data-testid="mobile-session-attach"
        className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left focus-ring rounded-[12px]"
      >
        <span
          className="grid size-[18px] shrink-0 place-items-center"
          style={{ color: agent ? agent.brand : "var(--ink-2)" }}
        >
          <Icon strokeWidth={1.75} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[14.5px] text-[color:var(--ink)]">
            {terminalLabel(session, branchName ?? "shell")}
          </span>
          <span className="truncate font-mono text-[12px] text-[color:var(--muted-foreground)]">
            {subtitle}
          </span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[12px] text-[color:var(--muted-foreground)]">
          <StatusDot variant={exited ? "idle" : "run"} size={8} />
          {exited ? "exited" : "live"}
        </span>
      </button>
      {!exited && (
        <button
          type="button"
          onClick={onRename}
          data-testid="mobile-session-rename"
          aria-label="Rename session"
          className="grid size-9 shrink-0 place-items-center rounded-[10px] text-[color:var(--muted-foreground)] transition-colors hover:bg-[color:var(--surface)] hover:text-[color:var(--ink)] focus-ring"
        >
          <PenLine strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
}

/* More — the secondary worktree views demoted from the bar (Review · Files ·
 * Logs · Open web). Review/Files/Logs select the matching full-width worktree
 * tab (Logs lives in the Runtime tab); Open web follows the exposed address. */
function MobileMoreSheet({
  reviewSummary,
  exposedUrl,
  onReview,
  onFiles,
  onLogs,
  onClose,
}: {
  reviewSummary: ReviewSummary | null;
  exposedUrl: string | null;
  onReview: () => void;
  onFiles: () => void;
  onLogs: () => void;
  onClose: () => void;
}) {
  const dirty = !!reviewSummary && reviewSummary.changedFiles > 0;
  return (
    <BottomSheet
      testId="mobile-more-sheet"
      ariaLabel="More worktree views"
      onClose={onClose}
    >
      <div className="flex flex-col px-2 pb-3">
        <div className="px-3 pb-1 pt-2">
          <span className="text-[15px] font-semibold text-[color:var(--ink)]">
            More
          </span>
        </div>
        <MoreSheetRow
          icon={<GitPullRequestArrow />}
          label="Review"
          testId="more-review"
          onClick={onReview}
          trailing={
            dirty ? (
              <span
                data-testid="more-review-dirty"
                className="font-mono text-[11px] tabular-nums"
              >
                <span className="text-[color:var(--good)]">
                  +{reviewSummary!.additions}
                </span>
                <span className="ml-0.5 text-[color:var(--bad)]">
                  −{reviewSummary!.deletions}
                </span>
              </span>
            ) : null
          }
        />
        <MoreSheetRow
          icon={<FolderOpen />}
          label="Files"
          testId="more-files"
          onClick={onFiles}
        />
        <MoreSheetRow
          icon={<ScrollText />}
          label="Logs"
          testId="more-logs"
          onClick={onLogs}
        />
        {exposedUrl ? (
          <a
            href={exposedUrl}
            target="_blank"
            rel="noreferrer"
            data-testid="more-open-web"
            onClick={onClose}
            className="flex w-full items-center gap-3 rounded-[12px] px-3 py-3 text-left text-[color:var(--ink)] transition-colors hover:bg-[color:var(--hover)] focus-ring [&_svg]:size-[18px] [&_svg]:[stroke-width:1.75]"
          >
            <span className="grid size-[18px] shrink-0 place-items-center text-[color:var(--muted-foreground)]">
              <ExternalLink />
            </span>
            <span className="flex-1 text-[14.5px]">Open web</span>
          </a>
        ) : null}
      </div>
    </BottomSheet>
  );
}

function MoreSheetRow({
  icon,
  label,
  testId,
  trailing,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  testId: string;
  trailing?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="flex w-full items-center gap-3 rounded-[12px] px-3 py-3 text-left text-[color:var(--ink)] transition-colors hover:bg-[color:var(--hover)] focus-ring [&_svg]:size-[18px] [&_svg]:[stroke-width:1.75]"
    >
      <span className="grid size-[18px] shrink-0 place-items-center text-[color:var(--muted-foreground)]">
        {icon}
      </span>
      <span className="flex-1 text-[14.5px]">{label}</span>
      {trailing}
    </button>
  );
}

/* Quiet, text-only removal indicator shown next to the worktree title while a
 * remove operation is running. v3 style: word + spinner, no bordered chip. */
function RemovingBadge() {
  return (
    <span
      data-testid="worktree-removing-badge"
      className="inline-flex shrink-0 items-center gap-1.5 text-[11.5px] font-medium text-[color:var(--bad)]"
    >
      <Loader2 className="h-3 w-3 animate-spin" />
      removing
    </span>
  );
}

/* ====================================================================
 * Modals
 *   Bottom-sheet on small screens, centered dialog on md+.
 * ==================================================================== */

export function RemoveWorktreeModal({
  path,
  submitting,
  onCancel,
  onConfirm,
}: {
  path: string;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <ModalShell
      testId="worktree-remove-modal"
      ariaLabel="Discard local changes and remove worktree"
      submitting={submitting}
      onCancel={onCancel}
    >
      <header className="px-6 pt-6 pb-4 border-b border-[color:var(--hair)]">
        <span className="text-[11.5px] font-medium uppercase tracking-[0.18em] text-[color:var(--bad)]">
          Local changes will be discarded
        </span>
        <h2 className="mt-1.5 text-[20px] font-semibold tracking-[-0.01em] text-[color:var(--ink)]">
          Remove worktree with local changes
        </h2>
      </header>
      <div className="px-6 py-5 flex flex-col gap-3.5">
        <p className="text-[14px] leading-[1.6] text-[color:var(--ink-2)] m-0">
          This worktree has staged, unstaged, untracked, or unmerged Git
          changes. WorktreeOS will stop the deployed services, remove persistent
          session artifacts, and run <Ic>git worktree remove</Ic>. Local
          changes in the worktree will be lost. The branch is not deleted.
        </p>
        <div
          data-testid="worktree-remove-path"
          className="rounded-[8px] bg-[color:var(--chip-bg)] px-3 py-2 font-mono text-[12px] text-[color:var(--ink)] break-all"
        >
          {path}
        </div>
      </div>
      <footer className="flex items-center justify-end gap-2 border-t border-[color:var(--hair)] px-6 py-3.5">
        <Button
          type="button"
          variant="default"
          disabled={submitting}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="solid"
          disabled={submitting}
          onClick={() => onConfirm()}
          data-testid="worktree-remove-confirm"
          className="bg-[color:var(--bad)] border-[color:var(--bad)] text-white hover:brightness-[1.05]"
        >
          {submitting ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Trash2 />
          )}
          Discard changes and remove
        </Button>
      </footer>
    </ModalShell>
  );
}

export function DeploymentActionModal({
  mode,
  submitting,
  deploymentOptions,
  onCancel,
  onConfirm,
}: {
  mode: "start" | "restart";
  submitting: boolean;
  deploymentOptions?: GeneratedDeploymentOptions;
  onCancel: () => void;
  onConfirm: (
    force: boolean,
    selection: DeploymentActionSelection,
  ) => void | Promise<void>;
}) {
  const [force, setForce] = useState(false);
  const hasGenerated = deploymentOptions !== undefined;
  const targetNames = useMemo(
    () => (deploymentOptions ? Object.keys(deploymentOptions.targets) : []),
    [deploymentOptions],
  );
  type Mode = "all" | "target" | "custom";
  const [selectMode, setSelectMode] = useState<Mode>("all");
  const [selectedTarget, setSelectedTarget] = useState<string>(
    () => targetNames[0] ?? "",
  );
  const allServiceNames = useMemo(
    () =>
      deploymentOptions
        ? [...deploymentOptions.appServices].sort()
        : [],
    [deploymentOptions],
  );
  const [selectedServices, setSelectedServices] = useState<Set<string>>(
    () => new Set(),
  );
  const argumentNames = useMemo(
    () => (deploymentOptions ? [...deploymentOptions.arguments] : []),
    [deploymentOptions],
  );
  const [argumentValues, setArgumentValues] = useState<Record<string, string>>(
    () => Object.fromEntries(argumentNames.map((name) => [name, ""])),
  );
  const title = mode === "start" ? "Start deployment" : "Restart deployment";
  const description =
    mode === "start"
      ? "WorktreeOS will run wos up for this worktree."
      : "WorktreeOS will re-run wos up for this worktree, restarting services.";

  const canSubmit = (() => {
    if (!hasGenerated || selectMode === "all") return true;
    if (selectMode === "target") return selectedTarget.length > 0;
    return selectedServices.size > 0;
  })();

  function selection(): DeploymentActionSelection {
    return buildDeploymentSelection({
      hasGenerated,
      selectMode,
      selectedTarget,
      selectedServices,
      argumentNames,
      argumentValues,
    });
  }

  function toggleService(name: string, next: boolean): void {
    setSelectedServices((prev) => {
      const out = new Set(prev);
      if (next) out.add(name);
      else out.delete(name);
      return out;
    });
  }

  return (
    <ModalShell
      ariaLabel={title}
      submitting={submitting}
      onCancel={onCancel}
    >
      <header className="px-6 pt-6 pb-4 border-b border-[color:var(--hair)]">
        <span className="text-[11.5px] font-medium uppercase tracking-[0.18em] text-[color:var(--muted-foreground)]">
          {mode === "start" ? "Start worktree" : "Restart worktree"}
        </span>
        <h2 className="mt-1.5 text-[20px] font-semibold tracking-[-0.01em] text-[color:var(--ink)]">
          {title}
        </h2>
        <p className="mt-1.5 text-[13.5px] leading-[1.55] text-[color:var(--muted-foreground)] m-0">
          {description}
        </p>
      </header>
      <div className="px-6 py-5 flex flex-col gap-5 max-h-[60vh] overflow-auto">
        {hasGenerated && (
          <section className="flex flex-col gap-2.5">
            <header className="flex items-baseline gap-3">
              <h3 className="m-0 text-[14px] font-semibold text-[color:var(--ink)]">
                What to start
              </h3>
              <span className="text-[12.5px] text-[color:var(--muted-foreground)]">
                {selectMode === "all"
                  ? "all services"
                  : selectMode === "target"
                    ? `target: ${selectedTarget || "—"}`
                    : `${selectedServices.size} of ${allServiceNames.length} selected`}
              </span>
            </header>
            <div className="inline-flex items-stretch h-[30px] rounded-lg border border-[color:var(--hair-2)] overflow-hidden self-start">
              <ModeTab
                active={selectMode === "all"}
                onClick={() => setSelectMode("all")}
                disabled={submitting}
              >
                All services
              </ModeTab>
              {targetNames.length > 0 ? (
                <ModeTab
                  active={selectMode === "target"}
                  onClick={() => setSelectMode("target")}
                  disabled={submitting}
                >
                  Target
                </ModeTab>
              ) : null}
              <ModeTab
                active={selectMode === "custom"}
                onClick={() => setSelectMode("custom")}
                disabled={submitting}
              >
                Custom
              </ModeTab>
            </div>
            {selectMode === "target" && targetNames.length > 0 && (
              <select
                value={selectedTarget}
                onChange={(e) => setSelectedTarget(e.target.value)}
                disabled={submitting}
                className="w-full rounded-[8px] border border-[color:var(--hair-2)] bg-[color:var(--surface)] px-3 py-2 text-[13.5px] text-[color:var(--ink)] focus:outline-none focus:ring-1 focus:ring-[color:var(--ink)]/30"
              >
                {targetNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            )}
            {selectMode === "custom" && (
              <ul className="list-none p-0 m-0 [&_li]:list-none">
                {allServiceNames.map((name, i) => (
                  <li
                    key={name}
                    className={cn(
                      "border-t border-[color:var(--hair)]",
                      i === 0 ? "border-t-0" : "",
                      i === allServiceNames.length - 1 ? "border-b" : "",
                    )}
                  >
                    <Checkbox
                      checked={selectedServices.has(name)}
                      onCheckedChange={(next) => toggleService(name, next)}
                      disabled={submitting}
                      data-testid={`deployment-modal-service-${name}`}
                    >
                      <Ic>{name}</Ic>
                    </Checkbox>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {hasGenerated && argumentNames.length > 0 && (
          <section className="flex flex-col gap-2.5">
            <h3 className="m-0 text-[14px] font-semibold text-[color:var(--ink)]">
              Runtime arguments
            </h3>
            <div className="flex flex-col gap-2.5">
              {argumentNames.map((name) => (
                <label
                  key={name}
                  className="flex flex-col gap-1.5"
                  htmlFor={`runtime-arg-${name}`}
                >
                  <span className="font-mono text-[12px] text-[color:var(--muted-foreground)]">
                    {name}
                  </span>
                  <input
                    id={`runtime-arg-${name}`}
                    type="text"
                    value={argumentValues[name] ?? ""}
                    disabled={submitting}
                    onChange={(e) =>
                      setArgumentValues({
                        ...argumentValues,
                        [name]: e.target.value,
                      })
                    }
                    placeholder="leave blank to use template default"
                    className="rounded-[8px] border border-[color:var(--hair-2)] bg-[color:var(--surface)] px-3 py-2 font-mono text-[13px] text-[color:var(--ink)] placeholder:text-[color:var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[color:var(--ink)]/30"
                  />
                </label>
              ))}
            </div>
          </section>
        )}

        <section className="flex flex-col gap-2.5">
          <h3 className="m-0 text-[14px] font-semibold text-[color:var(--ink)]">
            Options
          </h3>
          <ul className="list-none p-0 m-0 [&_li]:list-none">
            <li className="border-t border-b border-[color:var(--hair)]">
              <Checkbox
                checked={force}
                onCheckedChange={setForce}
                disabled={submitting}
                trailing={
                  <span className="text-[color:var(--bad)]">destructive</span>
                }
                data-testid="deployment-modal-force"
              >
                Force — recreate the volume clone and re-initialize dependencies
              </Checkbox>
            </li>
          </ul>
        </section>
      </div>
      <footer className="flex items-center justify-end gap-2 border-t border-[color:var(--hair)] px-6 py-3.5">
        <Button
          type="button"
          variant="default"
          disabled={submitting}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="solid"
          disabled={submitting || !canSubmit}
          onClick={() => onConfirm(force, selection())}
        >
          {submitting ? (
            <Loader2 className="animate-spin" />
          ) : mode === "start" ? (
            <Play fill="currentColor" strokeWidth={0} />
          ) : (
            <RotateCw />
          )}
          {mode === "start" ? "Start" : "Restart"}
        </Button>
      </footer>
    </ModalShell>
  );
}

function ModeTab({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        "px-3 text-[12.5px] font-medium cursor-pointer bg-transparent border-0",
        "[&:not(:last-child)]:border-r [&:not(:last-child)]:border-[color:var(--hair-2)]",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        active
          ? "bg-[color:var(--hover)] text-[color:var(--ink)]"
          : "text-[color:var(--muted-foreground)] hover:bg-[color:var(--hover)] hover:text-[color:var(--ink)]",
      )}
    >
      {children}
    </button>
  );
}
