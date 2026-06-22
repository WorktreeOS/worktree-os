/**
 * Detection, installation, and migration of wos agent activity plugins.
 *
 * Detection answers "does the agent the user is running have the wos plugin
 * wired?" so the web UI can offer installation, plus "is it outdated?" so it
 * can offer an update. Installation (manual via the UI endpoint, or opt-in via
 * the `autoInjectAgentPlugins` global setting) keeps the user-level agent
 * configs wired idempotently:
 *
 * - Claude Code: a real versioned plugin (`wos@worktreeos`) installed through
 *   the headless `claude plugin` CLI; state is read from the plugin registry
 *   (`~/.claude/plugins/installed_plugins.json`). Legacy hook entries injected
 *   into `~/.claude/settings.json` by older wos versions are migrated away and
 *   no longer count as installed.
 * - OpenCode: a plugin entry in the user's `opencode.json`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import {
  addClaudeMarketplace,
  type ClaudeCliResult,
  type ClaudeCliRunner,
  CLAUDE_PLUGIN_KEY,
  installClaudePluginCli,
  uninstallClaudePluginCli,
  updateClaudeMarketplace,
  updateClaudePluginCli,
} from "./claude-plugin-cli";
import {
  addCodexMarketplace,
  type CodexCliResult,
  type CodexCliRunner,
  type CodexPluginListStatus,
  installCodexPluginCli,
  parseCodexPluginList,
} from "./codex-plugin-cli";

export type PluginAgent = "claude" | "opencode" | "codex";

/** Root of the bundled Claude Code plugin (plugin.json + hooks + scripts). */
export function claudePluginRoot(): string {
  return resolve(import.meta.dir, "../../plugin-claude");
}

/** Root of the bundled Codex plugin (`.codex-plugin/plugin.json` + hooks). */
export function codexPluginRoot(): string {
  return resolve(import.meta.dir, "../../plugin-codex");
}

/**
 * Entry written into the opencode config. The package is not published to
 * npm, so the entry is a `file://` URL pointing at the local source — the
 * layout-relative resolution mirrors `claudePluginRoot()`.
 */
export function opencodePluginEntry(): string {
  return `file://${resolve(import.meta.dir, "../../plugin-opencode/src/index.ts")}`;
}

/** Marker matched against legacy injected hook entries in settings.json. */
const CLAUDE_HOOK_MARKER = "plugin-claude/scripts";

function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR
    ? resolve(env.CLAUDE_CONFIG_DIR)
    : resolve(homedir(), ".claude");
}

function claudeSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(claudeConfigDir(env), "settings.json");
}

function claudePluginRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(claudeConfigDir(env), "plugins", "installed_plugins.json");
}

function opencodeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME
    ? resolve(env.XDG_CONFIG_HOME)
    : resolve(homedir(), ".config");
  return resolve(base, "opencode", "opencode.json");
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Version declared by the bundled plugin manifest, or null when unreadable. */
export function bundledClaudePluginVersion(): string | null {
  const manifest = readJson(
    resolve(claudePluginRoot(), ".claude-plugin", "plugin.json"),
  );
  return typeof manifest?.version === "string" ? manifest.version : null;
}

/** Version declared by the bundled Codex manifest, or null when unreadable. */
export function bundledCodexPluginVersion(): string | null {
  const manifest = readJson(
    resolve(codexPluginRoot(), ".codex-plugin", "plugin.json"),
  );
  return typeof manifest?.version === "string" ? manifest.version : null;
}

/**
 * Read the wos Codex plugin's install status via a synchronous
 * `codex plugin list --json`. Tolerant by contract: a missing `codex` CLI, a
 * non-zero exit, or unparseable output all read as "not installed", so
 * detection never errors a session and installation (idempotent) repairs it.
 */
export function installedCodexPluginStatus(
  env: NodeJS.ProcessEnv = process.env,
): CodexPluginListStatus {
  try {
    const proc = Bun.spawnSync(["codex", "plugin", "list", "--json"], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
      windowsHide: true,
      env,
    });
    if (!proc.success) return { installed: false, version: null };
    return parseCodexPluginList(proc.stdout.toString());
  } catch {
    return { installed: false, version: null };
  }
}

/**
 * Pure mapping from a parsed `codex plugin list --json` status to the public
 * `AgentPluginStatus`. `outdated` is included only when the listing surfaces an
 * installed semver (a local source reports `"local"` → `version: null` → no
 * outdated indicator, parity with opencode which has no version to repair).
 * Exported for tests that exercise the four list shapes without spawning codex.
 */
