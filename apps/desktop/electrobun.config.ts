import type { ElectrobunConfig } from "electrobun";

/**
 * Electrobun build/runtime config for the WorktreeOS desktop app.
 *
 * The app is a native window over the existing self-hosting daemon: the Bun
 * process (`src/main.ts`) adopts-or-hosts the daemon and the system webview
 * loads its loopback URL. Resources copied here land under the bundle's
 * `Resources/` folder (`PATHS.RESOURCES_FOLDER`) and are resolved at runtime in
 * `src/resources.ts`:
 *   - `web`     — the built `apps/web` SPA, served by the hosted daemon via
 *                 `DaemonWebOptions.assetRoot`.
 *   - `bin/wos` — the compiled CLI (`bun run build:binary` → `dist/wos`),
 *                 symlinked onto PATH so agent hooks reach the daemon.
 *   - `plugins/*` — agent plugin sources as real on-disk files (external agent
 *                 runtimes cannot read Bun's `/$bunfs/`).
 *
 * Paths are relative to this config's directory (`apps/desktop`).
 */
const config: ElectrobunConfig = {
  app: {
    name: "WorktreeOS",
    identifier: "dev.worktreeos.desktop",
    version: "0.0.3",
    description: "One control plane for every worktree, every project, every agent.",
  },
  build: {
    // `naming: "index.js"` matters: Electrobun's native launcher hardcodes the
    // worker entrypoint as `Resources/app/bun/index.js`. Without this, Bun.build
    // names the output after the source file (`main.js`), the launcher's Worker
    // silently fails to find it, and the app hangs forever in the native event
    // loop with no window and no tray (looks "running" but shows nothing).
    bun: { entrypoint: "src/main.ts", naming: "index.js" },
    copy: {
      "../web/dist": "web",
      "../../dist/wos": "bin/wos",
      "../../packages/plugin-claude": "plugins/plugin-claude",
      "../../packages/plugin-codex": "plugins/plugin-codex",
      "../../packages/plugin-opencode": "plugins/plugin-opencode",
      "../../packages/plugin-pi": "plugins/plugin-pi",
    },
    // System webview (WKWebView on macOS) — keeps the bundle small and the
    // frontend byte-identical to the browser build.
    mac: { defaultRenderer: "native" },
  },
  runtime: {
    // Tray-decoupled lifecycle (design D3): closing the window must NOT quit the
    // Bun process, so the hosted daemon keeps supervising sessions/monitors.
    // Quit is explicit (tray / app menu) and tears the daemon down.
    exitOnLastWindowClosed: false,
  },
};

export default config;
