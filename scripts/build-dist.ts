#!/usr/bin/env bun
/**
 * Assemble the publishable `@worktreeos/cli` npm package into a staging dir
 * (`dist/npm/` by default; override with `WOS_DIST_OUTDIR`).
 *
 * The published package is a single self-contained bundle:
 *   dist/npm/
 *     package.json   ← generated: name @worktreeos/cli, public, tag version,
 *                       bin {wos: "./wos.js"}, files whitelist, no workspace deps
 *     wos.js         ← `bun build --target=bun` of apps/cli/index.ts, web embedded
 *     plugins/
 *       claude/      ← real files: .claude-plugin/ (plugin.json + marketplace.json),
 *                       hooks/, src/  (marketplace source for `claude plugin`)
 *       codex/       ← real files: .codex-plugin/, .agents/plugins/marketplace.json,
 *                       hooks/
 *       opencode/src/index.ts ← self-contained bundle (opencode loads via file://)
 *       pi/src/index.ts       ← self-contained bundle (the pi shim re-exports it)
 *
 * The bundle keeps the `agent-hook` fast path lazy: the entry's dynamic imports
 * stay deferred inside the single file, so `wos agent-hook` never evaluates the
 * web/daemon bundle. Idempotent: the staging dir is cleaned on every run.
 *
 * Exported as functions so the packaged-layout contract test can assemble the
 * plugin layout into a temp dir without rebuilding the heavy CLI bundle.
 */

