import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  getWorktreeDisplayName,
  getWorktreeNote,
  loadProjects,
  markProjectError,
  projectsFilePath,
  registerProjectBySourcePath,
  removeWorktreeDisplayName,
  removeWorktreeNote,
  saveProjects,
  setWorktreeDisplayName,
  setWorktreeNote,
  validateWorktreeDisplayName,
  validateWorktreeNote,
  type ProjectRecord,
} from "@worktreeos/core/project-registry";
import {
  resolveProjectPath,
  ProjectResolveError,
} from "@worktreeos/core/project-resolve";

let tmpHome: string;
let filePath: string;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "wos-registry-"));
  filePath = join(tmpHome, "projects.json");
});

afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true });
});

describe("project registry storage", () => {
  test("returns empty list when file is absent", async () => {
    const projects = await loadProjects({ filePath });
    expect(projects).toEqual([]);
  });

  test("does not create the file when loading empty registry", async () => {
    await loadProjects({ filePath });
    const file = Bun.file(filePath);
    expect(await file.exists()).toBe(false);
  });

  test("registers new project with stable id and timestamps", async () => {
    let counter = 0;
    const fixedNow = new Date("2026-05-18T10:00:00.000Z");
    const result = await registerProjectBySourcePath("/repo/main", {
      filePath,
      now: () => fixedNow,
      newId: () => `proj-${++counter}`,
    });
    expect(result.created).toBe(true);
    expect(result.project.id).toBe("proj-1");
    expect(result.project.sourcePath).toBe(resolve("/repo/main"));
    expect(result.project.createdAt).toBe(fixedNow.toISOString());
    expect(result.project.lastSeenAt).toBe(fixedNow.toISOString());
    expect(result.project.displayName).toBe("main");
  });

  test("re-registering existing source path keeps id, bumps lastSeenAt", async () => {
    const t1 = new Date("2026-05-18T10:00:00.000Z");
    const t2 = new Date("2026-05-18T11:00:00.000Z");
    const first = await registerProjectBySourcePath("/repo/main", {
      filePath,
      now: () => t1,
      newId: () => "id-1",
    });
    const second = await registerProjectBySourcePath("/repo/main", {
      filePath,
      now: () => t2,
      newId: () => "id-2",
    });
    expect(second.created).toBe(false);
    expect(second.project.id).toBe("id-1");
    expect(second.project.createdAt).toBe(first.project.createdAt);
    expect(second.project.lastSeenAt).toBe(t2.toISOString());
  });

  test("saves and loads round-trip preserves fields", async () => {
    const recs: ProjectRecord[] = [
      {
        id: "a",
        sourcePath: "/repo/a",
        displayName: "Alpha",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-02T00:00:00.000Z",
        lastError: "stale",
      },
    ];
    await saveProjects(recs, { filePath });
    const loaded = await loadProjects({ filePath });
    expect(loaded).toEqual([
      { ...recs[0]!, sourcePath: resolve("/repo/a") },
    ]);
  });

  test("markProjectError clears error when message is empty", async () => {
    await registerProjectBySourcePath("/repo/a", { filePath });
    const loaded = await loadProjects({ filePath });
    const id = loaded[0]!.id;
    await markProjectError(id, "boom", { filePath });
    const withError = await loadProjects({ filePath });
    expect(withError[0]!.lastError).toBe("boom");
    await markProjectError(id, undefined, { filePath });
    const cleared = await loadProjects({ filePath });
    expect(cleared[0]!.lastError).toBeUndefined();
  });

  test("ignores malformed entries in stored file", async () => {
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        projects: [
          null,
          { id: "ok", sourcePath: "/repo/a", createdAt: "x", lastSeenAt: "y" },
          { sourcePath: "/repo/b" },
          { id: "" },
        ],
      }),
    );
    const loaded = await loadProjects({ filePath });
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.id).toBe("ok");
  });

  test("projectsFilePath uses WOS_HOME when set", () => {
    const path = projectsFilePath({ WOS_HOME: "/custom" });
    expect(path).toBe(resolve("/custom", "projects.json"));
  });
});

