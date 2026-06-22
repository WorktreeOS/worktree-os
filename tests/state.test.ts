import { test, expect, describe, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  readState,
  removeSessionRootForWorktree,
  stateFilePath,
  writeState,
  writeUpFailure,
  upFailureFilePath,
} from "@worktreeos/core/state";
import { sessionRootForWorktree } from "@worktreeos/core/paths";
import { computeProjectName } from "@worktreeos/core/project-name";

async function makeTmp(): Promise<string> {
  return await mkdtemp(resolve(tmpdir(), "wos-state-"));
}

const ORIGINAL_WOS_HOME = process.env.WOS_HOME;
afterEach(() => {
  if (ORIGINAL_WOS_HOME === undefined) delete process.env.WOS_HOME;
  else process.env.WOS_HOME = ORIGINAL_WOS_HOME;
});

describe("stateFilePath", () => {
  test("resolves under <wos-home>/sessions/<session-name>/state.json", () => {
    process.env.WOS_HOME = "/tmp/wos-home";
    expect(stateFilePath("/var/www/repo-path")).toBe(
      "/tmp/wos-home/sessions/var-www-repo-path/state.json",
    );
  });

  test("honors WOS_HOME for every worktree path", () => {
    process.env.WOS_HOME = "/tmp/wos-home";
    expect(stateFilePath("/repo")).toBe(
      "/tmp/wos-home/sessions/repo/state.json",
    );
  });
});

describe("state IO", () => {
  test("returns null when file is missing", async () => {
    const dir = await makeTmp();
    try {
      const path = resolve(dir, "wos", "state.json");
      expect(await readState(path)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("round-trips state through disk", async () => {
    const dir = await makeTmp();
    try {
      const path = resolve(dir, "wos", "state.json");
      const state = {
        initialized: true,
        projectName: "wos-repo-abcd1234",
        composeFile: "/tmp/docker-compose.yaml",
      };
      await writeState(path, state);
      expect(await readState(path)).toEqual(state);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves portAssignments across read/write", async () => {
    const dir = await makeTmp();
    try {
      const path = resolve(dir, "wos", "state.json");
      const state = {
        initialized: true,
        projectName: "wos-repo-abcd1234",
        composeFile: "/tmp/docker-compose.yaml",
        portAssignments: {
          api: { "3000": 21437 },
          db: { "5432": 24891 },
        },
      };
      await writeState(path, state);
      const loaded = await readState(path);
      expect(loaded).toEqual(state);
      expect(loaded!.portAssignments!.api!["3000"]).toBe(21437);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("removeSessionRootForWorktree", () => {
  test("removes the entire persisted session root for a worktree", async () => {
    const dir = await makeTmp();
    try {
      process.env.WOS_HOME = dir;
      const worktree = "/var/www/feature-a";
      const root = sessionRootForWorktree(worktree);
      await mkdir(root, { recursive: true });
      await writeState(stateFilePath(worktree), {
        initialized: true,
        projectName: "wos-x-12345678",
        composeFile: resolve(root, "compose.yaml"),
      });
      await writeFile(resolve(root, "compose.yaml"), "services: {}\n");
      await writeFile(resolve(root, "compose-base.yaml"), "services: {}\n");
      await writeFile(
        resolve(root, "compose-overlay.yaml"),
        "services: {}\n",
      );
      await writeUpFailure(upFailureFilePath(worktree), {
        failedAt: new Date().toISOString(),
        message: "boom",
      });

      await removeSessionRootForWorktree(worktree);

      expect(await Bun.file(stateFilePath(worktree)).exists()).toBe(false);
      expect(await Bun.file(resolve(root, "compose.yaml")).exists()).toBe(
        false,
      );
      expect(
        await Bun.file(resolve(root, "compose-base.yaml")).exists(),
      ).toBe(false);
      expect(
        await Bun.file(resolve(root, "compose-overlay.yaml")).exists(),
      ).toBe(false);
      expect(await Bun.file(upFailureFilePath(worktree)).exists()).toBe(
        false,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("is idempotent when the session root does not exist", async () => {
    const dir = await makeTmp();
    try {
      process.env.WOS_HOME = dir;
      await expect(
        removeSessionRootForWorktree("/var/www/never-initialized"),
      ).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("computeProjectName", () => {
  test("includes repo basename and short hash of current worktree", () => {
    const name = computeProjectName("/repo/wt-feature", "/repo/main");
    expect(name).toMatch(/^wos-main-[a-f0-9]{8}$/);
  });

  test("is stable for the same worktree path", () => {
    const a = computeProjectName("/repo/wt", "/repo/main");
    const b = computeProjectName("/repo/wt", "/repo/main");
    expect(a).toBe(b);
  });

  test("differs across worktrees", () => {
    const a = computeProjectName("/repo/wt-a", "/repo/main");
    const b = computeProjectName("/repo/wt-b", "/repo/main");
    expect(a).not.toBe(b);
  });

  test("sanitizes repo name", () => {
    const name = computeProjectName("/path/wt", "/path/My Repo!");
    expect(name).toMatch(/^wos-my-repo-[a-f0-9]{8}$/);
  });
});
