import { test, expect } from "bun:test";

import {
  TERMINAL_KEYBOARD_MIN_DELTA_PX,
  computeTerminalKeyboardHeight,
} from "./use-visual-viewport";

const base = {
  availableHeight: 800,
  coarsePointer: true,
  isController: true,
} as const;

test("clamps to the visible height when the keyboard is up", () => {
  expect(
    computeTerminalKeyboardHeight({ ...base, visualViewportHeight: 500 }),
  ).toBe(500);
});

test("no clamp on a fine pointer (no on-screen keyboard)", () => {
  expect(
    computeTerminalKeyboardHeight({
      ...base,
      coarsePointer: false,
      visualViewportHeight: 500,
    }),
  ).toBeNull();
});

test("no clamp for a viewer (not the controller)", () => {
  expect(
    computeTerminalKeyboardHeight({
      ...base,
      isController: false,
      visualViewportHeight: 500,
    }),
  ).toBeNull();
});

test("no clamp when the heights are ~equal (keyboard down)", () => {
  expect(
    computeTerminalKeyboardHeight({ ...base, visualViewportHeight: 790 }),
  ).toBeNull();
});

test("clamps at exactly the minimum delta threshold", () => {
  const visualViewportHeight =
    base.availableHeight - TERMINAL_KEYBOARD_MIN_DELTA_PX;
  expect(
    computeTerminalKeyboardHeight({ ...base, visualViewportHeight }),
  ).toBe(visualViewportHeight);
});

test("no clamp just below the minimum delta threshold", () => {
  expect(
    computeTerminalKeyboardHeight({
      ...base,
      visualViewportHeight:
        base.availableHeight - TERMINAL_KEYBOARD_MIN_DELTA_PX + 1,
    }),
  ).toBeNull();
});

test("no clamp when the visual viewport is unknown", () => {
  expect(
    computeTerminalKeyboardHeight({ ...base, visualViewportHeight: null }),
  ).toBeNull();
});

test("no clamp when the available height is not yet measured", () => {
  expect(
    computeTerminalKeyboardHeight({
      ...base,
      availableHeight: 0,
      visualViewportHeight: 500,
    }),
  ).toBeNull();
});
