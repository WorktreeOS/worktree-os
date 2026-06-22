import { describe, expect, test } from "bun:test";
import {
  projectMonogram,
  projectPaletteSlot,
  projectTile,
} from "./project-identity";

describe("projectPaletteSlot", () => {
  test("is deterministic — same id yields the same slot across calls", () => {
    const a = projectPaletteSlot("depboy");
    const b = projectPaletteSlot("depboy");
    expect(a).toBe(b);
  });

  test("stays within palette bounds [0, 8) for varied ids", () => {
    const ids = ["depboy", "hr", "mosd", "lk_current", "a", "", "x".repeat(64)];
    for (const id of ids) {
      const slot = projectPaletteSlot(id);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(8);
      expect(Number.isInteger(slot)).toBe(true);
    }
  });
});

describe("projectMonogram", () => {
  test("takes the first two alphanumerics, lowercased", () => {
    expect(projectMonogram("depboy")).toBe("de");
    expect(projectMonogram("hr")).toBe("hr");
    expect(projectMonogram("mosd")).toBe("mo");
    expect(projectMonogram("lk_current")).toBe("lk");
  });

  test("skips leading non-alphanumerics and uppercases down", () => {
    expect(projectMonogram("  My-App")).toBe("my");
    expect(projectMonogram("3rd_party")).toBe("3r");
  });

  test("falls back to ?? when there are no alphanumerics", () => {
    expect(projectMonogram("___")).toBe("??");
    expect(projectMonogram("")).toBe("??");
  });

  test("returns a single char when only one alphanumeric exists", () => {
    expect(projectMonogram("x")).toBe("x");
  });
});

describe("projectTile", () => {
  test("maps the slot to a 1-indexed palette var and derives the monogram", () => {
    const tile = projectTile({ id: "depboy", displayName: "depboy" });
    const slot = projectPaletteSlot("depboy");
    expect(tile.colorVar).toBe(`var(--p-${slot + 1})`);
    expect(tile.monogram).toBe("de");
  });

  test("colorVar is always one of the eight palette slots", () => {
    const valid = new Set(
      Array.from({ length: 8 }, (_, i) => `var(--p-${i + 1})`),
    );
    for (const id of ["a", "bb", "ccc", "dddd", "project-eee"]) {
      const tile = projectTile({ id, displayName: id });
      expect(valid.has(tile.colorVar)).toBe(true);
    }
  });
});
