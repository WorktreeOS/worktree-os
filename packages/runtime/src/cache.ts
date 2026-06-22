import { cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, normalize, resolve, sep } from "node:path";
import type { CacheEntryConfig } from "@worktreeos/core/config";
import { wosCacheRoot } from "@worktreeos/core/paths";

export class CacheError extends Error {}

export function defaultCacheRoot(): string {
  return wosCacheRoot();
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function hashHex(input: string | Uint8Array): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(input);
  return h.digest("hex");
}

function ensureInsideWorktree(worktreeRoot: string, rel: string, field: string): string {
  const root = resolve(worktreeRoot);
  const abs = resolve(root, rel);
  if (abs === root || !abs.startsWith(root + sep)) {
    throw new CacheError(
      `${field} "${rel}" must resolve strictly inside the worktree (${root})`,
    );
  }
  return abs;
}

export function encodedPathName(rel: string): string {
  return hashHex(normalize(rel));
}

const GLOB_CHARS = /[*?[\]{}]/;

export function hasGlobChars(path: string): boolean {
  return GLOB_CHARS.test(path);
}

async function resolveGlobPattern(pattern: string, worktreeRoot: string): Promise<string[]> {
  const segments = pattern.split("/");
  let candidates = [""];

  for (const seg of segments) {
    const next: string[] = [];
    if (hasGlobChars(seg)) {
      const segGlob = new Bun.Glob(seg);
      for (const prefix of candidates) {
        const dir = resolve(worktreeRoot, prefix || ".");
        let entries: string[];
        try {
          entries = await readdir(dir);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (segGlob.match(entry)) {
            next.push(prefix ? `${prefix}/${entry}` : entry);
          }
        }
      }
    } else {
      for (const prefix of candidates) {
        next.push(prefix ? `${prefix}/${seg}` : seg);
      }
    }
    candidates = next;
  }

  const results: string[] = [];
  for (const c of candidates) {
    if (await pathExists(resolve(worktreeRoot, c))) {
      results.push(c);
    }
  }
  return results.sort();
}

export async function expandCachePaths(
  configuredPaths: string[],
  worktreeRoot: string,
): Promise<string[]> {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const p of configuredPaths) {
    if (!hasGlobChars(p)) {
      if (!seen.has(p)) {
        seen.add(p);
        result.push(p);
      }
      continue;
    }
    for (const match of await resolveGlobPattern(p, worktreeRoot)) {
      if (!seen.has(match)) {
        seen.add(match);
        result.push(match);
      }
    }
  }

  return result.sort();
}

const MANIFEST_FILE = "_manifest.json";

async function loadManifest(keyDir: string): Promise<string[] | null> {
  const file = Bun.file(resolve(keyDir, MANIFEST_FILE));
  if (!(await file.exists())) return null;
  try {
    const data = await file.json();
    if (Array.isArray(data) && data.every((p: unknown) => typeof p === "string")) {
      return data as string[];
    }
    return null;
  } catch {
    return null;
  }
}

async function saveManifest(dir: string, paths: string[]): Promise<void> {
  await Bun.write(resolve(dir, MANIFEST_FILE), JSON.stringify(paths));
}

