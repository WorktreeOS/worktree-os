import { test, expect, describe } from "bun:test";
import {
  applyDirectoryError,
  applyDirectoryListing,
  applyFileContent,
  applyFileError,
  applySaveSuccess,
  beginSelectFile,
  collapseDirectory,
  createEmptyFileExplorerState,
  inferMonacoLanguage,
  isDirty,
  markDirectoryLoading,
  resetForWorktree,
  sortEntries,
  toggleDirectory,
  updateDraft,
} from "../apps/web/src/lib/file-explorer-logic";
import type {
  WorktreeFileContentResponse,
  WorktreeFileEntry,
  WorktreeFileTreeResponse,
} from "../apps/web/src/lib/ui-api";

function entry(
  partial: Partial<WorktreeFileEntry> & {
    name: string;
    kind: "file" | "directory";
  },
): WorktreeFileEntry {
  return {
    path: partial.path ?? partial.name,
    name: partial.name,
    kind: partial.kind,
    ...(partial.size !== undefined ? { size: partial.size } : {}),
    ...(partial.mtimeMs !== undefined ? { mtimeMs: partial.mtimeMs } : {}),
  };
}

function content(
  file: string,
  text: string,
  mtimeMs = 1000,
): WorktreeFileContentResponse {
  return {
    worktreePath: "/wt",
    file,
    content: text,
    size: text.length,
    mtimeMs,
    editable: true,
  };
}

describe("sortEntries", () => {
  test("places directories before files and sorts alphabetically", () => {
    const sorted = sortEntries([
      entry({ name: "zeta.txt", kind: "file" }),
      entry({ name: "alpha", kind: "directory" }),
      entry({ name: "Beta", kind: "directory" }),
      entry({ name: "alpha.md", kind: "file" }),
    ]);
    expect(sorted.map((e) => e.name)).toEqual([
      "alpha",
      "Beta",
      "alpha.md",
      "zeta.txt",
    ]);
  });
});

describe("directory state transitions", () => {
  test("marks a directory as loading then loaded", () => {
    let state = createEmptyFileExplorerState("/wt");
    state = markDirectoryLoading(state, "");
    expect(state.directories[""]?.status.kind).toBe("loading");
    const response: WorktreeFileTreeResponse = {
      worktreePath: "/wt",
      dir: "",
      entries: [
        entry({ name: "src", kind: "directory" }),
        entry({ name: "README.md", kind: "file" }),
      ],
    };
    state = applyDirectoryListing(state, response, 42);
    const node = state.directories[""];
    expect(node?.expanded).toBe(true);
    expect(node?.status).toEqual({
      kind: "loaded",
      loadedAt: 42,
      entries: [
        entry({ name: "src", kind: "directory" }),
        entry({ name: "README.md", kind: "file" }),
      ],
    });
  });

  test("records directory error without forgetting expansion", () => {
    let state = createEmptyFileExplorerState("/wt");
    state = applyDirectoryListing(
      state,
      { worktreePath: "/wt", dir: "src", entries: [] },
      1,
    );
    state = applyDirectoryError(state, "src", "boom");
    expect(state.directories.src?.expanded).toBe(true);
    expect(state.directories.src?.status).toEqual({
      kind: "error",
      message: "boom",
    });
  });

  test("collapseDirectory and toggleDirectory flip expansion", () => {
    let state = createEmptyFileExplorerState("/wt");
    state = applyDirectoryListing(
      state,
      { worktreePath: "/wt", dir: "src", entries: [] },
      1,
    );
    state = collapseDirectory(state, "src");
    expect(state.directories.src?.expanded).toBe(false);
    state = toggleDirectory(state, "src");
    expect(state.directories.src?.expanded).toBe(true);
  });
});

