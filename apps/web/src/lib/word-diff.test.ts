import { test, expect, describe } from "bun:test";
import { segmentWordDiff, tokenizeLine } from "./word-diff";

function joined(segs: { text: string }[]): string {
  return segs.map((s) => s.text).join("");
}
function emphasized(segs: { text: string; emphasis: boolean }[]): string {
  return segs
    .filter((s) => s.emphasis)
    .map((s) => s.text)
    .join("");
}

describe("tokenizeLine", () => {
  test("splits into word / non-word / whitespace runs", () => {
    expect(tokenizeLine("a = b()")).toEqual(["a", " ", "=", " ", "b", "()"]);
  });
});

describe("segmentWordDiff", () => {
  test("returns null for identical lines", () => {
    expect(segmentWordDiff("same", "same")).toBeNull();
  });

  test("preserves the full text on each side", () => {
    const res = segmentWordDiff("const a = 1;", "const a = 2;");
    expect(res).not.toBeNull();
    expect(joined(res!.removed)).toBe("const a = 1;");
    expect(joined(res!.added)).toBe("const a = 2;");
  });

  test("emphasizes only the changed token", () => {
    const res = segmentWordDiff("const a = 1;", "const a = 2;");
    expect(emphasized(res!.removed)).toBe("1");
    expect(emphasized(res!.added)).toBe("2");
  });

  test("emphasizes inserted words", () => {
    const res = segmentWordDiff("foo bar", "foo new bar");
    expect(joined(res!.added)).toBe("foo new bar");
    expect(emphasized(res!.added)).toContain("new");
    // The shared tokens are not emphasized on the removed side.
    expect(emphasized(res!.removed)).toBe("");
  });

  test("returns null when nothing is common", () => {
    expect(segmentWordDiff("aaa", "bbb")).toBeNull();
  });
});