function trashSuffix(): string {
  return `.wos-cache-trash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function computeCacheKeyHash(
  entry: CacheEntryConfig,
  worktreeRoot: string,
): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  if (entry.key.kind === "literal") {
    hasher.update("literal:");
    hasher.update(entry.key.literal);
  } else {
    hasher.update("files:");
    for (const file of entry.key.files) {
      const abs = ensureInsideWorktree(worktreeRoot, file, "cache.key.files");
      const f = Bun.file(abs);
      if (!(await f.exists())) {
        throw new CacheError(
          `cache key file "${file}" does not exist in worktree (${worktreeRoot})`,
        );
      }
      const bytes = new Uint8Array(await f.arrayBuffer());
      hasher.update(file);
      hasher.update("\0");
      hasher.update(bytes);
      hasher.update("\0");
    }
  }
  return hasher.digest("hex");
}

export interface CacheRestoreResult {
  status: "hit" | "miss";
  restoredPaths: string[];
}

export interface CacheOperationOptions {
  entry: CacheEntryConfig;
  worktreeRoot: string;
  cacheRoot?: string;
}

export async function restoreCacheEntry(
  opts: CacheOperationOptions,
): Promise<CacheRestoreResult> {
  const cacheRoot = opts.cacheRoot ?? defaultCacheRoot();
  const keyHash = await computeCacheKeyHash(opts.entry, opts.worktreeRoot);
  const keyDir = resolve(cacheRoot, keyHash);
  if (!(await pathExists(keyDir))) {
    return { status: "miss", restoredPaths: [] };
  }

  const expanded = await expandCachePaths(opts.entry.paths, opts.worktreeRoot);
  const seen = new Set(expanded);
  const manifest = await loadManifest(keyDir);
  if (manifest) {
    for (const p of manifest) {
      if (!seen.has(p)) {
        seen.add(p);
        expanded.push(p);
      }
    }
    expanded.sort();
  }

  const restored: string[] = [];
  for (const rel of expanded) {
    const dst = ensureInsideWorktree(opts.worktreeRoot, rel, "cache.paths");
    const cached = resolve(keyDir, encodedPathName(rel));
    if (!(await pathExists(cached))) continue;
    await replacePath(dst, cached);
    restored.push(rel);
  }
  return { status: "hit", restoredPaths: restored };
}

async function replacePath(dst: string, src: string): Promise<void> {
  if (await pathExists(dst)) {
    const parked = resolve(dirname(dst), trashSuffix());
    try {
      await rename(dst, parked);
    } catch {
      await rm(dst, { recursive: true, force: true });
    }
    rm(parked, { recursive: true, force: true }).catch(() => {});
  }
  await mkdir(dirname(dst), { recursive: true });
  await cp(src, dst, { recursive: true, errorOnExist: true, force: false });
}

export interface CacheSaveResult {
  status: "saved" | "skipped";
  savedPaths: string[];
}

export async function saveCacheEntry(
  opts: CacheOperationOptions,
): Promise<CacheSaveResult> {
  const cacheRoot = opts.cacheRoot ?? defaultCacheRoot();
  await mkdir(cacheRoot, { recursive: true });
  const keyHash = await computeCacheKeyHash(opts.entry, opts.worktreeRoot);
  const tmpDir = resolve(
    cacheRoot,
    `.tmp-${keyHash.slice(0, 12)}-${Math.random().toString(36).slice(2, 10)}`,
  );
  await mkdir(tmpDir, { recursive: true });
  try {
    const expanded = await expandCachePaths(opts.entry.paths, opts.worktreeRoot);
    const saved: string[] = [];
    for (const rel of expanded) {
      const src = ensureInsideWorktree(opts.worktreeRoot, rel, "cache.paths");
      if (!(await pathExists(src))) continue;
      const dst = resolve(tmpDir, encodedPathName(rel));
      await cp(src, dst, { recursive: true, errorOnExist: true, force: false });
      saved.push(rel);
    }
    if (saved.length === 0) {
      await rm(tmpDir, { recursive: true, force: true });
      return { status: "skipped", savedPaths: [] };
    }
    await saveManifest(tmpDir, saved);
    const finalDir = resolve(cacheRoot, keyHash);
    await atomicReplaceDir(tmpDir, finalDir);
    return { status: "saved", savedPaths: saved };
  } catch (e) {
    await rm(tmpDir, { recursive: true, force: true });
    throw e;
  }
}

async function atomicReplaceDir(tmp: string, finalDir: string): Promise<void> {
  if (await pathExists(finalDir)) {
    const parked = `${finalDir}${trashSuffix()}`;
    try {
      await rename(finalDir, parked);
    } catch {
      await rm(finalDir, { recursive: true, force: true });
    }
    rm(parked, { recursive: true, force: true }).catch(() => {});
  }
  await rename(tmp, finalDir);
}