describe("selected file state", () => {
  test("beginSelectFile clears prior draft and content", () => {
    let state = createEmptyFileExplorerState("/wt");
    state = applyFileContent(
      beginSelectFile(state, "a.txt"),
      content("a.txt", "old"),
    );
    state = updateDraft(state, "old + edits");
    expect(isDirty(state)).toBe(true);
    state = beginSelectFile(state, "b.txt");
    expect(state.selectedFile).toBe("b.txt");
    expect(state.selectedContent).toBeNull();
    expect(state.draft).toBeNull();
    expect(state.selectedLoading).toBe(true);
    expect(state.selectedError).toBeNull();
  });

  test("applyFileContent ignores stale responses", () => {
    let state = createEmptyFileExplorerState("/wt");
    state = beginSelectFile(state, "a.txt");
    state = applyFileContent(state, content("other.txt", "boom"));
    expect(state.selectedContent).toBeNull();
    expect(state.selectedLoading).toBe(true);
  });

  test("updateDraft marks state dirty when draft differs from content", () => {
    let state = createEmptyFileExplorerState("/wt");
    state = applyFileContent(
      beginSelectFile(state, "a.txt"),
      content("a.txt", "x"),
    );
    expect(isDirty(state)).toBe(false);
    state = updateDraft(state, "xy");
    expect(isDirty(state)).toBe(true);
    state = updateDraft(state, "x");
    expect(isDirty(state)).toBe(false);
  });

  test("applySaveSuccess clears dirty and bumps mtime guard", () => {
    let state = createEmptyFileExplorerState("/wt");
    state = applyFileContent(
      beginSelectFile(state, "a.txt"),
      content("a.txt", "x", 1000),
    );
    state = updateDraft(state, "xy");
    state = applySaveSuccess(state, {
      file: "a.txt",
      size: 2,
      mtimeMs: 2000,
    });
    expect(isDirty(state)).toBe(false);
    expect(state.mtimeGuard).toBe(2000);
    expect(state.selectedContent?.size).toBe(2);
    expect(state.selectedContent?.content).toBe("xy");
  });

  test("applyFileError stores conflict details without dropping selection", () => {
    let state = createEmptyFileExplorerState("/wt");
    state = beginSelectFile(state, "a.txt");
    state = applyFileError(state, "a.txt", {
      kind: "conflict",
      message: "changed",
      currentMtimeMs: 9999,
    });
    expect(state.selectedFile).toBe("a.txt");
    expect(state.selectedError?.kind).toBe("conflict");
    expect(state.selectedLoading).toBe(false);
  });
});

describe("resetForWorktree", () => {
  test("returns same state when worktree path is unchanged", () => {
    const state = applyFileContent(
      beginSelectFile(createEmptyFileExplorerState("/wt"), "a.txt"),
      content("a.txt", "x"),
    );
    expect(resetForWorktree(state, "/wt")).toBe(state);
  });

  test("returns fresh state when worktree path changes", () => {
    const state = applyFileContent(
      beginSelectFile(createEmptyFileExplorerState("/wt"), "a.txt"),
      content("a.txt", "x"),
    );
    const next = resetForWorktree(state, "/other");
    expect(next.worktreePath).toBe("/other");
    expect(next.selectedFile).toBeNull();
    expect(next.directories).toEqual({});
  });
});

describe("inferMonacoLanguage", () => {
  test("maps common extensions", () => {
    expect(inferMonacoLanguage("a/b.ts")).toBe("typescript");
    expect(inferMonacoLanguage("nested/deep/index.tsx")).toBe("typescript");
    expect(inferMonacoLanguage("script.py")).toBe("python");
    expect(inferMonacoLanguage("config.json")).toBe("json");
    expect(inferMonacoLanguage("style.css")).toBe("css");
    expect(inferMonacoLanguage("notes.md")).toBe("markdown");
    expect(inferMonacoLanguage("compose.yml")).toBe("yaml");
  });

  test("respects basename matches like Dockerfile and Makefile", () => {
    expect(inferMonacoLanguage("Dockerfile")).toBe("dockerfile");
    expect(inferMonacoLanguage("path/to/Makefile")).toBe("makefile");
  });

  test("falls back to plaintext for unknown extensions", () => {
    expect(inferMonacoLanguage("LICENSE")).toBe("plaintext");
    expect(inferMonacoLanguage("file.weirdext")).toBe("plaintext");
  });
});