describe("worktree display name metadata", () => {
  test("validates trimmed, bounded, non-control values", () => {
    expect(validateWorktreeDisplayName("Checkout redesign")).toEqual({
      ok: true,
      value: "Checkout redesign",
    });
    expect(validateWorktreeDisplayName("  spaced  ")).toEqual({
      ok: true,
      value: "spaced",
    });
    expect(validateWorktreeDisplayName("")).toMatchObject({ ok: false });
    expect(validateWorktreeDisplayName("   ")).toMatchObject({ ok: false });
    expect(validateWorktreeDisplayName(42 as unknown)).toMatchObject({
      ok: false,
    });
    expect(validateWorktreeDisplayName("x".repeat(121))).toMatchObject({
      ok: false,
    });
    expect(validateWorktreeDisplayName("badname")).toMatchObject({
      ok: false,
    });
  });

  test("loadProjects tolerates absent worktreeDisplayNames", async () => {
    await registerProjectBySourcePath("/repo/main", { filePath });
    const list = await loadProjects({ filePath });
    expect(list[0]!.worktreeDisplayNames).toBeUndefined();
  });

  test("setWorktreeDisplayName persists value keyed by normalized path", async () => {
    const reg = await registerProjectBySourcePath("/repo/main", { filePath });
    const wtPath = "/repo/feature";
    const result = await setWorktreeDisplayName(
      reg.project.id,
      wtPath,
      "  Checkout redesign  ",
      { filePath },
    );
    expect(result).not.toBeNull();
    expect(result!.displayName).toBe("Checkout redesign");

    const reloaded = await loadProjects({ filePath });
    const stored = reloaded.find((p) => p.id === reg.project.id);
    expect(getWorktreeDisplayName(stored!, wtPath)).toBe("Checkout redesign");
    expect(getWorktreeDisplayName(stored!, "/repo/main")).toBeUndefined();
  });

  test("setWorktreeDisplayName rejects invalid input", async () => {
    const reg = await registerProjectBySourcePath("/repo/main", { filePath });
    await expect(
      setWorktreeDisplayName(reg.project.id, "/repo/x", "  ", { filePath }),
    ).rejects.toThrow(/empty/);
  });

  test("setWorktreeDisplayName returns null for unknown project", async () => {
    const result = await setWorktreeDisplayName(
      "nope",
      "/repo/x",
      "Name",
      { filePath },
    );
    expect(result).toBeNull();
  });

  test("removeWorktreeDisplayName drops the entry and the map when empty", async () => {
    const reg = await registerProjectBySourcePath("/repo/main", { filePath });
    await setWorktreeDisplayName(reg.project.id, "/repo/feature", "X", {
      filePath,
    });
    const after = await removeWorktreeDisplayName(
      reg.project.id,
      "/repo/feature",
      { filePath },
    );
    expect(after!.worktreeDisplayNames).toBeUndefined();
  });

  test("loadProjects ignores malformed worktreeDisplayNames entries", async () => {
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        projects: [
          {
            id: "p",
            sourcePath: "/repo/main",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastSeenAt: "2026-01-01T00:00:00.000Z",
            worktreeDisplayNames: {
              "/repo/a": "Good Name",
              "/repo/b": 42,
              "/repo/c": "   ",
              "/repo/d": "x".repeat(200),
              "": "Anonymous",
            },
          },
        ],
      }),
    );
    const list = await loadProjects({ filePath });
    expect(list).toHaveLength(1);
    expect(list[0]!.worktreeDisplayNames).toEqual({
      [resolve("/repo/a")]: "Good Name",
    });
  });
});

