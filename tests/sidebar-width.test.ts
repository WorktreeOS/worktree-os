import { describe, expect, test } from "bun:test";
import {
  clampSidebarWidth,
  getSidebarMaxWidth,
  persistSidebarWidth,
  readStoredSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_RESERVED_LAYOUT,
  SIDEBAR_WIDTH_STORAGE_KEY,
} from "../apps/web/src/lib/sidebar-width";

function makeMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => Array.from(data.keys())[index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, String(value));
    },
  } as Storage;
}

describe("getSidebarMaxWidth", () => {
  test("caps at the absolute maximum on a wide viewport", () => {
    expect(getSidebarMaxWidth(2560)).toBe(SIDEBAR_MAX_WIDTH);
  });

  test("reserves space for the worktree detail area on mid viewports", () => {
    // 1024 - 640 reserved = 384, below the absolute cap.
    expect(getSidebarMaxWidth(1024)).toBe(1024 - SIDEBAR_RESERVED_LAYOUT);
  });

  test("never drops below the minimum on a narrow viewport", () => {
    expect(getSidebarMaxWidth(700)).toBe(SIDEBAR_MIN_WIDTH);
  });
});

describe("clampSidebarWidth", () => {
  test("clamps below MIN to MIN", () => {
    expect(clampSidebarWidth(100, 1920)).toBe(SIDEBAR_MIN_WIDTH);
  });

  test("clamps above the viewport-derived maximum", () => {
    expect(clampSidebarWidth(99_999, 1024)).toBe(getSidebarMaxWidth(1024));
  });

  test("clamps above the absolute maximum on a wide viewport", () => {
    expect(clampSidebarWidth(99_999, 2560)).toBe(SIDEBAR_MAX_WIDTH);
  });

  test("passes a valid width through unchanged", () => {
    expect(clampSidebarWidth(320, 1920)).toBe(320);
  });

  test("returns default (capped to viewport) when NaN/Infinity", () => {
    expect(clampSidebarWidth(Number.NaN, 1920)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY, 1920)).toBe(
      SIDEBAR_DEFAULT_WIDTH,
    );
  });

  test("narrow viewport falls back to MIN width", () => {
    expect(clampSidebarWidth(400, 700)).toBe(SIDEBAR_MIN_WIDTH);
  });
});

describe("readStoredSidebarWidth / persistSidebarWidth", () => {
  test("round-trip via memory storage", () => {
    const storage = makeMemoryStorage();
    expect(readStoredSidebarWidth(storage)).toBeNull();
    persistSidebarWidth(312, storage);
    expect(storage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe("312");
    expect(readStoredSidebarWidth(storage)).toBe(312);
  });

  test("persisted width is rounded to a whole pixel", () => {
    const storage = makeMemoryStorage();
    persistSidebarWidth(312.7, storage);
    expect(storage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe("313");
  });

  test("invalid stored value returns null", () => {
    const storage = makeMemoryStorage();
    storage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, "not-a-number");
    expect(readStoredSidebarWidth(storage)).toBeNull();
  });

  test("missing/invalid stored value is recovered by the clamp fallback", () => {
    const stored = readStoredSidebarWidth(makeMemoryStorage()) ?? Number.NaN;
    const value = clampSidebarWidth(stored, 1920);
    expect(value).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});
