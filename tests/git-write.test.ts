import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  commit,
  createBranchInPlace,
  detectHeadState,
  fetch,
  GitError,
  hasStagedChanges,
  isValidBranchName,
  NothingStagedError,
  push,
  stageAllChanges,
  stageFiles,
  unstageFiles,
} from "@worktreeos/core/git";

async function makeTempGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wos-git-write-"));
  const root = await realpath(dir);
  await Bun.$`git init -q ${root}`.quiet();
  await Bun.$`git -C ${root} config user.email t@t.t`.quiet();
  await Bun.$`git -C ${root} config user.name t`.quiet();
  await Bun.$`git -C ${root} config commit.gpgsign false`.quiet();
  await writeFile(join(root, "seed.txt"), "seed\n");
  await Bun.$`git -C ${root} add seed.txt`.quiet();
  await Bun.$`git -C ${root} commit -q -m init`.quiet();
  return root;
}

async function stagedNames(root: string): Promise<string[]> {
  const out = await Bun.$`git -C ${root} diff --cached --name-only`.text();
  return out.split("\n").filter((l) => l.length > 0);
}

describe("isValidBranchName", () => {
  test("accepts ordinary names", () => {
    expect(isValidBranchName("feature/x")).toBe(true);
    expect(isValidBranchName("fix-123")).toBe(true);
  });
  test("rejects invalid names", () => {
    expect(isValidBranchName("")).toBe(false);
    expect(isValidBranchName("has space")).toBe(false);
    expect(isValidBranchName("-leading")).toBe(false);
    expect(isValidBranchName("trailing/")).toBe(false);
    expect(isValidBranchName("a..b")).toBe(false);
    expect(isValidBranchName("a~b")).toBe(false);
    expect(isValidBranchName("ends.lock")).toBe(false);
  });
});

