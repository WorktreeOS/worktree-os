import { describe, expect, test } from "bun:test";
import {
  MAX_TERMINAL_TITLE_LENGTH,
  TerminalTitleValidationError,
  normalizeTerminalTitle,
} from "@worktreeos/daemon/terminal-layer/title";

describe("normalizeTerminalTitle", () => {
  test("trims surrounding whitespace", () => {
    expect(normalizeTerminalTitle("  api logs  ")).toBe("api logs");
  });

  test("treats null, undefined, and empty-after-trim as a clear", () => {
    expect(normalizeTerminalTitle(null)).toBeUndefined();
    expect(normalizeTerminalTitle(undefined)).toBeUndefined();
    expect(normalizeTerminalTitle("")).toBeUndefined();
    expect(normalizeTerminalTitle("   ")).toBeUndefined();
  });

  test("rejects control characters", () => {
    expect(() => normalizeTerminalTitle("bad\u0007title")).toThrow(
      TerminalTitleValidationError,
    );
    expect(() => normalizeTerminalTitle("line\nbreak")).toThrow(
      TerminalTitleValidationError,
    );
  });

  test("accepts a title at the maximum length but rejects one over it", () => {
    const max = "x".repeat(MAX_TERMINAL_TITLE_LENGTH);
    expect(normalizeTerminalTitle(max)).toBe(max);
    expect(() =>
      normalizeTerminalTitle("x".repeat(MAX_TERMINAL_TITLE_LENGTH + 1)),
    ).toThrow(TerminalTitleValidationError);
  });

  test("preserves non-control unicode", () => {
    expect(normalizeTerminalTitle("café · 测试")).toBe("café · 测试");
  });
});
