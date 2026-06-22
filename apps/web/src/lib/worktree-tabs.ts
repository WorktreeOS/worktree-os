import type { LogChannel } from "./ui-api";

/**
 * Worktree detail destinations. The selected worktree page is a single
 * full-width tabbed surface: `overview` is the work dossier, and `runtime`,
 * `review`, `files`, and `terminal` are the operational surfaces. `runtime`
 * owns launch, deployment progress, failure recovery, services, tunnels, and
 * channel-scoped logs — logs are not a standalone tab.
 */
export type WorktreeTab = "overview" | "runtime" | "review" | "files" | "terminal";

/**
 * Selected-tab state for the worktree detail route. There is no open/closed
 * panel state: the fallback destination is simply `tab: "overview"`. Exactly
 * one tab is the active full-width content area.
 */
export type WorktreeSurfaceState = {
  tab: WorktreeTab;
  /**
   * Selected runtime log channel. Channel-scoped logs render inside the
   * `runtime` tab, so this is meaningful whenever `tab === "runtime"`.
   */
  logsChannel: LogChannel | null;
  /**
   * One-shot terminal focus request: the `terminal` tab focuses the session
   * with this id on the next render. Cleared by
   * `selectTerminalSession(prev, null)` once the terminal surface has acted.
   */
  terminalSessionId: string | null;
};

export const WORKTREE_TABS: readonly WorktreeTab[] = [
  "overview",
  "runtime",
  "review",
  "files",
  "terminal",
];

/**
 * Global (not per-worktree) memory of the last selected worktree tab, so the
 * destination survives reloads and worktree switches.
 */
export const WORKTREE_TAB_STORAGE_KEY = "wos.worktree.tab";

/**
 * Legacy right-panel visibility storage. Read once for a soft migration onto
 * `WORKTREE_TAB_STORAGE_KEY`; never written by the tab model.
 */
export const LEGACY_RIGHT_PANEL_VISIBILITY_STORAGE_KEY =
  "wos.right-panel.visibility";

/**
 * Viewport widths below this threshold (iPad-sized screens and smaller) are
 * "compact": the touch chrome (mobile app bar + bottom navigation) leads and
 * the desktop tab strip + focus control are hidden, so no resize or dock
 * control is ever exposed there.
 */
export const COMPACT_VIEWPORT_PX = 1024;

/**
 * Map a stored tab string onto a current worktree tab. The legacy `logs` tab
 * was folded into `runtime`, so older values restore as `runtime`. Unknown
 * values return `null`.
 */
export function normalizeStoredTab(tab: string): WorktreeTab | null {
  if (tab === "logs") return "runtime";
  if (WORKTREE_TABS.includes(tab as WorktreeTab)) {
    return tab as WorktreeTab;
  }
  return null;
}

/** Fresh surface state for a given starting tab (defaults to `overview`). */
export function initialSurfaceState(
  tab: WorktreeTab = "overview",
): WorktreeSurfaceState {
  return {
    tab,
    logsChannel: tab === "runtime" ? "init" : null,
    terminalSessionId: null,
  };
}

/**
 * Select a worktree tab, preserving the runtime log channel and terminal focus
 * request that belong to the other operational tabs. Selecting `runtime`
 * defaults the log channel to `init` when none is set.
 */
export function selectTab(
  prev: WorktreeSurfaceState,
  tab: WorktreeTab,
  options: {
    logsChannel?: LogChannel | null;
    terminalSessionId?: string | null;
  } = {},
): WorktreeSurfaceState {
  return {
    tab,
    logsChannel:
      tab === "runtime"
        ? options.logsChannel ?? prev.logsChannel ?? "init"
        : prev.logsChannel,
    terminalSessionId:
      tab === "terminal"
        ? options.terminalSessionId ?? prev.terminalSessionId
        : prev.terminalSessionId,
  };
}

/**
 * Select a runtime log channel, switching to the `runtime` tab. Used by
 * service-row "Open logs", init-log, and failed-channel actions so they all
 * point at the one operational surface.
 */
export function setLogsChannel(
  prev: WorktreeSurfaceState,
  channel: LogChannel,
): WorktreeSurfaceState {
  return { ...prev, tab: "runtime", logsChannel: channel };
}

/**
 * Request that the terminal tab focus a specific session id. A real id selects
 * the `terminal` tab and focuses it; passing `null` clears a pending request in
 * place (after the terminal surface has acted) without changing the tab.
 */
