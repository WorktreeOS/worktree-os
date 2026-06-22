import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

export const DEFAULT_WOS_HOME_DIRNAME = ".wos";
export const SESSIONS_DIRNAME = "sessions";
export const CACHE_DIRNAME = "cache";
export const SESSION_COMPOSE_FILENAME = "compose.yaml";
export const SESSION_COMPOSE_BASE_FILENAME = "compose-base.yaml";
export const SESSION_COMPOSE_OVERLAY_FILENAME = "compose-overlay.yaml";
export const SESSION_STATE_FILENAME = "state.json";
export const SESSION_UP_FAILURE_FILENAME = "last-up-failure.json";
export const SESSION_SHELL_DIRNAME = "shell";
export const SESSION_SHELL_LOGS_DIRNAME = "logs";

export function wosHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.WOS_HOME;
  if (raw && raw.length > 0) {
    return expandHome(raw);
  }
  return resolve(homedir(), DEFAULT_WOS_HOME_DIRNAME);
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

export function wosCacheRoot(): string {
  return resolve(wosHome(), CACHE_DIRNAME);
}

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const SAFE_SESSION_NAME = /^[A-Za-z0-9._-]+$/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/**
 * Normalize a Windows drive-letter path for stable naming/hashing: forward
 * slashes, uppercase drive letter, no trailing separator.
 */
function normalizeWindowsPath(p: string): string {
  const slashed = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return slashed.charAt(0).toUpperCase() + slashed.slice(1);
}

function normalizeWorktreePath(worktreeRoot: string): string {
  if (WINDOWS_DRIVE_PATH.test(worktreeRoot)) {
    return normalizeWindowsPath(worktreeRoot);
  }
  return resolve(worktreeRoot);
}

/** The pre-Windows naming algorithm: join path segments with dashes. */
function legacySessionName(worktreeRoot: string): string {
  if (WINDOWS_DRIVE_PATH.test(worktreeRoot)) {
    return normalizeWindowsPath(worktreeRoot).split("/").join("-");
  }
  const abs = resolve(worktreeRoot);
  const stripped = abs.startsWith(sep) ? abs.slice(sep.length) : abs;
  return stripped.split(sep).join("-");
}

/** Safe as a directory name on Windows and POSIX filesystems. */
function isFilesystemSafeSessionName(name: string): boolean {
  return (
    name.length > 0 &&
    SAFE_SESSION_NAME.test(name) &&
    !name.endsWith(".") &&
    !WINDOWS_RESERVED_NAME.test(name)
  );
}

function hashedSessionName(worktreeRoot: string, legacy: string): string {
  const hash = createHash("sha256")
    .update(normalizeWorktreePath(worktreeRoot))
    .digest("hex")
    .slice(0, 10);
  const slug = legacy
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+/, "")
    .slice(0, 48)
    .replace(/[-.]+$/, "");
  return slug.length > 0 ? `${slug}--${hash}` : `worktree--${hash}`;
}

/**
 * Session name for a worktree. The legacy dash-joined name is kept whenever it
 * is filesystem-safe (existing POSIX state stays readable). Unsafe names
 * (Windows drive letters, reserved characters, trailing dots/spaces) fall back
 * to a sanitized `slug--hash` form — unless a legacy session directory already
 * exists, which keeps pre-existing state attached to its session.
 */
export function sessionNameForWorktree(worktreeRoot: string): string {
  const legacy = legacySessionName(worktreeRoot);
  if (isFilesystemSafeSessionName(legacy)) return legacy;
  if (existsSync(resolve(wosHome(), SESSIONS_DIRNAME, legacy))) return legacy;
  return hashedSessionName(worktreeRoot, legacy);
}

export function sessionRootForWorktree(worktreeRoot: string): string {
  return resolve(
    wosHome(),
    SESSIONS_DIRNAME,
    sessionNameForWorktree(worktreeRoot),
  );
}

export function sessionComposePath(worktreeRoot: string): string {
  return resolve(sessionRootForWorktree(worktreeRoot), SESSION_COMPOSE_FILENAME);
}

export function sessionComposeBasePath(worktreeRoot: string): string {
  return resolve(
    sessionRootForWorktree(worktreeRoot),
    SESSION_COMPOSE_BASE_FILENAME,
  );
}

export function sessionComposeOverlayPath(worktreeRoot: string): string {
  return resolve(
    sessionRootForWorktree(worktreeRoot),
    SESSION_COMPOSE_OVERLAY_FILENAME,
  );
}

export function sessionStatePath(worktreeRoot: string): string {
  return resolve(sessionRootForWorktree(worktreeRoot), SESSION_STATE_FILENAME);
}

export function sessionUpFailurePath(worktreeRoot: string): string {
  return resolve(
    sessionRootForWorktree(worktreeRoot),
    SESSION_UP_FAILURE_FILENAME,
  );
}

/** Root directory for shell-backend runtime artifacts (logs) of a session. */
export function sessionShellRoot(worktreeRoot: string): string {
  return resolve(sessionRootForWorktree(worktreeRoot), SESSION_SHELL_DIRNAME);
}

/** Directory holding per-service shell stdout/stderr log files for a session. */
export function sessionShellLogDir(worktreeRoot: string): string {
  return resolve(sessionShellRoot(worktreeRoot), SESSION_SHELL_LOGS_DIRNAME);
}

/**
 * Absolute path of the persisted shell log file for a service stream. Service
 * names are sanitized to a filesystem-safe form; wos persists the resolved
 * paths in session state so readers do not recompute the sanitization.
 */
export function sessionShellServiceLogPath(
  worktreeRoot: string,
  service: string,
  stream: "stdout" | "stderr",
): string {
  const safe = service.replace(/[^A-Za-z0-9._-]/g, "_");
  return resolve(sessionShellLogDir(worktreeRoot), `${safe}.${stream}.log`);
}
