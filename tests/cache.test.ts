import { test, expect, describe, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import type { CacheEntryConfig } from "@worktreeos/core/config";
import {
  CacheError,
  computeCacheKeyHash,
  defaultCacheRoot,
  expandCachePaths,
  hasGlobChars,
  restoreCacheEntry,
  saveCacheEntry,
} from "@worktreeos/runtime/cache";

const ORIGINAL_WOS_HOME = process.env.WOS_HOME;
afterEach(() => {
  if (ORIGINAL_WOS_HOME === undefined) delete process.env.WOS_HOME;
  else process.env.WOS_HOME = ORIGINAL_WOS_HOME;
});

async function makeWorkspace(): Promise<{ root: string; cacheRoot: string }> {
  const parent = await mkdtemp(resolve(tmpdir(), "wos-cache-"));
  const root = resolve(parent, "wt");
  const cacheRoot = resolve(parent, "cache");
  await mkdir(root, { recursive: true });
  await mkdir(cacheRoot, { recursive: true });
  return { root, cacheRoot };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("defaultCacheRoot", () => {
  test("defaults to <home>/.wos/cache when WOS_HOME is unset", () => {
    delete process.env.WOS_HOME;
    expect(defaultCacheRoot()).toBe(resolve(homedir(), ".wos", "cache"));
  });

  test("uses <WOS_HOME>/cache when WOS_HOME is set", () => {
    process.env.WOS_HOME = "/tmp/custom-wos-home";
    expect(defaultCacheRoot()).toBe("/tmp/custom-wos-home/cache");
  });
});

describe("computeCacheKeyHash", () => {
  test("returns a stable hash for an explicit literal key", async () => {
    const ws = await makeWorkspace();
    try {
      const entry: CacheEntryConfig = {
        key: { kind: "literal", literal: "ruby-v1" },
        paths: ["vendor/bundle"],
      };
      const a = await computeCacheKeyHash(entry, ws.root);
      const b = await computeCacheKeyHash(entry, ws.root);
      expect(a).toBe(b);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("different literal keys produce different hashes", async () => {
    const ws = await makeWorkspace();
    try {
      const a = await computeCacheKeyHash(
        { key: { kind: "literal", literal: "v1" }, paths: ["x"] },
        ws.root,
      );
      const b = await computeCacheKeyHash(
        { key: { kind: "literal", literal: "v2" }, paths: ["x"] },
        ws.root,
      );
      expect(a).not.toBe(b);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("computes hash from file contents when key.files is configured", async () => {
    const ws = await makeWorkspace();
    try {
      await writeFile(resolve(ws.root, "yarn.lock"), "alpha");
      const entry: CacheEntryConfig = {
        key: { kind: "files", files: ["yarn.lock"] },
        paths: ["node_modules"],
      };
      const a = await computeCacheKeyHash(entry, ws.root);
      await writeFile(resolve(ws.root, "yarn.lock"), "beta");
      const b = await computeCacheKeyHash(entry, ws.root);
      expect(a).not.toBe(b);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("fails when a key file is missing", async () => {
    const ws = await makeWorkspace();
    try {
      await expect(
        computeCacheKeyHash(
          { key: { kind: "files", files: ["yarn.lock"] }, paths: ["node_modules"] },
          ws.root,
        ),
      ).rejects.toThrow(CacheError);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("rejects key files that escape the worktree", async () => {
    const ws = await makeWorkspace();
    try {
      await expect(
        computeCacheKeyHash(
          { key: { kind: "files", files: ["../escape"] }, paths: ["node_modules"] },
          ws.root,
        ),
      ).rejects.toThrow(CacheError);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });
});

describe("restoreCacheEntry", () => {
  test("returns miss when no cache entry exists for the computed key", async () => {
    const ws = await makeWorkspace();
    try {
      const result = await restoreCacheEntry({
        entry: {
          key: { kind: "literal", literal: "missing" },
          paths: ["node_modules"],
        },
        worktreeRoot: ws.root,
        cacheRoot: ws.cacheRoot,
      });
      expect(result).toEqual({ status: "miss", restoredPaths: [] });
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("restores cached directory contents into the worktree", async () => {
    const ws = await makeWorkspace();
    try {
      const entry: CacheEntryConfig = {
        key: { kind: "literal", literal: "v1" },
        paths: ["node_modules"],
      };
      await mkdir(resolve(ws.root, "node_modules", "lib"), { recursive: true });
      await writeFile(resolve(ws.root, "node_modules", "lib", "a.js"), "cached");
      await saveCacheEntry({ entry, worktreeRoot: ws.root, cacheRoot: ws.cacheRoot });
      await rm(resolve(ws.root, "node_modules"), { recursive: true, force: true });
      const result = await restoreCacheEntry({
        entry,
        worktreeRoot: ws.root,
        cacheRoot: ws.cacheRoot,
      });
      expect(result.status).toBe("hit");
      expect(result.restoredPaths).toEqual(["node_modules"]);
      expect(await Bun.file(resolve(ws.root, "node_modules", "lib", "a.js")).text()).toBe(
        "cached",
      );
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("replaces existing worktree contents with cached contents", async () => {
    const ws = await makeWorkspace();
    try {
      const entry: CacheEntryConfig = {
        key: { kind: "literal", literal: "v1" },
        paths: ["node_modules"],
      };
      await mkdir(resolve(ws.root, "node_modules"), { recursive: true });
      await writeFile(resolve(ws.root, "node_modules", "fresh.txt"), "cached");
      await saveCacheEntry({ entry, worktreeRoot: ws.root, cacheRoot: ws.cacheRoot });
      await rm(resolve(ws.root, "node_modules"), { recursive: true, force: true });
      await mkdir(resolve(ws.root, "node_modules"), { recursive: true });
      await writeFile(resolve(ws.root, "node_modules", "stale.txt"), "old");
      const result = await restoreCacheEntry({
        entry,
        worktreeRoot: ws.root,
        cacheRoot: ws.cacheRoot,
      });
      expect(result.status).toBe("hit");
      expect(await pathExists(resolve(ws.root, "node_modules", "stale.txt"))).toBe(false);
      expect(await Bun.file(resolve(ws.root, "node_modules", "fresh.txt")).text()).toBe(
        "cached",
      );
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("rejects paths that escape the worktree", async () => {
    const ws = await makeWorkspace();
    try {
      const finalDir = resolve(ws.cacheRoot, await computeCacheKeyHash(
        { key: { kind: "literal", literal: "v1" }, paths: ["../escape"] },
        ws.root,
      ));
      await mkdir(finalDir, { recursive: true });
      await expect(
        restoreCacheEntry({
          entry: {
            key: { kind: "literal", literal: "v1" },
            paths: ["../escape"],
          },
          worktreeRoot: ws.root,
          cacheRoot: ws.cacheRoot,
        }),
      ).rejects.toThrow(CacheError);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });
});

describe("saveCacheEntry", () => {
  test("saves directory contents under the computed cache key", async () => {
    const ws = await makeWorkspace();
    try {
      const entry: CacheEntryConfig = {
        key: { kind: "literal", literal: "v1" },
        paths: ["node_modules"],
      };
      await mkdir(resolve(ws.root, "node_modules"), { recursive: true });
      await writeFile(resolve(ws.root, "node_modules", "a.txt"), "saved");
      const result = await saveCacheEntry({
        entry,
        worktreeRoot: ws.root,
        cacheRoot: ws.cacheRoot,
      });
      expect(result.status).toBe("saved");
      expect(result.savedPaths).toEqual(["node_modules"]);
      const keyHash = await computeCacheKeyHash(entry, ws.root);
      expect(await pathExists(resolve(ws.cacheRoot, keyHash))).toBe(true);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("skips missing paths and reports skipped when nothing exists", async () => {
    const ws = await makeWorkspace();
    try {
      const entry: CacheEntryConfig = {
        key: { kind: "literal", literal: "v1" },
        paths: ["node_modules"],
      };
      const result = await saveCacheEntry({
        entry,
        worktreeRoot: ws.root,
        cacheRoot: ws.cacheRoot,
      });
      expect(result).toEqual({ status: "skipped", savedPaths: [] });
      const keyHash = await computeCacheKeyHash(entry, ws.root);
      expect(await pathExists(resolve(ws.cacheRoot, keyHash))).toBe(false);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("overwrites previous cache contents atomically", async () => {
    const ws = await makeWorkspace();
    try {
      const entry: CacheEntryConfig = {
        key: { kind: "literal", literal: "v1" },
        paths: ["node_modules"],
      };
      await mkdir(resolve(ws.root, "node_modules"), { recursive: true });
      await writeFile(resolve(ws.root, "node_modules", "first.txt"), "1");
      await saveCacheEntry({ entry, worktreeRoot: ws.root, cacheRoot: ws.cacheRoot });
      await rm(resolve(ws.root, "node_modules"), { recursive: true, force: true });
      await mkdir(resolve(ws.root, "node_modules"), { recursive: true });
      await writeFile(resolve(ws.root, "node_modules", "second.txt"), "2");
      await saveCacheEntry({ entry, worktreeRoot: ws.root, cacheRoot: ws.cacheRoot });
      await rm(resolve(ws.root, "node_modules"), { recursive: true, force: true });
      const restored = await restoreCacheEntry({
        entry,
        worktreeRoot: ws.root,
        cacheRoot: ws.cacheRoot,
      });
      expect(restored.status).toBe("hit");
      expect(await pathExists(resolve(ws.root, "node_modules", "first.txt"))).toBe(false);
      expect(await Bun.file(resolve(ws.root, "node_modules", "second.txt")).text()).toBe("2");
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("does not leave temporary directories in the cache root on success", async () => {
    const ws = await makeWorkspace();
    try {
      const entry: CacheEntryConfig = {
        key: { kind: "literal", literal: "v1" },
        paths: ["node_modules"],
      };
      await mkdir(resolve(ws.root, "node_modules"), { recursive: true });
      await writeFile(resolve(ws.root, "node_modules", "a.txt"), "x");
      await saveCacheEntry({ entry, worktreeRoot: ws.root, cacheRoot: ws.cacheRoot });
      const proc = Bun.spawn(["ls", ws.cacheRoot], { stdout: "pipe" });
      const out = await new Response(proc.stdout).text();
      expect(out).not.toMatch(/\.tmp-/);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });
});

describe("hasGlobChars", () => {
  test("returns false for literal paths", () => {
    expect(hasGlobChars("node_modules")).toBe(false);
    expect(hasGlobChars("packages/api/node_modules")).toBe(false);
  });

  test("returns true for paths with wildcard characters", () => {
    expect(hasGlobChars("packages/*/node_modules")).toBe(true);
    expect(hasGlobChars("libs/*/dist")).toBe(true);
    expect(hasGlobChars("cache-?")).toBe(true);
    expect(hasGlobChars("pkg-[ab]/out")).toBe(true);
  });
});

describe("expandCachePaths", () => {
  test("returns literal paths unchanged", async () => {
    const ws = await makeWorkspace();
    try {
      const result = await expandCachePaths(["node_modules", "vendor"], ws.root);
      expect(result).toEqual(["node_modules", "vendor"]);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("expands wildcard paths to matching worktree entries", async () => {
    const ws = await makeWorkspace();
    try {
      await mkdir(resolve(ws.root, "packages/a/node_modules"), { recursive: true });
      await mkdir(resolve(ws.root, "packages/b/node_modules"), { recursive: true });
      await mkdir(resolve(ws.root, "packages/c"), { recursive: true });
      const result = await expandCachePaths(["packages/*/node_modules"], ws.root);
      expect(result).toEqual(["packages/a/node_modules", "packages/b/node_modules"]);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("returns empty for wildcard with no matches", async () => {
    const ws = await makeWorkspace();
    try {
      const result = await expandCachePaths(["packages/*/node_modules"], ws.root);
      expect(result).toEqual([]);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("deduplicates overlapping literal and wildcard results", async () => {
    const ws = await makeWorkspace();
    try {
      await mkdir(resolve(ws.root, "packages/a/node_modules"), { recursive: true });
      const result = await expandCachePaths(
        ["packages/a/node_modules", "packages/*/node_modules"],
        ws.root,
      );
      expect(result).toEqual(["packages/a/node_modules"]);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("sorts expanded paths", async () => {
    const ws = await makeWorkspace();
    try {
      await mkdir(resolve(ws.root, "packages/z/node_modules"), { recursive: true });
      await mkdir(resolve(ws.root, "packages/a/node_modules"), { recursive: true });
      const result = await expandCachePaths(["packages/*/node_modules"], ws.root);
      expect(result).toEqual(["packages/a/node_modules", "packages/z/node_modules"]);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });
});

describe("wildcard restoreCacheEntry", () => {
  test("restores multiple paths matched by wildcard pattern", async () => {
    const ws = await makeWorkspace();
    try {
      const entry: CacheEntryConfig = {
        key: { kind: "literal", literal: "mono-v1" },
        paths: ["packages/*/node_modules"],
      };
      await mkdir(resolve(ws.root, "packages/a/node_modules"), { recursive: true });
      await writeFile(resolve(ws.root, "packages/a/node_modules/dep.js"), "a-dep");
      await mkdir(resolve(ws.root, "packages/b/node_modules"), { recursive: true });
      await writeFile(resolve(ws.root, "packages/b/node_modules/dep.js"), "b-dep");
      await saveCacheEntry({ entry, worktreeRoot: ws.root, cacheRoot: ws.cacheRoot });

      await rm(resolve(ws.root, "packages/a/node_modules"), { recursive: true, force: true });
      await rm(resolve(ws.root, "packages/b/node_modules"), { recursive: true, force: true });

      const result = await restoreCacheEntry({
        entry,
        worktreeRoot: ws.root,
        cacheRoot: ws.cacheRoot,
      });
      expect(result.status).toBe("hit");
      expect(result.restoredPaths).toEqual([
        "packages/a/node_modules",
        "packages/b/node_modules",
      ]);
      expect(
        await Bun.file(resolve(ws.root, "packages/a/node_modules/dep.js")).text(),
      ).toBe("a-dep");
      expect(
        await Bun.file(resolve(ws.root, "packages/b/node_modules/dep.js")).text(),
      ).toBe("b-dep");
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("restores cached paths from manifest when worktree dirs are absent", async () => {
    const ws = await makeWorkspace();
    try {
      const entry: CacheEntryConfig = {
        key: { kind: "literal", literal: "mono-v1" },
        paths: ["packages/*/node_modules"],
      };
      await mkdir(resolve(ws.root, "packages/a/node_modules"), { recursive: true });
      await writeFile(resolve(ws.root, "packages/a/node_modules/dep.js"), "a-dep");
      await mkdir(resolve(ws.root, "packages/b/node_modules"), { recursive: true });
      await writeFile(resolve(ws.root, "packages/b/node_modules/dep.js"), "b-dep");
      await saveCacheEntry({ entry, worktreeRoot: ws.root, cacheRoot: ws.cacheRoot });

      // Remove all package dirs so glob expansion finds nothing
      await rm(resolve(ws.root, "packages"), { recursive: true, force: true });
      await mkdir(resolve(ws.root, "packages"), { recursive: true });

      const result = await restoreCacheEntry({
        entry,
        worktreeRoot: ws.root,
        cacheRoot: ws.cacheRoot,
      });
      expect(result.status).toBe("hit");
      expect(result.restoredPaths).toEqual([
        "packages/a/node_modules",
        "packages/b/node_modules",
      ]);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });
});

describe("wildcard saveCacheEntry", () => {
  test("saves all expanded wildcard paths", async () => {
    const ws = await makeWorkspace();
    try {
      const entry: CacheEntryConfig = {
        key: { kind: "literal", literal: "mono-v1" },
        paths: ["packages/*/node_modules"],
      };
      await mkdir(resolve(ws.root, "packages/a/node_modules"), { recursive: true });
      await writeFile(resolve(ws.root, "packages/a/node_modules/a.txt"), "a");
      await mkdir(resolve(ws.root, "packages/b/node_modules"), { recursive: true });
      await writeFile(resolve(ws.root, "packages/b/node_modules/b.txt"), "b");
      const result = await saveCacheEntry({
        entry,
        worktreeRoot: ws.root,
        cacheRoot: ws.cacheRoot,
      });
      expect(result.status).toBe("saved");
      expect(result.savedPaths).toEqual([
        "packages/a/node_modules",
        "packages/b/node_modules",
      ]);
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });

  test("skips when wildcard matches no paths", async () => {
    const ws = await makeWorkspace();
    try {
      const entry: CacheEntryConfig = {
        key: { kind: "literal", literal: "mono-v1" },
        paths: ["packages/*/node_modules"],
      };
      const result = await saveCacheEntry({
        entry,
        worktreeRoot: ws.root,
        cacheRoot: ws.cacheRoot,
      });
      expect(result).toEqual({ status: "skipped", savedPaths: [] });
    } finally {
      await rm(ws.root, { recursive: true, force: true });
    }
  });
});
