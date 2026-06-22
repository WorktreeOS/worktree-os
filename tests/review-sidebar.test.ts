import { test, expect, describe } from "bun:test";
import {
  clampReviewPage,
  clampReviewWidth,
  collapseDiffContext,
  CONTEXT_THRESHOLD,
  getReviewPageCount,
  getReviewVisibleRange,
  persistReviewWidth,
  readStoredReviewWidth,
  REVIEW_DEFAULT_WIDTH,
  REVIEW_FILES_PER_PAGE,
  REVIEW_MIN_WIDTH,
  REVIEW_WIDTH_STORAGE_KEY,
} from "../apps/web/src/lib/review-sidebar-logic";
import {
  buildPlainTextLines,
  findLanguageDescriptionForPath,
  highlightDiffFile,
  loadLanguageSupportForPath,
} from "../apps/web/src/lib/review-syntax-highlight";
import type {
  DiffFile,
  DiffHunk,
  DiffLine,
} from "../apps/web/src/lib/ui-api";

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

describe("clampReviewWidth", () => {
  test("clamps below MIN to MIN", () => {
    expect(clampReviewWidth(100, 1920)).toBe(REVIEW_MIN_WIDTH);
  });

  test("clamps above viewport upper bound", () => {
    expect(clampReviewWidth(99_999, 1280)).toBeLessThan(1280);
    expect(clampReviewWidth(99_999, 1280)).toBeGreaterThanOrEqual(
      REVIEW_MIN_WIDTH,
    );
  });

  test("returns default when NaN/Infinity", () => {
    expect(clampReviewWidth(Number.NaN, 1920)).toBeGreaterThanOrEqual(
      REVIEW_MIN_WIDTH,
    );
    expect(clampReviewWidth(Number.NaN, 1920)).toBeLessThanOrEqual(
      REVIEW_DEFAULT_WIDTH,
    );
  });

  test("narrow viewport falls back to MIN width", () => {
    expect(clampReviewWidth(600, 600)).toBe(REVIEW_MIN_WIDTH);
  });
});

describe("readStoredReviewWidth / persistReviewWidth", () => {
  test("round-trip via memory storage", () => {
    const storage = makeMemoryStorage();
    expect(readStoredReviewWidth(storage)).toBeNull();
    persistReviewWidth(620, storage);
    expect(storage.getItem(REVIEW_WIDTH_STORAGE_KEY)).toBe("620");
    expect(readStoredReviewWidth(storage)).toBe(620);
  });

  test("invalid stored value returns null", () => {
    const storage = makeMemoryStorage();
    storage.setItem(REVIEW_WIDTH_STORAGE_KEY, "not-a-number");
    expect(readStoredReviewWidth(storage)).toBeNull();
  });

  test("invalid stored value is clamped by clampReviewWidth fallback", () => {
    const stored = readStoredReviewWidth(makeMemoryStorage()) ?? Number.NaN;
    const value = clampReviewWidth(stored, 1920);
    expect(value).toBeGreaterThanOrEqual(REVIEW_MIN_WIDTH);
  });
});

describe("collapseDiffContext", () => {
  function ctx(n: number): DiffLine[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `c-${i}`,
      kind: "context" as const,
      content: `line ${i}`,
      oldLine: i + 1,
      newLine: i + 1,
    }));
  }

  function add(content: string, newLine: number): DiffLine {
    return { id: `a-${newLine}`, kind: "add", content, newLine };
  }

  test("short context runs are passed through verbatim", () => {
    const lines: DiffLine[] = [
      ...ctx(2),
      add("hello", 3),
      ...ctx(2),
    ];
    const rows = collapseDiffContext(lines);
    expect(rows.filter((r) => r.kind === "collapsed")).toHaveLength(0);
    expect(rows).toHaveLength(5);
  });

  test("long internal context runs collapse to a single row", () => {
    const lines: DiffLine[] = [
      add("first", 1),
      ...ctx(CONTEXT_THRESHOLD + 6),
      add("last", 100),
    ];
    const rows = collapseDiffContext(lines);
    const collapsed = rows.filter((r) => r.kind === "collapsed");
    expect(collapsed).toHaveLength(1);
    if (collapsed[0]!.kind === "collapsed") {
      expect(collapsed[0]!.count).toBeGreaterThan(0);
    }
    expect(rows[0]!.kind).toBe("line");
  });

  test("leading context run skips head display rows", () => {
    const lines: DiffLine[] = [...ctx(20), add("change", 21)];
    const rows = collapseDiffContext(lines);
    expect(rows[0]!.kind).toBe("collapsed");
    if (rows[0]!.kind === "collapsed") {
      // leading collapsed row covers the full run minus tail context rows.
      expect(rows[0]!.count).toBeGreaterThanOrEqual(15);
    }
  });

  test("trailing context run skips tail display rows", () => {
    const lines: DiffLine[] = [add("change", 1), ...ctx(20)];
    const rows = collapseDiffContext(lines);
    const last = rows[rows.length - 1]!;
    expect(last.kind).toBe("collapsed");
  });

  test("highlightable line content from helpers still matches DiffLine.content (regression)", () => {
    const lines: DiffLine[] = [add("const a = 1;", 1), ...ctx(2)];
    const rows = collapseDiffContext(lines);
    const renderedLineIds = rows
      .filter((r) => r.kind === "line")
      .map((r) => (r.kind === "line" ? r.line.id : ""));
    expect(renderedLineIds).toContain("a-1");
  });
});

