/**
 * Shared first-run setup environment helpers.
 *
 * These are the cross-cutting, side-effect-isolated primitives used by BOTH the
 * (non-interactive) `wos init` CLI path and the daemon web onboarding endpoints
 * (`GET /ui/v1/setup/environment`, `POST /ui/v1/setup/install-tmux`). Keeping one
 * implementation here means the CLI `--install-tmux` flag and the web tmux-install
 * action share the same package-manager detection, install runner, Docker probe,
 * free-port selection, and stability-warning copy — they cannot drift.
 *
 * Pure decision helpers (`selectNextFreePort`, `detectPackageManager`) take their
 * effects as injected predicates so they stay unit-testable. The genuinely
 * side-effectful runners (`runInstallCommand`, `probeDockerEnvironment`) are
 * isolated in their own functions so callers can substitute stubs.
 */

/**
 * The single literal stability warning emitted whenever the effective terminal
 * backend resolves to `default`. Referenced by the non-interactive init path,
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

/** Supported host package managers for the tmux/psmux install offer. */
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
 * Per-manager probe binary and the install command offered. POSIX managers
 * install `tmux`; the Windows managers install `psmux` (the tmux-compatible
 * ConPTY multiplexer the tmux backend probes for on win32). `requiresElevation`
 * marks managers whose install command needs a sudo password: the daemon has no
 * TTY to answer for one, so those are surfaced as guidance rather than auto-run.
 */
const PACKAGE_MANAGERS: Record<
  PackageManagerId,
  { bin: string; command: string; requiresElevation: boolean }
> = {
  brew: { bin: "brew", command: "brew install tmux", requiresElevation: false },
  apt: { bin: "apt-get", command: "sudo apt-get install -y tmux", requiresElevation: true },
  dnf: { bin: "dnf", command: "sudo dnf install -y tmux", requiresElevation: true },
  pacman: { bin: "pacman", command: "sudo pacman -S --noconfirm tmux", requiresElevation: true },
  winget: { bin: "winget", command: "winget install psmux", requiresElevation: false },
  scoop: { bin: "scoop", command: "scoop install psmux", requiresElevation: false },
};

/**
 * Whether the given package manager's install command requires elevation
 * (sudo). apt/dnf/pacman do; brew/winget/scoop do not.
 */
export function managerRequiresElevation(manager: PackageManagerId): boolean {
  return PACKAGE_MANAGERS[manager].requiresElevation;
}

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

/** Run a package-manager install command; returns whether it exited cleanly. */
export async function runInstallCommand(
  command: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  try {
    const res =
      platform === "win32"
        ? await Bun.$`cmd /c ${command}`.nothrow()
        : await Bun.$`sh -c ${command}`.nothrow();
    return res.exitCode === 0;
  } catch {
    return false;
  }
}

export interface DockerEnvironmentProbe {
  /** Whether a `docker` binary is present on PATH. */
  dockerInstalled: boolean;
  /** Whether `docker compose version` (Compose v2) succeeds. */
  dockerComposeV2: boolean;
}

/**
 * Probe the host Docker environment: whether the `docker` CLI is present and
 * whether Docker Compose v2 (`docker compose version`) is usable. Compose is
 * only probed when the `docker` binary exists. Side-effectful (spawns
 * `docker`); isolated so the CLI and the daemon onboarding endpoint share one
 * implementation.
 */
export async function probeDockerEnvironment(): Promise<DockerEnvironmentProbe> {
  const dockerInstalled = Boolean(Bun.which("docker"));
  if (!dockerInstalled) {
    return { dockerInstalled: false, dockerComposeV2: false };
  }
  let dockerComposeV2 = false;
  try {
    const probe = await Bun.$`docker compose version`.quiet().nothrow();
    dockerComposeV2 = probe.exitCode === 0;
  } catch {
    dockerComposeV2 = false;
  }
  return { dockerInstalled, dockerComposeV2 };
}
