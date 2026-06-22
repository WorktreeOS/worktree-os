import { test, expect } from "bun:test";

import {
  KITTY_FLAG_DISAMBIGUATE,
  KITTY_SHIFT_ENTER,
  createKittyKeyboardState,
} from "./kitty-keyboard";

test("starts disabled so Shift+Enter keeps the legacy encoding", () => {
  const state = createKittyKeyboardState();
  expect(state.flags()).toBe(0);
  expect(state.disambiguates()).toBe(false);
});

test("push enables disambiguation; pop restores the previous state", () => {
  const state = createKittyKeyboardState();
  state.push(KITTY_FLAG_DISAMBIGUATE);
  expect(state.disambiguates()).toBe(true);
  state.pop(1);
  expect(state.disambiguates()).toBe(false);
});

test("nested programs stack and unwind independently", () => {
  const state = createKittyKeyboardState();
  state.push(KITTY_FLAG_DISAMBIGUATE); // agent CLI enters
  state.push(0); // spawns a child that disables the protocol
  expect(state.disambiguates()).toBe(false);
  state.pop(1); // child exits
  expect(state.disambiguates()).toBe(true);
});

test("pop never underflows the stack", () => {
  const state = createKittyKeyboardState();
  state.push(KITTY_FLAG_DISAMBIGUATE);
  state.pop(5);
  expect(state.flags()).toBe(0);
  expect(state.disambiguates()).toBe(false);
});

test("set replaces, ORs, and clears flags by mode", () => {
  const state = createKittyKeyboardState();
  state.set(KITTY_FLAG_DISAMBIGUATE, 1); // replace
  expect(state.disambiguates()).toBe(true);
  state.set(0b1000, 2); // OR a higher bit on
  expect(state.flags()).toBe(KITTY_FLAG_DISAMBIGUATE | 0b1000);
  state.set(KITTY_FLAG_DISAMBIGUATE, 3); // clear the disambiguate bit
  expect(state.disambiguates()).toBe(false);
  expect(state.flags()).toBe(0b1000);
});

test("set modifies the top of the stack, not the main flags", () => {
  const state = createKittyKeyboardState();
  state.push(0);
  state.set(KITTY_FLAG_DISAMBIGUATE, 1);
  expect(state.disambiguates()).toBe(true);
  state.pop(1); // back to the untouched main flags
  expect(state.flags()).toBe(0);
});

test("reset clears the stack and main flags", () => {
  const state = createKittyKeyboardState();
  state.push(KITTY_FLAG_DISAMBIGUATE);
  state.reset();
  expect(state.flags()).toBe(0);
  expect(state.disambiguates()).toBe(false);
});

test("Shift+Enter sequence is Enter (13) with the shift modifier (2)", () => {
  expect(KITTY_SHIFT_ENTER).toBe("\x1b[13;2u");
});
