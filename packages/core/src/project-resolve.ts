import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import {
  defaultWorktreeGitRunner,
  GitError,
  parseWorktreeList,
  selectSourceWorktree,
  type WorktreeEntry,
  type WorktreeGitRunner,
} from "./git";

export class ProjectResolveError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "missing"
      | "not-directory"
      | "not-a-worktree"
      | "git-error",
  ) {
    super(message);
  }
}

export interface ResolvedProjectPath {
  /** The submitted path, normalized. */
  inputPath: string;
  /** Selected primary/source worktree absolute path. */
  sourcePath: string;
  /** Resolved primary worktree entry (with branch/HEAD when available). */
  source: WorktreeEntry;
  /** All worktrees reported by git for this repository. */
  worktrees: WorktreeEntry[];
}

export interface ResolveProjectPathOptions {
  gitRunner?: WorktreeGitRunner;
}

/**
 * Validate that `inputPath` is an existing Git worktree and resolve the
 * repository's primary/source worktree path. Throws `ProjectResolveError`
 * with an actionable message when validation fails.
 */
function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export async function resolveProjectPath(
  inputPath: string,
  opts: ResolveProjectPathOptions = {},
): Promise<ResolvedProjectPath> {
  const normalized = realpathOrSelf(resolve(inputPath));
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(normalized);
  } catch {
    throw new ProjectResolveError(
      `path not found: ${normalized}`,
      "missing",
    );
  }
  if (!stats.isDirectory()) {
    throw new ProjectResolveError(
      `path is not a directory: ${normalized}`,
      "not-directory",
    );
  }
  const run = opts.gitRunner ?? defaultWorktreeGitRunner;
  let output: string;
  try {
    output = await run(normalized, ["worktree", "list", "--porcelain"]);
  } catch (e) {
    if (e instanceof GitError) {
      const msg = e.message.toLowerCase();
      if (
        msg.includes("not a git repository") ||
        msg.includes("not inside a work tree") ||
        msg.includes("not inside a working tree")
      ) {
        throw new ProjectResolveError(
          `path is not a git worktree: ${normalized}`,
          "not-a-worktree",
        );
      }
      throw new ProjectResolveError(
        `git could not read the worktree: ${e.message}`,
        "git-error",
      );
    }
    throw e;
  }
  const worktrees = parseWorktreeList(output);
  if (worktrees.length === 0) {
    throw new ProjectResolveError(
      `git returned no worktrees for ${normalized}`,
      "not-a-worktree",
    );
  }
  const source = selectSourceWorktree(worktrees);
  return {
    inputPath: normalized,
    sourcePath: realpathOrSelf(resolve(source.path)),
    source,
    worktrees,
  };
}
