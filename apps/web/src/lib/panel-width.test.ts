import { describe, expect, test } from "bun:test";
import {
  PANEL_CENTER_MIN,
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  PANEL_WIDTH_STORAGE_KEY,
  clampPanelWidth,
  getPanelMaxWidth,
  persistPanelWidth,
  readStoredPanelWidth,
} from "./panel-width";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    map,
  };
}

describe("getPanelMaxWidth", () => {
  test("is capped by the absolute maximum on wide viewports", () => {
    // Plenty of room: rail + center min leave more than the cap.
    expect(getPanelMaxWidth(2560, 256)).toBe(PANEL_MAX_WIDTH);
  });

  test("shrinks to leave the rail and a minimum center column", () => {
    const viewport = 1280;
    const railWidth = 256;
    expect(getPanelMaxWidth(viewport, railWidth)).toBe(
      viewport - railWidth - PANEL_CENTER_MIN,
    );
  });

  test("a wider rail leaves less room for the panel", () => {
    const viewport = 1280;
    expect(getPanelMaxWidth(viewport, 480)).toBeLessThan(
      getPanelMaxWidth(viewport, 256),
    );
  });

  test("never returns below the panel minimum on narrow desktops", () => {
    expect(getPanelMaxWidth(900, 480)).toBe(PANEL_MIN_WIDTH);
  });
});

describe("clampPanelWidth", () => {
  test("keeps an in-range width unchanged", () => {
    expect(clampPanelWidth(560, 2560, 256)).toBe(560);
  });

  test("clamps below the minimum up to the minimum", () => {
    expect(clampPanelWidth(120, 2560, 256)).toBe(PANEL_MIN_WIDTH);
  });

  test("clamps above the viewport/rail maximum down", () => {
    const viewport = 1280;
    const railWidth = 256;
    const max = getPanelMaxWidth(viewport, railWidth);
    expect(clampPanelWidth(9999, viewport, railWidth)).toBe(max);
  });

  test("clamps above the absolute cap down to the cap on wide viewports", () => {
    expect(clampPanelWidth(9999, 2560, 256)).toBe(PANEL_MAX_WIDTH);
  });

  test("falls back to the default for NaN, capped by the viewport maximum", () => {
    expect(clampPanelWidth(Number.NaN, 2560, 256)).toBe(PANEL_DEFAULT_WIDTH);
    // On a narrow desktop the default is capped down to the max.
    const max = getPanelMaxWidth(900, 480);
    expect(clampPanelWidth(Number.NaN, 900, 480)).toBe(
      Math.min(PANEL_DEFAULT_WIDTH, max),
    );
  });

  test("falls back to the default for Infinity", () => {
    expect(clampPanelWidth(Number.POSITIVE_INFINITY, 2560, 256)).toBe(
      PANEL_DEFAULT_WIDTH,
    );
  });
});

describe("readStoredPanelWidth", () => {
  test("returns null when nothing is stored", () => {
    expect(readStoredPanelWidth(fakeStorage())).toBeNull();
  });

  test("returns null for an invalid stored value", () => {
    expect(
      readStoredPanelWidth(fakeStorage({ [PANEL_WIDTH_STORAGE_KEY]: "abc" })),
    ).toBeNull();
  });

  test("returns the parsed stored value (even when out of bounds)", () => {
    expect(
      readStoredPanelWidth(fakeStorage({ [PANEL_WIDTH_STORAGE_KEY]: "9999" })),
    ).toBe(9999);
  });
});

describe("persistPanelWidth", () => {
  test("writes the rounded width to storage", () => {
    const store = fakeStorage();
    persistPanelWidth(563.7, store);
    expect(store.map.get(PANEL_WIDTH_STORAGE_KEY)).toBe("564");
  });

  test("round-trips through read", () => {
    const store = fakeStorage();
    persistPanelWidth(600, store);
    expect(readStoredPanelWidth(store)).toBe(600);
  });
});
