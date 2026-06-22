import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  addWorktreeComment,
  getWorktreeComments,
  loadProjects,
  registerProjectBySourcePath,
  removeWorktreeComment,
  validateWorktreeComment,
  WORKTREE_COMMENT_MAX_LENGTH,
  ProjectRegistryError,
} from "@worktreeos/core/project-registry";

let tmpHome: string;
let filePath: string;
let projectId: string;
const sourcePath = "/abs/project-src";
const worktreePath = "/abs/project-src/wt-a";

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "wos-comments-"));
  filePath = join(tmpHome, "projects.json");
  const reg = await registerProjectBySourcePath(sourcePath, {
    filePath,
    newId: () => "proj-1",
  });
  projectId = reg.project.id;
});

afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true });
});

describe("worktree comments", () => {
  test("append, list, and delete a comment", async () => {
    const added = await addWorktreeComment(projectId, worktreePath, "first", {
      filePath,
      now: () => new Date("2026-06-14T10:00:00.000Z"),
      newId: () => "c1",
    });
    expect(added).not.toBeNull();
    expect(added!.comment).toEqual({
      id: "c1",
      text: "first",
      createdAt: "2026-06-14T10:00:00.000Z",
    });

    await addWorktreeComment(projectId, worktreePath, "second", {
      filePath,
      newId: () => "c2",
    });

    const projects = await loadProjects({ filePath });
    const record = projects.find((p) => p.id === projectId)!;
    expect(getWorktreeComments(record, worktreePath).map((c) => c.text)).toEqual([
      "first",
      "second",
    ]);

    await removeWorktreeComment(projectId, worktreePath, "c1", { filePath });
    const after = await loadProjects({ filePath });
    const rec2 = after.find((p) => p.id === projectId)!;
    expect(getWorktreeComments(rec2, worktreePath).map((c) => c.id)).toEqual([
      "c2",
    ]);
  });

  test("rejects empty and over-long comments", async () => {
    await expect(
      addWorktreeComment(projectId, worktreePath, "   ", { filePath }),
    ).rejects.toBeInstanceOf(ProjectRegistryError);
    await expect(
      addWorktreeComment(
        projectId,
        worktreePath,
        "x".repeat(WORKTREE_COMMENT_MAX_LENGTH + 1),
        { filePath },
      ),
    ).rejects.toBeInstanceOf(ProjectRegistryError);
  });

  test("returns null for an unknown project", async () => {
    const result = await addWorktreeComment("nope", worktreePath, "hi", {
      filePath,
    });
    expect(result).toBeNull();
  });

  test("comments survive a load round-trip keyed by resolved path", async () => {
    await addWorktreeComment(projectId, worktreePath, "keep me", {
      filePath,
      newId: () => "c1",
    });
    const projects = await loadProjects({ filePath });
    const record = projects.find((p) => p.id === projectId)!;
    expect(record.worktreeComments).toHaveProperty(resolve(worktreePath));
  });

  test("validation helper", () => {
    expect(validateWorktreeComment("ok").ok).toBe(true);
    expect(validateWorktreeComment("").ok).toBe(false);
    expect(validateWorktreeComment(123).ok).toBe(false);
  });
});