export function codexPluginStatus(
  list: CodexPluginListStatus,
  bundled: string | null = bundledCodexPluginVersion(),
): AgentPluginStatus {
  if (!list.installed) return { installed: false };
  if (list.version === null || bundled === null) return { installed: true };
  return { installed: true, outdated: versionLessThan(list.version, bundled) };
}

/**
 * Installed wos plugin version from the Claude Code plugin registry, or null
 * when not installed. Tolerant of registry format drift: anything that does
 * not look like the known v2 shape reads as "not installed", which is safe
 * because installation is idempotent.
 */
export function installedClaudePluginVersion(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const registry = readJson(claudePluginRegistryPath(env));
  const plugins = registry?.plugins;
  if (typeof plugins !== "object" || plugins === null) return null;
  const entries = (plugins as Record<string, unknown>)[CLAUDE_PLUGIN_KEY];
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { version?: unknown }).version === "string"
    ) {
      return (entry as { version: string }).version;
    }
  }
  return null;
}

/** Numeric-aware semver comparison; non-numeric segments compare as 0. */
function versionLessThan(a: string, b: string): boolean {
  const pa = a.split(".").map((s) => Number.parseInt(s, 10) || 0);
  const pb = b.split(".").map((s) => Number.parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db;
  }
  return false;
}

function opencodePluginInstalled(env: NodeJS.ProcessEnv): boolean {
  const config = readJson(opencodeConfigPath(env));
  if (!config || !Array.isArray(config.plugin)) return false;
  return config.plugin.some(
    (entry) =>
      typeof entry === "string" &&
      entry.includes("plugin-opencode"),
  );
}

export interface AgentPluginStatus {
  installed: boolean;
  /** Present for claude only: installed version is older than the bundled one. */
  outdated?: boolean;
}

/**
 * Fresh install/update status of the wos plugin for `agent`. Reads the
 * registry/manifest on every call so detection never lags reality — the only
 * hot caller (the active-command resolver) already runs behind a far costlier
 * process-tree scan, so a cache earned nothing but staleness.
 */
export function getAgentPluginStatus(
  agent: PluginAgent,
  env: NodeJS.ProcessEnv = process.env,
): AgentPluginStatus {
  if (agent === "claude") {
    const installed = installedClaudePluginVersion(env);
    const bundled = bundledClaudePluginVersion();
    return {
      installed: installed !== null,
      outdated:
        installed !== null && bundled !== null
          ? versionLessThan(installed, bundled)
          : false,
    };
  }
  if (agent === "codex") {
    return codexPluginStatus(installedCodexPluginStatus(env));
  }
  return { installed: opencodePluginInstalled(env) };
}

/** Whether the wos plugin for `agent` is installed (fresh read). */
export function isAgentPluginInstalled(
  agent: PluginAgent,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return getAgentPluginStatus(agent, env).installed;
}

/**
 * No-op retained for compatibility. Detection no longer caches, so there is
 * nothing to reset; existing callers and tests keep working unchanged.
 */
export function resetAgentPluginInstallCache(): void {}

/**
 * Migration: strip legacy wos hook entries (commands under
 * `plugin-claude/scripts`) injected into `~/.claude/settings.json` by older
 * wos versions, preserving all unrelated hooks and settings. Idempotent.
 * Returns true when the file was modified.
 */
export function removeLegacyClaudeHooks(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const path = claudeSettingsPath(env);
  const settings = readJson(path);
  if (!settings || typeof settings.hooks !== "object" || settings.hooks === null) {
    return false;
  }
  const hooks = settings.hooks as Record<string, unknown>;
  let changed = false;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter(
      (entry) => !JSON.stringify(entry).includes(CLAUDE_HOOK_MARKER),
    );
    if (kept.length !== entries.length) {
      changed = true;
      if (kept.length > 0) hooks[event] = kept;
      else delete hooks[event];
    }
  }
  if (!changed) return false;
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  return true;
}

export type ClaudePluginInstallResult = ClaudeCliResult & {
  /** True when legacy settings.json hook entries were removed. */
  migratedLegacyHooks: boolean;
};

/**
 * Bring the Claude Code wos plugin to the bundled version: migrate legacy
 * injected hooks away, register the marketplace, then install (or update when
 * outdated). Every CLI step is idempotent; a missing `claude` binary surfaces
 * as a typed error.
 */
