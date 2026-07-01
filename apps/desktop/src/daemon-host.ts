/**
 * Adopt-or-host: the desktop app's daemon lifecycle.
 *
 * On launch the app runs the same discovery the CLI uses
 * (`createDaemonBootstrap().discover()`) and either:
 *   - adopts a healthy, protocol-compatible daemon (the window just points at
 *     its existing `webUrl` — e.g. a `wos up` already started one), or
 *   - hosts a daemon in-process via `startDaemon()` when none is reachable, or
 *   - replaces a protocol-incompatible daemon (after confirmation) then hosts.
 *
 * Everything converges on the single `~/.wos/` rendezvous, so the CLI and any
 * agent plugins reach whichever process owns the daemon — desktop or headless.
 *
 * This module is intentionally free of any Electrobun import so the decision
 * logic stays unit-testable without a windowing runtime. The Electrobun entry
 * (`main.ts`) calls `ensureDesktopDaemon` and wires the window/tray around it.
 */

import {
  createDaemonBootstrap,
  type DaemonBootstrap,
  type DaemonDiscovery,
} from "@worktreeos/daemon/daemon-bootstrap";
import {
  startDaemon,
  type DaemonHandle,
} from "@worktreeos/daemon/daemon-server";
import { loadGlobalConfig } from "@worktreeos/core/global-config";

/** The plan derived purely from a discovery result. */
export type HostPlan =
  | { action: "adopt"; baseUrl: string }
  | { action: "host" }
  | { action: "replace"; baseUrl: string };

/**
 * Pure mapping from a discovery result to the desktop launch plan. Mirrors the
 * CLI's `ensureRunning`/`start` branching but resolves an incompatible daemon
 * to an explicit `replace` (the app confirms with the user before evicting).
 */
export function planFromDiscovery(found: DaemonDiscovery): HostPlan {
  switch (found.kind) {
    case "healthy":
      return { action: "adopt", baseUrl: found.baseUrl };
    case "incompatible":
      return { action: "replace", baseUrl: found.baseUrl };
    case "absent":
      return { action: "host" };
  }
}

export interface EnsureDaemonOptions {
  /**
   * Directory holding the bundled `apps/web` build, served by the hosted daemon
   * via `DaemonWebOptions.assetRoot`. Ignored when adopting.
   */
  assetRoot: string;
  /**
   * Asked before evicting a protocol-incompatible daemon. Returning false
   * leaves the incompatible daemon in place and the app adopts its URL anyway
   * (the window loads, control-plane actions may be limited). Defaults to a
   * conservative "do not replace".
   */
  confirmReplace?: (baseUrl: string) => Promise<boolean>;
  /** Override the bootstrap (tests). */
  bootstrap?: DaemonBootstrap;
  /** Override startDaemon (tests). */
  startDaemonFn?: typeof startDaemon;
  /** Override config loading (tests). */
  loadConfig?: typeof loadGlobalConfig;
  /**
   * Invoked when a UI client requests daemon shutdown via
   * `POST /ui/v1/daemon/stop`. The desktop app wires this to its own teardown.
   * Only used on the host path.
   */
  onStopRequested?: () => void;
}

export interface DesktopDaemon {
  /** Whether this process started (and therefore owns) the daemon. */
  isHost: boolean;
  /** Client-facing loopback URL the window should load. */
  webUrl: string;
  /**
   * Stop the daemon — only meaningful when `isHost`. For an adopted daemon this
   * is a no-op so Quit never tears down a daemon another process owns.
   */
  stop: () => Promise<void>;
}

/**
 * Resolve a daemon for the desktop window: adopt an existing one or host one
 * in-process. The hosted daemon serves the bundled web assets and writes the
 * standard `~/.wos/daemon.json` + `~/.wos/agent-token` rendezvous (via
 * `startDaemon`), so agents reach it identically to a headless daemon.
 */
export async function ensureDesktopDaemon(
  opts: EnsureDaemonOptions,
): Promise<DesktopDaemon> {
  const bootstrap = opts.bootstrap ?? createDaemonBootstrap();
  const start = opts.startDaemonFn ?? startDaemon;
  const loadConfig = opts.loadConfig ?? loadGlobalConfig;

  const plan = planFromDiscovery(await bootstrap.discover());

  if (plan.action === "adopt") {
    return { isHost: false, webUrl: plan.baseUrl, stop: async () => {} };
  }

  if (plan.action === "replace") {
    const confirm = opts.confirmReplace ?? (async () => false);
    if (await confirm(plan.baseUrl)) {
      // stop() handles the incompatible case by terminating the reported pid.
      await bootstrap.stop();
    } else {
      // Leave the foreign daemon; load its UI without hosting our own.
      return { isHost: false, webUrl: plan.baseUrl, stop: async () => {} };
    }
  }

  const config = await loadConfig();
  const handle: DaemonHandle = await start({
    web: {
      host: config.web.host,
      port: config.web.port,
      assetRoot: opts.assetRoot,
    },
    // Opt out of the subprocess-based restart scheduler: a detached `wos
    // restart` would spawn a *second* headless daemon competing with this
    // in-process host. Desktop restart is handled at the app level by
    // re-hosting. (daemon-server treats an undefined restartScheduler as
    // "embedded caller opts out".)
    restartScheduler: undefined,
    stopScheduler: opts.onStopRequested
      ? () => {
          // Deferred so the HTTP response flushes before shutdown begins.
          setTimeout(() => opts.onStopRequested?.(), 50);
        }
      : undefined,
  });

  return {
    isHost: true,
    webUrl: handle.webUrl,
    stop: () => handle.stop(),
  };
}
