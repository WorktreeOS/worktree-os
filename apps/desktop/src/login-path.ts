/**
 * Login-shell PATH resolution for a Finder/Dock-launched app.
 *
 * A GUI app launched from Finder inherits a minimal `PATH` (e.g.
 * `/usr/bin:/bin:/usr/sbin:/sbin`), not the user's shell PATH. The hosted
 * daemon shells out to `git`, `docker`, and `claude` (the last gates
 * `ensureAgentPluginsInjected()` → `claude plugin install`), so before
 * `startDaemon()` the app probes the user's login shell for its real PATH and
 * applies it to the daemon process environment.
 *
 * The same resolved PATH tells CLI provisioning whether its target directory
 * (e.g. `~/.local/bin`) is actually reachable, so a symlink there is useful
 * rather than silently inert.
 */

/** Split a `PATH` value into its non-empty directory entries. */
export function pathDirs(pathValue: string | undefined | null): string[] {
  if (!pathValue) return [];
  return pathValue.split(":").filter((d) => d.length > 0);
}

/** True when `dir` is present on the given `PATH` value. */
export function isOnPath(dir: string, pathValue: string | undefined | null): boolean {
  return pathDirs(pathValue).includes(dir);
}

export interface LoginShellPathOptions {
  /** Override the spawn (tests). Receives argv, returns the captured stdout. */
  run?: (argv: string[]) => Promise<string>;
  /** Environment to read `SHELL` from and pass through (tests). */
  env?: NodeJS.ProcessEnv;
}

async function defaultRun(argv: string[]): Promise<string> {
  const proc = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

/**
 * Probe the user's login shell for its effective `PATH`. Runs the shell as a
 * login + interactive shell (`-lic`) so `.zprofile`/`.zshrc` and the macOS
 * `path_helper` both contribute, then prints `$PATH`. Returns the trimmed value
 * or `null` when it cannot be resolved (the caller falls back to the inherited
 * environment).
 */
export async function loginShellPath(
  opts: LoginShellPathOptions = {},
): Promise<string | null> {
  const env = opts.env ?? process.env;
  const run = opts.run ?? defaultRun;
  const shell = env.SHELL && env.SHELL.length > 0 ? env.SHELL : "/bin/zsh";
  try {
    const out = await run([shell, "-lic", 'printf %s "$PATH"']);
    const value = out.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}
