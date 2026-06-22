import { test, expect, describe } from "bun:test";
import {
  allStagedAction,
  allStagedState,
  changeTotals,
  diffBarCells,
  isFullyStaged,
  isStaged,
  mergeChanges,
  reviewedProgress,
} from "./review-explorer-logic";
import type { DiffFile, DiffSet, ReviewDiffResponse } from "./ui-api";

function file(path: string, additions = 1, deletions = 0): DiffFile {
  return {
    id: path,
    status: "modified",
    newPath: path,
    additions,
    deletions,
    binary: false,
    isText: true,
    hunks: [],
  };
}

function diffSet(files: DiffFile[]): DiffSet {
  return {
    raw: "",
    additions: files.reduce((a, f) => a + f.additions, 0),
    deletions: files.reduce((a, f) => a + f.deletions, 0),
    changedFiles: files.length,
    files,
  };
}

function review(staged: DiffFile[], unstaged: DiffFile[]): ReviewDiffResponse {
  return {
    totalAdditions: 0,
    totalDeletions: 0,
    totalChangedFiles: 0,
    staged: diffSet(staged),
    unstaged: diffSet(unstaged),
  };
}

describe("mergeChanges", () => {
  test("returns [] for null", () => {
    expect(mergeChanges(null)).toEqual([]);
  });

  test("merges staged + unstaged into one ordered list with staged states", () => {
    const r = review(
      [file("a.ts", 2, 1), file("both.ts", 1, 0)],
      [file("b.ts", 3, 0), file("both.ts", 0, 2)],
    );
    const entries = mergeChanges(r);
    expect(entries.map((e) => e.path)).toEqual(["a.ts", "b.ts", "both.ts"]);
    const byPath = Object.fromEntries(entries.map((e) => [e.path, e]));
    expect(byPath["a.ts"]!.staged).toBe("staged");
    expect(byPath["b.ts"]!.staged).toBe("unstaged");
    expect(byPath["both.ts"]!.staged).toBe("partial");
    // both.ts combines additions/deletions across the two sets.
    expect(byPath["both.ts"]!.additions).toBe(1);
    expect(byPath["both.ts"]!.deletions).toBe(2);
  });

  test("prefers the working-tree (unstaged) file as the representative", () => {
    const stagedFile = file("x.ts", 5, 0);
    const unstagedFile = file("x.ts", 1, 1);
    const entries = mergeChanges(review([stagedFile], [unstagedFile]));
    expect(entries[0]!.file).toBe(unstagedFile);
  });
});

describe("isStaged / isFullyStaged", () => {
  test("staged and partial are checked; unstaged is not", () => {
    const r = review([file("s.ts")], [file("u.ts")]);
    const entries = mergeChanges(r);
    expect(isStaged(entries.find((e) => e.path === "s.ts")!)).toBe(true);
    expect(isStaged(entries.find((e) => e.path === "u.ts")!)).toBe(false);
  });

  test("a partial file is checked but not fully staged", () => {
    const entries = mergeChanges(review([file("p.ts")], [file("p.ts")]));
    const partial = entries[0]!;
    expect(partial.staged).toBe("partial");
    expect(isStaged(partial)).toBe(true);
    expect(isFullyStaged(partial)).toBe(false);
  });
});

describe("changeTotals", () => {
  test("sums additions/deletions and counts staged", () => {
    const entries = mergeChanges(
      review([file("a.ts", 2, 1)], [file("b.ts", 3, 4)]),
    );
    expect(changeTotals(entries)).toEqual({
      files: 2,
      additions: 5,
      deletions: 5,
      stagedCount: 1,
    });
  });
});

describe("allStagedState / allStagedAction", () => {
  test("none when nothing staged", () => {
    const entries = mergeChanges(review([], [file("a.ts"), file("b.ts")]));
    expect(allStagedState(entries)).toBe("none");
    expect(allStagedAction(entries)).toEqual({
      action: "stage",
      paths: ["a.ts", "b.ts"],
    });
  });

  test("all when everything staged", () => {
    const entries = mergeChanges(review([file("a.ts"), file("b.ts")], []));
    expect(allStagedState(entries)).toBe("all");
    expect(allStagedAction(entries)).toEqual({
      action: "unstage",
      paths: ["a.ts", "b.ts"],
    });
  });

  test("some when mixed; stage action targets only the unstaged ones", () => {
    const entries = mergeChanges(review([file("a.ts")], [file("b.ts")]));
    expect(allStagedState(entries)).toBe("some");
    expect(allStagedAction(entries)).toEqual({
      action: "stage",
      paths: ["b.ts"],
    });
  });

  test("none for an empty list", () => {
    expect(allStagedState([])).toBe("none");
  });

  test("a partial file keeps the state in 'some' and gets staged by stage-all", () => {
    // one fully-staged file + one partial file (present in both sets).
    const entries = mergeChanges(
      review([file("s.ts"), file("p.ts")], [file("p.ts")]),
    );
    expect(allStagedState(entries)).toBe("some");
    expect(allStagedAction(entries)).toEqual({
      action: "stage",
      paths: ["p.ts"],
    });
  });

  test("a lone partial file is 'some', not 'all'", () => {
    const entries = mergeChanges(review([file("p.ts")], [file("p.ts")]));
    expect(allStagedState(entries)).toBe("some");
  });
});

describe("reviewedProgress", () => {
  test("counts reviewed paths", () => {
    const entries = mergeChanges(review([file("a.ts")], [file("b.ts")]));
    expect(reviewedProgress(entries, new Set(["a.ts"]))).toEqual({
      reviewed: 1,
      total: 2,
    });
  });
});

describe("diffBarCells", () => {
  test("all neutral when no change", () => {
    expect(diffBarCells(0, 0)).toEqual(["o", "o", "o", "o", "o"]);
  });
  test("all green when only additions", () => {
    expect(diffBarCells(10, 0)).toEqual(["g", "g", "g", "g", "g"]);
  });
  test("all red when only deletions", () => {
    expect(diffBarCells(0, 10)).toEqual(["r", "r", "r", "r", "r"]);
  });
  test("mixed split mirrors the ratio with a minimum of one green", () => {
    const cells = diffBarCells(1, 9);
    expect(cells.filter((c) => c === "g").length).toBe(1);
    expect(cells.filter((c) => c === "r").length).toBe(4);
  });
});
