/**
 * Headless wrapper around the `codex plugin` CLI, mirroring
 * `claude-plugin-cli.ts`. All mutations of the Codex plugin state go through
 * here — the registry/cache files (`~/.codex/plugins/cache/...`) are
 * undocumented and must never be written directly.
 *
 * Codex's plugin subsystem is a near-clone of Claude Code's, but its verbs
 * differ (verified against codex-cli 0.141.0): a local repository marketplace
 * (`.agents/plugins/marketplace.json`) is registered with
 * `codex plugin marketplace add <source>`, the plugin is installed with
 * `codex plugin add wos@worktreeos` (not `install`), removed with
 * `codex plugin remove wos@worktreeos` (not `uninstall`), and the installed set
 * is read from `codex plugin list --json`. All three of `marketplace add`,
 * `add`, and the list read are idempotent. Unlike Claude Code there is no
 * separate `plugin update` verb; a refreshed marketplace plus a re-`add`
 * resolves the current version (see `ensureCodexPluginInstalled`).
 */

import { resolve } from "node:path";

import { packagedPluginsDir } from "./packaged-layout";

export const CODEX_MARKETPLACE_NAME = "worktreeos";
export const CODEX_PLUGIN_NAME = "wos";
export const CODEX_PLUGIN_KEY = `${CODEX_PLUGIN_NAME}@${CODEX_MARKETPLACE_NAME}`;

export type CodexCliResult =
  | { ok: true }
  | { ok: false; error: "codex-cli-not-found" | "command-failed"; message: string };

export type CodexCliRunner = (
  args: string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** Installed status of the wos plugin, derived from `codex plugin list --json`. */
export interface CodexPluginListStatus {
  installed: boolean;
  /** Reported version, or null when none / a non-semver (e.g. `"local"`). */
  version: string | null;
}

/**
 * Marketplace source handed to `codex plugin marketplace add`: a local
 * directory carrying `.agents/plugins/marketplace.json`. `WOS_CODEX_MARKETPLACE_SOURCE`
 * overrides it. Under the published npm layout it is the on-disk plugin dir
 * laid down beside the bundle (`<pkgRoot>/plugins/codex`); in a source checkout
 * it is the repository root (the committed `.agents/plugins/marketplace.json`).
 */
export function codexMarketplaceSource(
  env: NodeJS.ProcessEnv = process.env,
  pluginsDir: string | null = packagedPluginsDir(),
): string {
  if (env.WOS_CODEX_MARKETPLACE_SOURCE) return env.WOS_CODEX_MARKETPLACE_SOURCE;
  if (pluginsDir) return resolve(pluginsDir, "codex");
  return resolve(import.meta.dir, "../../..");
}

const defaultRunner: CodexCliRunner = async (args) => {
  const proc = Bun.spawn(["codex", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    windowsHide: true,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
};

async function runPluginCommand(
  args: string[],
  run: CodexCliRunner,
): Promise<CodexCliResult & { stdout?: string }> {
  try {
    const { exitCode, stdout, stderr } = await run(["plugin", ...args]);
    if (exitCode !== 0) {
      return {
        ok: false,
        error: "command-failed",
        message: `codex plugin ${args.join(" ")} failed (${exitCode}): ${stderr.trim()}`,
      };
    }
    return { ok: true, stdout };
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    if ((e as { code?: string }).code === "ENOENT" || /ENOENT|No such file/.test(message)) {
      return {
        ok: false,
        error: "codex-cli-not-found",
        message: "the `codex` CLI was not found on PATH",
      };
    }
    return { ok: false, error: "command-failed", message };
  }
}

/** Idempotently register the wos marketplace from the resolved source. */
export function addCodexMarketplace(
  source: string = codexMarketplaceSource(),
  run: CodexCliRunner = defaultRunner,
): Promise<CodexCliResult> {
  return runPluginCommand(["marketplace", "add", source], run);
}

/** Idempotently install the wos plugin (`codex plugin add wos@worktreeos`). */
export function installCodexPluginCli(
  run: CodexCliRunner = defaultRunner,
): Promise<CodexCliResult> {
  return runPluginCommand(["add", CODEX_PLUGIN_KEY], run);
}

/** Remove the wos plugin (`codex plugin remove wos@worktreeos`). */
export function uninstallCodexPluginCli(
  run: CodexCliRunner = defaultRunner,
): Promise<CodexCliResult> {
  return runPluginCommand(["remove", CODEX_PLUGIN_KEY], run);
}

/**
 * Parse `codex plugin list --json` (`{ installed: [...], available: [...] }`)
 * into the wos plugin's install status. Tolerant of format drift: anything that
 * does not look like the known shape reads as "not installed", which is safe
 * because installation is idempotent. A non-semver version (e.g. `"local"`) is
 * reported as `null` so the caller omits any outdated comparison.
 */
export function parseCodexPluginList(stdout: string): CodexPluginListStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { installed: false, version: null };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { installed: false, version: null };
  }
  const installed = (parsed as Record<string, unknown>).installed;
  if (!Array.isArray(installed)) return { installed: false, version: null };
  for (const entry of installed) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const name =
      typeof e.name === "string"
        ? e.name
        : typeof e.plugin === "string"
          ? e.plugin
          : undefined;
    if (name !== CODEX_PLUGIN_NAME) continue;
    const raw = typeof e.version === "string" ? e.version : "";
    const version = /^\d+\.\d+/.test(raw) ? raw : null;
    return { installed: true, version };
  }
  return { installed: false, version: null };
}

/** Run `codex plugin list --json` and parse the wos plugin's install status. */
export async function listCodexPlugins(
  run: CodexCliRunner = defaultRunner,
): Promise<
  | { ok: true; status: CodexPluginListStatus }
  | { ok: false; error: "codex-cli-not-found" | "command-failed"; message: string }
> {
  const result = await runPluginCommand(["list", "--json"], run);
  if (!result.ok) return result;
  return { ok: true, status: parseCodexPluginList(result.stdout ?? "") };
}
