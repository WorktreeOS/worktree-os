/**
 * Desktop project-sidebar width model.
 *
 * Mirrors the Review sidebar's clamped/persisted width helper
 * (`review-sidebar-logic.ts`): pure functions are easy to unit-test and keep
 * viewport concerns out of React state. Scoped to the desktop left rail only —
 * the mobile bottom-sheet navigator never reads or writes this width.
 */

export const SIDEBAR_WIDTH_STORAGE_KEY = "wos.sidebar.width";
/** Narrowest the rail may shrink before branch names stop scanning well. */
export const SIDEBAR_MIN_WIDTH = 208;
/** The historical fixed rail width (`w-[16rem]`). */
export const SIDEBAR_DEFAULT_WIDTH = 256;
/** Absolute cap so a wide monitor cannot turn the rail into a half-screen. */
export const SIDEBAR_MAX_WIDTH = 480;
/** Horizontal space reserved for the worktree detail area beside the rail. */
export const SIDEBAR_RESERVED_LAYOUT = 640;

/**
 * Largest width the rail may take for a given viewport: bounded by the absolute
 * cap and by leaving `SIDEBAR_RESERVED_LAYOUT` for the worktree detail area.
 * Never returns below `SIDEBAR_MIN_WIDTH` so the rail stays usable on narrow
 * desktops.
 */
export function getSidebarMaxWidth(viewport: number): number {
  const viewportUpper = Math.max(
    SIDEBAR_MIN_WIDTH,
    viewport - SIDEBAR_RESERVED_LAYOUT,
  );
  return Math.min(SIDEBAR_MAX_WIDTH, viewportUpper);
}

/**
 * Clamp a raw width into the safe range for the current viewport. Invalid
 * values (NaN/Infinity) fall back to the default, itself capped by the
 * viewport-derived maximum.
 */
export function clampSidebarWidth(raw: number, viewport: number): number {
  const upper = getSidebarMaxWidth(viewport);
  if (!Number.isFinite(raw)) {
    return Math.min(SIDEBAR_DEFAULT_WIDTH, upper);
  }
  return Math.min(Math.max(raw, SIDEBAR_MIN_WIDTH), upper);
}

export function readStoredSidebarWidth(
  storage?: Pick<Storage, "getItem"> | null,
): number | null {
  const store =
    storage ??
    (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return null;
  try {
    const raw = store.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function persistSidebarWidth(
  width: number,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  const store =
    storage ??
    (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return;
  try {
    store.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(width)));
  } catch {
    /* storage unavailable */
  }
}
