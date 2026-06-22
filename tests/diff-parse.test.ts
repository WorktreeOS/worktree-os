import { test, expect, describe } from "bun:test";
import { buildDiffSet, parseRawDiff } from "@worktreeos/core/diff-parse";
import {
  parseNameStatus,
  parseNumstat,
} from "@worktreeos/core/git";

describe("buildDiffSet — added/deleted/modified", () => {
  test("added file with new content", () => {
    const raw = [
      "diff --git a/hello.txt b/hello.txt",
      "new file mode 100644",
      "index 0000000..ce01362",
      "--- /dev/null",
      "+++ b/hello.txt",
      "@@ -0,0 +1,2 @@",
      "+hello",
      "+world",
      "",
    ].join("\n");
    const set = buildDiffSet({
      raw,
      numstat: parseNumstat("2\t0\thello.txt\n"),
      nameStatus: parseNameStatus("A\thello.txt\n"),
    });
    expect(set.files).toHaveLength(1);
    const file = set.files[0]!;
    expect(file.status).toBe("added");
    expect(file.newPath).toBe("hello.txt");
    expect(file.oldPath).toBeUndefined();
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(0);
    expect(file.hunks).toHaveLength(1);
    const hunk = file.hunks[0]!;
    expect(hunk.lines.map((l) => l.kind)).toEqual(["add", "add"]);
    expect(hunk.lines.map((l) => l.newLine)).toEqual([1, 2]);
    expect(hunk.lines.map((l) => l.content)).toEqual(["hello", "world"]);
    expect(set.additions).toBe(2);
    expect(set.deletions).toBe(0);
    expect(set.changedFiles).toBe(1);
  });

  test("deleted file", () => {
    const raw = [
      "diff --git a/bye.txt b/bye.txt",
      "deleted file mode 100644",
      "index ce01362..0000000",
      "--- a/bye.txt",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-hello",
      "-world",
      "",
    ].join("\n");
    const set = buildDiffSet({
      raw,
      numstat: parseNumstat("0\t2\tbye.txt\n"),
      nameStatus: parseNameStatus("D\tbye.txt\n"),
    });
    expect(set.files[0]!.status).toBe("deleted");
    expect(set.files[0]!.oldPath).toBe("bye.txt");
    expect(set.files[0]!.additions).toBe(0);
    expect(set.files[0]!.deletions).toBe(2);
    expect(set.files[0]!.hunks[0]!.lines.map((l) => l.kind)).toEqual([
      "delete",
      "delete",
    ]);
    expect(set.files[0]!.hunks[0]!.lines.map((l) => l.oldLine)).toEqual([1, 2]);
  });

  test("modified file produces stable file id", () => {
    const raw = [
      "diff --git a/a.ts b/a.ts",
      "index 111..222 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,3 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      " const c = 3;",
      "",
    ].join("\n");
    const set = buildDiffSet({
      raw,
      numstat: parseNumstat("1\t1\ta.ts\n"),
      nameStatus: parseNameStatus("M\ta.ts\n"),
    });
    expect(set.files[0]!.id).toBe("modified:a.ts");
    expect(set.files[0]!.status).toBe("modified");
    expect(set.files[0]!.additions).toBe(1);
    expect(set.files[0]!.deletions).toBe(1);
    const hunk = set.files[0]!.hunks[0]!;
    expect(hunk.id).toContain("modified:a.ts#");
    // Stable across re-runs of the same input.
    const again = buildDiffSet({
      raw,
      numstat: parseNumstat("1\t1\ta.ts\n"),
      nameStatus: parseNameStatus("M\ta.ts\n"),
    });
    expect(again.files[0]!.id).toBe(set.files[0]!.id);
    expect(again.files[0]!.hunks[0]!.id).toBe(hunk.id);
    expect(again.files[0]!.hunks[0]!.lines[0]!.id).toBe(hunk.lines[0]!.id);
  });
});

describe("buildDiffSet — renames and binaries", () => {
  test("rename without content change", () => {
    const raw = [
      "diff --git a/old.txt b/new.txt",
      "similarity index 100%",
      "rename from old.txt",
      "rename to new.txt",
      "",
    ].join("\n");
    const set = buildDiffSet({
      raw,
      numstat: parseNumstat("0\t0\told.txt\tnew.txt\n"),
      nameStatus: parseNameStatus("R100\told.txt\tnew.txt\n"),
    });
    expect(set.files).toHaveLength(1);
    const file = set.files[0]!;
    expect(file.status).toBe("renamed");
    expect(file.oldPath).toBe("old.txt");
    expect(file.newPath).toBe("new.txt");
    expect(file.hunks).toHaveLength(0);
    expect(file.isText).toBe(false);
    expect(file.binary).toBe(false);
  });

  test("binary file marked as binary, isText=false", () => {
    const raw = [
      "diff --git a/logo.png b/logo.png",
      "index 111..222 100644",
      "Binary files a/logo.png and b/logo.png differ",
      "",
    ].join("\n");
    const set = buildDiffSet({
      raw,
      numstat: parseNumstat("-\t-\tlogo.png\n"),
      nameStatus: parseNameStatus("M\tlogo.png\n"),
    });
    expect(set.files[0]!.binary).toBe(true);
    expect(set.files[0]!.isText).toBe(false);
    expect(set.files[0]!.hunks).toHaveLength(0);
  });
});

