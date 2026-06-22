/**
 * Deterministic hash of the plugin content shipped to Claude Code's plugin
 * cache. The committed manifest (content-manifest.json) pins this hash to a
 * plugin.json version; the contract test fails when content changes without a
 * version bump (run `bun scripts/update-plugin-manifest.ts` after bumping).
 */

import { readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

const PLUGIN_ROOT = import.meta.dir;

/** Files that constitute the installable plugin (manifest + hooks). */
export function shippedFiles(root: string = PLUGIN_ROOT): string[] {
  const files: string[] = [];
  for (const dir of [".claude-plugin", "hooks"]) {
    for (const entry of readdirSync(resolve(root, dir), {
      withFileTypes: true,
    })) {
      if (entry.isFile()) files.push(resolve(root, dir, entry.name));
    }
  }
  return files.sort();
}

export async function computeContentHash(
  root: string = PLUGIN_ROOT,
): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const file of shippedFiles(root)) {
    hasher.update(relative(root, file));
    hasher.update("\0");
    hasher.update(await Bun.file(file).arrayBuffer());
    hasher.update("\0");
  }
  return hasher.digest("hex");
}

export function pluginRoot(): string {
  return PLUGIN_ROOT;
}