import { cpSync, mkdirSync, rmSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";

const repoRoot = resolve(import.meta.dir, "..");

/** Published version from the tag/env (`v1.2.3` → `1.2.3`), default `0.0.0`. */
export function resolvePublishVersion(
  raw: string | undefined = process.env.WOS_PUBLISH_VERSION,
): string {
  const trimmed = raw?.trim();
  if (!trimmed) return "0.0.0";
  return trimmed.replace(/^v/, "");
}

/** Copy a directory tree, skipping `node_modules` and the workspace manifest. */
function copyTree(src: string, dest: string): void {
  cpSync(src, dest, {
    recursive: true,
    filter: (from) =>
      !from.includes("/node_modules") && !from.endsWith("/package.json"),
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(value, null, 2) + "\n");
}

/** Read a JSON file relative to the repo root. */
async function readJson(relPath: string): Promise<Record<string, unknown>> {
  return (await Bun.file(resolve(repoRoot, relPath)).json()) as Record<
    string,
    unknown
  >;
}

/**
 * Rewrite a marketplace manifest so every plugin's `source` points at the
 * marketplace root itself (`.`): under the packaged layout the marketplace dir
 * and the plugin dir are the same directory beside the bundle.
 */
function selfHostedMarketplace(
  manifest: Record<string, unknown>,
): Record<string, unknown> {
  const plugins = Array.isArray(manifest.plugins) ? manifest.plugins : [];
  return {
    ...manifest,
    plugins: plugins.map((p) =>
      typeof p === "object" && p !== null ? { ...p, source: "." } : p,
    ),
  };
}

async function buildCliBundle(outDir: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [resolve(repoRoot, "apps/cli/index.ts")],
    target: "bun",
    minify: true,
    plugins: [tailwind],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  const artifact = result.outputs.find((o) => o.kind === "entry-point");
  if (!artifact) {
    console.error("build-dist: no entry-point output produced");
    process.exit(1);
  }
  let code = await artifact.text();
  // Guarantee the Bun shebang survives bundling so a global bin shim / bunx
  // routes the invocation to Bun (the in-file Bun guard then enforces it).
  if (!code.startsWith("#!")) {
    code = `#!/usr/bin/env bun\n${code}`;
  }
  const outFile = resolve(outDir, "wos.js");
  await Bun.write(outFile, code);
  await chmod(outFile, 0o755);
}

/**
 * Bundle a plugin entry to a single self-contained source file (workspace
 * imports inlined; node builtins external) so opencode/pi can load it from the
 * packaged layout without a source checkout. Written with a `.ts` extension to
 * match the resolver entries (opencode `file://…/index.ts`, the pi shim).
 */
async function buildPluginEntry(
  entryRel: string,
  outFile: string,
): Promise<void> {
  const result = await Bun.build({
    entrypoints: [resolve(repoRoot, entryRel)],
    target: "bun",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  const artifact = result.outputs.find((o) => o.kind === "entry-point");
  if (!artifact) {
    console.error(`build-dist: no entry-point output for ${entryRel}`);
    process.exit(1);
  }
  mkdirSync(dirname(outFile), { recursive: true });
  await Bun.write(outFile, await artifact.text());
}

/**
 * Lay the four agent plugins into `<outDir>/plugins` as real on-disk files:
 * Claude + Codex as copied trees with a self-hosted marketplace manifest, and
 * OpenCode + pi as self-contained source bundles.
 */
export async function layDownPlugins(outDir: string): Promise<void> {
  const pluginsDir = resolve(outDir, "plugins");

  // Claude: full plugin tree + a self-hosted marketplace manifest beside it.
  const claudeDir = resolve(pluginsDir, "claude");
  copyTree(resolve(repoRoot, "packages/plugin-claude"), claudeDir);
  await writeJson(
    resolve(claudeDir, ".claude-plugin/marketplace.json"),
    selfHostedMarketplace(await readJson(".claude-plugin/marketplace.json")),
  );

  // Codex: plugin tree (.codex-plugin + hooks) + a self-hosted marketplace
  // manifest at the path codex reads (`.agents/plugins/marketplace.json`).
  const codexDir = resolve(pluginsDir, "codex");
  copyTree(resolve(repoRoot, "packages/plugin-codex"), codexDir);
  await writeJson(
    resolve(codexDir, ".agents/plugins/marketplace.json"),
    selfHostedMarketplace(await readJson(".agents/plugins/marketplace.json")),
  );

  // OpenCode + pi: self-contained source bundles their runtimes load directly.
  await buildPluginEntry(
    "packages/plugin-opencode/src/index.ts",
    resolve(pluginsDir, "opencode/src/index.ts"),
  );
  await buildPluginEntry(
    "packages/plugin-pi/src/index.ts",
    resolve(pluginsDir, "pi/src/index.ts"),
  );
}

async function writePackageJson(outDir: string, version: string): Promise<void> {
  await writeJson(resolve(outDir, "package.json"), {
    name: "@worktreeos/cli",
    version,
    private: false,
    type: "module",
    description:
      "WorktreeOS CLI — manage Git worktrees, Docker deployments, and agent activity.",
    // `repository` is required for npm provenance to bind the published artifact
    // to the building repo (see the release workflow's `--provenance`).
    repository: {
      type: "git",
      url: "git+https://github.com/WorktreeOS/worktree-os.git",
    },
    homepage: "https://github.com/WorktreeOS/worktree-os",
    bin: { wos: "./wos.js" },
    files: ["wos.js", "plugins", "README.md"],
  });
}

/** Ship the repo README as the package's npm landing page. */
function copyReadme(outDir: string): void {
  cpSync(resolve(repoRoot, "README.md"), resolve(outDir, "README.md"));
}

/** Assemble the complete publishable package into `outDir`. */
export async function assembleDist(opts: {
  outDir: string;
  version: string;
}): Promise<void> {
  rmSync(opts.outDir, { recursive: true, force: true });
  mkdirSync(opts.outDir, { recursive: true });
  await buildCliBundle(opts.outDir);
  await layDownPlugins(opts.outDir);
  await writePackageJson(opts.outDir, opts.version);
  copyReadme(opts.outDir);
}

if (import.meta.main) {
  const outDir = process.env.WOS_DIST_OUTDIR
    ? resolve(process.env.WOS_DIST_OUTDIR)
    : resolve(repoRoot, "dist/npm");
  const version = resolvePublishVersion();
  await assembleDist({ outDir, version });
  console.log(`Assembled @worktreeos/cli@${version} into ${outDir}`);
}
