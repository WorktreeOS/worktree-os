/**
 * CLI provisioning: keep a working `wos` on the user's PATH.
 *
 * Every agent plugin hook is the bare command `wos agent-hook <event>`
 * (`plugin-claude/hooks/hooks.json`), so an agent can only reach the daemon if
 * `wos` resolves on PATH wherever it runs. A desktop-only install otherwise has
 * no `wos`, and every hook silently no-ops.
 *
 * Policy (idempotent, self-healing, non-destructive):
 *   - A working *foreign* `wos` already on PATH (e.g. install.sh) is left alone.
 *   - Our own managed symlink is refreshed to the current bundled binary
 *     (handles the app being moved or updated).
 *   - Otherwise, when the preferred dir is on PATH, (re)create the symlink.
 *   - When PATH cannot be guaranteed without editing shell profiles, surface a
 *     notice — never edit dotfiles silently.
 */

import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { isOnPath } from "./login-path";

export type SymlinkDecision =
  /** A working foreign `wos` is on PATH; do nothing. */
  | { action: "skip-foreign"; existing: string }
  /** Our managed symlink already points at the current binary. */
  | { action: "skip-current"; link: string }
  /** Create or refresh the managed symlink at `link` → `target`. */
  | { action: "link"; link: string; target: string }
  /** No `wos` on PATH and no app-writable dir on PATH; tell the user. */
  | { action: "notice"; preferredDir: string };

export interface SymlinkInputs {
  /** Absolute path to the `wos` binary bundled in the app. */
  bundledWos: string;
  /** Resolved `which wos` on the login-shell PATH, or null when absent. */
  existingWos: string | null;
  /** `realpath` of `existingWos`, or null. Identifies our own link target. */
  existingRealpath: string | null;
  /**
   * True when `existingWos` is a symlink living in `preferredDir` — i.e. one we
   * manage (possibly stale after an app move/update) rather than a foreign
   * install elsewhere.
   */
  existingIsManaged: boolean;
  /** Directory the app symlinks into, e.g. `~/.local/bin`. */
  preferredDir: string;
  /** The effective login-shell PATH value. */
  loginPath: string | null;
}

/** Pure decision: what (if anything) to do about the `wos` symlink. */
export function decideSymlink(i: SymlinkInputs): SymlinkDecision {
  const link = resolve(i.preferredDir, "wos");

  if (i.existingWos) {
    // Already resolves to our current bundled binary — nothing to do.
    if (i.existingRealpath && i.existingRealpath === i.bundledWos) {
      return { action: "skip-current", link: i.existingWos };
    }
    // Our managed symlink but pointing elsewhere (app moved/updated) — refresh.
    if (i.existingIsManaged) {
      return { action: "link", link, target: i.bundledWos };
    }
    // A foreign `wos` (install.sh copy, Homebrew, …) — never overwrite.
    return { action: "skip-foreign", existing: i.existingWos };
  }

  // No `wos` on PATH. Only link when the target dir is actually on PATH, else
  // the symlink would be inert and we must not edit dotfiles to force it.
  if (isOnPath(i.preferredDir, i.loginPath)) {
    return { action: "link", link, target: i.bundledWos };
  }
  return { action: "notice", preferredDir: i.preferredDir };
}

/** Default preferred symlink directory (`~/.local/bin`). */
export function defaultPreferredDir(home: string = homedir()): string {
  return resolve(home, ".local", "bin");
}

export interface ProvisionEffects {
  which: (cmd: string) => Promise<string | null>;
  realpath: (p: string) => Promise<string | null>;
  /** Read a symlink's target, or null when `p` is not a symlink. */
  readlink: (p: string) => Promise<string | null>;
  ensureDir: (dir: string) => Promise<void>;
  symlink: (target: string, link: string) => Promise<void>;
  notify: (message: string) => void;
}

export interface ProvisionInputs {
  bundledWos: string;
  preferredDir: string;
  loginPath: string | null;
}

/**
 * Probe the environment, decide, and apply. Returns the decision taken so the
 * caller (and tests) can assert behavior. Best-effort: never throws — a failed
 * filesystem op degrades to a notice rather than blocking app launch.
 */
export async function provisionCli(
  inputs: ProvisionInputs,
  fx: ProvisionEffects,
): Promise<SymlinkDecision> {
  const existingWos = await fx.which("wos");
  const existingRealpath = existingWos ? await fx.realpath(existingWos) : null;
  const existingTarget = existingWos ? await fx.readlink(existingWos) : null;
  const existingIsManaged =
    existingTarget !== null && dirname(existingWos!) === inputs.preferredDir;

  const decision = decideSymlink({
    bundledWos: inputs.bundledWos,
    existingWos,
    existingRealpath,
    existingIsManaged,
    preferredDir: inputs.preferredDir,
    loginPath: inputs.loginPath,
  });

  try {
    if (decision.action === "link") {
      await fx.ensureDir(inputs.preferredDir);
      await fx.symlink(decision.target, decision.link);
    } else if (decision.action === "notice") {
      fx.notify(
        `wos: add a 'wos' command to your PATH so agent integrations work. ` +
          `Symlink ${inputs.bundledWos} into a directory on your PATH, e.g.\n` +
          `  ln -sf "${inputs.bundledWos}" /usr/local/bin/wos`,
      );
    }
  } catch {
    // Filesystem op failed — degrade to a notice rather than block launch.
    fx.notify(
      `wos: could not install the 'wos' command automatically. Symlink ` +
        `${inputs.bundledWos} into a directory on your PATH.`,
    );
  }

  return decision;
}
