import { test, expect } from "bun:test";
import { isAnotherInstanceRunning } from "./instance-lock";

const alive = () => true;
const dead = () => false;

test("no existing lock → not running", () => {
  expect(isAnotherInstanceRunning(null, 100, alive)).toBe(false);
});

test("our own pid → not a conflict", () => {
  expect(isAnotherInstanceRunning(100, 100, alive)).toBe(false);
});

test("another live pid → conflict", () => {
  expect(isAnotherInstanceRunning(200, 100, alive)).toBe(true);
});

test("stale lock (dead pid) → not a conflict", () => {
  expect(isAnotherInstanceRunning(200, 100, dead)).toBe(false);
});
