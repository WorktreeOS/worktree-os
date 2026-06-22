import { test, expect, describe } from "bun:test";
import {
  assertNotSourceWorktree,
  branchExistsInSource,
  buildBranchWorktreeAddArgs,
  buildDetachedWorktreeAddArgs,
  buildWorktreeRemoveArgs,
  createBranchWorktreeFromSource,
  createDetachedWorktreeFromSource,
  ensureCurrentWorktree,
  GitError,
  isNonWorktreeGitError,
  isSourceWorktree,
  NotInsideWorktreeError,
  NOT_INSIDE_WORKTREE_MESSAGE,
  parseDirtyStatus,
  parsePorcelainEntries,
  parseWorktreeList,
  readWorktreeDirtyStatus,
  removeWorktreeFromSource,
  selectSourceWorktree,
  SourceWorktreeRemoveError,
  SOURCE_WORKTREE_REMOVE_MESSAGE,
  type GitRunner,
  type WorktreeGitRunner,
} from "@worktreeos/core/git";

describe("parseWorktreeList", () => {
  test("parses normal entries", () => {
    const output = [
      "worktree /repo/main",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repo/feature",
      "HEAD def456",
      "branch refs/heads/feature",
      "",
    ].join("\n");
    const entries = parseWorktreeList(output);
    expect(entries).toEqual([
      {
        path: "/repo/main",
        bare: false,
        detached: false,
        head: "abc123",
        branchRef: "refs/heads/main",
        branch: "main",
      },
      {
        path: "/repo/feature",
        bare: false,
        detached: false,
        head: "def456",
        branchRef: "refs/heads/feature",
        branch: "feature",
      },
    ]);
  });

  test("parses detached and bare flags", () => {
    const output = [
      "worktree /repo/bare",
      "bare",
      "",
      "worktree /repo/detached",
      "HEAD abc",
      "detached",
      "",
      "worktree /repo/normal",
      "HEAD def",
      "branch refs/heads/main",
      "",
    ].join("\n");
    const entries = parseWorktreeList(output);
    expect(entries).toEqual([
      { path: "/repo/bare", bare: true, detached: false },
      {
        path: "/repo/detached",
        bare: false,
        detached: true,
        head: "abc",
      },
      {
        path: "/repo/normal",
        bare: false,
        detached: false,
        head: "def",
        branchRef: "refs/heads/main",
        branch: "main",
      },
    ]);
  });

  test("tolerates trailing entry without blank line", () => {
    const output = "worktree /repo/main\nHEAD abc\nbranch refs/heads/main\n";
    expect(parseWorktreeList(output)).toEqual([
      {
        path: "/repo/main",
        bare: false,
        detached: false,
        head: "abc",
        branchRef: "refs/heads/main",
        branch: "main",
      },
    ]);
  });
});

describe("selectSourceWorktree", () => {
  test("prefers first non-bare non-detached", () => {
    const entries = [
      { path: "/repo/bare", bare: true, detached: false },
      { path: "/repo/feature", bare: false, detached: true },
      { path: "/repo/main", bare: false, detached: false },
      { path: "/repo/other", bare: false, detached: false },
    ];
    expect(selectSourceWorktree(entries)).toEqual(entries[2]!);
  });

  test("falls back to first entry when only detached/bare exist", () => {
    const entries = [
      { path: "/repo/bare", bare: true, detached: false },
      { path: "/repo/det", bare: false, detached: true },
    ];
    expect(selectSourceWorktree(entries)).toEqual(entries[0]!);
  });

  test("throws on empty list", () => {
    expect(() => selectSourceWorktree([])).toThrow();
  });
});

