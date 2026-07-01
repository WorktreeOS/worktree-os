/**
 * WorktreeOS desktop — Electrobun bun-process entry.
 *
 * Boot sequence:
 *   1. Open a native window immediately with a loading page, so a window ALWAYS
 *      appears even if later steps fail or hang (then navigate it).
 *   2. Single-instance guard.
 *   3. Resolve the login-shell PATH (design D6) — bounded by a timeout so it can
 *      never hang boot — and apply it for the hosted daemon's subprocesses.
 *   4. Provision a `wos` CLI on PATH (design D5).
 *   5. Adopt-or-host the daemon (design D1); the daemon graph is imported
 *      dynamically so a bundling/load failure surfaces as a visible error.
 *   6. Navigate the window to the daemon URL; wire tray + lifecycle (design D3).
 *
 * Any failure is logged to `~/.wos/desktop.log` and shown in the window.
 *
 * Depends on the Electrobun native runtime; runs only under `electrobun dev` /
 * the packaged app. The decision logic lives in framework-free, unit-tested
 * modules (`daemon-host`, `cli-provision`, `login-path`, `instance-lock`,
 * `resources`).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { mkdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { BrowserWindow, PATHS, Tray, app } from "electrobun";
import { wosHome } from "@worktreeos/core/paths";

import { defaultPreferredDir, provisionCli, type ProvisionEffects } from "./cli-provision";
import { acquireInstanceLock } from "./instance-lock";
import { loginShellPath, pathDirs } from "./login-path";
import { bundledWosPath, pluginsDir, webAssetRoot } from "./resources";
import type { DesktopDaemon } from "./daemon-host";

const WINDOW_FRAME = { x: 0, y: 0, width: 1280, height: 800 } as const;
const LOGIN_PATH_TIMEOUT_MS = 4_000;

let daemon: DesktopDaemon | null = null;
let window: BrowserWindow | null = null;
let tray: Tray | null = null;

// --- logging ------------------------------------------------------------

function logPath(): string {
  const home = wosHome();
  try {
    mkdirSync(home, { recursive: true });
  } catch {
    /* best-effort */
  }
  return resolve(home, "desktop.log");
}

function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    appendFileSync(logPath(), line);
  } catch {
    /* best-effort */
  }
  process.stderr.write(`[wos-desktop] ${line}`);
}

// Capture anything that escapes — otherwise a crash is invisible.
process.on("uncaughtException", (e) => log(`uncaughtException: ${e?.stack ?? e}`));
process.on("unhandledRejection", (e) => log(`unhandledRejection: ${String(e)}`));

// --- window -------------------------------------------------------------

const LOADING_HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{height:100%;margin:0;font:15px -apple-system,system-ui,sans-serif;
background:#faf9f7;color:#3a3a3a;display:flex;align-items:center;justify-content:center}
.c{text-align:center;opacity:.7}</style></head>
<body><div class="c">Starting WorktreeOS…</div></body></html>`;

function errorHtml(title: string, detail: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{height:100%;margin:0;font:14px -apple-system,system-ui,sans-serif;
background:#faf9f7;color:#3a3a3a}.w{max-width:680px;margin:48px auto;padding:0 24px}
h1{font-size:18px}code,pre{font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
pre{white-space:pre-wrap;background:#f0eee9;border-radius:8px;padding:12px;color:#7a2a2a}
.m{color:#777}</style></head><body><div class="w">
<h1>${esc(title)}</h1>
<pre>${esc(detail)}</pre>
<p class="m">Full log: <code>${esc(logPath())}</code></p></div></body></html>`;
}

/**
 * Tag the loopback URL so the frontend skips service-worker / PWA registration
 * (see `isDesktopRuntime` in `apps/web/src/register-service-worker.ts`).
 */
function desktopUrl(webUrl: string): string {
  const u = new URL(webUrl);
  u.searchParams.set("wosRuntime", "desktop");
  return u.toString();
}

/**
 * Create the single window if absent, else reveal it.
 *
 * `initialUrl` is passed straight into the `BrowserWindow` constructor rather
 * than loaded via a follow-up `loadURL()` call: the constructor's own initial
 * content (whichever of `html`/`url` is set) is applied by the native side on
 * a short async delay, so an explicit load issued right after construction
 * races it and can be clobbered ~100ms later. Boot has enough delay before its
 * `navigate()` call (PATH resolution, daemon lookup) that the race never
 * surfaces there; a tray reopen has no such gap, so it must load the target
 * URL from construction instead of loading-placeholder-then-navigate.
 */
function ensureWindow(initialUrl?: string): void {
  if (window) {
    window.show();
    return;
  }
  window = new BrowserWindow({
    title: "WorktreeOS",
    html: initialUrl ? null : LOADING_HTML,
    url: initialUrl ? desktopUrl(initialUrl) : null,
    frame: { ...WINDOW_FRAME },
    renderer: "native",
  });
  window.on("close", () => {
    // Tray-decoupled: the window is gone but the daemon (this process) lives on.
    window = null;
  });
}