describe("buildDiffSet — multi-hunk and no-newline", () => {
  test("multiple hunks in same file", () => {
    const raw = [
      "diff --git a/big.txt b/big.txt",
      "index 111..222 100644",
      "--- a/big.txt",
      "+++ b/big.txt",
      "@@ -1,2 +1,2 @@",
      "-a",
      "+aa",
      " b",
      "@@ -10,2 +10,2 @@",
      "-c",
      "+cc",
      " d",
      "",
    ].join("\n");
    const set = buildDiffSet({
      raw,
      numstat: parseNumstat("2\t2\tbig.txt\n"),
      nameStatus: parseNameStatus("M\tbig.txt\n"),
    });
    expect(set.files[0]!.hunks).toHaveLength(2);
    expect(set.files[0]!.hunks[0]!.oldStart).toBe(1);
    expect(set.files[0]!.hunks[1]!.oldStart).toBe(10);
    expect(set.files[0]!.hunks[0]!.id).not.toBe(set.files[0]!.hunks[1]!.id);
  });

  test("no-newline-at-end-of-file marker is captured", () => {
    const raw = [
      "diff --git a/nl.txt b/nl.txt",
      "index 111..222 100644",
      "--- a/nl.txt",
      "+++ b/nl.txt",
      "@@ -1 +1 @@",
      "-a",
      "\\ No newline at end of file",
      "+b",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const set = buildDiffSet({
      raw,
      numstat: parseNumstat("1\t1\tnl.txt\n"),
      nameStatus: parseNameStatus("M\tnl.txt\n"),
    });
    const kinds = set.files[0]!.hunks[0]!.lines.map((l) => l.kind);
    expect(kinds).toEqual(["delete", "no-newline", "add", "no-newline"]);
  });
});

describe("buildDiffSet — totals and empty", () => {
  test("empty diff produces empty set", () => {
    const set = buildDiffSet({ raw: "", numstat: [], nameStatus: [] });
    expect(set.files).toHaveLength(0);
    expect(set.additions).toBe(0);
    expect(set.deletions).toBe(0);
    expect(set.changedFiles).toBe(0);
  });

  test("aggregate additions/deletions sum over files", () => {
    const raw = [
      "diff --git a/one.txt b/one.txt",
      "index 111..222 100644",
      "--- a/one.txt",
      "+++ b/one.txt",
      "@@ -1 +1,2 @@",
      " one",
      "+extra",
      "diff --git a/two.txt b/two.txt",
      "index 333..444 100644",
      "--- a/two.txt",
      "+++ b/two.txt",
      "@@ -1,2 +1 @@",
      " two",
      "-gone",
      "",
    ].join("\n");
    const set = buildDiffSet({
      raw,
      numstat: parseNumstat("1\t0\tone.txt\n0\t1\ttwo.txt\n"),
      nameStatus: parseNameStatus("M\tone.txt\nM\ttwo.txt\n"),
    });
    expect(set.files).toHaveLength(2);
    expect(set.additions).toBe(1);
    expect(set.deletions).toBe(1);
    expect(set.changedFiles).toBe(2);
  });
});

describe("parseRawDiff — header parsing", () => {
  test("handles quoted paths with spaces", () => {
    const raw = [
      'diff --git "a/with space.txt" "b/with space.txt"',
      "index 111..222 100644",
      '--- "a/with space.txt"',
      '+++ "b/with space.txt"',
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const sections = parseRawDiff(raw);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.newPath).toBe("with space.txt");
    expect(sections[0]!.oldPath).toBe("with space.txt");
    expect(sections[0]!.hunks).toHaveLength(1);
  });
});

describe("parseNumstat / parseNameStatus", () => {
  test("parseNumstat handles binary marker", () => {
    const entries = parseNumstat("-\t-\tlogo.png\n5\t3\tsrc/a.ts\n");
    expect(entries).toHaveLength(2);
    expect(entries[0]!.additions).toBeNull();
    expect(entries[0]!.deletions).toBeNull();
    expect(entries[1]!.additions).toBe(5);
    expect(entries[1]!.deletions).toBe(3);
  });

  test("parseNumstat handles renamed pair", () => {
    const entries = parseNumstat("4\t2\told.txt\tnew.txt\n");
    expect(entries[0]!.oldPath).toBe("old.txt");
    expect(entries[0]!.newPath).toBe("new.txt");
  });

  test("parseNameStatus parses simple and rename forms", () => {
    const entries = parseNameStatus(
      ["A\tnew.txt", "D\tgone.txt", "R100\told.txt\trenamed.txt", ""].join("\n"),
    );
    expect(entries[0]!.status).toBe("A");
    expect(entries[0]!.newPath).toBe("new.txt");
    expect(entries[1]!.status).toBe("D");
    expect(entries[2]!.status).toBe("R100");
    expect(entries[2]!.oldPath).toBe("old.txt");
    expect(entries[2]!.newPath).toBe("renamed.txt");
  });
});
