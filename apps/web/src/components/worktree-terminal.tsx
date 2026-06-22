import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  ChevronUp,
  ChevronsDown,
  ChevronsUp,
  Hand,
  Loader2,
  Minus,
  PenLine,
  Plus,
  Puzzle,
  RotateCw,
  Settings2,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import { useUiApi } from "@/lib/api-context";
import { useUnifiedEvents } from "@/lib/events-context";
import { useActiveTerminal } from "@/lib/active-terminal-context";
import { useHasTouch } from "@/lib/viewport";
import { UiApiError, type SettingsTerminalBackend } from "@/lib/ui-api";
import { terminalBackendWarning } from "@/lib/terminal-backend-warning";
import type {
  TerminalSessionMetadata,
  TerminalSessionStatus,
} from "@/lib/terminal-protocol";
import {
  TerminalConnection,
  type TerminalConnectionState,
} from "@/lib/terminal-connection";
import {
  XtermViewport,
  type XtermViewportHandle,
} from "@/components/terminal/xterm-viewport";
import { TouchQuickActions } from "@/components/terminal/touch-quick-actions";
import { WriteComposerModal } from "@/components/terminal/write-composer-modal";
import { RenameTerminalModal } from "@/components/terminal/rename-terminal-modal";
import { Button } from "@/components/ui/button";
import { ModalShell } from "@/components/ui/modal-shell";
import { StatusDot, StatusSpinner } from "@/components/ui/status-dot";
import {
  contextPercent,
  formatTokenCount,
  hasMeaningfulTelemetry,
  shortModelName,
} from "@/lib/agent-telemetry";
import { cn, formatDuration } from "@/lib/utils";
import {
  computeTerminalKeyboardHeight,
  useVisualViewportHeight,
} from "@/lib/use-visual-viewport";
import {
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_SCROLLBACK_MAX,
  TERMINAL_SCROLLBACK_MIN,
  clampFontSize,
  clampScrollback,
  computeRedrawNudge,
  resolveScrollIntent,
  type ScrollDirection,
  persistCursorBlink,
  persistFontSize,
  persistQuickActionsVisible,
  persistScrollback,
  persistTouchOverride,
  readStoredCursorBlink,
  readStoredFontSize,
  readStoredQuickActionsVisible,
  readStoredScrollback,
  readStoredTouchOverride,
  resolveTouchTerminalMode,
  type TouchTerminalOverride,
} from "@/lib/touch-terminal";

interface WorktreeTerminalSectionProps {
  worktreePath: string;
  branchName?: string;
  /** Pending request to focus a specific session id (from another surface). */
  requestedSessionId?: string;
  /** Fires once the requested session id has been resolved into the active
   * tab — lets the caller clear its pending state. */
  onSessionFocused?: () => void;
}

function generateClientId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `c-${Math.random().toString(36).slice(2)}`;
  }
}

import {
  AGENT_PRESENTATION,
  terminalAgent,
  terminalLabel as agentTerminalLabel,
  type AgentPresentation,
} from "@/lib/terminal-agents";
import {
  offerFromSession,
  persistDismissedPluginState,
  readDismissedPluginState,
  shouldRenderOffer,
  type AgentPluginBannerKind,
  type AgentPluginBannerOffer,
} from "@/lib/agent-plugin-banner";

function pathBasename(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  return normalized.split("/").pop() || normalized || "terminal";
}

/* AgentPluginsBanner — quiet one-line nudge at the top of the Terminal panel
 * for the focused session's *actionable* plugin states only: `Install`
 * (missing) and `Update` (claude outdated). The benign "installed & current"
 * state is not a nudge — it lives in the header `PluginStatusButton` instead,
 * which opens a reinstall confirm dialog. After a successful action the banner
 * reminds that running agents need a `/plugin reload` or restart. Dismissal is
 * scoped to the detected `<agent>:<state>` and reappears when that changes. */
const GENERIC_PLUGIN_FAILURE =
  "Plugin action failed — check daemon logs, or enable Auto-inject in Settings → Terminal.";
const CLAUDE_CLI_MISSING =
  "The claude CLI was not found on PATH — install Claude Code first.";
const CODEX_CLI_MISSING =
  "The codex CLI was not found on PATH — install Codex first.";

function pluginFailureMessage(e: unknown): string {
  const message = e instanceof Error ? e.message : "";
  if (/codex-cli-not-found|codex.* not found/i.test(message)) {
    return CODEX_CLI_MISSING;
  }
  return /claude-cli-not-found|claude.* not found/i.test(message)
    ? CLAUDE_CLI_MISSING
    : GENERIC_PLUGIN_FAILURE;
}

