/**
 * Pure, side-effect-free decision logic for the `wos init` setup wizard.
 *
 * Everything in this module is a deterministic function of its inputs (the host
 * platform, an injected `which` lookup, parsed argv, probe results) so the
 * branching the wizard runner wires to `readline` / `Bun.which` / child-process
 * installs can be unit-tested in isolation (`bun test`), per the repo's
 * test-through-pure-functions norm. The wizard runner in `init.ts` is the only
 * place that performs I/O.
 */

import type { TerminalBackendId } from "@worktreeos/core/global-config";

/**
 * The single literal stability warning emitted whenever the effective terminal
 * backend resolves to `default`. Referenced by the wizard (on declining tmux),
 * `wos start`, and — as a synchronized copy — the web terminal surface. Tests
 * assert the exact copy on every surface to guard against drift.
 */
export const OUTSIDE_TMUX_WARNING =
  "Running outside tmux/psmux — terminal sessions may be unstable.";

/**
 * Return the first free port at or above `start`, probing each candidate with
 * the injected `isFree` predicate. Scans up to the maximum valid port (65535);
 * when nothing in range is free it falls back to `start` (the daemon's own bind
 * remains the source of truth — this is advisory UX only).
 */
export function selectNextFreePort(
  start: number,
  isFree: (port: number) => boolean,
): number {
  for (let port = start; port <= 65535; port++) {
    if (isFree(port)) return port;
  }
  return start;
}

/** Supported host package managers for the insistent tmux/psmux install offer. */
export type PackageManagerId =
  | "brew"
  | "apt"
  | "dnf"
  | "pacman"
  | "winget"
  | "scoop";

export interface PackageManagerInstall {
  /** The detected package manager. */
  manager: PackageManagerId;
  /** Ready-to-run shell command that installs the multiplexer. */
  command: string;
}

/**
 * Per-manager probe binary and the install command the wizard offers to run.
 * POSIX managers install `tmux`; the Windows managers install `psmux` (the
 * tmux-compatible ConPTY multiplexer the tmux backend probes for on win32).
 */
const PACKAGE_MANAGERS: Record<
  PackageManagerId,
  { bin: string; command: string }
> = {
  brew: { bin: "brew", command: "brew install tmux" },
  apt: { bin: "apt-get", command: "sudo apt-get install -y tmux" },
  dnf: { bin: "dnf", command: "sudo dnf install -y tmux" },
  pacman: { bin: "pacman", command: "sudo pacman -S --noconfirm tmux" },
  winget: { bin: "winget", command: "winget install psmux" },
  scoop: { bin: "scoop", command: "scoop install psmux" },
};

/** Platform-ordered preference list of package managers to probe. */
function managerPreference(platform: NodeJS.Platform): PackageManagerId[] {
  if (platform === "win32") return ["winget", "scoop"];
  if (platform === "darwin") return ["brew"];
  // Linux and other POSIX hosts: distro managers first, then linuxbrew.
  return ["apt", "dnf", "pacman", "brew"];
}

/**
 * Detect the preferred host package manager and the matching tmux/psmux install
 * command, probing each candidate binary via the injected `which`. Returns
 * `null` when no supported manager is found.
 */
export function detectPackageManager(
  platform: NodeJS.Platform,
  which: (name: string) => string | null,
): PackageManagerInstall | null {
  for (const manager of managerPreference(platform)) {
    const entry = PACKAGE_MANAGERS[manager];
    if (which(entry.bin)) {
      return { manager, command: entry.command };
    }
  }
  return null;
}

/** Commands exempt from the global-config gate: the wizard entrypoints + help. */
const CONFIG_EXEMPT_COMMANDS = new Set(["init", "help", "--help", "-h"]);

/**
 * Gate decision: whether `command` requires the global config file to exist.
 * Returns `false` only for the wizard entrypoints (bare/no command, `init`) and
 * help (`help` / `-h` / `--help`); every other command requires a config.
 */
export function requiresConfig(command: string | undefined): boolean {
  if (command === undefined) return false;
  return !CONFIG_EXEMPT_COMMANDS.has(command);
}

export interface ParsedInitArgs {
  host?: string;
  port?: number;
  backend?: TerminalBackendId;
  installTmux: boolean;
  yes: boolean;
}

export interface InitArgsError {
  error: string;
}

/**
 * Parse the `wos init` flags: `--host`, `--port`, `--backend <default|tmux>`,
 * `--install-tmux`, `--yes`. Both `--flag value` and `--flag=value` forms are
 * accepted for valued flags. Unknown arguments and invalid `--port` /
 * `--backend` values produce a usage error.
 */
export function parseInitArgs(
  argv: string[],
): ParsedInitArgs | InitArgsError {
  const out: ParsedInitArgs = { installTmux: false, yes: false };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);

    const takeValue = (): string | InitArgsError => {
      if (inlineValue !== undefined) {
        if (inlineValue.length === 0) return { error: `${flag} requires a value` };
        return inlineValue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        return { error: `${flag} requires a value` };
      }
      i += 1;
      return next;
    };

    switch (flag) {
      case "--host": {
        const value = takeValue();
        if (typeof value !== "string") return value;
        out.host = value;
        break;
      }
      case "--port": {
        const value = takeValue();
        if (typeof value !== "string") return value;
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return { error: "--port must be an integer in [1, 65535]" };
        }
        out.port = port;
        break;
      }
      case "--backend": {
        const value = takeValue();
        if (typeof value !== "string") return value;
        if (value !== "default" && value !== "tmux") {
          return { error: "--backend must be 'default' or 'tmux'" };
        }
        out.backend = value;
        break;
      }
      case "--install-tmux":
        if (inlineValue !== undefined) {
          return { error: "--install-tmux does not take a value" };
        }
        out.installTmux = true;
        break;
      case "--yes":
        if (inlineValue !== undefined) {
          return { error: "--yes does not take a value" };
        }
        out.yes = true;
        break;
      default:
        return { error: `unknown argument: ${arg}` };
    }
    i += 1;
  }
  return out;
}

export interface BackendDecisionInput {
  /** Whether tmux/psmux was detected as available on the host. */
  available: boolean;
  /** Detected host package manager, or null when none is available. */
  packageManager: PackageManagerInstall | null;
  /** Whether the user accepted the tmux install offer. */
  installAccepted: boolean;
  /** Whether the install command, once run, succeeded. */
  installOk: boolean;
}

export interface BackendDecision {
  backend: TerminalBackendId;
  /** True when the resolved backend is `default` and the warning must be shown. */
  warn: boolean;
}

/**
 * Resolve the terminal backend from the tmux availability / install outcome.
 * tmux is selected when it was already available, or when a package-manager
 * install was accepted and succeeded; every other outcome (unavailable with no
 * manager, declined, or a failed install) falls back to `default` + warning.
 */
export function resolveBackendDecision(
  input: BackendDecisionInput,
): BackendDecision {
  if (input.available) return { backend: "tmux", warn: false };
  if (input.packageManager && input.installAccepted && input.installOk) {
    return { backend: "tmux", warn: false };
  }
  return { backend: "default", warn: true };
}

/**
 * Whether `host` is a loopback address (so the non-loopback LAN-exposure
 * confirmation can be skipped). Matches `localhost`, the IPv4 loopback block
 * (`127.0.0.0/8`), and the IPv6 loopback (`::1`). Everything else — including
 * `0.0.0.0` (all interfaces) — is treated as non-loopback.
 */
export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (value === "localhost") return true;
  if (value === "::1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) return true;
  return false;
}
