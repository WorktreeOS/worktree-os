/**
 * Headless wrapper around the `claude plugin` CLI. All mutations of the
 * Claude Code plugin state go through here — the registry/cache files are
 * undocumented and must never be written directly.
 *
 * Verified CLI semantics (spike 2026-06-11):
 * - `claude plugin marketplace add <path>` is idempotent (exit 0 on re-add).
 * - `claude plugin install wos@worktreeos --scope user` is idempotent.
 * - `claude plugin update` requires the full `wos@worktreeos` key and only
 *   picks up new content after `claude plugin marketplace update worktreeos`.
 */

import { resolve } from "node:path";

import { packagedPluginsDir } from "./packaged-layout";

export const CLAUDE_MARKETPLACE_NAME = "worktreeos";
export const CLAUDE_PLUGIN_KEY = `wos@${CLAUDE_MARKETPLACE_NAME}`;

export type ClaudeCliResult =
  | { ok: true }
  | { ok: false; error: "claude-cli-not-found" | "command-failed"; message: string };

export type ClaudeCliRunner = (
  args: string[],
) => Promise<{ exitCode: number; stderr: string }>;

/**
 * Marketplace source handed to `claude plugin marketplace add`: a local
 * directory carrying `.claude-plugin/marketplace.json`. `WOS_CLAUDE_MARKETPLACE_SOURCE`
 * overrides it. Under the published npm layout it is the on-disk plugin dir
 * laid down beside the bundle (`<pkgRoot>/plugins/claude`); in a source checkout
 * it is the repository root (the committed `.claude-plugin/marketplace.json`).
 */
export function claudeMarketplaceSource(
  env: NodeJS.ProcessEnv = process.env,
  pluginsDir: string | null = packagedPluginsDir(),
): string {
  if (env.WOS_CLAUDE_MARKETPLACE_SOURCE) return env.WOS_CLAUDE_MARKETPLACE_SOURCE;
  if (pluginsDir) return resolve(pluginsDir, "claude");
  return resolve(import.meta.dir, "../../..");
}

const defaultRunner: ClaudeCliRunner = async (args) => {
  const proc = Bun.spawn(["claude", ...args], {
    stdout: "ignore",
    stderr: "pipe",
    stdin: "ignore",
    windowsHide: true,
  });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stderr };
};

async function runPluginCommand(
  args: string[],
  run: ClaudeCliRunner,
): Promise<ClaudeCliResult> {
  try {
    const { exitCode, stderr } = await run(["plugin", ...args]);
    if (exitCode !== 0) {
      return {
        ok: false,
        error: "command-failed",
        message: `claude plugin ${args.join(" ")} failed (${exitCode}): ${stderr.trim()}`,
      };
    }
    return { ok: true };
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    if ((e as { code?: string }).code === "ENOENT" || /ENOENT|No such file/.test(message)) {
      return {
        ok: false,
        error: "claude-cli-not-found",
        message: "the `claude` CLI was not found on PATH",
      };
    }
    return { ok: false, error: "command-failed", message };
  }
}

/** Idempotently register the wos marketplace from the resolved source. */
export function addClaudeMarketplace(
  source: string = claudeMarketplaceSource(),
  run: ClaudeCliRunner = defaultRunner,
): Promise<ClaudeCliResult> {
  return runPluginCommand(["marketplace", "add", source], run);
}

/** Refresh the marketplace so `plugin update` can see new versions. */
export function updateClaudeMarketplace(
  run: ClaudeCliRunner = defaultRunner,
): Promise<ClaudeCliResult> {
  return runPluginCommand(["marketplace", "update", CLAUDE_MARKETPLACE_NAME], run);
}

/** Idempotently install the wos plugin at user scope. */
export function installClaudePluginCli(
  run: ClaudeCliRunner = defaultRunner,
): Promise<ClaudeCliResult> {
  return runPluginCommand(["install", CLAUDE_PLUGIN_KEY, "--scope", "user"], run);
}

/** Update the wos plugin to the latest marketplace version. */
export function updateClaudePluginCli(
  run: ClaudeCliRunner = defaultRunner,
): Promise<ClaudeCliResult> {
  return runPluginCommand(["update", CLAUDE_PLUGIN_KEY], run);
}

/** Remove the wos plugin from the user's Claude Code plugin registry. */
export function uninstallClaudePluginCli(
  run: ClaudeCliRunner = defaultRunner,
): Promise<ClaudeCliResult> {
  return runPluginCommand(["uninstall", CLAUDE_PLUGIN_KEY], run);
}