describe("worktree note metadata", () => {
  test("validates trimmed, bounded values; allows newlines; empty is ok", () => {
    expect(validateWorktreeNote("QA is testing\nhere")).toEqual({
      ok: true,
      value: "QA is testing\nhere",
    });
    expect(validateWorktreeNote("  spaced  ")).toEqual({
      ok: true,
      value: "spaced",
    });
    // Empty/whitespace-only is valid and means "clear".
    expect(validateWorktreeNote("")).toEqual({ ok: true, value: "" });
    expect(validateWorktreeNote("   ")).toEqual({ ok: true, value: "" });
    expect(validateWorktreeNote(42 as unknown)).toMatchObject({ ok: false });
    expect(validateWorktreeNote("x".repeat(1001))).toMatchObject({
      ok: false,
    });
    expect(validateWorktreeNote("bad\x00null")).toMatchObject({ ok: false });
  });

  test("set and read a note keyed by normalized path", async () => {
    const reg = await registerProjectBySourcePath("/repo/main", { filePath });
    const result = await setWorktreeNote(
      reg.project.id,
      "/repo/feature",
      "  do not delete  ",
      { filePath },
    );
    expect(result).not.toBeNull();
    expect(result!.note).toBe("do not delete");

    const reloaded = await loadProjects({ filePath });
    const stored = reloaded.find((p) => p.id === reg.project.id);
    expect(getWorktreeNote(stored!, "/repo/feature")).toBe("do not delete");
    expect(getWorktreeNote(stored!, "/repo/main")).toBeUndefined();
  });

  test("empty note clears the stored value", async () => {
    const reg = await registerProjectBySourcePath("/repo/main", { filePath });
    await setWorktreeNote(reg.project.id, "/repo/feature", "temp", { filePath });
    const cleared = await setWorktreeNote(reg.project.id, "/repo/feature", "  ", {
      filePath,
    });
    expect(cleared!.note).toBeUndefined();
    const reloaded = await loadProjects({ filePath });
    expect(reloaded[0]!.worktreeNotes).toBeUndefined();
  });

  test("note is independent of display name", async () => {
    const reg = await registerProjectBySourcePath("/repo/main", { filePath });
    await setWorktreeDisplayName(reg.project.id, "/repo/feature", "Checkout", {
      filePath,
    });
    await setWorktreeNote(reg.project.id, "/repo/feature", "demo Friday", {
      filePath,
    });
    const reloaded = await loadProjects({ filePath });
    const stored = reloaded[0]!;
    expect(getWorktreeDisplayName(stored, "/repo/feature")).toBe("Checkout");
    expect(getWorktreeNote(stored, "/repo/feature")).toBe("demo Friday");
    // Updating the note leaves the display name intact.
    await setWorktreeNote(reg.project.id, "/repo/feature", "changed", {
      filePath,
    });
    const after = (await loadProjects({ filePath }))[0]!;
    expect(getWorktreeDisplayName(after, "/repo/feature")).toBe("Checkout");
    expect(getWorktreeNote(after, "/repo/feature")).toBe("changed");
  });

  test("removeWorktreeNote drops the entry and the map when empty", async () => {
    const reg = await registerProjectBySourcePath("/repo/main", { filePath });
    await setWorktreeNote(reg.project.id, "/repo/feature", "X", { filePath });
    const after = await removeWorktreeNote(reg.project.id, "/repo/feature", {
      filePath,
    });
    expect(after!.worktreeNotes).toBeUndefined();
  });

  test("setWorktreeNote returns null for unknown project", async () => {
    const result = await setWorktreeNote("nope", "/repo/x", "note", {
      filePath,
    });
    expect(result).toBeNull();
  });
});