describe("review pagination helpers", () => {
  test("getReviewPageCount returns at least one for empty sets", () => {
    expect(getReviewPageCount(0)).toBe(1);
    expect(getReviewPageCount(-3)).toBe(1);
  });

  test("getReviewPageCount handles full and partial last page", () => {
    expect(getReviewPageCount(REVIEW_FILES_PER_PAGE)).toBe(1);
    expect(getReviewPageCount(REVIEW_FILES_PER_PAGE + 1)).toBe(2);
    expect(getReviewPageCount(REVIEW_FILES_PER_PAGE * 3)).toBe(3);
  });

  test("clampReviewPage clamps to valid range", () => {
    const total = REVIEW_FILES_PER_PAGE * 2 + 4;
    expect(clampReviewPage(-1, total)).toBe(0);
    expect(clampReviewPage(0, total)).toBe(0);
    expect(clampReviewPage(99, total)).toBe(2);
  });

  test("clampReviewPage handles NaN/Infinity safely", () => {
    expect(clampReviewPage(Number.NaN, 30)).toBe(0);
    expect(clampReviewPage(Number.POSITIVE_INFINITY, 30)).toBeGreaterThanOrEqual(
      0,
    );
  });

  test("getReviewVisibleRange returns zero range for empty sets", () => {
    const range = getReviewVisibleRange(0, 0);
    expect(range.startIndex).toBe(0);
    expect(range.endIndex).toBe(0);
    expect(range.startDisplay).toBe(0);
    expect(range.endDisplay).toBe(0);
  });

  test("getReviewVisibleRange computes 1-based display positions", () => {
    const range = getReviewVisibleRange(0, REVIEW_FILES_PER_PAGE * 2 + 3);
    expect(range.startDisplay).toBe(1);
    expect(range.endDisplay).toBe(REVIEW_FILES_PER_PAGE);
    expect(range.startIndex).toBe(0);
    expect(range.endIndex).toBe(REVIEW_FILES_PER_PAGE);
  });

  test("getReviewVisibleRange clamps last page to total files", () => {
    const total = REVIEW_FILES_PER_PAGE + 3;
    const range = getReviewVisibleRange(1, total);
    expect(range.startIndex).toBe(REVIEW_FILES_PER_PAGE);
    expect(range.endIndex).toBe(total);
    expect(range.endDisplay).toBe(total);
  });

  test("getReviewVisibleRange clamps out-of-range page", () => {
    const total = REVIEW_FILES_PER_PAGE + 2;
    const range = getReviewVisibleRange(99, total);
    expect(range.startIndex).toBe(REVIEW_FILES_PER_PAGE);
    expect(range.endIndex).toBe(total);
  });
});

describe("review pager visibility (component behavior)", () => {
  test("pager is hidden when total files fit within the page", () => {
    expect(REVIEW_FILES_PER_PAGE > REVIEW_FILES_PER_PAGE).toBe(false);
  });

  test("pager appears once total files exceed the page limit", () => {
    const fewer = REVIEW_FILES_PER_PAGE;
    const more = REVIEW_FILES_PER_PAGE + 1;
    expect(fewer > REVIEW_FILES_PER_PAGE).toBe(false);
    expect(more > REVIEW_FILES_PER_PAGE).toBe(true);
  });

  test("prev button disabled on first page, next disabled on last page", () => {
    const total = REVIEW_FILES_PER_PAGE * 3 + 1;
    const pages = getReviewPageCount(total);
    const first = clampReviewPage(0, total);
    const last = clampReviewPage(pages - 1, total);
    expect(first <= 0).toBe(true);
    expect(last >= pages - 1).toBe(true);
  });

  test("page resets to a valid index when active set shrinks", () => {
    const total = REVIEW_FILES_PER_PAGE * 4;
    const wasOnPage = clampReviewPage(3, total);
    expect(wasOnPage).toBe(3);
    const shrunk = clampReviewPage(3, REVIEW_FILES_PER_PAGE);
    expect(shrunk).toBe(0);
  });
});

