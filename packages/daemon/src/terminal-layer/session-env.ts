/**
 * Session environment + login-shell policy for spawned terminals.
 *
 * A spawned interactive terminal must NOT inherit the daemon's full process
 * environment. The daemon env is a long-lived, frozen snapshot that carries
 * daemon-private bookkeeping (`WOS_HOME`), a stale `PATH`, and variables the
 * user has since removed from their dotfiles — all of which leak into every
 * new pane. Instead the pane runs as a **login shell** (which rebuilds `PATH`
 * and all user/product variables from `.zprofile`/`.zshrc` and the macOS
 * `path_helper` on every terminal), and the daemon passes only the narrow
 * allowlist below: variables that do not live in dotfiles but are needed for
 * ssh/locale/proxy behavior.
 *
 * `PATH` is deliberately absent from the allowlist — the login shell rebuilds
 * it, and a propagated `PATH` would be a stale snapshot anyway.
 *
 * This policy is for the default interactive shell only. An explicit program
 * (e.g. `docker compose exec`) supplies its own complete replacement
 * environment and is spawned as-is, never through this allowlist.
 */

/**
 * Exact variable names carried from the daemon env into a spawned terminal.
 * `LC_*` locale variables and the proxy variables are matched by group in
 * `isAllowedSessionEnv` rather than enumerated here.
 */
export const TERMINAL_SESSION_ENV_ALLOWLIST: readonly string[] = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TERM_PROGRAM",
  "COLORTERM",
  "LANG",
  "LANGUAGE",
  "TZ",
  "SSH_AUTH_SOCK",
  "SSH_CONNECTION",
  "SSH_CLIENT",
  "DISPLAY",
  "XAUTHORITY",
  "TMPDIR",
];

/** Proxy variables (lowercase + uppercase) carried into a spawned terminal. */
const PROXY_ENV_NAMES: readonly string[] = [
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
];

const allowlist = new Set<string>(TERMINAL_SESSION_ENV_ALLOWLIST);
const proxyNames = new Set<string>(PROXY_ENV_NAMES);

/**
 * True when `name` should be carried from the daemon env into a spawned
 * terminal: an exact allowlist entry, any `LC_*` locale variable, or a proxy
 * variable. `PATH` is intentionally excluded — the login shell rebuilds it.
 */
export function isAllowedSessionEnv(name: string): boolean {
  return allowlist.has(name) || name.startsWith("LC_") || proxyNames.has(name);
}

/**
 * Select only the allowlisted variables from a base environment, dropping
 * everything else (daemon-private vars, a stale `PATH`, resurrected vars).
 */
export function selectSessionEnv(
  base: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(base)) {
    if (typeof v === "string" && isAllowedSessionEnv(k)) out[k] = v;
  }
  return out;
}

/**
 * Compose the shell argv for a session, requesting login mode when the manager
 * asked for it. A login shell reads the user's `.zprofile`/`.zshrc` (and on
 * macOS runs `path_helper`), rebuilding `PATH` and user/product variables on
 * every terminal.
 *
 * Login mode is POSIX-only: Windows shells (cmd/PowerShell) have no `-l` login
 * concept, so the args pass through unchanged there. An explicit program
 * (`login` unset/false) also passes through unchanged.
 */
export function loginShellArgs(
  opts: { login?: boolean; args?: string[] },
  isWindows: boolean,
): string[] {
  const base = opts.args ?? [];
  if (opts.login && !isWindows) return ["-l", ...base];
  return base;
}