describe("manual project resolution", () => {
  test("rejects missing path", async () => {
    await expect(
      resolveProjectPath(join(tmpHome, "does-not-exist")),
    ).rejects.toBeInstanceOf(ProjectResolveError);
  });

  test("rejects non-directory path", async () => {
    const f = join(tmpHome, "afile");
    await writeFile(f, "x");
    try {
      await resolveProjectPath(f);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ProjectResolveError);
      expect((e as ProjectResolveError).code).toBe("not-directory");
    }
  });

  test("rejects a non-worktree directory", async () => {
    const dir = join(tmpHome, "plain");
    await mkdir(dir, { recursive: true });
    const runner = async (_root: string, _args: string[]) => {
      const { GitError } = await import("@worktreeos/core/git");
      throw new GitError(
        "git -C plain worktree list --porcelain failed (exit 128): fatal: not a git repository",
      );
    };
    try {
      await resolveProjectPath(dir, { gitRunner: runner });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ProjectResolveError);
      expect((e as ProjectResolveError).code).toBe("not-a-worktree");
    }
  });

  test("returns selected source worktree even when input is non-source", async () => {
    const dir = join(tmpHome, "feature");
    await mkdir(dir, { recursive: true });
    const output = [
      "worktree /repo/main",
      "HEAD aaa",
      "branch refs/heads/main",
      "",
      "worktree /repo/feature",
      "HEAD bbb",
      "branch refs/heads/feature",
      "",
    ].join("\n");
    const runner = async () => output;
    const resolved = await resolveProjectPath(dir, { gitRunner: runner });
    expect(resolved.sourcePath).toBe(resolve("/repo/main"));
    expect(resolved.source.branch).toBe("main");
    expect(resolved.worktrees.length).toBe(2);
  });
});

describe("git diff helpers", () => {
  test("readStagedDiff invokes git diff --cached scoped to worktree", async () => {
    const { readStagedDiff } = await import("@worktreeos/core/git");
    const calls: Array<{ root: string; args: string[] }> = [];
    const runner = async (root: string, args: string[]) => {
      calls.push({ root, args });
      return "diff --staged\n";
    };
    const result = await readStagedDiff("/repo/main", runner);
    expect(result).toBe("diff --staged\n");
    expect(calls[0]).toEqual({
      root: "/repo/main",
      args: ["diff", "--cached", "--no-ext-diff", "--"],
    });
  });

  test("readUnstagedDiff invokes git diff scoped to worktree", async () => {
    const { readUnstagedDiff } = await import("@worktreeos/core/git");
    const calls: Array<{ root: string; args: string[] }> = [];
    const runner = async (root: string, args: string[]) => {
      calls.push({ root, args });
      return "diff\n";
    };
    const result = await readUnstagedDiff("/repo/main", runner);
    expect(result).toBe("diff\n");
    expect(calls[0]).toEqual({
      root: "/repo/main",
      args: ["diff", "--no-ext-diff", "--"],
    });
  });
});

describe("git worktree metadata parsing", () => {
  test("preserves branch and HEAD when reported", async () => {
    const { parseWorktreeList } = await import("@worktreeos/core/git");
    const output = [
      "worktree /repo/main",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repo/feature",
      "HEAD def456",
      "branch refs/heads/feature/x",
      "",
    ].join("\n");
    const entries = parseWorktreeList(output);
    expect(entries[0]!).toEqual({
      path: "/repo/main",
      bare: false,
      detached: false,
      head: "abc123",
      branchRef: "refs/heads/main",
      branch: "main",
    });
    expect(entries[1]!.branch).toBe("feature/x");
  });

  test("detached and bare entries omit branch/HEAD", async () => {
    const { parseWorktreeList } = await import("@worktreeos/core/git");
    const output = [
      "worktree /repo/bare",
      "bare",
      "",
      "worktree /repo/det",
      "HEAD xyz",
      "detached",
      "",
    ].join("\n");
    const entries = parseWorktreeList(output);
    expect(entries[0]!.branch).toBeUndefined();
    expect(entries[0]!.head).toBeUndefined();
    expect(entries[1]!.detached).toBe(true);
    expect(entries[1]!.head).toBe("xyz");
    expect(entries[1]!.branch).toBeUndefined();
  });
});
