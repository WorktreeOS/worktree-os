/**
 * Right-docked worktree-panel width model.
 *
 * Mirrors the desktop rail's width helper (`sidebar-width.ts`): pure functions
 * are easy to unit-test and keep viewport concerns out of React state. The
 * panel is a desktop-only split-pane affordance — the touch full-screen worktree
 * surface never reads or writes this width.
 *
 * Unlike the rail, the panel clamp is also *rail-aware*: the largest panel for a
 * viewport leaves room for both the current rail width and a minimum center
 * column (`panel ≤ viewport − railWidth − centerMin`), so rail + panel together
 * can never hide the center content (for example the board behind the panel).
 */

export const PANEL_WIDTH_STORAGE_KEY = "wos.worktree-panel.width";
/** Narrowest the panel may shrink before the compact chrome stops fitting. */
export const PANEL_MIN_WIDTH = 400;
/** Comfortable default panel width (compact dossier chrome). */
export const PANEL_DEFAULT_WIDTH = 560;
/** Absolute cap so a wide monitor cannot turn the panel into a half-screen. */
export const PANEL_MAX_WIDTH = 760;
/** Minimum horizontal space reserved for the center content beside rail+panel. */
export const PANEL_CENTER_MIN = 420;

/**
 * Largest width the panel may take for a given viewport and current rail width:
 * bounded by the absolute cap and by leaving the rail plus a minimum center
 * column visible. Never returns below `PANEL_MIN_WIDTH` so the panel stays
 * usable even on narrow desktops (the shell still guarantees a single instance,
 * so an overlap here is preferable to a zero-width panel).
 */
export function getPanelMaxWidth(viewport: number, railWidth: number): number {
  const viewportUpper = Math.max(
    PANEL_MIN_WIDTH,
    viewport - railWidth - PANEL_CENTER_MIN,
  );
  return Math.min(PANEL_MAX_WIDTH, viewportUpper);
}

/**
 * Clamp a raw width into the safe range for the current viewport and rail width.
 * Invalid values (NaN/Infinity) fall back to the default, itself capped by the
 * viewport/rail-derived maximum.
 */
export function clampPanelWidth(
  raw: number,
  viewport: number,
  railWidth: number,
): number {
  const upper = getPanelMaxWidth(viewport, railWidth);
  if (!Number.isFinite(raw)) {
    return Math.min(PANEL_DEFAULT_WIDTH, upper);
  }
  return Math.min(Math.max(raw, PANEL_MIN_WIDTH), upper);
}

export function readStoredPanelWidth(
  storage?: Pick<Storage, "getItem"> | null,
): number | null {
  const store =
    storage ??
    (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return null;
  try {
    const raw = store.getItem(PANEL_WIDTH_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function persistPanelWidth(
  width: number,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  const store =
    storage ??
    (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return;
  try {
    store.setItem(PANEL_WIDTH_STORAGE_KEY, String(Math.round(width)));
  } catch {
    /* storage unavailable */
  }
}
