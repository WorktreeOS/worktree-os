import { resolve, sep } from "node:path";
import { wosHome } from "./paths";
import type { ProjectRecord } from "./project-registry";

export const MANAGED_WORKTREES_DIRNAME = "worktrees";

const UNSAFE_SEGMENT_PATTERN = /[^A-Za-z0-9._-]+/g;
const ID_SUFFIX_LENGTH = 8;

/**
 * Resolve the managed-worktrees root directory, i.e.
 * `$WOS_HOME/worktrees`. New managed Git worktrees are placed under
 * `<root>/{project}/{name}`.
 */
export function managedWorktreesRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(wosHome(env), MANAGED_WORKTREES_DIRNAME);
}

/**
 * Derive a stable, path-safe directory segment for a project. The segment is
 * derived from the project's display name with unsafe characters replaced and
 * a stable short suffix taken from the project id. The suffix guarantees that
 * different projects never share the same directory, even when their display
 * names collide or sanitize to the same value.
 */
export function deriveProjectSegment(record: ProjectRecord): string {
  const sanitized = sanitizeSegment(record.displayName);
  const suffix = shortIdSuffix(record.id);
  if (sanitized.length === 0) return `project-${suffix}`;
  return `${sanitized}-${suffix}`;
}

function sanitizeSegment(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) return "";
  const replaced = trimmed.replace(UNSAFE_SEGMENT_PATTERN, "-");
  const collapsed = replaced.replace(/-+/g, "-");
  const stripped = collapsed.replace(/^[-.]+|[-.]+$/g, "");
  if (stripped === "." || stripped === "..") return "";
  return stripped;
}

function shortIdSuffix(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9]/g, "");
  if (cleaned.length === 0) return "000000";
  return cleaned.slice(0, ID_SUFFIX_LENGTH);
}

/**
 * Absolute path of the managed-worktrees project directory for `record`,
 * i.e. `$WOS_HOME/worktrees/{projectSegment}`.
 */
export function managedWorktreesProjectRoot(
  record: ProjectRecord,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(managedWorktreesRoot(env), deriveProjectSegment(record));
}

export interface ManagedWorktreeNameValidationOk {
  ok: true;
  name: string;
}

export interface ManagedWorktreeNameValidationError {
  ok: false;
  message: string;
}

export type ManagedWorktreeNameValidation =
  | ManagedWorktreeNameValidationOk
  | ManagedWorktreeNameValidationError;

/**
 * Validate a managed worktree name as a single safe path segment. Rejects
 * empty names, path separators, dot segments (`.`, `..`), and any character
 * that could resolve outside the project's worktrees directory.
 */
export function validateManagedWorktreeName(
  raw: unknown,
): ManagedWorktreeNameValidation {
  if (typeof raw !== "string") {
    return { ok: false, message: "worktree name must be a string" };
  }
  const name = raw.trim();
  if (name.length === 0) {
    return { ok: false, message: "worktree name must not be empty" };
  }
  if (name === "." || name === "..") {
    return { ok: false, message: "worktree name must not be '.' or '..'" };
  }
  if (name.includes("/") || name.includes("\\") || name.includes(sep)) {
    return {
      ok: false,
      message: "worktree name must not contain path separators",
    };
  }
  if (name.startsWith(".")) {
    return {
      ok: false,
      message: "worktree name must not start with '.'",
    };
  }
  if (UNSAFE_SEGMENT_PATTERN.test(name)) {
    UNSAFE_SEGMENT_PATTERN.lastIndex = 0;
    return {
      ok: false,
      message:
        "worktree name must contain only letters, digits, '.', '_' or '-'",
    };
  }
  UNSAFE_SEGMENT_PATTERN.lastIndex = 0;
  return { ok: true, name };
}

export interface ResolveManagedWorktreePathInput {
  record: ProjectRecord;
  name: string;
  env?: NodeJS.ProcessEnv;
}

export interface ManagedWorktreePathResolution {
  /** Project segment under `$WOS_HOME/worktrees`. */
  projectSegment: string;
  /** `$WOS_HOME/worktrees/{projectSegment}`. */
  projectRoot: string;
  /** Final managed worktree target path. */
  targetPath: string;
}

export class ManagedWorktreePathError extends Error {}

/**
 * Resolve the managed worktree target path. Validates the name and ensures
 * the target stays under the project's managed-worktrees directory.
 */
export function resolveManagedWorktreePath(
  input: ResolveManagedWorktreePathInput,
): ManagedWorktreePathResolution {
  const validation = validateManagedWorktreeName(input.name);
  if (!validation.ok) {
    throw new ManagedWorktreePathError(validation.message);
  }
  const env = input.env ?? process.env;
  const projectSegment = deriveProjectSegment(input.record);
  const projectRoot = resolve(managedWorktreesRoot(env), projectSegment);
  const targetPath = resolve(projectRoot, validation.name);
  const expectedPrefix = projectRoot + sep;
  if (targetPath !== projectRoot && !targetPath.startsWith(expectedPrefix)) {
    throw new ManagedWorktreePathError(
      "resolved worktree path escapes the project worktrees directory",
    );
  }
  if (targetPath === projectRoot) {
    throw new ManagedWorktreePathError(
      "worktree name resolves to the project worktrees directory",
    );
  }
  return { projectSegment, projectRoot, targetPath };
}