export async function ensureClaudePluginInstalled(
  env: NodeJS.ProcessEnv = process.env,
  run?: ClaudeCliRunner,
): Promise<ClaudePluginInstallResult> {
  let migratedLegacyHooks = false;
  try {
    migratedLegacyHooks = removeLegacyClaudeHooks(env);
  } catch {
    // best-effort: an unreadable settings.json must not block installation
  }
  const status = getAgentPluginStatus("claude", env);
  const finish = (result: ClaudeCliResult): ClaudePluginInstallResult => ({
    ...result,
    migratedLegacyHooks,
  });
  if (status.installed && !status.outdated) {
    return finish({ ok: true });
  }
  const added = await addClaudeMarketplace(undefined, run);
  if (!added.ok) return finish(added);
  if (status.installed && status.outdated) {
    const refreshed = await updateClaudeMarketplace(run);
    if (!refreshed.ok) return finish(refreshed);
    return finish(await updateClaudePluginCli(run));
  }
  return finish(await installClaudePluginCli(run));
}

/**
 * Force a clean reinstall of the Claude Code wos plugin: migrate legacy
 * injected hooks away (best-effort), then `uninstall` → `marketplace update`
 * → `install --scope user` through the headless CLI. A plain update only
 * re-points to the latest marketplace version and won't repair a corrupt or
 * stale install — removing then reinstalling does. The first failing CLI step
 * is surfaced as a typed error; a missing `claude` binary surfaces as
 * `claude-cli-not-found`.
 */
export async function reinstallClaudePlugin(
  env: NodeJS.ProcessEnv = process.env,
  run?: ClaudeCliRunner,
): Promise<ClaudePluginInstallResult> {
  let migratedLegacyHooks = false;
  try {
    migratedLegacyHooks = removeLegacyClaudeHooks(env);
  } catch {
    // best-effort: an unreadable settings.json must not block reinstallation
  }
  const finish = (result: ClaudeCliResult): ClaudePluginInstallResult => ({
    ...result,
    migratedLegacyHooks,
  });
  const uninstalled = await uninstallClaudePluginCli(run);
  if (!uninstalled.ok) return finish(uninstalled);
  const refreshed = await updateClaudeMarketplace(run);
  if (!refreshed.ok) return finish(refreshed);
  return finish(await installClaudePluginCli(run));
}

/**
 * Bring the Codex wos plugin to the bundled version through the headless
 * `codex plugin` CLI: register the marketplace, then install. Codex has no
 * separate `plugin update` verb in the surface we target, so the outdated path
 * re-runs the same idempotent add→install — a refreshed marketplace resolves
 * the current version. A missing `codex` binary surfaces as a typed
 * `codex-cli-not-found` error and the daemon stays healthy.
 */
export async function ensureCodexPluginInstalled(
  env: NodeJS.ProcessEnv = process.env,
  run?: CodexCliRunner,
): Promise<CodexCliResult> {
  const status = getAgentPluginStatus("codex", env);
  if (status.installed && !status.outdated) return { ok: true };
  const added = await addCodexMarketplace(undefined, run);
  if (!added.ok) return added;
  return await installCodexPluginCli(run);
}

/**
 * Idempotently add the wos plugin entry to the user's opencode config. The
 * file is created when missing; an existing entry leaves the file unchanged.
 */
export function injectOpencodePlugin(
  env: NodeJS.ProcessEnv = process.env,
  pluginEntry: string = opencodePluginEntry(),
): boolean {
  const path = opencodeConfigPath(env);
  const config = readJson(path) ?? {};
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  if (plugins.includes(pluginEntry)) return false;
  // Replace stale wos entries (e.g. an old path or the unpublished npm name)
  // instead of accumulating duplicates.
  const kept = plugins.filter(
    (entry) =>
      !(typeof entry === "string" && entry.includes("plugin-opencode")),
  );
  config.plugin = [...kept, pluginEntry];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  return true;
}

/** Run all installs; used when `autoInjectAgentPlugins` is enabled. */
export async function ensureAgentPluginsInjected(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    await ensureClaudePluginInstalled(env);
  } catch {
    // best-effort: install failures must not break daemon startup
  }
  try {
    await ensureCodexPluginInstalled(env);
  } catch {
    // best-effort: a missing codex CLI must not break daemon startup
  }
  try {
    injectOpencodePlugin(env);
  } catch {
    // best-effort
  }
}

// Re-export for callers that need to verify paths in diagnostics/tests.
export { claudeSettingsPath, opencodeConfigPath, claudePluginRegistryPath };