function AgentPluginsBanner({
  offer,
}: {
  offer: AgentPluginBannerOffer | null;
}) {
  const api = useUiApi();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<AgentPluginBannerKind | null>(null);
  const [failureMessage, setFailureMessage] = useState<string | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(() =>
    readDismissedPluginState(),
  );

  // Reinstall (installed & current) is owned by the header button + dialog;
  // the banner only nudges the actionable missing / outdated states.
  const nudge = offer && offer.kind !== "reinstall" ? offer : null;

  // A change in the detected state retires any transient success/error so the
  // freshly-detected state gets a clean offer.
  const stateKey = nudge?.stateKey ?? null;
  useEffect(() => {
    setDone(null);
    setFailureMessage(null);
  }, [stateKey]);

  if (!nudge) return null;
  const transient = done !== null || failureMessage !== null;
  if (!transient && !shouldRenderOffer(nudge, dismissedKey)) return null;

  const agentLabel = AGENT_PRESENTATION[nudge.agent].label;

  const dismiss = () => {
    setDone(null);
    setFailureMessage(null);
    persistDismissedPluginState(nudge.stateKey);
    setDismissedKey(nudge.stateKey);
  };

  const runAction = async () => {
    setBusy(true);
    setFailureMessage(null);
    try {
      const res = await api.installAgentPlugins();
      // Codex install is best-effort and reports its outcome in the body (not as
      // a thrown error), so a codex offer judges success/failure from `res.codex`
      // — surfacing a typed `codex-cli-not-found` inline.
      if (nudge.agent === "codex") {
        if (res.codex.installed && !res.codex.error) {
          setDone(nudge.kind);
        } else if (res.codex.error === "codex-cli-not-found") {
          setFailureMessage(CODEX_CLI_MISSING);
        } else if (res.codex.error) {
          // Surface the real codex CLI failure (its first line) so a broken
          // codex install is diagnosable from the banner, not hidden behind the
          // generic message.
          const detail = (res.codex.message ?? "").split("\n")[0]?.trim();
          setFailureMessage(
            detail
              ? `Codex plugin install failed: ${detail}`
              : GENERIC_PLUGIN_FAILURE,
          );
        } else {
          setFailureMessage(GENERIC_PLUGIN_FAILURE);
        }
      } else if (
        res.claude.installed &&
        !res.claude.outdated &&
        res.opencode.installed
      ) {
        setDone(nudge.kind);
      } else {
        setFailureMessage(GENERIC_PLUGIN_FAILURE);
      }
    } catch (e) {
      setFailureMessage(pluginFailureMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="flex shrink-0 items-center gap-3 border-b border-white/10 bg-white/[0.04] px-3 py-2"
      data-testid="agent-plugins-banner"
    >
      <span className="min-w-0 flex-1 text-[12.5px] text-muted-foreground">
        {done !== null ? (
          <>
            {done === "update" ? "Plugin updated." : "Plugins installed."}{" "}
            Restart agent sessions (or run{" "}
            <code className="font-mono text-foreground">/plugin reload</code>{" "}
            in Claude Code) for the change to take effect.
          </>
        ) : failureMessage ? (
          failureMessage
        ) : nudge.kind === "install" ? (
          `The wos ${agentLabel} plugin isn't installed — agent status and questions won't appear in the sidebar.`
        ) : (
          `A newer wos ${agentLabel} plugin is available — updates apply to new agent sessions.`
        )}
      </span>
      {done === null && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void runAction()}
          data-testid={`agent-plugins-${nudge.kind}`}
          className="h-7 shrink-0"
        >
          {busy ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
          {nudge.kind === "install" ? "Install" : "Update"}
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        onClick={dismiss}
        data-testid="agent-plugins-dismiss"
        className="h-7 shrink-0 text-muted-foreground"
      >
        {done !== null ? "Got it" : "Dismiss"}
      </Button>
    </div>
  );
}

/* Header affordance shown when the focused session runs claude with the wos
 * plugin installed and current. Its presence (and the calm leading dot) reads
 * as "plugin active"; clicking opens the reinstall confirm dialog — a clean
 * uninstall→reinstall repair for a stale/corrupt registry. Claude-only:
 * OpenCode has no versioned registry to repair. */
function PluginStatusButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      size="icon"
      variant="ghost"
      className="relative h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
      onClick={onClick}
      data-testid="terminal-plugin-status"
      aria-label="wos Claude Code plugin installed — reinstall"
      title="wos Claude Code plugin · installed and up to date — click to reinstall"
    >
      <Puzzle className="h-3.5 w-3.5" />
      <span className="absolute right-[5px] top-[5px] h-[5px] w-[5px] rounded-full bg-[color:var(--good)] ring-2 ring-black" />
    </Button>
  );
}

/* Confirm dialog behind the header `PluginStatusButton`. A reinstall is a
 * benign repair, not a destructive action, so the shell stays calm (no red).
 * Manages its own request lifecycle: idle → busy → done, surfacing a typed
 * failure inline and, on success, the `/plugin reload` requirement. */
function PluginReinstallModal({ onClose }: { onClose: () => void }) {
  const api = useUiApi();
  const [phase, setPhase] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  const reinstall = async () => {
    setPhase("busy");
    setError(null);
    try {
      const res = await api.reinstallAgentPlugins();
      if (res.claude.installed && !res.claude.outdated) {
        setPhase("done");
      } else {
        setPhase("idle");
        setError(GENERIC_PLUGIN_FAILURE);
      }
    } catch (e) {
      setPhase("idle");
      setError(pluginFailureMessage(e));
    }
  };

  const busy = phase === "busy";
  return (
    <ModalShell
      testId="terminal-plugin-reinstall-modal"
      ariaLabel="Reinstall wos plugin"
      submitting={busy}
      onCancel={onClose}
    >
      <div className="border-b border-[color:var(--hair-2)] px-5 py-3">
        <div className="flex items-center gap-2 text-[color:var(--ink-2)]">
          <Puzzle className="h-4 w-4" />
          <span className="font-mono text-[10.5px] uppercase tracking-[0.22em]">
            wos Claude Code plugin
          </span>
        </div>
        <h2 className="mt-1 text-[16px] font-semibold tracking-tight text-[color:var(--ink)]">
          {phase === "done" ? "Plugin reinstalled" : "Reinstall plugin"}
        </h2>
      </div>
      <div className="space-y-3 px-5 py-4 text-sm">
        {phase === "done" ? (
          <p className="text-[color:var(--ink-2)]">
            The wos plugin was reinstalled. Reload it (run{" "}
            <code className="font-mono text-[color:var(--ink)]">
              /plugin reload
            </code>{" "}
            in Claude Code) or restart agent sessions for the change to take
            effect.
          </p>
        ) : (
          <>
            <p className="text-[color:var(--ink-2)]">
              This removes and reinstalls the wos Claude Code plugin to repair a
              stale or corrupt install. It is installed and up to date —
              reinstall only if activity tracking is misbehaving.
            </p>
            {error && (
              <p className="text-[13px] text-[color:var(--bad)]">{error}</p>
            )}
          </>
        )}
      </div>
      <div className="flex flex-col-reverse gap-2 border-t border-[color:var(--hair-2)] px-5 py-3 md:flex-row md:justify-end">
        {phase === "done" ? (
          <Button
            type="button"
            variant="solid"
            onClick={onClose}
            className="h-11 md:h-9"
          >
            Done
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={onClose}
              className="h-11 md:h-9"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="solid"
              disabled={busy}
              onClick={() => void reinstall()}
              data-testid="terminal-plugin-reinstall-confirm"
              className="h-11 md:h-9"
            >
              {busy ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCw className="mr-2 h-3.5 w-3.5" />
              )}
              Reinstall
            </Button>
          </>
        )}
      </div>
    </ModalShell>
  );
}

// Statuses that mean a session has finished running.
const COMPLETED_TERMINAL_STATUSES: ReadonlySet<TerminalSessionStatus> = new Set([
  "exited",
  "failed",
  "disposed",
]);

function isActiveSession(session: TerminalSessionMetadata): boolean {
  return !COMPLETED_TERMINAL_STATUSES.has(session.status);
}

/* Pick which session the tab list should focus. Keeps the anchored session if
 * it is still active; otherwise moves to the nearest active session by list
 * position, falling back to null when nothing is left to show. */
function pickFocusedSessionId(
  sessions: TerminalSessionMetadata[],
  anchorId: string | null,
): string | null {
  const anchorIndex = anchorId
    ? sessions.findIndex((s) => s.id === anchorId)
    : -1;
  if (anchorIndex === -1) {
    return sessions.find(isActiveSession)?.id ?? null;
  }
  for (let distance = 0; distance < sessions.length; distance++) {
    const after = sessions[anchorIndex + distance];
    if (after && isActiveSession(after)) return after.id;
    const before = sessions[anchorIndex - distance];
    if (before && isActiveSession(before)) return before.id;
  }
  return null;
}

/* Display label for this panel's surfaces (tabs / footer / terminate confirm).
 * Same precedence as the shared `terminalLabel` (user title → agent label →
 * fallback), but a plain shell falls back to the shell's own name (e.g.
 * `/bin/zsh` → `zsh`) rather than the worktree/project name. */
function terminalLabel(session: TerminalSessionMetadata, fallbackName: string): string {
  const shell = session.shell?.trim();
  const fallback = shell ? pathBasename(shell) : fallbackName;
  return agentTerminalLabel(session, fallback);
}

function terminalSubtitle(
  session: TerminalSessionMetadata,
  branchName: string | undefined,
): string {
  if (session.status === "exited") return "exited";
  if (session.activeCommand?.command) {
    return session.activeCommand.command.split("/").pop() ?? session.activeCommand.command;
  }
  return branchName ?? "shell";
}

/* Agent identity badge for a session tab: a rounded-square chip carrying the
 * detected agent's brand mark (tinted, or rendered as-is when full-colour), or
 * a neutral shell glyph for a plain terminal. Mirrors the demo's `.aglyph`. */
function SessionGlyph({ session }: { session: TerminalSessionMetadata }) {
  const agent = terminalAgent(session);
  if (!agent) {
    return (
      <span className="grid size-[20px] shrink-0 place-items-center rounded-[6px] text-[color:var(--muted-foreground)] [&_svg]:size-[15px]">
        <TerminalIcon strokeWidth={1.75} />
      </span>
    );
  }
  const Icon = agent.icon;
  if (agent.fullColor) {
    return (
      <span className="grid size-[20px] shrink-0 place-items-center rounded-[6px] bg-white/[0.08] [&_svg]:size-[14px]">
        <Icon />
      </span>
    );
  }
  return (
    <span
      className="grid size-[20px] shrink-0 place-items-center rounded-[6px] [&_svg]:size-[14px]"
      style={{
        background: `color-mix(in oklch, ${agent.brand} 22%, transparent)`,
        color: agent.brand,
      }}
    >
      <Icon strokeWidth={1.75} />
    </span>
  );
}

/* One session tab in the Terminal panel's horizontal session strip (desktop
 * only — phones switch sessions through the mobile Sessions sheet). Carries the
 * agent glyph + label + a quiet live/unread indicator, and its own close (×)
 * that opens the terminate confirm. Active is a soft fill + hairline. */
