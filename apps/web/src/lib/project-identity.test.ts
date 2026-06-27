import { describe, expect, test } from "bun:test";
import {
  WORKTREE_TONES,
  projectMonogram,
  projectPaletteSlot,
  projectTile,
  worktreeMonogram,
  worktreeTile,
  worktreeTone,
} from "./project-identity";

describe("projectPaletteSlot", () => {
  test("is deterministic — same id yields the same slot across calls", () => {
    const a = projectPaletteSlot("depboy");
    const b = projectPaletteSlot("depboy");
    expect(a).toBe(b);
  });

  test("stays within palette bounds [0, 36) for varied ids", () => {
    const ids = ["depboy", "hr", "mosd", "lk_current", "a", "", "x".repeat(64)];
    for (const id of ids) {
      const slot = projectPaletteSlot(id);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(36);
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
  test("uses the persisted colorSlot, mapped to a 1-indexed palette var", () => {
    const tile = projectTile({ id: "depboy", displayName: "depboy", colorSlot: 12 });
    expect(tile.colorVar).toBe("var(--p-13)");
    expect(tile.monogram).toBe("de");
  });

  test("falls back to a stable hash of the id when colorSlot is missing", () => {
    const tile = projectTile({ id: "depboy", displayName: "depboy" });
    const slot = projectPaletteSlot("depboy");
    expect(tile.colorVar).toBe(`var(--p-${slot + 1})`);
  });

  test("ignores an out-of-range colorSlot and falls back to the hash", () => {
    const tile = projectTile({ id: "depboy", displayName: "depboy", colorSlot: 999 });
    expect(tile.colorVar).toBe(`var(--p-${projectPaletteSlot("depboy") + 1})`);
  });

  test("colorVar is always one of the 36 palette slots", () => {
    const valid = new Set(
      Array.from({ length: 36 }, (_, i) => `var(--p-${i + 1})`),
    );
    for (let slot = 0; slot < 36; slot++) {
      const tile = projectTile({ id: "x", displayName: "x", colorSlot: slot });
      expect(valid.has(tile.colorVar)).toBe(true);
    }
  });
});

describe("worktreeMonogram", () => {
  test("uses the first letters of the first two segments for multi-segment labels", () => {
    expect(worktreeMonogram("feature-tree")).toBe("ft");
    expect(worktreeMonogram("fix/auth")).toBe("fa");
    expect(worktreeMonogram("wos-d38cf804")).toBe("wd");
  });

  test("falls back to the first two alphanumerics for a single segment", () => {
    expect(worktreeMonogram("main")).toBe("ma");
    expect(worktreeMonogram("x")).toBe("x");
  });

  test("falls back to ?? when there are no alphanumerics", () => {
    expect(worktreeMonogram("___")).toBe("??");
  });
});

describe("worktreeTone", () => {
  test("is deterministic and within [0, WORKTREE_TONES)", () => {
    const paths = [
      "/a/main",
      "/a/feature-tree",
      "/b/wos-d38cf804",
      "",
      "/".repeat(40),
    ];
    for (const p of paths) {
      const tone = worktreeTone(p);
      expect(tone).toBe(worktreeTone(p));
      expect(tone).toBeGreaterThanOrEqual(0);
      expect(tone).toBeLessThan(WORKTREE_TONES);
      expect(Number.isInteger(tone)).toBe(true);
    }
  });
});

describe("worktreeTile", () => {
  test("keeps the project's persisted color slot while encoding the worktree", () => {
    const project = { id: "depboy", colorSlot: 5 };
    const tile = worktreeTile(project, {
      path: "/depboy/feature-tree",
      label: "feature-tree",
    });
    expect(tile.colorVar).toBe("var(--p-6)");
    expect(tile.monogram).toBe("ft");
    expect(tile.tone).toBe(worktreeTone("/depboy/feature-tree"));
  });

  test("falls back to a hash of the id when the project has no colorSlot", () => {
    const tile = worktreeTile(
      { id: "/some/path" },
      { path: "/some/path", label: "main" },
    );
    expect(tile.colorVar).toBe(`var(--p-${projectPaletteSlot("/some/path") + 1})`);
  });

  test("siblings of one project share the hue but differ in monogram", () => {
    const project = { id: "depboy", colorSlot: 5 };
    const main = worktreeTile(project, { path: "/depboy/main", label: "main" });
    const feat = worktreeTile(project, {
      path: "/depboy/feature-tree",
      label: "feature-tree",
    });
    expect(main.colorVar).toBe(feat.colorVar);
    expect(main.monogram).not.toBe(feat.monogram);
  });
});
