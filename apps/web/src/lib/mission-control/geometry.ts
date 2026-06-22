/**
 * Pure pane-geometry math for the Mission Control wall.
 *
 * Captured screens have wildly different native geometries (e.g. 221×56 vs
 * 80×24) and the wall cannot resize the live pane to fit (that would SIGWINCH
 * the real interactive viewer). So normalization happens on the client: each
 * mode maps a screen `{ cols, rows }` and a card pixel box to a font size and
 * the slice of rows to render. All functions here are pure and synchronous.
 */

export const GEOMETRY_MODES = [
  "hybrid",
  "proportional",
  "fit",
  "top",
  "bottom",
  "native",
] as const;

export type GeometryMode = (typeof GEOMETRY_MODES)[number];

export const DEFAULT_GEOMETRY_MODE: GeometryMode = "hybrid";

/** Monospace cell metrics as multiples of the font size. */
const CHAR_ASPECT = 0.6; // cell width / font-size
const LINE_HEIGHT = 1.2; // cell height / font-size

/** Font-size clamp (px) for scaled modes. */
export const MC_FONT_MIN = 4;
export const MC_FONT_MAX = 16;

/** Columns above which `hybrid` treats a pane as "wide" → fit-to-width thumbnail. */
export const HYBRID_WIDE_COLS = 120;

/** Readable font (px) used by `hybrid` for narrow panes and as the `native` size. */
export const READABLE_FONT = 11;
export const NATIVE_FONT = 13;

export interface CardBox {
  width: number;
  height: number;
}

export interface ScreenGeometry {
  cols: number;
  rows: number;
}

export interface PaneLayout {
  /** Font size (px) to render the snapshot at. */
  fontSize: number;
  /** Pixel width the rendered content occupies. */
  contentWidth: number;
  /** Pixel height the rendered content occupies. */
  contentHeight: number;
  /** Half-open slice of snapshot rows to render: `[start, end)`. */
  visibleRows: { start: number; end: number };
  /** Where partial views anchor; `none` when the whole screen is shown. */
  anchor: "top" | "bottom" | "none";
}

function clampFont(px: number): number {
  if (!Number.isFinite(px)) return MC_FONT_MIN;
  return Math.max(MC_FONT_MIN, Math.min(MC_FONT_MAX, px));
}

export function cellWidth(fontSize: number): number {
  return fontSize * CHAR_ASPECT;
}

export function cellHeight(fontSize: number): number {
  return fontSize * LINE_HEIGHT;
}

/** Largest clamped font that fits the whole grid inside the box on both axes. */
export function fitFontSize(box: CardBox, geom: ScreenGeometry): number {
  const byWidth = box.width / Math.max(1, geom.cols * CHAR_ASPECT);
  const byHeight = box.height / Math.max(1, geom.rows * LINE_HEIGHT);
  return clampFont(Math.min(byWidth, byHeight));
}

/** Font that scales the grid to the box width (rows may then overflow height). */
function fitWidthFontSize(box: CardBox, geom: ScreenGeometry): number {
  return clampFont(box.width / Math.max(1, geom.cols * CHAR_ASPECT));
}

/** How many rows fit in the box at a given font size. */
function rowsThatFit(box: CardBox, fontSize: number): number {
  return Math.max(1, Math.floor(box.height / cellHeight(fontSize)));
}

function wholeScreen(
  fontSize: number,
  geom: ScreenGeometry,
): PaneLayout {
  return {
    fontSize,
    contentWidth: geom.cols * cellWidth(fontSize),
    contentHeight: geom.rows * cellHeight(fontSize),
    visibleRows: { start: 0, end: geom.rows },
    anchor: "none",
  };
}

/** Compute the per-pane layout for a mode, screen geometry, and card box. */
export function computePaneLayout(
  mode: GeometryMode,
  geom: ScreenGeometry,
  box: CardBox,
): PaneLayout {
  const safeGeom: ScreenGeometry = {
    cols: Math.max(1, Math.floor(geom.cols)),
    rows: Math.max(1, Math.floor(geom.rows)),
  };

  if (mode === "fit") {
    return wholeScreen(fitFontSize(box, safeGeom), safeGeom);
  }

  if (mode === "native") {
    return wholeScreen(NATIVE_FONT, safeGeom);
  }

  if (mode === "proportional") {
    // Fixed height (the card box height); width follows the true cols×rows
    // aspect so nothing is clipped. The wall lays proportional cards out at
    // their derived width rather than in a uniform grid.
    const fontSize = clampFont(box.height / (safeGeom.rows * LINE_HEIGHT));
    return {
      fontSize,
      contentWidth: safeGeom.cols * cellWidth(fontSize),
      contentHeight: box.height,
      visibleRows: { start: 0, end: safeGeom.rows },
      anchor: "none",
    };
  }

  if (mode === "top" || mode === "bottom") {
    const fontSize = fitWidthFontSize(box, safeGeom);
    const fit = rowsThatFit(box, fontSize);
    if (fit >= safeGeom.rows) {
      return wholeScreen(fontSize, safeGeom);
    }
    const visibleRows =
      mode === "top"
        ? { start: 0, end: fit }
        : { start: safeGeom.rows - fit, end: safeGeom.rows };
    return {
      fontSize,
      contentWidth: safeGeom.cols * cellWidth(fontSize),
      contentHeight: fit * cellHeight(fontSize),
      visibleRows,
      anchor: mode,
    };
  }

  // hybrid: wide screens become a fit-to-width thumbnail showing the whole
  // grid; narrow screens render at a readable font anchored to the latest rows.
  if (safeGeom.cols > HYBRID_WIDE_COLS) {
    return wholeScreen(fitFontSize(box, safeGeom), safeGeom);
  }
  const fontSize = READABLE_FONT;
  const fit = rowsThatFit(box, fontSize);
  if (fit >= safeGeom.rows) {
    return wholeScreen(fontSize, safeGeom);
  }
  return {
    fontSize,
    contentWidth: safeGeom.cols * cellWidth(fontSize),
    contentHeight: fit * cellHeight(fontSize),
    visibleRows: { start: safeGeom.rows - fit, end: safeGeom.rows },
    anchor: "bottom",
  };
}

/** Human label for a geometry mode (UI control). */
export function geometryModeLabel(mode: GeometryMode): string {
  switch (mode) {
    case "hybrid":
      return "Hybrid";
    case "proportional":
      return "Proportional";
    case "fit":
      return "Fit";
    case "top":
      return "Top";
    case "bottom":
      return "Bottom";
    case "native":
      return "Native";
  }
}