function navigate(url: string): void {
  if (!window) {
    ensureWindow(url);
    return;
  }
  window.webview?.loadURL(desktopUrl(url));
}

/** Reveal the window; if it was closed, re-navigate it (a fresh window would
 *  otherwise sit on the loading placeholder forever since boot only navigates
 *  once). */
function showMainWindow(): void {
  if (window) {
    window.show();
    return;
  }
  if (daemon) {
    navigate(daemon.webUrl);
  } else {
    ensureWindow();
  }
}

function showError(title: string, detail: string): void {
  ensureWindow();
  window?.webview?.loadHTML(errorHtml(title, detail));
}

// --- lifecycle ----------------------------------------------------------

async function quit(): Promise<void> {
  try {
    if (daemon?.isHost) await daemon.stop();
  } finally {
    app.quit();
  }
}

function setupTray(): void {
  if (tray) return;
  tray = new Tray({ title: "WorktreeOS", template: true });
  tray.setMenu([
    { label: "Open WorktreeOS", action: "open" },
    { type: "divider" },
    { label: "Quit", action: "quit" },
  ] as Parameters<Tray["setMenu"]>[0]);
  tray.on("tray-clicked", (event) => {
    const action = (event as { data?: { action?: string } })?.data?.action;
    if (action === "quit") {
      void quit();
      return;
    }
    showMainWindow();
  });
}

// --- provisioning effects ----------------------------------------------

function provisionEffects(loginPath: string | null): ProvisionEffects {
  const dirs = pathDirs(loginPath);
  return {
    which: async (cmd) => {
      for (const dir of dirs) {
        const candidate = resolve(dir, cmd);
        if (await Bun.file(candidate).exists()) return candidate;
      }
      return null;
    },
    realpath: async (p) => {
      try {
        return await realpath(p);
      } catch {
        return null;
      }
    },
    readlink: async (p) => {
      try {
        return await readlink(p);
      } catch {
        return null;
      }
    },
    ensureDir: async (dir) => {
      await mkdir(dir, { recursive: true });
    },
    symlink: async (target, link) => {
      await rm(link, { force: true });
      await symlink(target, link);
    },
    notify: (message) => log(message),
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((r) => setTimeout(() => r(fallback), ms)),
  ]);
}

// --- boot ---------------------------------------------------------------

async function boot(): Promise<void> {
  log("boot: start");
  // 1. A window appears no matter what happens next.
  ensureWindow();

  // 2. Single-instance guard.
  if (!acquireInstanceLock(resolve(wosHome(), "desktop.lock"))) {
    log("boot: another instance is running — yielding");
    showError(
      "WorktreeOS is already running",
      "Another WorktreeOS instance owns the daemon. Use the existing window, " +
        "or quit it (and remove ~/.wos/desktop.lock) before relaunching.",
    );
    return;
  }

  try {
    const resourcesDir = PATHS.RESOURCES_FOLDER;
    log(`boot: resourcesDir=${resourcesDir}`);

    // On-disk plugin sources for the hosted daemon (design D7).
    process.env.WOS_PLUGIN_ROOT_DIR = pluginsDir(resourcesDir);

    // 3. Finder-launch PATH fix — bounded so it can never hang boot.
    const loginPath = await withTimeout(loginShellPath(), LOGIN_PATH_TIMEOUT_MS, null);
    if (loginPath) {
      process.env.PATH = loginPath;
      log("boot: applied login-shell PATH");
    } else {
      log("boot: login-shell PATH unavailable — using inherited env");
    }

    // 4. CLI provisioning (non-destructive; never edits dotfiles).
    const decision = await provisionCli(
      { bundledWos: bundledWosPath(resourcesDir), preferredDir: defaultPreferredDir(), loginPath },
      provisionEffects(loginPath),
    );
    log(`boot: cli provisioning → ${decision.action}`);

    // 5. Adopt-or-host. Imported dynamically so a daemon-graph bundling/load
    //    failure is caught and shown rather than crashing the process silently.
    log("boot: loading daemon module");
    const { ensureDesktopDaemon } = await import("./daemon-host");
    log("boot: resolving daemon (adopt-or-host)");
    daemon = await ensureDesktopDaemon({
      assetRoot: webAssetRoot(resourcesDir),
      confirmReplace: async () => true,
      onStopRequested: () => void quit(),
    });
    log(`boot: daemon ready (isHost=${daemon.isHost}) at ${daemon.webUrl}`);

    // 6. Navigate the window. (Do this before tray so a tray failure can never
    //    mask a working app.)
    navigate(daemon.webUrl);
    log("boot: navigated window to daemon");

    try {
      setupTray();
      app.on("open-url", () => showMainWindow());
    } catch (e) {
      log(`boot: tray/lifecycle setup failed (non-fatal): ${String(e)}`);
    }
    log("boot: done");
  } catch (err) {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log(`boot: FAILED — ${detail}`);
    showError("WorktreeOS failed to start", detail);
  }
}

// Create the window synchronously during initial module evaluation (the
// canonical Electrobun pattern) so it cannot be gated behind any async step.
ensureWindow();
void boot();
