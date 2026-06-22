import { test, expect } from "bun:test";
import { formatDuration } from "./utils";

test("formatDuration: sub-minute reads as <1m", () => {
  expect(formatDuration(0)).toBe("<1m");
  expect(formatDuration(59_000)).toBe("<1m");
});

test("formatDuration: minutes under an hour", () => {
  expect(formatDuration(60_000)).toBe("1m");
  expect(formatDuration(45 * 60_000)).toBe("45m");
  expect(formatDuration(59 * 60_000)).toBe("59m");
});

test("formatDuration: hours under a day", () => {
  expect(formatDuration(60 * 60_000)).toBe("1h");
  expect(formatDuration(2 * 60 * 60_000 + 30 * 60_000)).toBe("2h");
  expect(formatDuration(23 * 60 * 60_000)).toBe("23h");
});

test("formatDuration: days", () => {
  expect(formatDuration(24 * 60 * 60_000)).toBe("1d");
  expect(formatDuration(3 * 24 * 60 * 60_000)).toBe("3d");
});

test("formatDuration: invalid input falls back to <1m", () => {
  expect(formatDuration(Number.NaN)).toBe("<1m");
  expect(formatDuration(-1000)).toBe("<1m");
});