describe("git write operations", () => {
  let root: string;
  beforeEach(async () => {
    root = await makeTempGitRepo();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("stageFiles / unstageFiles toggle staging", async () => {
    await writeFile(join(root, "a.txt"), "a\n");
    await stageFiles(root, ["a.txt"]);
    expect(await stagedNames(root)).toEqual(["a.txt"]);
    expect(await hasStagedChanges(root)).toBe(true);

    await unstageFiles(root, ["a.txt"]);
    expect(await stagedNames(root)).toEqual([]);
    expect(await hasStagedChanges(root)).toBe(false);
  });

  test("stageAllChanges stages tracked modifications and untracked files", async () => {
    await writeFile(join(root, "seed.txt"), "seed-changed\n"); // tracked modification
    await writeFile(join(root, "new.txt"), "new\n"); // untracked addition

    await stageAllChanges(root);
    expect(await hasStagedChanges(root)).toBe(true);
    expect((await stagedNames(root)).sort()).toEqual(["new.txt", "seed.txt"]);

    const result = await commit(root, { message: "commit all" });
    expect(result.summary).toContain("commit all");
  });

  test("stageFiles rejects pathspecs that escape the worktree root", async () => {
    await expect(stageFiles(root, ["../escape.txt"])).rejects.toBeInstanceOf(
      GitError,
    );
    await expect(stageFiles(root, [""])).rejects.toBeInstanceOf(GitError);
  });

  test("commit creates a commit from staged changes", async () => {
    await writeFile(join(root, "a.txt"), "a\n");
    await stageFiles(root, ["a.txt"]);
    const result = await commit(root, { message: "add a" });
    expect(result.sha.length).toBeGreaterThan(0);
    expect(result.summary).toContain("add a");
    const log = await Bun.$`git -C ${root} log -1 --pretty=%s`.text();
    expect(log.trim()).toBe("add a");
  });

  test("commit rejects with NothingStagedError when nothing staged", async () => {
    await expect(commit(root, { message: "noop" })).rejects.toBeInstanceOf(
      NothingStagedError,
    );
  });

  test("commit --amend folds staged changes into the latest commit", async () => {
    await writeFile(join(root, "a.txt"), "a\n");
    await stageFiles(root, ["a.txt"]);
    await commit(root, { message: "first" });
    const before = (await Bun.$`git -C ${root} rev-list --count HEAD`.text()).trim();

    await writeFile(join(root, "b.txt"), "b\n");
    await stageFiles(root, ["b.txt"]);
    const amended = await commit(root, { message: "first amended", amend: true });
    const after = (await Bun.$`git -C ${root} rev-list --count HEAD`.text()).trim();

    expect(after).toBe(before);
    expect(amended.summary).toContain("first amended");
    const subject = await Bun.$`git -C ${root} log -1 --pretty=%s`.text();
    expect(subject.trim()).toBe("first amended");
  });

  test("detectHeadState reports attached and detached heads", async () => {
    const attached = await detectHeadState(root);
    expect(attached.detached).toBe(false);
    expect(attached.branch).toBeDefined();
    expect(attached.head.length).toBeGreaterThan(0);

    const sha = (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim();
    await Bun.$`git -C ${root} checkout -q --detach ${sha}`.quiet();
    const detached = await detectHeadState(root);
    expect(detached.detached).toBe(true);
    expect(detached.branch).toBeUndefined();
    expect(detached.head.length).toBeGreaterThan(0);
  });

  test("createBranchInPlace creates and switches to a new branch", async () => {
    const sha = (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim();
    await Bun.$`git -C ${root} checkout -q --detach ${sha}`.quiet();

    const head = await createBranchInPlace(root, "work/new-feature");
    expect(head.detached).toBe(false);
    expect(head.branch).toBe("work/new-feature");

    await writeFile(join(root, "c.txt"), "c\n");
    await stageFiles(root, ["c.txt"]);
    await commit(root, { message: "on branch" });
    const branch = (
      await Bun.$`git -C ${root} rev-parse --abbrev-ref HEAD`.text()
    ).trim();
    expect(branch).toBe("work/new-feature");
  });

  test("createBranchInPlace rejects an invalid name without spawning git", async () => {
    await expect(createBranchInPlace(root, "bad name")).rejects.toBeInstanceOf(
      GitError,
    );
  });

  test("createBranchInPlace rejects an already-existing branch", async () => {
    const current = (
      await Bun.$`git -C ${root} rev-parse --abbrev-ref HEAD`.text()
    ).trim();
    await expect(createBranchInPlace(root, current)).rejects.toBeInstanceOf(
      GitError,
    );
  });

  test("push sends the current branch to a remote", async () => {
    const bareDir = await mkdtemp(join(tmpdir(), "wos-git-remote-"));
    const bare = await realpath(bareDir);
    try {
      await Bun.$`git init -q --bare ${bare}`.quiet();
      await Bun.$`git -C ${root} remote add origin ${bare}`.quiet();

      // No upstream yet → must set it.
      await push(root, { setUpstream: true });
      const branch = (
        await Bun.$`git -C ${root} rev-parse --abbrev-ref HEAD`.text()
      ).trim();
      const remoteSha = (
        await Bun.$`git -C ${bare} rev-parse ${branch}`.text()
      ).trim();
      const localSha = (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim();
      expect(remoteSha).toBe(localSha);

      // Upstream now exists → plain push works.
      await writeFile(join(root, "d.txt"), "d\n");
      await stageFiles(root, ["d.txt"]);
      await commit(root, { message: "more" });
      await push(root);
      const remoteSha2 = (
        await Bun.$`git -C ${bare} rev-parse ${branch}`.text()
      ).trim();
      const localSha2 = (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim();
      expect(remoteSha2).toBe(localSha2);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  test("push surfaces a GitError when there is no remote", async () => {
    await expect(push(root)).rejects.toBeInstanceOf(GitError);
  });

  test("fetch refreshes remote-tracking refs without touching the working tree", async () => {
    const bareDir = await mkdtemp(join(tmpdir(), "wos-git-fetch-"));
    const bare = await realpath(bareDir);
    const otherDir = await mkdtemp(join(tmpdir(), "wos-git-fetch-other-"));
    const other = await realpath(otherDir);
    try {
      await Bun.$`git init -q --bare ${bare}`.quiet();
      await Bun.$`git -C ${root} remote add origin ${bare}`.quiet();
      await push(root, { setUpstream: true });

      // A second clone advances the remote behind our worktree's back.
      await Bun.$`git clone -q ${bare} ${other}`.quiet();
      await Bun.$`git -C ${other} config user.email t@t.t`.quiet();
      await Bun.$`git -C ${other} config user.name t`.quiet();
      await Bun.$`git -C ${other} config commit.gpgsign false`.quiet();
      await writeFile(join(other, "remote.txt"), "remote\n");
      await Bun.$`git -C ${other} add remote.txt`.quiet();
      await Bun.$`git -C ${other} commit -q -m remote`.quiet();
      await Bun.$`git -C ${other} push -q`.quiet();

      const headBefore = (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim();
      await fetch(root);
      const headAfter = (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim();
      // Fetch must not move HEAD / touch the working tree.
      expect(headAfter).toBe(headBefore);

      // The remote-tracking ref now points at the pushed remote commit.
      const branch = (
        await Bun.$`git -C ${root} rev-parse --abbrev-ref HEAD`.text()
      ).trim();
      const remoteSha = (await Bun.$`git -C ${bare} rev-parse ${branch}`.text()).trim();
      const trackingSha = (
        await Bun.$`git -C ${root} rev-parse refs/remotes/origin/${branch}`.text()
      ).trim();
      expect(trackingSha).toBe(remoteSha);
    } finally {
      await rm(bare, { recursive: true, force: true });
      await rm(other, { recursive: true, force: true });
    }
  });

  test("fetch is a no-op when the worktree has no remote", async () => {
    const result = await fetch(root);
    expect(result.summary).toBe("");
  });

  test("fetch surfaces a GitError preserving the message for an unreachable remote", async () => {
    await Bun.$`git -C ${root} remote add origin ${join(tmpdir(), "wos-missing-remote-xyz")}`.quiet();
    await expect(fetch(root)).rejects.toBeInstanceOf(GitError);
  });
});
