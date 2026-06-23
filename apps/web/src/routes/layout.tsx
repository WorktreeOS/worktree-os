import { useCallback, useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { PanelLeft } from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { WorktreePanel } from "@/components/worktree-panel";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import { PublicLoginView } from "@/components/public-login";
import { SetupRoute } from "@/routes/setup";
import { UiApiProvider } from "@/lib/api-context";
import { ProjectsProvider } from "@/lib/projects-context";
import { StatusCatalogProvider } from "@/lib/status-catalog-context";
import { EventsProvider } from "@/lib/events-context";
import { TerminalSessionsProvider } from "@/lib/terminal-sessions-context";
import { ActiveTerminalProvider } from "@/lib/active-terminal-context";
import {
  PublicAuthProvider,
  usePublicAuth,
} from "@/lib/public-auth-context";
import { gateDecision } from "@/lib/public-auth-state";
import { SetupProvider, useSetupGate } from "@/lib/setup-context";
import { useDeployFailureNotifications } from "@/lib/deploy-notifications-bridge";
import { useNotificationSound } from "@/lib/notification-sound-bridge";
import { usePresenceReporter } from "@/lib/presence-reporter";
import {
  clampSidebarWidth,
  persistSidebarWidth,
  readStoredSidebarWidth,
} from "@/lib/sidebar-width";
import {
  clampPanelWidth,
  getPanelMaxWidth,
  persistPanelWidth,
  readStoredPanelWidth,
} from "@/lib/panel-width";
import {
  WorktreePanelProvider,
  useWorktreePanel,
} from "@/lib/worktree-panel-context";
import { isPanelRoute, worktreeRouteUrl } from "@/lib/worktree-open";
import { Toaster } from "@/components/ui/sonner";

const DESKTOP_MQ = "(min-width: 1024px)";

function readInitialOpen(): { open: boolean; isDesktop: boolean } {
  if (typeof window === "undefined") return { open: true, isDesktop: true };
  const isDesktop = window.matchMedia(DESKTOP_MQ).matches;
  return { open: isDesktop, isDesktop };
}

/** Initial desktop rail width: stored preference clamped to the viewport. */
function readInitialSidebarWidth(): number {
  const viewport = typeof window === "undefined" ? 1280 : window.innerWidth;
  return clampSidebarWidth(readStoredSidebarWidth() ?? Number.NaN, viewport);
}

/** Initial docked-panel width: stored preference clamped to viewport + rail. */
function readInitialPanelWidth(railWidth: number): number {
  const viewport = typeof window === "undefined" ? 1280 : window.innerWidth;
  return clampPanelWidth(readStoredPanelWidth() ?? Number.NaN, viewport, railWidth);
}

export interface SidebarOutletContext {
  sidebarOpen: boolean;
  /** Reopen the collapsed desktop rail. */
  openSidebar: () => void;
  /** Toggle the desktop rail (collapse when open, reopen when collapsed). The
   * toggle control now lives in the page header, not inside the rail. */
  toggleSidebar: () => void;
  /** Raise the mobile bottom-sheet navigator (replaces the left drawer). */
  openNavigator: () => void;
}

function GatedShell() {
  const { state, markUnauthorized } = usePublicAuth();
  const decision = gateDecision(state);

  if (decision === "loading") {
    return (
      <div className="flex h-dvh w-screen items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (decision === "login" || decision === "error") {
    return <PublicLoginView />;
  }

  return (
    <UiApiProvider onUnauthorized={markUnauthorized}>
      <SetupProvider>
        <EventsProvider>
          <ProjectsProvider>
            <StatusCatalogProvider>
              <TerminalSessionsProvider>
                <ActiveTerminalProvider>
                  {/* Ephemeral right-docked worktree panel selection lives above
                   * the shell so it survives in-app route changes. */}
                  <WorktreePanelProvider>
                    <SetupAwareShell />
                  </WorktreePanelProvider>
                </ActiveTerminalProvider>
              </TerminalSessionsProvider>
            </StatusCatalogProvider>
          </ProjectsProvider>
        </EventsProvider>
      </SetupProvider>
    </UiApiProvider>
  );
}

/**
 * Render the app shell with sidebar + main outlet, or — when first-run setup
 * is required — a chromeless shell that hosts only the setup flow so the
 * empty sidebar does not distract users before any project is registered.
 * Docs routes always bypass the gate.
 */
function SetupAwareShell() {
  const { state } = useSetupGate();
  const location = useLocation();
  const navigate = useNavigate();
  const panel = useWorktreePanel();
  useDeployFailureNotifications();
  useNotificationSound();
  usePresenceReporter();
  const initial = readInitialOpen();
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(initial.open);
  const [isDesktop, setIsDesktop] = useState<boolean>(initial.isDesktop);
  // Desktop rail width (px). Collapse/open toggles `sidebarOpen`, never this —
  // reopening restores the last clamped width. Mobile never reads it.
  const [sidebarWidth, setSidebarWidth] = useState<number>(
    () => readInitialSidebarWidth(),
  );
  // Docked worktree-panel width (px), owned by the shell and clamped against the
  // current rail width + viewport so rail + panel can never crush the center.
  const [panelWidth, setPanelWidth] = useState<number>(() =>
    readInitialPanelWidth(readInitialSidebarWidth()),
  );
  // Mobile navigation rises as a bottom sheet (the navigator) instead of a
  // left slide-in drawer; this is its open state.
  const [navigatorOpen, setNavigatorOpen] = useState<boolean>(false);

  const openSidebar = () => setSidebarOpen(true);
  const toggleSidebar = () => setSidebarOpen((v) => !v);
  const openNavigator = () => setNavigatorOpen(true);

  // Live drag update: the shell owns the clamp so the rail can never crowd out
  // the worktree detail area on the current viewport.
  const changeSidebarWidth = useCallback((raw: number) => {
    setSidebarWidth(clampSidebarWidth(raw, window.innerWidth));
  }, []);
  // Persist when the drag completes. Read the latest width through the updater
  // so the closure cannot capture a stale value mid-drag.
  const commitSidebarWidth = useCallback(() => {
    setSidebarWidth((w) => {
      persistSidebarWidth(w);
      return w;
    });
  }, []);

  // Docked-panel resize: live clamp against the current rail width + viewport,
  // persist on release. The rail-aware clamp keeps a minimum center column.
  const changePanelWidth = useCallback(
    (raw: number) => {
      setPanelWidth(clampPanelWidth(raw, window.innerWidth, sidebarWidth));
    },
    [sidebarWidth],
  );
  const commitPanelWidth = useCallback(() => {
    setPanelWidth((w) => {
      persistPanelWidth(w);
      return w;
    });
  }, []);

  const outletContext: SidebarOutletContext = {
    sidebarOpen,
    openSidebar,
    toggleSidebar,
    openNavigator,
  };
  const onWorktreeRoute = location.pathname === "/worktree";
  // The docked panel is a board-local affordance: it renders only on a
  // panel-hosting route (currently just the board), never beside another route.
  // This also upholds the single-instance invariant — the heavy worktree view is
  // mounted by the full-screen `/worktree` route OR the panel, never both, since
  // a panel route is never `/worktree`. Touch viewports open full-screen instead.
  const showPanel =
    isDesktop && panel.path !== null && isPanelRoute(location.pathname);
  // Expand promotes the panel's worktree to the full-screen route, then clears
  // the ephemeral selection so the panel does not reappear when navigating back.
  const onExpandPanel = useCallback(() => {
    if (panel.path === null) return;
    navigate(worktreeRouteUrl(panel.path));
    panel.close();
  }, [navigate, panel]);

  // Routes that carry the rail toggle inside their own page header (desktop):
  // worktree, home (`/`), and settings. On those the floating toggle is
  // suppressed on desktop; everywhere else (select, board, docs) it remains the
  // desktop toggle. On touch the floating button is the navigator opener for
  // every route except worktree (which raises the navigator from its app bar).
  const onHomeRoute = location.pathname === "/";
  const onSettingsRoute =
    location.pathname === "/settings" ||
    location.pathname.startsWith("/settings/");
  const routeOwnsHeaderToggle =
    onWorktreeRoute || onHomeRoute || onSettingsRoute;
  const showFloatingToggle = isDesktop
    ? !routeOwnsHeaderToggle
    : !onWorktreeRoute;
  /* The worktree route is a full-height shell that manages its own internal
   * scroll (fixed top bar / command bar, scrollable surface). Letting `main`
   * also scroll would stack a second scrollbar, so hand scrolling to the
   * route on this path. The docked panel is a separate flex column that owns its
   * own scroll, so the center route's scroll/toggle ownership is unaffected by
   * the panel being present. */
  const routeManagesOwnScroll = onWorktreeRoute;

  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_MQ);
    const handler = (e: MediaQueryListEvent) => {
      setIsDesktop(e.matches);
      setSidebarOpen(e.matches);
      if (e.matches) setNavigatorOpen(false);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // Reclamp the rail width when the desktop viewport shrinks/grows so a width
  // chosen on a wide monitor cannot hide the worktree detail area on a smaller
  // one. Runs once on becoming desktop to fix up a restored-but-too-wide value.
  useEffect(() => {
    if (!isDesktop) return;
    const reclamp = () =>
      setSidebarWidth((w) => clampSidebarWidth(w, window.innerWidth));
    reclamp();
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, [isDesktop]);

  // Reclamp the panel width on viewport change AND whenever the rail width
  // changes, so rail + panel together can never crush the center. Depends on
  // `sidebarWidth` so a rail resize immediately tightens the panel's ceiling.
  useEffect(() => {
    if (!isDesktop) return;
    const reclamp = () =>
      setPanelWidth((w) => clampPanelWidth(w, window.innerWidth, sidebarWidth));
    reclamp();
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, [isDesktop, sidebarWidth]);

  // Dismiss the navigator on route change so a worktree picked from it does
  // not leave the sheet hanging over the next screen.
  useEffect(() => {
    setNavigatorOpen(false);
  }, [location.pathname, location.search]);

  // The `/select` placeholder means "no worktree is open" — a docked panel left
  // over from a previous selection (e.g. after a project switch) would contradict
  // that and strand the user beside an empty center, so clear it on arrival.
  useEffect(() => {
    if (location.pathname === "/select") panel.close();
  }, [location.pathname, panel.close]);

  const inDocs = location.pathname.startsWith("/docs/");
  const setupActive =
    !inDocs && state.kind === "ready" && state.status.setupRequired;

  if (setupActive) {
    return (
      <div
        className="relative flex h-dvh w-screen overflow-hidden bg-[color:var(--shell)] text-[color:var(--ink)]"
        data-testid="setup-shell"
      >
        <main className="relative flex-1 overflow-auto bg-[color:var(--surface)]">
          <SetupRoute />
        </main>
      </div>
    );
  }

  return (
    <div className="relative flex h-dvh w-screen overflow-hidden bg-[color:var(--shell)] text-[color:var(--ink)]">
      {/* Desktop rail only — on touch viewports the rail content is reached
       * through the bottom-sheet navigator, never a left slide-in drawer. */}
      {isDesktop && (
        <Sidebar
          open={sidebarOpen}
          isDesktop
          width={sidebarWidth}
          onWidthChange={changeSidebarWidth}
          onWidthCommit={commitSidebarWidth}
          onClose={() => setSidebarOpen(false)}
        />
      )}

      <main
        className={`relative flex-1 bg-[color:var(--surface)] ${
          routeManagesOwnScroll ? "overflow-hidden" : "overflow-auto"
        }`}
      >
        {/* Floating rail toggle for routes that do not host their own header
         * trigger (select / board / docs): on desktop it collapses/reopens the
         * rail (anchored just past the rail's right edge when open, at the
         * content edge when collapsed); on touch it raises the mobile navigator.
         * Worktree, home, and settings carry the toggle in their page header. */}
        {showFloatingToggle && (
          <button
            type="button"
            onClick={isDesktop ? toggleSidebar : openNavigator}
            aria-label={isDesktop && sidebarOpen ? "Collapse sidebar" : "Open menu"}
            data-testid="open-sidebar-button"
            style={isDesktop && sidebarOpen ? { left: sidebarWidth + 8 } : undefined}
            className="fixed left-2 top-2 z-40 grid h-9 w-9 place-items-center rounded-md border border-[color:var(--hair-2)] bg-[color:var(--surface)]/90 text-[color:var(--ink)] shadow-sm backdrop-blur transition-colors hover:bg-[color:var(--hover)] focus-ring"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        )}
        <Outlet context={outletContext} />
      </main>

      {/* Right-docked worktree panel — a resizable split-pane sibling that
       * shrinks the center (never an overlay). Suppressed on `/worktree` and on
       * touch by `showPanel`. */}
      {showPanel && panel.path !== null && (
        <WorktreePanel
          path={panel.path}
          tab={panel.tab}
          width={panelWidth}
          maxWidth={getPanelMaxWidth(
            typeof window === "undefined" ? 1280 : window.innerWidth,
            sidebarWidth,
          )}
          onWidthChange={changePanelWidth}
          onWidthCommit={commitPanelWidth}
          onClose={panel.close}
          onExpand={onExpandPanel}
          onClearTab={panel.clearTab}
        />
      )}

      {/* Mobile navigator — the project switcher + worktree tree, raised as a
       * bottom sheet from the worktree bottom bar / app-bar title chip, or the
       * floating trigger on other routes. */}
      {!isDesktop && navigatorOpen && (
        <BottomSheet
          testId="mobile-navigator-sheet"
          ariaLabel="Worktree navigator"
          onClose={() => setNavigatorOpen(false)}
        >
          <Sidebar
            embedded
            open
            isDesktop={false}
            onClose={() => setNavigatorOpen(false)}
          />
        </BottomSheet>
      )}
    </div>
  );
}

export function RootLayout() {
  return (
    <PublicAuthProvider>
      <GatedShell />
      <Toaster />
    </PublicAuthProvider>
  );
}
