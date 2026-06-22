import { describe, expect, test } from "bun:test";
import {
  cellWidth,
  computePaneLayout,
  fitFontSize,
  HYBRID_WIDE_COLS,
  MC_FONT_MAX,
  MC_FONT_MIN,
} from "./geometry";

const BIG_BOX = { width: 2000, height: 2000 };
const SMALL_BOX = { width: 100, height: 80 };
const CARD = { width: 360, height: 240 };

describe("fitFontSize clamps", () => {
  test("a tiny grid in a big box clamps up to the max font", () => {
    expect(fitFontSize(BIG_BOX, { cols: 2, rows: 2 })).toBe(MC_FONT_MAX);
  });

  test("a huge grid in a small box clamps down to the min font", () => {
    expect(fitFontSize(SMALL_BOX, { cols: 2000, rows: 2000 })).toBe(MC_FONT_MIN);
  });
});

describe("fit mode shows the whole screen", () => {
  test("renders all rows with no anchor", () => {
    const layout = computePaneLayout("fit", { cols: 80, rows: 24 }, CARD);
    expect(layout.anchor).toBe("none");
    expect(layout.visibleRows).toEqual({ start: 0, end: 24 });
  });
});

describe("proportional mode preserves aspect without clipping", () => {
  test("content height equals the card height and width follows aspect", () => {
    const geom = { cols: 80, rows: 24 };
    const layout = computePaneLayout("proportional", geom, CARD);
    expect(layout.visibleRows).toEqual({ start: 0, end: 24 });
    expect(layout.contentHeight).toBe(CARD.height);
    // Width is exactly cols × cell width at the derived font — nothing clipped.
    expect(layout.contentWidth).toBeCloseTo(
      geom.cols * cellWidth(layout.fontSize),
      5,
    );
  });

  test("a wider terminal yields a proportionally wider pane at equal height", () => {
    const narrow = computePaneLayout("proportional", { cols: 80, rows: 24 }, CARD);
    const wide = computePaneLayout("proportional", { cols: 160, rows: 24 }, CARD);
    expect(wide.contentHeight).toBe(narrow.contentHeight);
    expect(wide.contentWidth).toBeGreaterThan(narrow.contentWidth);
  });
});

describe("hybrid threshold", () => {
  test("a wide pane renders as a whole-screen thumbnail", () => {
    const layout = computePaneLayout(
      "hybrid",
      { cols: HYBRID_WIDE_COLS + 1, rows: 56 },
      CARD,
    );
    expect(layout.anchor).toBe("none");
    expect(layout.visibleRows).toEqual({ start: 0, end: 56 });
  });

  test("a narrow tall pane anchors to the latest rows", () => {
    const layout = computePaneLayout("hybrid", { cols: 80, rows: 200 }, CARD);
    expect(layout.anchor).toBe("bottom");
    expect(layout.visibleRows.end).toBe(200);
    expect(layout.visibleRows.start).toBeGreaterThan(0);
  });
});

describe("top / bottom anchoring", () => {
  const tall = { cols: 80, rows: 200 };
  test("top shows the first rows", () => {
    const layout = computePaneLayout("top", tall, CARD);
    expect(layout.anchor).toBe("top");
    expect(layout.visibleRows.start).toBe(0);
    expect(layout.visibleRows.end).toBeLessThan(200);
  });
  test("bottom shows the last rows", () => {
    const layout = computePaneLayout("bottom", tall, CARD);
    expect(layout.anchor).toBe("bottom");
    expect(layout.visibleRows.end).toBe(200);
    expect(layout.visibleRows.start).toBeGreaterThan(0);
  });
});

describe("native mode", () => {
  test("uses a fixed font and shows all rows", () => {
    const layout = computePaneLayout("native", { cols: 80, rows: 24 }, CARD);
    expect(layout.fontSize).toBe(13);
    expect(layout.visibleRows).toEqual({ start: 0, end: 24 });
  });
});