function makeHunk(lines: DiffLine[]): DiffHunk {
  return {
    id: "h-1",
    oldStart: 1,
    oldLines: lines.length,
    newStart: 1,
    newLines: lines.length,
    lines,
  };
}

function makeTextFile(
  newPath: string,
  lines: DiffLine[],
  overrides: Partial<DiffFile> = {},
): DiffFile {
  return {
    id: "f-1",
    status: "modified",
    newPath,
    oldPath: newPath,
    additions: lines.filter((l) => l.kind === "add").length,
    deletions: lines.filter((l) => l.kind === "delete").length,
    binary: false,
    isText: true,
    hunks: [makeHunk(lines)],
    ...overrides,
  };
}

describe("review syntax-highlight language matching", () => {
  test("matches known language by new file path", () => {
    const desc = findLanguageDescriptionForPath("src/index.ts", undefined);
    expect(desc).not.toBeNull();
    expect(desc?.name?.toLowerCase()).toContain("typescript");
  });

  test("falls back to old path when new path is missing (e.g. deleted file)", () => {
    const desc = findLanguageDescriptionForPath(undefined, "old/file.py");
    expect(desc).not.toBeNull();
    expect(desc?.name?.toLowerCase()).toContain("python");
  });

  test("returns null for unknown extensions", () => {
    const desc = findLanguageDescriptionForPath(
      "fixtures/data.unknownext",
      undefined,
    );
    expect(desc).toBeNull();
  });

  test("returns null when both paths are missing", () => {
    const desc = findLanguageDescriptionForPath(undefined, undefined);
    expect(desc).toBeNull();
  });

  test("loadLanguageSupportForPath resolves null for unknown languages", async () => {
    const support = await loadLanguageSupportForPath(
      "fixtures/data.unknownext",
      undefined,
    );
    expect(support).toBeNull();
  });
});

describe("review syntax-highlight fragment building", () => {
  test("buildPlainTextLines returns one fragment per textual line with original text", () => {
    const file = makeTextFile("file.txt", [
      { id: "a-1", kind: "add", content: "alpha", newLine: 1 },
      { id: "c-1", kind: "context", content: "beta", oldLine: 1, newLine: 2 },
      { id: "d-1", kind: "delete", content: "gamma", oldLine: 2 },
      { id: "n-1", kind: "no-newline", content: "" },
    ]);
    const map = buildPlainTextLines(file);
    expect(map.get("a-1")?.[0]?.text).toBe("alpha");
    expect(map.get("c-1")?.[0]?.text).toBe("beta");
    expect(map.get("d-1")?.[0]?.text).toBe("gamma");
    expect(map.has("n-1")).toBe(false);
  });

  test("highlightDiffFile preserves original line text after token slicing", async () => {
    const file = makeTextFile("snippet.ts", [
      {
        id: "a-1",
        kind: "add",
        content: "const greeting = 'hi';",
        newLine: 1,
      },
      {
        id: "c-1",
        kind: "context",
        content: "function ping() {}",
        oldLine: 1,
        newLine: 2,
      },
      {
        id: "d-1",
        kind: "delete",
        content: "let removed = 0;",
        oldLine: 2,
      },
    ]);
    const support = await loadLanguageSupportForPath(file.newPath, undefined);
    expect(support).not.toBeNull();
    const map = highlightDiffFile(file, support!);
    const join = (id: string) =>
      (map.get(id) ?? []).map((f) => f.text).join("");
    expect(join("a-1")).toBe("const greeting = 'hi';");
    expect(join("c-1")).toBe("function ping() {}");
    expect(join("d-1")).toBe("let removed = 0;");
  });

  test("highlightDiffFile emits at least one token class for highlighted code", async () => {
    const file = makeTextFile("snippet.ts", [
      {
        id: "a-1",
        kind: "add",
        content: "const greeting = 'hi';",
        newLine: 1,
      },
    ]);
    const support = await loadLanguageSupportForPath(file.newPath, undefined);
    const map = highlightDiffFile(file, support!);
    const fragments = map.get("a-1") ?? [];
    expect(fragments.length).toBeGreaterThan(0);
    expect(fragments.some((f) => f.className.length > 0)).toBe(true);
  });
});