function SessionTab({
  session,
  active,
  label,
  onSelect,
  onClose,
}: {
  session: TerminalSessionMetadata;
  active: boolean;
  label: string;
  onSelect: () => void;
  onClose: () => void;
}) {
  const agent = terminalAgent(session);
  const live = session.status === "running" || session.status === "creating";
  const unread = Boolean(session.unreadSince);
  // Agent activity (reported by agent-side plugins) drives the tab's status
  // bead while the session is live, mirroring the rail's TerminalSessionRow: a
  // working agent shows a brand-tinted spinner, an awaiting-input agent an amber
  // "needs you" dot, an idle agent a hollow ring. A plain shell shows a green
  // dot only while a foreground process runs; an idle shell stays quiet.
  const activity = live ? session.agentActivity : undefined;
  const working = activity?.state === "working";
  return (
    <div
      role="tab"
      aria-selected={active}
      data-testid="terminal-session-tab"
      data-session-id={session.id}
      data-active={active ? "true" : undefined}
      onClick={onSelect}
      title={label}
      className={cn(
        "group/tab relative flex h-[30px] max-w-[230px] shrink-0 cursor-pointer items-center gap-2 rounded-[8px] border pl-2 pr-1 transition-colors",
        active
          ? "border-white/10 bg-white/[0.07] text-foreground"
          : "border-transparent text-[color:var(--muted-foreground)] hover:bg-white/[0.06] hover:text-foreground",
        !live && "opacity-60",
      )}
    >
      <SessionGlyph session={session} />
      {/* The name reserves its heaviest (bold) width with an invisible ghost so
       * the tab keeps a stable width when the visible weight changes on
       * select / unread — otherwise the strip nudges on every tab switch. */}
      <span className="relative min-w-0 flex-1">
        <span
          aria-hidden
          className="invisible block truncate text-[12.5px] font-bold"
        >
          {label}
        </span>
        <span
          className={cn(
            "absolute inset-0 truncate text-[12.5px]",
            unread
              ? "font-bold text-foreground"
              : active
                ? "font-semibold"
                : undefined,
          )}
        >
          {label}
        </span>
      </span>
      {/* Status bead — priority: needs-you (awaiting-input) > working
       * (spinner) > unread (blue) > idle agent (hollow) > running shell
       * (green). An idle plain shell stays quiet — selection conveys focus. */}
      {activity?.state === "awaiting-input" ? (
        <StatusDot
          variant="partial"
          size={7}
          title={activity.question?.summary ?? "Waiting for you"}
        />
      ) : working ? (
        <StatusSpinner
          size={10}
          color={agent?.brand}
          title={activity?.question?.summary}
        />
      ) : unread ? (
        <span
          aria-label="Unread output"
          className="size-1.5 shrink-0 rounded-full bg-[color:var(--unread)]"
        />
      ) : activity ? (
        <StatusDot variant="idle" size={7} />
      ) : live && session.activeCommand ? (
        <StatusDot variant="run" size={7} />
      ) : null}
      {/* Per-tab close (live sessions only — an exited tab carries no kill, it
       * ages out on the daemon's terminal.removed event, mirroring the rail). */}
      {live ? (
        <button
          type="button"
          data-testid="terminal-session-close"
          aria-label={`Close ${label}`}
          title="Close session"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className={cn(
            "grid size-[18px] shrink-0 place-items-center rounded-[5px] text-[color:var(--muted-foreground)] transition-opacity hover:bg-white/[0.14] hover:text-foreground [&_svg]:size-[13px]",
            active ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100",
          )}
        >
          <X strokeWidth={1.75} />
        </button>
      ) : (
        <span className="w-1 shrink-0" />
      )}
    </div>
  );
}

