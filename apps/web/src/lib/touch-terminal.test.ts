import { test, expect } from "bun:test";

import {
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_SCROLLBACK_DEFAULT,
  TERMINAL_SCROLLBACK_MAX,
  TERMINAL_SCROLLBACK_MIN,
  clampFontSize,
  clampScrollback,
  computeRedrawNudge,
  persistCursorBlink,
  persistFontSize,
  persistScrollback,
  readStoredCursorBlink,
  readStoredFontSize,
  readStoredScrollback,
  resolveScrollIntent,
} from "./touch-terminal";

/** Minimal in-memory storage mock for the read/persist helpers. */
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
}

test("clampFontSize bounds and rounds", () => {
  expect(clampFontSize(13)).toBe(13);
  expect(clampFontSize(1)).toBe(TERMINAL_FONT_SIZE_MIN);
  expect(clampFontSize(999)).toBe(TERMINAL_FONT_SIZE_MAX);
  expect(clampFontSize(12.6)).toBe(13);
});

test("clampScrollback bounds", () => {
  expect(clampScrollback(5000)).toBe(5000);
  expect(clampScrollback(0)).toBe(TERMINAL_SCROLLBACK_MIN);
  expect(clampScrollback(10_000_000)).toBe(TERMINAL_SCROLLBACK_MAX);
});

test("readStoredFontSize falls back when unset or invalid", () => {
  expect(readStoredFontSize(fakeStorage())).toBe(TERMINAL_FONT_SIZE_DEFAULT);
  expect(readStoredFontSize(fakeStorage({ "wos.terminal.fontSize": "nope" }))).toBe(
    TERMINAL_FONT_SIZE_DEFAULT,
  );
});

test("readStoredFontSize clamps an out-of-range stored value", () => {
  expect(readStoredFontSize(fakeStorage({ "wos.terminal.fontSize": "500" }))).toBe(
    TERMINAL_FONT_SIZE_MAX,
  );
  expect(readStoredFontSize(fakeStorage({ "wos.terminal.fontSize": "2" }))).toBe(
    TERMINAL_FONT_SIZE_MIN,
  );
});

test("persistFontSize round-trips through clamp", () => {
  const store = fakeStorage();
  persistFontSize(18, store);
  expect(readStoredFontSize(store)).toBe(18);
  persistFontSize(999, store);
  expect(readStoredFontSize(store)).toBe(TERMINAL_FONT_SIZE_MAX);
});

test("scrollback round-trips and defaults", () => {
  const store = fakeStorage();
  expect(readStoredScrollback(store)).toBe(TERMINAL_SCROLLBACK_DEFAULT);
  persistScrollback(20000, store);
  expect(readStoredScrollback(store)).toBe(20000);
});

test("cursor blink read/persist and default", () => {
  const store = fakeStorage();
  expect(readStoredCursorBlink(store)).toBe(true);
  persistCursorBlink(false, store);
  expect(readStoredCursorBlink(store)).toBe(false);
  persistCursorBlink(true, store);
  expect(readStoredCursorBlink(store)).toBe(true);
});

test("computeRedrawNudge shrinks rows by one and preserves cols", () => {
  const nudge = computeRedrawNudge({ cols: 80, rows: 24 });
  expect(nudge.off).toEqual({ cols: 80, rows: 23 });
  expect(nudge.restore).toEqual({ cols: 80, rows: 24 });
});

test("computeRedrawNudge grows rows when only one row is available", () => {
  const nudge = computeRedrawNudge({ cols: 120, rows: 1 });
  expect(nudge.off).toEqual({ cols: 120, rows: 2 });
  expect(nudge.restore).toEqual({ cols: 120, rows: 1 });
});

test("resolveScrollIntent moves local scrollback in the normal buffer", () => {
  expect(resolveScrollIntent("up", false)).toEqual({
    kind: "scroll",
    action: "pages",
    amount: -1,
  });
  expect(resolveScrollIntent("down", false)).toEqual({
    kind: "scroll",
    action: "pages",
    amount: 1,
  });
  expect(resolveScrollIntent("top", false)).toEqual({
    kind: "scroll",
    action: "top",
  });
  expect(resolveScrollIntent("bottom", false)).toEqual({
    kind: "scroll",
    action: "bottom",
  });
});

test("resolveScrollIntent synthesizes a wheel gesture in the alternate buffer", () => {
  expect(resolveScrollIntent("up", true)).toEqual({
    kind: "wheel",
    direction: "up",
  });
  expect(resolveScrollIntent("top", true)).toEqual({
    kind: "wheel",
    direction: "up",
  });
  expect(resolveScrollIntent("down", true)).toEqual({
    kind: "wheel",
    direction: "down",
  });
  expect(resolveScrollIntent("bottom", true)).toEqual({
    kind: "wheel",
    direction: "down",
  });
});
