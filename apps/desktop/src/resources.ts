/**
 * Runtime locations of the resources copied into the app bundle by
 * `electrobun.config.ts` (`build.copy`). At runtime the caller passes
 * Electrobun's `PATHS.RESOURCES_FOLDER`; kept as pure path builders so they
 * stay unit-testable without the Electrobun runtime.
 *
 * Electrobun nests every `build.copy` destination under `Resources/app/` (its
 * `appBundleAppCodePath`), *not* directly under `PATHS.RESOURCES_FOLDER`. Each
 * builder resolves through that `app/` segment accordingly.
 */

import { resolve } from "node:path";

export type AgentPlugin = "claude" | "codex" | "opencode" | "pi";

/** The `Resources/app` code root where Electrobun places copied resources. */
function appRoot(resourcesDir: string): string {
  return resolve(resourcesDir, "app");
}

/** The bundled `apps/web` build served by the hosted daemon (`assetRoot`). */
export function webAssetRoot(resourcesDir: string): string {
  return resolve(appRoot(resourcesDir), "web");
}

/** The bundled compiled `wos` CLI, symlinked onto PATH for agent hooks. */
export function bundledWosPath(resourcesDir: string): string {
  return resolve(appRoot(resourcesDir), "bin", "wos");
}

/** On-disk source root for an agent plugin (external runtimes read these). */
export function pluginRoot(resourcesDir: string, agent: AgentPlugin): string {
  return resolve(appRoot(resourcesDir), "plugins", `plugin-${agent}`);
}

/**
 * Base directory holding all bundled plugin packages — passed to the daemon as
 * `WOS_PLUGIN_ROOT_DIR` so `pluginPackageRoot` resolves on-disk sources.
 */
export function pluginsDir(resourcesDir: string): string {
  return resolve(appRoot(resourcesDir), "plugins");
}
