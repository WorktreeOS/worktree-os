import { test, expect, describe, afterEach } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runStatus } from "../apps/cli/commands/status";
import { GitError, type GitRunner } from "@worktreeos/core/git";

interface CapturedStreams {
  stdout: string;
  stderr: string;
  restore(): void;
}

function captureStdio(): CapturedStreams {
  let stdout = "";
  let stderr = "";
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;
  return {
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    restore() {
      process.stdout.write = origOut as typeof process.stdout.write;
      process.stderr.write = origErr as typeof process.stderr.write;
    },
  };
}

const tempDirs: string[] = [];
async function makeEmptyDir(): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), "wos-status-guard-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

const nonWorktreeRunner: GitRunner = async () => {
  throw new GitError(
    "git rev-parse --show-toplevel failed (exit 128): fatal: not a git repository (or any of the parent directories): .git",
  );
};

describe("runStatus non-worktree guard", () => {
  test("reports guard message and returns failure when not inside a worktree", async () => {
    const dir = await makeEmptyDir();
    const cwd = process.cwd();
    process.chdir(dir);
    const cap = captureStdio();
    try {
      const code = await runStatus([], { gitRunner: nonWorktreeRunner });
      expect(code).toBe(1);
      expect(cap.stderr).toContain("wos must be run from inside a Git worktree");
      expect(cap.stderr).not.toContain("wos status failed:");
      expect(cap.stdout).toBe("");
    } finally {
      cap.restore();
      process.chdir(cwd);
    }
  });

  test("does not read state or modify the working directory when guard fails", async () => {
    const dir = await makeEmptyDir();
    const cwd = process.cwd();
    process.chdir(dir);
    const cap = captureStdio();
    try {
      const before = await readdir(dir);
      await runStatus([], { gitRunner: nonWorktreeRunner });
      const after = await readdir(dir);
      expect(after).toEqual(before);
    } finally {
      cap.restore();
      process.chdir(cwd);
    }
  });

  test("short-circuits after the first failing git call (no compose, no state read)", async () => {
    const dir = await makeEmptyDir();
    const cwd = process.cwd();
    process.chdir(dir);
    const cap = captureStdio();
    let gitCalls = 0;
    const trackedRunner: GitRunner = async (args) => {
      gitCalls += 1;
      throw new GitError(
        `git ${args.join(" ")} failed (exit 128): fatal: not a git repository (or any of the parent directories): .git`,
      );
    };
    try {
      const code = await runStatus([], { gitRunner: trackedRunner });
      expect(code).toBe(1);
      expect(gitCalls).toBe(1);
      expect(cap.stderr).toBe("wos must be run from inside a Git worktree\n");
    } finally {
      cap.restore();
      process.chdir(cwd);
    }
  });

  test("surfaces unrelated Git failures as generic status failure", async () => {
    const dir = await makeEmptyDir();
    const cwd = process.cwd();
    process.chdir(dir);
    const cap = captureStdio();
    const oddRunner: GitRunner = async () => {
      throw new GitError(
        "git rev-parse --show-toplevel failed (exit 128): fatal: bad object HEAD",
      );
    };
    try {
      const code = await runStatus([], { gitRunner: oddRunner });
      expect(code).toBe(1);
      expect(cap.stderr).toContain("wos status failed:");
      expect(cap.stderr).toContain("bad object HEAD");
      expect(cap.stderr).not.toContain("wos must be run from inside a Git worktree");
    } finally {
      cap.restore();
      process.chdir(cwd);
    }
  });
});
