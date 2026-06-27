/**
 * Detection of the published npm package layout (`@worktreeos/cli`).
 *
 * The CLI ships as a single `bun build` bundle (`wos.js`) with the agent-plugin
 * files laid down beside it as real files under `plugins/` and a generated
 * `package.json` — see `scripts/build-dist.ts`. After bundling, every former
 * source module collapses into `wos.js`, so `import.meta.dir` resolves to the
 * package root for all of them; the `plugins/` directory sitting beside the
 * bundle is the marker that distinguishes the published layout from a source
 * checkout (where `import.meta.dir` is `packages/daemon/src`).
 *
 * Plugin-root and marketplace-source resolution consult this so the packaged
 * distribution hands the host agents' plugin tooling real on-disk files instead
 * of the `/$bunfs/` virtual path the compiled binary is stuck with.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Absolute path to the package root when running from the published npm
 * layout, or null in a source checkout. The package root is the directory
 * holding the bundle (`import.meta.dir` after bundling); it is recognized by a
 * sibling `plugins/` directory carrying the laid-down agent-plugin files.
 */
export function packageRoot(): string | null {
  const root = import.meta.dir;
  return existsSync(resolve(root, "plugins")) ? root : null;
}

/**
 * Absolute path to the laid-down `plugins/` directory under the published
 * layout, or null in a source checkout.
 */
export function packagedPluginsDir(): string | null {
  const root = packageRoot();
  return root ? resolve(root, "plugins") : null;
}

/**
 * Version of the running published CLI, read from the `package.json` beside the
 * bundle, or null when not running from the published layout (source checkout)
 * or the manifest is unreadable. Used to materialize the same version when an
 * ephemeral `bunx` launch establishes a persistent install.
 */
export function publishedCliVersion(): string | null {
  const root = packageRoot();
  if (!root) return null;
  try {
    const manifest = JSON.parse(
      readFileSync(resolve(root, "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}
