import { test, expect, describe } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  resolvePackageManagerCacheMounts,
  type PackageManagerCacheCommandRunner,
} from "@worktreeos/runtime/package-cache";
import type { AppConfig } from "@worktreeos/core/config";

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function app(overrides: Partial<AppConfig>): AppConfig {
  return {
    image: "node:22",
    initScript: ["bun install"],
    services: {},
    ...overrides,
  };
}

describe("resolvePackageManagerCacheMounts", () => {
  test("auto-detects only existing cache directories for enabled managers", async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "wos-pm-cache-"));
    try {
      const npmCache = resolve(dir, "npm");
      const bunCache = resolve(dir, "bun");
      await mkdir(npmCache);
      await mkdir(bunCache);
      const runner: PackageManagerCacheCommandRunner = async (args) => {
        const cmd = args.join(" ");
        if (cmd === "npm config get cache") return { stdout: `${npmCache}\n`, exitCode: 0 };
        if (cmd === "yarn cache dir") return { stdout: `${resolve(dir, "missing")}\n`, exitCode: 0 };
        if (cmd === "bun pm cache") return { stdout: `${bunCache}\n`, exitCode: 0 };
        return { stdout: "", exitCode: 1 };
      };

      const mounts = await resolvePackageManagerCacheMounts(
        app({
          connectNpmCache: true,
          connectYarnCache: true,
          connectBunCache: true,
        }),
        runner,
      );

      expect(mounts).toEqual([
        {
          kind: "npm",
          hostPath: npmCache,
          containerPath: "/wos-cache/npm",
          envName: "NPM_CONFIG_CACHE",
        },
        {
          kind: "bun",
          hostPath: bunCache,
          containerPath: "/wos-cache/bun",
          envName: "BUN_INSTALL_CACHE_DIR",
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uses explicit host paths and creates missing directories", async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "wos-pm-cache-"));
    try {
      const yarnCache = resolve(dir, "custom-yarn-cache");
      const mounts = await resolvePackageManagerCacheMounts(
        app({ connectYarnCache: yarnCache }),
        async () => ({ stdout: "", exitCode: 1 }),
      );

      expect(await pathExists(yarnCache)).toBe(true);
      expect(mounts).toEqual([
        {
          kind: "yarn",
          hostPath: yarnCache,
          containerPath: "/wos-cache/yarn",
          envName: "YARN_CACHE_FOLDER",
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("falls back to yarn cacheFolder when yarn cache dir is unavailable", async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "wos-pm-cache-"));
    try {
      const yarnCache = resolve(dir, "yarn-berry-cache");
      await mkdir(yarnCache);
      const mounts = await resolvePackageManagerCacheMounts(
        app({ connectYarnCache: true }),
        async (args) => {
          if (args.join(" ") === "yarn cache dir") {
            return { stdout: "", exitCode: 1 };
          }
          if (args.join(" ") === "yarn config get cacheFolder") {
            return { stdout: `${yarnCache}\n`, exitCode: 0 };
          }
          return { stdout: "", exitCode: 1 };
        },
      );

      expect(mounts).toEqual([
        {
          kind: "yarn",
          hostPath: yarnCache,
          containerPath: "/wos-cache/yarn",
          envName: "YARN_CACHE_FOLDER",
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