describe("ensureCurrentWorktree", () => {
  test("returns worktree root and git dir for a valid worktree", async () => {
    const calls: string[][] = [];
    const runner: GitRunner = async (args) => {
      calls.push(args);
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return "/repo/main\n";
      }
      if (args[0] === "rev-parse" && args[1] === "--git-dir") {
        return "/repo/main/.git\n";
      }
      throw new GitError(`unexpected git args: ${args.join(" ")}`);
    };
    const result = await ensureCurrentWorktree(runner);
    expect(result).toEqual({
      worktreeRoot: "/repo/main",
      gitDir: "/repo/main/.git",
    });
    expect(calls).toEqual([
      ["rev-parse", "--show-toplevel"],
      ["rev-parse", "--git-dir"],
    ]);
  });

  test("throws NotInsideWorktreeError when rev-parse reports not a git repository", async () => {
    const runner: GitRunner = async () => {
      throw new GitError(
        "git rev-parse --show-toplevel failed (exit 128): fatal: not a git repository (or any of the parent directories): .git",
      );
    };
    await expect(ensureCurrentWorktree(runner)).rejects.toBeInstanceOf(
      NotInsideWorktreeError,
    );
    try {
      await ensureCurrentWorktree(runner);
    } catch (e) {
      expect((e as Error).message).toBe(NOT_INSIDE_WORKTREE_MESSAGE);
    }
  });

  test("throws NotInsideWorktreeError for not inside a work tree", async () => {
    const runner: GitRunner = async () => {
      throw new GitError(
        "git rev-parse --git-dir failed (exit 128): fatal: not inside a work tree",
      );
    };
    await expect(ensureCurrentWorktree(runner)).rejects.toBeInstanceOf(
      NotInsideWorktreeError,
    );
  });

  test("preserves unrelated GitError without misclassifying as non-worktree", async () => {
    const original = new GitError(
      "git rev-parse --show-toplevel failed (exit 128): fatal: bad object HEAD",
    );
    const runner: GitRunner = async () => {
      throw original;
    };
    await expect(ensureCurrentWorktree(runner)).rejects.toBe(original);
  });

  test("preserves non-GitError (programmer error) untouched", async () => {
    const oops = new TypeError("something else");
    const runner: GitRunner = async () => {
      throw oops;
    };
    await expect(ensureCurrentWorktree(runner)).rejects.toBe(oops);
  });
});

describe("isSourceWorktree", () => {
  test("returns true when current root matches source path", () => {
    expect(isSourceWorktree("/repo/main", { path: "/repo/main", bare: false, detached: false })).toBe(true);
  });

  test("returns false when current root differs from source path", () => {
    expect(isSourceWorktree("/repo/feature", { path: "/repo/main", bare: false, detached: false })).toBe(false);
  });

  test("normalizes paths with trailing components", () => {
    expect(isSourceWorktree("/repo/main/.", { path: "/repo/main", bare: false, detached: false })).toBe(true);
  });
});

describe("buildWorktreeRemoveArgs", () => {
  test("builds basic remove args without force", () => {
    expect(buildWorktreeRemoveArgs("/repo/feature")).toEqual([
      "worktree",
      "remove",
      "/repo/feature",
    ]);
  });

  test("appends --force when force=true", () => {
    expect(
      buildWorktreeRemoveArgs("/repo/feature", { force: true }),
    ).toEqual(["worktree", "remove", "--force", "/repo/feature"]);
  });

  test("does not include --force when force=false", () => {
    expect(
      buildWorktreeRemoveArgs("/repo/feature", { force: false }),
    ).toEqual(["worktree", "remove", "/repo/feature"]);
  });

  test("does not include branch deletion flags so branch is preserved", () => {
    const args = buildWorktreeRemoveArgs("/repo/feature", { force: true });
    expect(args).not.toContain("--delete-branch");
    expect(args).not.toContain("-D");
    expect(args).not.toContain("branch");
  });
});

describe("removeWorktreeFromSource", () => {
  test("invokes git from source worktree with remove args", async () => {
    const calls: Array<{ cwd: string; args: string[] }> = [];
    const runner: WorktreeGitRunner = async (cwd, args) => {
      calls.push({ cwd, args });
      return "";
    };
    await removeWorktreeFromSource(
      "/repo/main",
      "/repo/feature",
      { force: true },
      runner,
    );
    expect(calls).toEqual([
      {
        cwd: "/repo/main",
        args: ["worktree", "remove", "--force", "/repo/feature"],
      },
    ]);
  });

  test("propagates git failure messages", async () => {
    const runner: WorktreeGitRunner = async () => {
      throw new GitError(
        "git -C /repo/main worktree remove /repo/feature failed (exit 128): fatal: dirty",
      );
    };
    await expect(
      removeWorktreeFromSource("/repo/main", "/repo/feature", {}, runner),
    ).rejects.toBeInstanceOf(GitError);
  });
});

