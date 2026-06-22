import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { AppConfig, PackageManagerCacheConfig } from "@worktreeos/core/config";

export type PackageManagerCacheKind = "npm" | "yarn" | "bun";

export interface PackageManagerCacheMount {
  kind: PackageManagerCacheKind;
  hostPath: string;
  containerPath: string;
  envName: string;
}

export type PackageManagerCacheCommandRunner = (
  args: string[],
) => Promise<{ stdout: string; exitCode: number }>;

interface CacheDefinition {
  kind: PackageManagerCacheKind;
  config: PackageManagerCacheConfig | undefined;
  commands: string[][];
  fallbackPath?: string;
  containerPath: string;
  envName: string;
}

export async function resolvePackageManagerCacheMounts(
  app: AppConfig,
  runner: PackageManagerCacheCommandRunner = defaultPackageManagerCacheCommandRunner,
): Promise<PackageManagerCacheMount[]> {
  const defs: CacheDefinition[] = [
    {
      kind: "npm",
      config: app.connectNpmCache,
      commands: [["npm", "config", "get", "cache"]],
      fallbackPath: resolve(homedir(), ".npm"),
      containerPath: "/wos-cache/npm",
      envName: "NPM_CONFIG_CACHE",
    },
    {
      kind: "yarn",
      config: app.connectYarnCache,
      commands: [
        ["yarn", "cache", "dir"],
        ["yarn", "config", "get", "cacheFolder"],
      ],
      containerPath: "/wos-cache/yarn",
      envName: "YARN_CACHE_FOLDER",
    },
    {
      kind: "bun",
      config: app.connectBunCache,
      commands: [["bun", "pm", "cache"]],
      fallbackPath: resolve(homedir(), ".bun", "install", "cache"),
      containerPath: "/wos-cache/bun",
      envName: "BUN_INSTALL_CACHE_DIR",
    },
  ];

  const mounts: PackageManagerCacheMount[] = [];
  for (const def of defs) {
    const hostPath = await resolveHostCachePath(def, runner);
    if (hostPath === null) continue;
    mounts.push({
      kind: def.kind,
      hostPath,
      containerPath: def.containerPath,
      envName: def.envName,
    });
  }
  return mounts;
}

async function resolveHostCachePath(
  def: CacheDefinition,
  runner: PackageManagerCacheCommandRunner,
): Promise<string | null> {
  if (def.config === undefined || def.config === false) return null;
  if (typeof def.config === "string") {
    const explicit = expandHome(def.config);
    await mkdir(explicit, { recursive: true });
    return explicit;
  }

  const detected = await detectExistingCachePath(def.commands, runner);
  if (detected !== null) {
    return detected;
  }
  if (def.fallbackPath && await pathIsDirectory(def.fallbackPath)) {
    return def.fallbackPath;
  }
  return null;
}

async function detectExistingCachePath(
  commands: string[][],
  runner: PackageManagerCacheCommandRunner,
): Promise<string | null> {
  for (const command of commands) {
    try {
      const result = await runner(command);
      if (result.exitCode !== 0) continue;
      const firstLine = result.stdout.trim().split(/\r?\n/, 1)[0]?.trim();
      if (!firstLine) continue;
      const path = expandHome(firstLine);
      if (await pathIsDirectory(path)) return path;
    } catch {
      continue;
    }
  }
  return null;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export const defaultPackageManagerCacheCommandRunner: PackageManagerCacheCommandRunner =
  async (args) => {
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return { stdout, exitCode };
  };
