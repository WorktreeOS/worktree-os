/**
 * Pure, side-effect-free decision logic for the non-interactive `wos init`.
 *
 * Everything in this module is a deterministic function of its inputs (parsed
 * argv, probe results) so the branching the init runner wires to `Bun.which` /
 * child-process installs can be unit-tested in isolation (`bun test`), per the
 * repo's test-through-pure-functions norm. The runner in `init.ts` is the only
 * place that performs I/O. Cross-package setup primitives (package-manager
 * detection, free-port selection, the tmux warning) live in
 * `@worktreeos/daemon/setup-environment` so the CLI and the daemon web
 * onboarding endpoints share one implementation.
 */

import type { TerminalBackendId } from "@worktreeos/core/global-config";
import type { PackageManagerInstall } from "@worktreeos/daemon/setup-environment";

export interface ParsedInitArgs {
  host?: string;
  port?: number;
  backend?: TerminalBackendId;
  installTmux: boolean;
  installPlugins: boolean;
  yes: boolean;
}

export interface InitArgsError {
  error: string;
}

/**
 * Parse the `wos init` flags: `--host`, `--port`, `--backend <default|tmux>`,
 * `--install-tmux`, `--install-plugins`, `--yes`. Both `--flag value` and
 * `--flag=value` forms are accepted for valued flags. Unknown arguments and
 * invalid `--port` / `--backend` values produce a usage error.
 */
export function parseInitArgs(
  argv: string[],
): ParsedInitArgs | InitArgsError {
  const out: ParsedInitArgs = { installTmux: false, installPlugins: false, yes: false };
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
      case "--install-plugins":
        if (inlineValue !== undefined) {
          return { error: "--install-plugins does not take a value" };
        }
        out.installPlugins = true;
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
 * warning can be skipped). Matches `localhost`, the IPv4 loopback block
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