describe("assertNotSourceWorktree", () => {
  test("throws SourceWorktreeRemoveError when target equals source path", () => {
    const entries = [
      {
        path: "/repo/main",
        bare: false,
        detached: false,
        head: "abc",
        branchRef: "refs/heads/main",
        branch: "main",
      },
      {
        path: "/repo/feature",
        bare: false,
        detached: false,
        head: "def",
        branchRef: "refs/heads/feature",
        branch: "feature",
      },
    ];
    expect(() => assertNotSourceWorktree("/repo/main", entries)).toThrow(
      SourceWorktreeRemoveError,
    );
    try {
      assertNotSourceWorktree("/repo/main", entries);
    } catch (e) {
      expect((e as Error).message).toBe(SOURCE_WORKTREE_REMOVE_MESSAGE);
    }
  });

  test("does not throw when target is secondary worktree", () => {
    const entries = [
      {
        path: "/repo/main",
        bare: false,
        detached: false,
        head: "abc",
        branchRef: "refs/heads/main",
        branch: "main",
      },
      {
        path: "/repo/feature",
        bare: false,
        detached: false,
        head: "def",
        branchRef: "refs/heads/feature",
        branch: "feature",
      },
    ];
    expect(() =>
      assertNotSourceWorktree("/repo/feature", entries),
    ).not.toThrow();
  });
});

describe("buildDetachedWorktreeAddArgs", () => {
  test("creates a detached worktree at HEAD without branch refs", () => {
    expect(buildDetachedWorktreeAddArgs("/tmp/wos-home/worktrees/app/wt"),
    ).toEqual([
      "worktree",
      "add",
      "--detach",
      "/tmp/wos-home/worktrees/app/wt",
      "HEAD",
    ]);
  });
});

describe("buildBranchWorktreeAddArgs", () => {
  test("attaches the worktree to an existing branch without -b", () => {
    const args = buildBranchWorktreeAddArgs(
      "/tmp/wos-home/worktrees/app/wt",
      "feature/login",
    );
    expect(args).toEqual([
      "worktree",
      "add",
      "/tmp/wos-home/worktrees/app/wt",
      "feature/login",
    ]);
    expect(args).not.toContain("-b");
    expect(args).not.toContain("-B");
  });
});

describe("branchExistsInSource", () => {
  test("returns true when rev-parse succeeds", async () => {
    const runner: WorktreeGitRunner = async (_cwd, args) => {
      expect(args).toEqual([
        "rev-parse",
        "--verify",
        "--quiet",
        "refs/heads/feature",
      ]);
      return "abc\n";
    };
    expect(await branchExistsInSource("/repo/main", "feature", runner)).toBe(
      true,
    );
  });

  test("returns false when rev-parse fails", async () => {
    const runner: WorktreeGitRunner = async () => {
      throw new GitError("git rev-parse failed (exit 1): ");
    };
    expect(await branchExistsInSource("/repo/main", "missing", runner)).toBe(
      false,
    );
  });

  test("rethrows non-GitError failures", async () => {
    const original = new TypeError("oops");
    const runner: WorktreeGitRunner = async () => {
      throw original;
    };
    await expect(
      branchExistsInSource("/repo/main", "x", runner),
    ).rejects.toBe(original);
  });
});

describe("createDetachedWorktreeFromSource", () => {
  test("invokes git worktree add --detach from the source worktree", async () => {
    const calls: Array<{ cwd: string; args: string[] }> = [];
    const runner: WorktreeGitRunner = async (cwd, args) => {
      calls.push({ cwd, args });
      return "";
    };
    await createDetachedWorktreeFromSource(
      "/repo/main",
      "/tmp/wos-home/worktrees/app/wt",
      runner,
    );
    expect(calls).toEqual([
      {
        cwd: "/repo/main",
        args: [
          "worktree",
          "add",
          "--detach",
          "/tmp/wos-home/worktrees/app/wt",
          "HEAD",
        ],
      },
    ]);
  });
});

describe("createBranchWorktreeFromSource", () => {
  test("invokes git worktree add <path> <branch> from the source worktree", async () => {
    const calls: Array<{ cwd: string; args: string[] }> = [];
    const runner: WorktreeGitRunner = async (cwd, args) => {
      calls.push({ cwd, args });
      return "";
    };
    await createBranchWorktreeFromSource(
      "/repo/main",
      "/tmp/wos-home/worktrees/app/wt",
      "feature/login",
      runner,
    );
    expect(calls).toEqual([
      {
        cwd: "/repo/main",
        args: [
          "worktree",
          "add",
          "/tmp/wos-home/worktrees/app/wt",
          "feature/login",
        ],
      },
    ]);
  });

  test("propagates git failure messages (e.g. branch already checked out)", async () => {
    const runner: WorktreeGitRunner = async () => {
      throw new GitError(
        "git -C /repo/main worktree add ... failed (exit 128): fatal: 'feature/login' is already checked out at '/repo/other'",
      );
    };
    await expect(
      createBranchWorktreeFromSource(
        "/repo/main",
        "/tmp/wt",
        "feature/login",
        runner,
      ),
    ).rejects.toBeInstanceOf(GitError);
  });
});