export function selectTerminalSession(
  prev: WorktreeSurfaceState,
  sessionId: string | null,
): WorktreeSurfaceState {
  if (sessionId === null) {
    if (prev.terminalSessionId === null) return prev;
    return { ...prev, terminalSessionId: null };
  }
  return { ...prev, tab: "terminal", terminalSessionId: sessionId };
}

/**
 * Normalize the surface when the selected worktree changes. The selected tab,
 * focus mode, and log channel are preserved across the switch; only the
 * terminal session focus is cleared, because session ids are scoped to the
 * previous worktree. Log-channel availability for the next worktree is
 * reconciled once its detail loads (see `normalizeLogsChannelForServices`).
 */
export function normalizeTabForWorktreeSwitch(
  prev: WorktreeSurfaceState,
): WorktreeSurfaceState {
  if (prev.terminalSessionId === null) return prev;
  return { ...prev, terminalSessionId: null };
}

/**
 * Whether `channel` is selectable for a worktree whose services are
 * `serviceNames`. The synthetic `init` channel is always available; a
 * `service:<name>` channel is available only when that service still exists.
 */
export function logChannelAvailable(
  channel: LogChannel,
  serviceNames: readonly string[],
): boolean {
  if (channel === "init") return true;
  const name = channel.slice("service:".length);
  return serviceNames.includes(name);
}

/**
 * Fall back to the `init` logs channel when the current channel is not
 * available for the next worktree's services. Returns the state unchanged when
 * no channel is selected or the channel is still valid.
 */
export function normalizeLogsChannelForServices(
  prev: WorktreeSurfaceState,
  serviceNames: readonly string[],
): WorktreeSurfaceState {
  if (prev.logsChannel === null) return prev;
  if (logChannelAvailable(prev.logsChannel, serviceNames)) return prev;
  return { ...prev, logsChannel: "init" };
}

function resolveStorage(
  storage?: Pick<Storage, "getItem"> | null,
): Pick<Storage, "getItem"> | null {
  return (
    storage ??
    (typeof window !== "undefined" ? window.localStorage : null)
  );
}

/**
 * Migrate the legacy `wos.right-panel.visibility` value onto a worktree tab:
 *
 * - An open legacy panel restores the equivalent tab (`logs` → `runtime`).
 * - A closed legacy panel restores `overview` (the least-surprising default).
 *
 * Returns `null` when nothing valid is stored so callers fall back to overview.
 */
export function migrateLegacyPanelVisibility(
  storage?: Pick<Storage, "getItem"> | null,
): WorktreeTab | null {
  const store = resolveStorage(storage);
  if (!store) return null;
  try {
    const raw = store.getItem(LEGACY_RIGHT_PANEL_VISIBILITY_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const { open, tab } = parsed as { open?: unknown; tab?: unknown };
    if (typeof open !== "boolean") return null;
    if (open === false) return "overview";
    if (typeof tab !== "string") return null;
    return normalizeStoredTab(tab);
  } catch {
    return null;
  }
}

/**
 * Read the persisted worktree tab, preferring the new key and falling back to a
 * one-time migration of the legacy right-panel visibility. Returns `null` when
 * nothing valid is stored so callers can apply their own default.
 */
export function readStoredWorktreeTab(
  storage?: Pick<Storage, "getItem"> | null,
): WorktreeTab | null {
  const store = resolveStorage(storage);
  if (!store) return null;
  try {
    const raw = store.getItem(WORKTREE_TAB_STORAGE_KEY);
    if (raw !== null) {
      const normalized = normalizeStoredTab(raw);
      if (normalized !== null) return normalized;
    }
  } catch {
    /* storage unavailable */
  }
  return migrateLegacyPanelVisibility(store);
}

export function persistWorktreeTab(
  tab: WorktreeTab,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  const store =
    storage ??
    (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return;
  try {
    store.setItem(WORKTREE_TAB_STORAGE_KEY, tab);
  } catch {
    /* storage unavailable */
  }
}

/** The tab to land on for a fresh mount: persisted/migrated value or overview. */
export function initialWorktreeTab(
  storage?: Pick<Storage, "getItem"> | null,
): WorktreeTab {
  return readStoredWorktreeTab(storage) ?? "overview";
}