export function WorktreeTerminalSection({
  worktreePath,
  branchName,
  requestedSessionId,
  onSessionFocused,
}: WorktreeTerminalSectionProps) {
  const api = useUiApi();
  const events = useUnifiedEvents();
  const [sessions, setSessions] = useState<TerminalSessionMetadata[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Active terminal backend, read once so we can surface the outside-tmux
  // stability warning as a local accent when a session runs on `default`.
  const [terminalBackend, setTerminalBackend] =
    useState<SettingsTerminalBackend | null>(null);

  // Touch terminal mode: detection + persisted override.
  const [touchOverride, setTouchOverride] = useState<TouchTerminalOverride>(
    () => readStoredTouchOverride(),
  );
  const [coarsePointer, setCoarsePointer] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerWidth,
  );
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const mql = window.matchMedia("(pointer: coarse)");
    const handler = (e: MediaQueryListEvent) => setCoarsePointer(e.matches);
    setCoarsePointer(mql.matches);
    if (mql.addEventListener) mql.addEventListener("change", handler);
    else mql.addListener(handler);
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener("change", handler);
      else mql.removeListener(handler);
      window.removeEventListener("resize", onResize);
    };
  }, []);
  const touchMode = useMemo(
    () =>
      resolveTouchTerminalMode({
        override: touchOverride,
        coarsePointer,
        viewportWidth,
      }),
    [touchOverride, coarsePointer, viewportWidth],
  );
  const [quickActionsVisible, setQuickActionsVisible] = useState<boolean>(
    () => readStoredQuickActionsVisible() ?? true,
  );
  const updateQuickActionsVisible = useCallback((visible: boolean) => {
    setQuickActionsVisible(visible);
    persistQuickActionsVisible(visible);
  }, []);
  const updateTouchOverride = useCallback((next: TouchTerminalOverride) => {
    setTouchOverride(next);
    persistTouchOverride(next);
  }, []);
  // Touch capability independent of viewport width / primary pointer: a wide
  // touchscreen desktop reports `(pointer: coarse)` false (its trackpad is the
  // primary pointer) yet is touch-capable. We surface the touch-controls
  // affordance on such devices and, when tapped, pin the chrome on.
  const hasTouch = useHasTouch();
  const showTouchControls = useCallback(() => {
    if (!touchMode) updateTouchOverride("force-on");
    updateQuickActionsVisible(true);
  }, [touchMode, updateTouchOverride, updateQuickActionsVisible]);

  // Display preferences (global, persisted): applied to every terminal viewport.
  const [fontSize, setFontSize] = useState<number>(() => readStoredFontSize());
  const [scrollback, setScrollback] = useState<number>(() =>
    readStoredScrollback(),
  );
  const [cursorBlink, setCursorBlink] = useState<boolean>(() =>
    readStoredCursorBlink(),
  );
  const updateFontSize = useCallback((px: number) => {
    const clamped = clampFontSize(px);
    setFontSize(clamped);
    persistFontSize(clamped);
  }, []);
  const updateScrollback = useCallback((n: number) => {
    const clamped = clampScrollback(n);
    setScrollback(clamped);
    persistScrollback(clamped);
  }, []);
  const updateCursorBlink = useCallback((on: boolean) => {
    setCursorBlink(on);
    persistCursorBlink(on);
  }, []);

  const [settingsOpen, setSettingsOpen] = useState(false);

  const worktreeName = useMemo(() => pathBasename(worktreePath), [worktreePath]);

  const refresh = useCallback(async () => {
    try {
      const res = await api.listTerminalLayerSessions(worktreePath);
      setSessions(res.sessions);
      setError(null);
      setSelectedId((current) => pickFocusedSessionId(res.sessions, current));
    } catch (e) {
      if (e instanceof UiApiError && e.status === 503) {
        setError("Terminal sessions are not available on this daemon.");
      } else if (e instanceof UiApiError && e.status === 403) {
        setError("Terminal access is restricted to trusted local clients.");
      } else {
        setError((e as Error).message);
      }
    } finally {
      setLoading(false);
    }
  }, [api, worktreePath]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  // Resolve the effective terminal backend once; best-effort (a failure leaves
  // the warning hidden rather than blocking the panel).
  useEffect(() => {
    let cancelled = false;
    void api
      .getSettingsConfig()
      .then((res) => {
        if (!cancelled) setTerminalBackend(res.effective.terminalBackend);
      })
      .catch(() => {
        /* best-effort: leave the warning hidden */
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  /* Honour an external request to focus a specific terminal. We wait until
   * the session is present in the local list (it may not have streamed in
   * yet after a navigation) and then mark the request as consumed so the
   * upstream pending state clears. */
  useEffect(() => {
    if (!requestedSessionId) return;
    if (sessions.some((s) => s.id === requestedSessionId)) {
      setSelectedId(requestedSessionId);
      onSessionFocused?.();
    }
  }, [requestedSessionId, sessions, onSessionFocused]);

  /* Publish the focused session so the rail can mark it as selected. The
   * Terminal panel is the single writer; clearing on unmount drops the
   * highlight when the panel closes or the worktree changes. */
  const { setActiveSessionId } = useActiveTerminal();
  useEffect(() => {
    setActiveSessionId(selectedId);
  }, [selectedId, setActiveSessionId]);
  useEffect(() => () => setActiveSessionId(null), [setActiveSessionId]);

  useEffect(() => {
    if (!sessions.some((s) => s.status === "running" || s.status === "creating")) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      void refresh();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [refresh, sessions]);

  useEffect(() => {
    const unsubscribe = events.subscribe((env) => {
      if (
        env.type === "terminal.started" ||
        env.type === "terminal.exited" ||
        env.type === "terminal.removed" ||
        env.type === "terminal.attached" ||
        env.type === "terminal.detached" ||
        env.type === "terminal.control-changed" ||
        env.type === "terminal.updated"
      ) {
        const ev = env.event as { terminal: { worktreePath: string } };
        if (ev.terminal.worktreePath === worktreePath) {
          void refresh();
        }
      }
    });
    return unsubscribe;
  }, [events, refresh, worktreePath]);

  const startTerminal = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const res = await api.createTerminalLayerSession({ worktreePath });
      setSessions((prev) => [...prev, res.session]);
      setSelectedId(res.session.id);
    } catch (e) {
      if (e instanceof UiApiError && e.status === 503) {
        setError("Terminal sessions are not available on this daemon.");
      } else if (e instanceof UiApiError && e.status === 403) {
        setError("Terminal access is restricted to trusted local clients.");
      } else {
        setError((e as Error).message);
      }
    } finally {
      setCreating(false);
    }
  }, [api, worktreePath]);

  // No auto-start: a terminal is created only on an explicit user action (the
  // rail's "New terminal" action or the empty-state "Start terminal" button).
  // Switching worktrees never spawns a session — a worktree with no sessions
  // simply shows the empty state.

  const [pendingTerminationId, setPendingTerminationId] = useState<string | null>(
    null,
  );
  const [terminating, setTerminating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const pendingTermination = useMemo(
    () =>
      pendingTerminationId
        ? sessions.find((s) => s.id === pendingTerminationId) ?? null
        : null,
    [pendingTerminationId, sessions],
  );

  const renaming = useMemo(
    () =>
      renamingId ? sessions.find((s) => s.id === renamingId) ?? null : null,
    [renamingId, sessions],
  );

  const confirmTerminate = useCallback(async () => {
    if (!pendingTerminationId) return;
    setTerminating(true);
    try {
      await api.terminateTerminalLayerSession(pendingTerminationId);
      await refresh();
      setPendingTerminationId(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTerminating(false);
    }
  }, [api, pendingTerminationId, refresh]);

  const selected = useMemo(
    () => sessions.find((s) => s.id === selectedId) ?? null,
    [sessions, selectedId],
  );

  // Tabs list only live sessions — a completed (exited / failed / disposed)
  // session is dropped from the strip entirely; `pickFocusedSessionId` already
  // moves focus off it, so the body never strands on a hidden tab.
  const tabSessions = useMemo(
    () => sessions.filter(isActiveSession),
    [sessions],
  );

  const selectedTitle = selected
    ? terminalLabel(selected, worktreeName)
    : "Terminal";

  // Plugin offer for the focused session: install / update drive the banner;
  // the benign "reinstall" state surfaces as the header status button.
  const pluginOffer = useMemo(() => offerFromSession(selected), [selected]);
  const [pluginModalOpen, setPluginModalOpen] = useState(false);

  // Outside-tmux stability warning: a local accent shown once a session exists
  // and the active backend is `default`. Never global page chrome.
  const backendWarning = terminalBackendWarning(terminalBackend ?? undefined);

  return (
    <section className="reveal dark flex min-h-0 min-w-0 flex-1 overflow-hidden bg-black text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Session strip — the panel's horizontal tabs. Each session is a tab
         * (glyph + name + live/unread bead + its own ×); the trailing + opens a
         * new terminal in this same worktree. Desktop only: phones switch
         * sessions through the mobile Sessions sheet, so the strip would only
         * duplicate it. */}
        {tabSessions.length > 0 && (
          <div
            role="tablist"
            aria-label="Terminal sessions"
            data-testid="terminal-session-tabs"
            className="hidden h-[42px] shrink-0 items-center gap-0.5 overflow-x-auto border-b border-white/10 bg-black px-1.5 [scrollbar-width:none] lg:flex [&::-webkit-scrollbar]:hidden"
          >
            {tabSessions.map((session) => (
              <SessionTab
                key={session.id}
                session={session}
                active={session.id === selectedId}
                label={terminalLabel(session, worktreeName)}
                onSelect={() => setSelectedId(session.id)}
                onClose={() => setPendingTerminationId(session.id)}
              />
            ))}
            <button
              type="button"
              data-testid="terminal-session-new"
              aria-label="New terminal session"
              title="New terminal session"
              disabled={creating}
              onClick={startTerminal}
              className="ml-1 grid size-7 shrink-0 place-items-center rounded-[8px] text-[color:var(--muted-foreground)] transition-colors hover:bg-white/[0.06] hover:text-foreground disabled:opacity-50 [&_svg]:size-4"
            >
              {creating ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Plus strokeWidth={1.75} />
              )}
            </button>
          </div>
        )}
        <AgentPluginsBanner offer={pluginOffer} />
        {backendWarning && selected && (
          <div
            className="flex shrink-0 items-center gap-2 border-b border-white/10 bg-white/[0.03] px-3 py-1.5 text-[12px] text-[color:var(--warn)]"
            data-testid="terminal-backend-warning"
          >
            <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-[color:var(--warn)]" />
            {backendWarning}
          </div>
        )}
        {error && (
          <div className="border-b border-border/70 bg-[color:var(--signal-error-soft)] px-4 py-1.5 text-[12px] text-[color:var(--signal-error)]">
            {error}
          </div>
        )}
        <div className="min-h-0 flex-1 bg-black">
          {loading ? (
            <div className="flex h-full items-center justify-center font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
              <span className="status-dot status-dot--info status-dot--pulse mr-2" />
              loading…
            </div>
          ) : !selected ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <TerminalIcon className="h-8 w-8 text-muted-foreground/40" />
              <div className="text-sm text-muted-foreground">
                No terminal session for this worktree yet.
              </div>
              <Button size="sm" onClick={startTerminal} disabled={creating}>
                <Plus className="mr-1.5 h-3 w-3" />
                Start terminal
              </Button>
            </div>
          ) : (
            <TerminalView
              session={selected}
              api={api}
              key={selected.id}
              touchMode={touchMode}
              coarsePointer={coarsePointer}
              hasTouch={hasTouch}
              quickActionsVisible={quickActionsVisible}
              onSetQuickActionsVisible={updateQuickActionsVisible}
              onShowTouchControls={showTouchControls}
              fontSize={fontSize}
              scrollback={scrollback}
              cursorBlink={cursorBlink}
              footer={{
                label: selectedTitle,
                onOpenSettings: () => setSettingsOpen(true),
                onRename: () => setRenamingId(selected.id),
                onTerminate: () => setPendingTerminationId(selected.id),
                showReinstall: pluginOffer?.kind === "reinstall",
                onReinstall: () => setPluginModalOpen(true),
              }}
            />
          )}
        </div>
      </div>
      {settingsOpen && (
        <TerminalSheet
          ariaLabel="Terminal display settings"
          onClose={() => setSettingsOpen(false)}
          testId="terminal-display-settings"
        >
          <TerminalDisplaySettings
            fontSize={fontSize}
            scrollback={scrollback}
            cursorBlink={cursorBlink}
            touchOverride={touchOverride}
            touchMode={touchMode}
            onFontSize={updateFontSize}
            onScrollback={updateScrollback}
            onCursorBlink={updateCursorBlink}
            onTouchOverride={updateTouchOverride}
          />
        </TerminalSheet>
      )}
      {pendingTermination && (
        <TerminateSessionModal
          label={terminalLabel(pendingTermination, worktreeName)}
          subtitle={terminalSubtitle(pendingTermination, branchName)}
          submitting={terminating}
          onCancel={() => setPendingTerminationId(null)}
          onConfirm={confirmTerminate}
        />
      )}
      {renaming && (
        <RenameTerminalModal
          session={renaming}
          fallbackLabel={worktreeName}
          onClose={() => setRenamingId(null)}
        />
      )}
      {pluginModalOpen && (
        <PluginReinstallModal onClose={() => setPluginModalOpen(false)} />
      )}
    </section>
  );
}

function TerminateSessionModal({
  label,
  subtitle,
  submitting,
  onCancel,
  onConfirm,
}: {
  label: string;
  subtitle: string;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <ModalShell
      testId="terminal-terminate-modal"
      ariaLabel="Terminate terminal session"
      submitting={submitting}
      onCancel={onCancel}
    >
      <div className="border-b border-border bg-[color:var(--signal-error-soft)]/40 px-5 py-3">
        <div className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-[color:var(--signal-error)]">
          destructive action
        </div>
        <h2 className="mt-0.5 text-[16px] font-semibold tracking-tight">
          Terminate terminal session
        </h2>
      </div>
      <div className="space-y-3 px-5 py-4 text-sm">
        <p className="text-muted-foreground">
          The PTY will be killed and any unsaved in-process state lost. Running
          processes (agent CLIs, dev servers) will receive SIGTERM.
        </p>
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
          <div className="text-[13px] font-medium">{label}</div>
          <div className="mt-0.5 font-mono text-[11.5px] text-muted-foreground">
            {subtitle}
          </div>
        </div>
      </div>
      <div className="flex flex-col-reverse gap-2 border-t border-border bg-muted/20 px-5 py-3 md:flex-row md:justify-end">
        <Button
          type="button"
          variant="outline"
          disabled={submitting}
          onClick={onCancel}
          className="h-11 md:h-9"
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={submitting}
          onClick={() => onConfirm()}
          data-testid="terminal-terminate-confirm"
          className="h-11 md:h-9"
        >
          {submitting ? (
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
          ) : (
            <X className="mr-2 h-3.5 w-3.5" />
          )}
          Terminate
        </Button>
      </div>
    </ModalShell>
  );
}

interface TerminalViewProps {
  session: TerminalSessionMetadata;
  api: ReturnType<typeof useUiApi>;
  touchMode: boolean;
  /** True on coarse-pointer devices that raise an on-screen keyboard. */
  coarsePointer: boolean;
  /** Device has touch input (any pointer coarse), even on a wide screen. */
  hasTouch: boolean;
  quickActionsVisible: boolean;
  onSetQuickActionsVisible: (visible: boolean) => void;
  /** Reveal the touch chrome, pinning touch mode on if it was off. */
  onShowTouchControls: () => void;
  fontSize: number;
  scrollback: number;
  cursorBlink: boolean;
  /** When set, render the terminal footer bar (session telemetry + relocated
   * controls). Omitted by hosts that own their own chrome (Mission Control
   * Focus), which then show no footer. */
  footer?: TerminalFooterControls;
}

/** Footer wiring supplied by the host that owns the session lifecycle. */
interface TerminalFooterControls {
  /** Focused session's display label, shown in the footer meta. */
  label: string;
  /** Open display settings / rename / terminate the focused session. */
  onOpenSettings: () => void;
  onRename: () => void;
  onTerminate: () => void;
  /** Show the plugin-reinstall affordance (claude installed & current). */
  showReinstall: boolean;
  onReinstall: () => void;
}

export function TerminalView({
  session,
  api,
  touchMode,
  coarsePointer,
  hasTouch,
  quickActionsVisible,
  onSetQuickActionsVisible,
  onShowTouchControls,
  fontSize,
  scrollback,
  cursorBlink,
  footer,
}: TerminalViewProps) {
  const viewportRef = useRef<XtermViewportHandle | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const connectionRef = useRef<TerminalConnection | null>(null);
  const [state, setState] = useState<TerminalConnectionState>("connecting");
  const [isController, setIsController] = useState<boolean>(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [scrollState, setScrollState] = useState<{
    atBottom: boolean;
    altBuffer: boolean;
  }>({ atBottom: true, altBuffer: false });
  const clientIdRef = useRef<string>(generateClientId());

  // Exited sessions: render a notice in xterm, skip the WebSocket.
  useEffect(() => {
    if (session.status !== "exited") return;
    const t = viewportRef.current;
    if (!t) return;
    t.writeln(
      `[session exited at ${session.exit?.exitedAt ?? "unknown time"}]`,
    );
  }, [session.status, session.exit?.exitedAt]);

  useEffect(() => {
    if (session.status === "exited") {
      setState("exited");
      return undefined;
    }
    const url = api.terminalLayerAttachUrl(session.id);
    // The session snapshot's cols/rows reflect the PTY's last known size —
    // possibly from a previous browser window of a different size. The
    // xterm viewport this parent owns has already finished its synchronous
    // initial fit (see `XtermViewport`'s `useLayoutEffect`), so its
    // `measure()` is the authoritative dims for THIS browser tab.
    const measured = viewportRef.current?.measure();
    const initialCols = measured?.cols ?? session.cols;
    const initialRows = measured?.rows ?? session.rows;
    // Belt-and-suspenders: if for any reason `measure()` was unavailable at
    // construction (e.g. the viewport mounted after this effect), re-sync
    // dims as soon as the handshake completes so the PTY can never be left
    // pinned to a stale snapshot size.
    let syncedDims = false;
    const syncDimsIfReady = () => {
      if (syncedDims) return;
      const c = connectionRef.current;
      const viewport = viewportRef.current;
      if (!c || !viewport) return;
      const m = viewport.measure();
      if (!m) return;
      syncedDims = true;
      c.sendResize(m.cols, m.rows);
    };
    const conn = new TerminalConnection({
      url,
      clientId: clientIdRef.current,
      cols: initialCols,
      rows: initialRows,
      desiredControl: "controller",
      listener: {
        onState(s) {
          setState(s);
          if (s === "live" || s === "replaying") {
            setErrorBanner(null);
            // hello-ack just arrived. Push the real viewport size so a
            // stale server-snapshot size cannot leave the PTY at the wrong
            // dimensions for the rest of the session.
            syncDimsIfReady();
          }
        },
        onOutput(data, replay) {
          viewportRef.current?.write(data, replay);
        },
        onReplayGap() {
          // Spec: reset the viewport when replay is unavailable; live output
          // resumes immediately.
          viewportRef.current?.reset();
        },
        onControl(_ownership, controller) {
          setIsController(controller);
        },
        onExit() {
          setState("exited");
        },
        onError(code, message, fatal) {
          if (code === "control-denied") return; // surfaced via control state
          if (code === "replay-gap") return;
          if (fatal || code === "version-unsupported" || code === "forbidden") {
            setErrorBanner(`${code}: ${message}`);
          }
        },
      },
    });
    connectionRef.current = conn;
    return () => {
      conn.dispose();
      connectionRef.current = null;
    };
    // Only re-attach when the session identity or its terminal lifecycle
    // changes — dimension snapshots flow through xterm's onResize callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, session.id, session.status]);

  // Desktop autofocus on open: when a terminal session is opened (this view
  // is keyed by session id, so it remounts per session), move keyboard focus
  // into the viewport once the connection is ready, so the user can type
  // immediately without clicking. Touch devices are excluded — focusing there
  // would raise the on-screen keyboard unprompted. The once-guard (reset by
  // the per-session remount) keeps a later reconnect from stealing focus back.
  const autoFocusedRef = useRef(false);
  useEffect(() => {
    if (touchMode || autoFocusedRef.current) return;
    if (session.status !== "running") return;
    if (state !== "live" && state !== "replaying") return;
    autoFocusedRef.current = true;
    viewportRef.current?.focus();
  }, [touchMode, session.status, state]);

  const handleInput = useCallback((data: string) => {
    connectionRef.current?.sendInput(data);
  }, []);

  const handleResize = useCallback((cols: number, rows: number) => {
    connectionRef.current?.sendResize(cols, rows);
  }, []);

  const takeControl = useCallback(() => {
    connectionRef.current?.requestControl();
  }, []);

  // Refresh control: re-fit the local viewport, then (for controllers) nudge
  // the PTY size off-and-back so a real SIGWINCH forces the foreground program
  // to repaint. Viewers cannot resize the PTY, so they get the re-fit only.
  const forceRedraw = useCallback(() => {
    const viewport = viewportRef.current;
    viewport?.refit();
    if (!isController) return;
    const conn = connectionRef.current;
    const dims = viewport?.measure();
    if (!conn || !dims) return;
    const { off, restore } = computeRedrawNudge(dims);
    conn.sendResize(off.cols, off.rows);
    window.setTimeout(() => {
      connectionRef.current?.sendResize(restore.cols, restore.rows);
    }, 120);
  }, [isController]);

  // Scroll controls. In the normal buffer we move the local xterm scrollback
  // (no server round-trip, works for viewers). In the alternate screen buffer
  // there is no scrollback, so we synthesize a wheel gesture and let xterm emit
  // the mode-correct sequence (mouse-wheel report or arrow keys); that input is
  // gated to controllers inside the viewport's onData pipeline.
  const handleScroll = useCallback((direction: ScrollDirection) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const intent = resolveScrollIntent(direction, viewport.isAltBuffer());
    if (intent.kind === "wheel") {
      viewport.scrollWheel(intent.direction);
      return;
    }
    if (intent.action === "pages") viewport.scrollPages(intent.amount);
    else if (intent.action === "top") viewport.scrollToTop();
    else viewport.scrollToBottom();
  }, []);

  // Any non-controller may take control while the session is live. We do NOT
  // require a current controller: when the controlling attachment detaches the
  // server clears ownership to `null` without promoting anyone, so a lone
  // remaining viewer must still be able to grab control. The server's
  // `requestControl` is permissive — it transfers from the previous controller
  // if one exists, otherwise grants from the unowned state.
  const canRequestControl =
    state === "live" && session.status === "running" && !isController;
  const showTakeControl = canRequestControl;

  // Composer draft is preserved across opens so a viewer-only attachment can
  // request control without losing what they were drafting.
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerDraft, setComposerDraft] = useState("");

  // Keep the foreground program's bottom-anchored input line above the
  // on-screen keyboard. By default the keyboard shrinks only the visual
  // viewport, so a fixed-height terminal hides its bottom rows behind it. On a
  // coarse-pointer controller typing directly (Write Composer closed), we
  // subscribe to the visual viewport and, when the keyboard is up, clamp this
  // view's height to the keyboard-reduced visible area. xterm's ResizeObserver
  // then runs its debounced `safeFit`, reducing `rows` so the TUI redraws its
  // input line above the keyboard; the clamp is released on dismiss and it
  // refits back. Viewers never enter this path (gated on `isController`), so
  // they send no PTY resize. On Android with `interactive-widget=resizes-content`
  // the layout viewport (and so this container's natural height) shrinks too,
  // leaving the visible/natural heights ~equal — the helper returns null there
  // and the existing window-resize fit handles it instead.
  const keyboardTracking =
    coarsePointer && isController && session.status === "running";
  const visualViewportHeight = useVisualViewportHeight(keyboardTracking);
  const [keyboardHeight, setKeyboardHeight] = useState<number | null>(null);
  useEffect(() => {
    const el = rootRef.current;
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!el || !vv || !keyboardTracking || composerOpen) {
      setKeyboardHeight(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    // Visible height from this container's top down to the keyboard top, in
    // visual-viewport coordinates (offsetTop is non-zero only if the page
    // itself scrolled, which the fixed app shell prevents).
    const visibleForContainer = vv.height - (rect.top - vv.offsetTop);
    // Natural height comes from the parent block, which is unaffected by the
    // maxHeight clamp we apply to this container — so there is no feedback loop.
    const parent = el.parentElement;
    const availableHeight = parent ? parent.clientHeight : rect.height;
    setKeyboardHeight(
      computeTerminalKeyboardHeight({
        visualViewportHeight: visibleForContainer,
        availableHeight,
        coarsePointer,
        isController,
      }),
    );
  }, [
    visualViewportHeight,
    keyboardTracking,
    composerOpen,
    coarsePointer,
    isController,
  ]);

  const showTouchChrome =
    touchMode && quickActionsVisible && session.status === "running";

  // Floating scroll controls (touch only). Hidden for viewers in the alternate
  // screen buffer, where there is neither scrollback nor a way to page the app.
  const showScrollControls =
    touchMode &&
    session.status === "running" &&
    !(scrollState.altBuffer && !isController);

  return (
    <div
      ref={rootRef}
      className="relative flex h-full w-full flex-col"
      style={
        keyboardHeight != null ? { maxHeight: `${keyboardHeight}px` } : undefined
      }
    >
      <div className="relative min-h-0 flex-1">
        <XtermViewport
          ref={viewportRef}
          inputEnabled={isController && session.status === "running"}
          onInput={handleInput}
          onResize={handleResize}
          onScrollStateChange={setScrollState}
          exited={session.status === "exited" || state === "exited"}
          fontSize={fontSize}
          scrollback={scrollback}
          cursorBlink={cursorBlink}
          testId="worktree-terminal-view"
        />
        {state === "replaying" && (
          <div
            className="absolute inset-0 z-20 flex items-center justify-center bg-black"
            data-testid="terminal-replay-loader"
          >
            <div className="flex items-center gap-2 font-mono text-[12px] text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              replaying session…
            </div>
          </div>
        )}
        {state === "disconnected" && (
          <div className="absolute right-2 top-2 rounded-md bg-[color:var(--signal-warning-soft)] px-2 py-1 font-mono text-[11px] text-[color:var(--signal-warning)] shadow">
            disconnected — reconnecting…
          </div>
        )}
        {errorBanner && (
          <div className="absolute right-2 top-2 rounded-md bg-[color:var(--signal-error-soft)] px-2 py-1 font-mono text-[11px] text-[color:var(--signal-error)] shadow">
            {errorBanner}
          </div>
        )}
        {showTakeControl && !showTouchChrome && (
          <button
            type="button"
            onClick={takeControl}
            className="absolute bottom-2 right-2 rounded-md border border-border bg-background/80 px-2 py-1 font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground hover:bg-accent/30"
            data-testid="terminal-take-control"
          >
            take control
          </button>
        )}
        {(touchMode || hasTouch) &&
          !showTouchChrome &&
          session.status === "running" && (
            <button
              type="button"
              data-testid="terminal-touch-quick-actions-show"
              onClick={onShowTouchControls}
              style={{ touchAction: "manipulation" }}
              className="pointer-events-auto absolute bottom-2 left-2 z-10 flex items-center gap-1.5 rounded-md border border-white/10 bg-black/70 px-2 py-1 text-[11px] text-foreground shadow"
            >
              <Hand className="h-3 w-3" />
              Show touch controls
            </button>
          )}
        {showScrollControls && (
          <div
            className="pointer-events-none absolute inset-y-0 right-2 z-10 flex flex-col justify-center gap-1.5"
            data-testid="terminal-scroll-controls"
          >
            {!scrollState.altBuffer && (
              <ScrollControlButton
                label="Scroll to top"
                onClick={() => handleScroll("top")}
              >
                <ChevronsUp className="h-4 w-4" />
              </ScrollControlButton>
            )}
            <ScrollControlButton
              label="Page up"
              onClick={() => handleScroll("up")}
            >
              <ChevronUp className="h-4 w-4" />
            </ScrollControlButton>
            <ScrollControlButton
              label="Page down"
              onClick={() => handleScroll("down")}
            >
              <ChevronDown className="h-4 w-4" />
            </ScrollControlButton>
            {!scrollState.altBuffer && (
              <ScrollControlButton
                label="Scroll to bottom"
                emphasized={!scrollState.atBottom}
                onClick={() => handleScroll("bottom")}
              >
                <ChevronsDown className="h-4 w-4" />
              </ScrollControlButton>
            )}
          </div>
        )}
      </div>
      {showTouchChrome && (
        <div className="flex shrink-0 flex-col">
          <div className="flex items-center justify-between border-t border-white/10 bg-[#070707] px-2 py-1 text-[11px] text-muted-foreground">
            <span className="font-mono uppercase tracking-[0.2em]">touch</span>
            <button
              type="button"
              data-testid="terminal-touch-quick-actions-hide"
              onClick={() => onSetQuickActionsVisible(false)}
              className="rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
            >
              Hide
            </button>
          </div>
          <TouchQuickActions
            session={session}
            isController={isController}
            canRequestControl={canRequestControl}
            keyboardUp={keyboardHeight != null}
            onSendInput={handleInput}
            onRequestControl={takeControl}
            onOpenComposer={() => setComposerOpen(true)}
          />
        </div>
      )}
      {footer && (
        <TerminalFooter
          session={session}
          label={footer.label}
          isController={isController}
          connState={state}
          onRefresh={forceRedraw}
          onOpenSettings={footer.onOpenSettings}
          onRename={footer.onRename}
          onTerminate={footer.onTerminate}
          showReinstall={footer.showReinstall}
          onReinstall={footer.onReinstall}
        />
      )}
      {touchMode && (
        <WriteComposerModal
          open={composerOpen}
          initialDraft={composerDraft}
          isController={isController}
          canRequestControl={canRequestControl}
          onClose={() => setComposerOpen(false)}
          onSend={handleInput}
          onRequestControl={takeControl}
          onDraftChange={setComposerDraft}
        />
      )}
    </div>
  );
}

/* A footer control button — 28pt, hover-fill, mirrors the demo's `.icobtn`. */
function FooterButton({
  title,
  testId,
  onClick,
  className,
  children,
}: {
  title: string;
  testId?: string;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      data-testid={testId}
      onClick={onClick}
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-[7px] text-[color:var(--muted-foreground)] transition-colors hover:bg-white/[0.08] hover:text-foreground [&_svg]:size-[15px]",
        className,
      )}
    >
      {children}
    </button>
  );
}

/* Context fullness past which the meter + context numbers turn red. Mirrors
 * CONTEXT_WARN_PERCENT in telemetry-cluster.tsx — keep the two in lockstep. */
const FOOTER_CONTEXT_WARN_PERCENT = 90;

/* Terminal footer bar — the relocated session controls + telemetry. Left: a
 * health dot + the session name + a status word + the control state (you have
 * control / viewing) + a compact agent statusline (model · context meter +
 * context/window tokens · total tokens · session duration). Right: the
 * controls demoted from the old header — refresh (controllers only), display
 * settings, rename, and (mobile only, since the desktop session strip owns the
 * per-tab ×) terminate. Mirrors `.tfooter` in demo/worktree-header-v4.html. */
function TerminalFooter({
  session,
  label,
  isController,
  connState,
  onRefresh,
  onOpenSettings,
  onRename,
  onTerminate,
  showReinstall,
  onReinstall,
}: {
  session: TerminalSessionMetadata;
  label: string;
  isController: boolean;
  connState: TerminalConnectionState;
  onRefresh: () => void;
  onOpenSettings: () => void;
  onRename: () => void;
  onTerminate: () => void;
  showReinstall: boolean;
  onReinstall: () => void;
}) {
  const live = session.status === "running";
  const exited = session.status === "exited";
  const telemetry =
    live && session.agentTelemetry && hasMeaningfulTelemetry(session.agentTelemetry)
      ? session.agentTelemetry
      : null;
  // Tick a coarse clock while live so the session duration stays current during
  // idle gaps between telemetry pushes; frozen once the session is not live.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [live]);
  const durationText = formatDuration(now - new Date(session.createdAt).getTime());
  const ctxPercent = telemetry ? contextPercent(telemetry) : 0;
  const ctxWarn = ctxPercent >= FOOTER_CONTEXT_WARN_PERCENT;
  // Keep a rounded sliver visible whenever context carries real usage.
  const ctxFill = ctxPercent === 0 ? 0 : Math.max(ctxPercent, 8);
  const statusWord = exited
    ? "exited"
    : connState === "replaying"
      ? "replaying"
      : connState === "connecting" || connState === "disconnected"
        ? "connecting"
        : live
          ? "running"
          : session.status;
  // Control state reads only while the session is live and attached.
  const controlWord =
    live && (connState === "live" || connState === "replaying")
      ? isController
        ? "you have control"
        : "viewing"
      : null;
  const Sep = () => <span className="text-white/20">·</span>;
  return (
    <div
      data-testid="terminal-footer"
      className="flex h-[38px] shrink-0 items-center gap-2.5 border-t border-white/10 bg-black pl-3 pr-1.5 font-mono text-[11px] text-[color:var(--muted-foreground)]"
    >
      <span className="flex min-w-0 items-center gap-2">
        <StatusDot variant={live ? "run" : "idle"} size={7} />
        <span
          className="truncate font-medium text-foreground"
          data-testid="terminal-footer-name"
          title={label}
        >
          {label}
        </span>
        <Sep />
        <span className="shrink-0">{statusWord}</span>
        {controlWord && (
          <>
            <Sep />
            <span
              className={cn(
                "shrink-0",
                controlWord === "viewing" && "text-[color:var(--warn)]",
              )}
            >
              {controlWord}
            </span>
          </>
        )}
        {telemetry && (
          <>
            <Sep />
            {telemetry.model && (
              <span
                className="shrink-0 text-[color:var(--ink-2)]"
                data-testid="terminal-footer-model"
              >
                {shortModelName(telemetry.model)}
              </span>
            )}
            {/* context meter — mirrors the capsule in telemetry-cluster.tsx:
                hairline-ringed track with a fill that reds past the warn line. */}
            <span
              aria-hidden
              className="h-[5px] w-11 shrink-0 overflow-hidden rounded-full bg-[color:var(--hair)] shadow-[inset_0_0_0_0.5px_var(--hair-2)]"
            >
              <span
                className={cn(
                  "block h-full rounded-full transition-[width] duration-500 ease-out",
                  ctxWarn ? "bg-[color:var(--bad)]" : "bg-[color:var(--ink-2)]",
                )}
                style={{ width: `${ctxFill}%` }}
              />
            </span>
            <span
              className={cn(
                "shrink-0 tabular-nums",
                ctxWarn
                  ? "text-[color:var(--bad)]"
                  : "text-[color:var(--ink-2)]",
              )}
              data-testid="terminal-footer-telemetry"
            >
              {formatTokenCount(telemetry.contextUsed)}/
              {formatTokenCount(telemetry.contextWindow)}
            </span>
            <Sep />
            <span className="shrink-0 font-medium tabular-nums text-[color:var(--ink-2)]">
              {formatTokenCount(telemetry.mainTokens)}
            </span>
            {/* cache % / 5h / 7d slot in here once AgentTelemetry carries
                rate_limits + a cache split (see plan follow-ups). */}
          </>
        )}
        {live && (
          <>
            <Sep />
            <span
              className="shrink-0 tabular-nums"
              data-testid="terminal-footer-duration"
            >
              {durationText}
            </span>
          </>
        )}
      </span>
      <span className="flex-1" />
      {showReinstall && <PluginStatusButton onClick={onReinstall} />}
      {live && isController && (
        <FooterButton
          title="Refresh terminal (re-fit and repaint)"
          testId="terminal-footer-refresh"
          onClick={onRefresh}
        >
          <RotateCw strokeWidth={1.75} />
        </FooterButton>
      )}
      <FooterButton
        title="Display settings"
        testId="terminal-footer-settings"
        onClick={onOpenSettings}
      >
        <Settings2 strokeWidth={1.75} />
      </FooterButton>
      {live && (
        <FooterButton
          title="Rename session"
          testId="terminal-footer-rename"
          onClick={onRename}
        >
          <PenLine strokeWidth={1.75} />
        </FooterButton>
      )}
      {live && (
        <FooterButton
          title="Terminate session"
          testId="terminal-footer-terminate"
          onClick={onTerminate}
          className="hover:text-[color:var(--bad)] lg:hidden"
        >
          <X strokeWidth={1.75} />
        </FooterButton>
      )}
    </div>
  );
}

/* Dark bottom-sheet (centered dialog on md+) for the terminal's dark surface.
 * Portaled and `.dark`-scoped so the shared terminal styles resolve correctly
 * outside the section's own subtree. */
function TerminalSheet({
  ariaLabel,
  onClose,
  testId,
  children,
}: {
  ariaLabel: string;
  onClose: () => void;
  testId?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div
      className="dark fixed inset-0 z-50 flex items-end justify-center bg-black/55 p-0 backdrop-blur-sm md:items-center md:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      data-testid={testId}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="reveal flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-t-[22px] border border-white/10 bg-[#0a0a0a] text-foreground shadow-[0_30px_60px_-28px_rgba(0,0,0,0.7)] md:rounded-[14px]">
        <div className="flex shrink-0 justify-center pt-2.5 md:hidden">
          <div className="h-1 w-9 rounded-full bg-white/20" />
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function SettingsRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-1 py-2">
      <div className="flex min-w-0 flex-col">
        <span className="text-[13px] text-foreground">{label}</span>
        {hint && (
          <span className="text-[11px] text-muted-foreground">{hint}</span>
        )}
      </div>
      {children}
    </div>
  );
}

function Stepper({
  value,
  onDec,
  onInc,
  decDisabled,
  incDisabled,
  testId,
}: {
  value: string;
  onDec: () => void;
  onInc: () => void;
  decDisabled?: boolean;
  incDisabled?: boolean;
  testId?: string;
}) {
  const btn =
    "grid h-8 w-8 place-items-center rounded-md border border-white/10 bg-white/[0.04] text-foreground transition-colors hover:bg-white/[0.1] disabled:cursor-not-allowed disabled:opacity-40";
  return (
    <div className="flex items-center gap-2" data-testid={testId}>
      <button
        type="button"
        onClick={onDec}
        disabled={decDisabled}
        aria-label="Decrease"
        className={btn}
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <span className="min-w-[3.5rem] text-center text-[13px] tabular-nums text-foreground">
        {value}
      </span>
      <button
        type="button"
        onClick={onInc}
        disabled={incDisabled}
        aria-label="Increase"
        className={btn}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/* Global terminal display preferences, applied live and persisted by the
 * parent section. Also hosts the touch-controls activation mode (formerly a
 * standalone header button). */
function TerminalDisplaySettings({
  fontSize,
  scrollback,
  cursorBlink,
  touchOverride,
  touchMode,
  onFontSize,
  onScrollback,
  onCursorBlink,
  onTouchOverride,
}: {
  fontSize: number;
  scrollback: number;
  cursorBlink: boolean;
  touchOverride: TouchTerminalOverride;
  touchMode: boolean;
  onFontSize: (px: number) => void;
  onScrollback: (n: number) => void;
  onCursorBlink: (on: boolean) => void;
  onTouchOverride: (mode: TouchTerminalOverride) => void;
}) {
  const SCROLLBACK_STEP = 1000;
  const touchModes: { value: TouchTerminalOverride; label: string }[] = [
    { value: "auto", label: "Auto" },
    { value: "force-on", label: "On" },
    { value: "force-off", label: "Off" },
  ];
  return (
    <div className="flex flex-col px-4 pb-5 pt-1 text-foreground">
      <div className="px-1 pb-1 text-[13px] font-semibold">Display settings</div>

      <SettingsRow label="Font size">
        <Stepper
          value={`${fontSize}px`}
          onDec={() => onFontSize(fontSize - 1)}
          onInc={() => onFontSize(fontSize + 1)}
          decDisabled={fontSize <= TERMINAL_FONT_SIZE_MIN}
          incDisabled={fontSize >= TERMINAL_FONT_SIZE_MAX}
          testId="terminal-setting-font-size"
        />
      </SettingsRow>

      <SettingsRow label="Scrollback">
        <Stepper
          value={scrollback.toLocaleString()}
          onDec={() => onScrollback(scrollback - SCROLLBACK_STEP)}
          onInc={() => onScrollback(scrollback + SCROLLBACK_STEP)}
          decDisabled={scrollback <= TERMINAL_SCROLLBACK_MIN}
          incDisabled={scrollback >= TERMINAL_SCROLLBACK_MAX}
          testId="terminal-setting-scrollback"
        />
      </SettingsRow>

      <SettingsRow label="Cursor blink">
        <button
          type="button"
          role="switch"
          aria-checked={cursorBlink}
          data-testid="terminal-setting-cursor-blink"
          onClick={() => onCursorBlink(!cursorBlink)}
          className={cn(
            "relative h-6 w-10 shrink-0 rounded-full border border-white/10 transition-colors",
            cursorBlink ? "bg-white/30" : "bg-white/[0.06]",
          )}
        >
          <span
            className={cn(
              "absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-white transition-all",
              cursorBlink ? "left-[18px]" : "left-[2px]",
            )}
          />
        </button>
      </SettingsRow>

      <SettingsRow
        label="Touch controls"
        hint={
          touchOverride === "auto"
            ? `auto · ${touchMode ? "on" : "off"}`
            : undefined
        }
      >
        <div
          className="flex items-center gap-0.5 rounded-md border border-white/10 bg-white/[0.04] p-0.5"
          data-testid="terminal-setting-touch-mode"
        >
          {touchModes.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => onTouchOverride(m.value)}
              data-active={touchOverride === m.value ? "true" : "false"}
              className={cn(
                "h-7 rounded px-2.5 text-[12px] transition-colors",
                touchOverride === m.value
                  ? "bg-white/[0.16] text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
      </SettingsRow>
    </div>
  );
}

/* Round floating button for the touch scroll-control column. `emphasized`
 * marks the "jump to bottom" affordance when live output sits below the
 * current scrollback position. */
function ScrollControlButton({
  label,
  emphasized,
  onClick,
  children,
}: {
  label: string;
  emphasized?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      data-emphasized={emphasized ? "true" : "false"}
      style={{ touchAction: "manipulation" }}
      className={cn(
        "pointer-events-auto grid h-9 w-9 place-items-center rounded-full border text-foreground shadow-md transition-colors",
        emphasized
          ? "border-white/40 bg-white/25 ring-1 ring-white/40 active:bg-white/35"
          : "border-white/15 bg-[#161616]/95 active:bg-[#2a2a2a]/95",
      )}
    >
      {children}
    </button>
  );
}
