/**
 * Regenerate packages/plugin-claude/content-manifest.json after a plugin
 * change. Refuses to run when the content changed but plugin.json still
 * declares the version already pinned in the manifest — bump it first.
 */

import { resolve } from "node:path";

import {
  computeContentHash,
  pluginRoot,
} from "@worktreeos/plugin-claude/content-hash";

const root = pluginRoot();
const manifestPath = resolve(root, "content-manifest.json");
const { version } = await Bun.file(
  resolve(root, ".claude-plugin/plugin.json"),
).json();
const hash = await computeContentHash();

const existing = (await Bun.file(manifestPath).exists())
  ? await Bun.file(manifestPath).json()
  : null;

if (existing && existing.hash !== hash && existing.version === version) {
  console.error(
    `plugin content changed but version is still ${version} — bump the` +
      ` version in packages/plugin-claude/.claude-plugin/plugin.json first`,
  );
  process.exit(1);
}

await Bun.write(manifestPath, JSON.stringify({ version, hash }, null, 2) + "\n");
console.log(`content-manifest.json updated: ${version} ${hash}`);