describe("isNonWorktreeGitError", () => {
  test("matches common non-worktree messages", () => {
    expect(
      isNonWorktreeGitError(
        new GitError("git rev-parse --show-toplevel failed (exit 128): fatal: not a git repository"),
      ),
    ).toBe(true);
    expect(
      isNonWorktreeGitError(
        new GitError("git rev-parse --git-dir failed (exit 128): fatal: not inside a work tree"),
      ),
    ).toBe(true);
  });

  test("does not match unrelated git errors", () => {
    expect(
      isNonWorktreeGitError(new GitError("git status failed (exit 1): fatal: bad object HEAD")),
    ).toBe(false);
  });

  test("does not match non-GitError values", () => {
    expect(isNonWorktreeGitError(new Error("not a git repository"))).toBe(false);
    expect(isNonWorktreeGitError(undefined)).toBe(false);
  });
});

describe("parseDirtyStatus", () => {
  test("reports zero totals for an empty porcelain output", () => {
    expect(parseDirtyStatus("")).toEqual({
      total: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      unmerged: 0,
    });
  });

  test("counts staged, unstaged, untracked, and unmerged entries", () => {
    const output = [
      "M  staged.ts",
      " M unstaged.ts",
      "MM both.ts",
      "?? untracked.ts",
      "UU conflict.ts",
      "AA both-added.ts",
      "",
    ].join("\n");
    const status = parseDirtyStatus(output);
    expect(status.total).toBe(6);
    expect(status.untracked).toBe(1);
    expect(status.unmerged).toBe(2);
    // staged.ts (M ), both.ts (MM) — staged column non-blank, not "??"/unmerged
    expect(status.staged).toBe(2);
    // unstaged.ts ( M), both.ts (MM) — worktree column non-blank, not untracked/unmerged
    expect(status.unstaged).toBe(2);
  });

  test("ignores blank lines and lines shorter than two characters", () => {
    const status = parseDirtyStatus("\n  \nM\n");
    expect(status.total).toBe(0);
  });
});

describe("parsePorcelainEntries", () => {
  test("keeps path and XY code for modified, added, deleted, and untracked", () => {
    const output = [
      " M src/app.ts",
      "A  src/new.ts",
      " D src/gone.ts",
      "?? notes.txt",
      "",
    ].join("\n");
    expect(parsePorcelainEntries(output)).toEqual([
      { path: "src/app.ts", code: " M" },
      { path: "src/new.ts", code: "A " },
      { path: "src/gone.ts", code: " D" },
      { path: "notes.txt", code: "??" },
    ]);
  });

  test("attributes rename/copy lines to the destination path", () => {
    const output = ["R  src/old.ts -> src/renamed.ts", ""].join("\n");
    expect(parsePorcelainEntries(output)).toEqual([
      { path: "src/renamed.ts", code: "R " },
    ]);
  });

  test("unquotes quoted paths with special characters", () => {
    // Git quotes paths with spaces/specials when core.quotePath is on.
    const output = ['?? "with space.txt"', ""].join("\n");
    expect(parsePorcelainEntries(output)).toEqual([
      { path: "with space.txt", code: "??" },
    ]);
  });

  test("ignores blank and too-short lines", () => {
    expect(parsePorcelainEntries("\n  \nM\n")).toEqual([]);
  });
});

describe("readWorktreeDirtyStatus", () => {
  test("invokes git status with porcelain v1 and untracked-files=all", async () => {
    const calls: Array<{ cwd: string; args: string[] }> = [];
    const runner: WorktreeGitRunner = async (cwd, args) => {
      calls.push({ cwd, args });
      return "";
    };
    const status = await readWorktreeDirtyStatus("/repo/feature", runner);
    expect(calls).toEqual([
      {
        cwd: "/repo/feature",
        args: ["status", "--porcelain=v1", "--untracked-files=all"],
      },
    ]);
    expect(status.total).toBe(0);
  });

  test("returns parsed counts from runner output", async () => {
    const runner: WorktreeGitRunner = async () =>
      ["?? new.ts", " M edited.ts", ""].join("\n");
    const status = await readWorktreeDirtyStatus("/repo/feature", runner);
    expect(status.total).toBe(2);
    expect(status.untracked).toBe(1);
    expect(status.unstaged).toBe(1);
  });
});
