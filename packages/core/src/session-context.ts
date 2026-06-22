import { loadConfig, type WosConfig } from "./config";
import {
  defaultGitRunner,
  ensureCurrentWorktree,
  gitRunnerInCwd,
  listWorktrees,
  selectSourceWorktree,
  type GitRunner,
  type WorktreeEntry,
} from "./git";
import { computeProjectName } from "./project-name";
import {
  sessionNameForWorktree,
  sessionRootForWorktree,
} from "./paths";
import {
  readState,
  stateFilePath,
  type WosState,
} from "./state";

export interface SessionContext {
  worktreeRoot: string;
  source: WorktreeEntry;
  config: WosConfig;
  projectName: string;
  sessionName: string;
  sessionRoot: string;
  /** Current persisted state (may be null when the session has not been initialized yet). */
  state: WosState | null;
}

export interface ResolveSessionOptions {
  /** Working directory used as a starting point. Defaults to process.cwd(). */
  cwd?: string;
  /** Git runner to use; defaults to the real `git` binary. */
  gitRunner?: GitRunner;
}

/**
 * Resolve a wos worktree session for the caller's directory.
 *
 * This DOES NOT select a renderer or perform any Docker / state-write work;
 * it gathers the read-only context the daemon and direct callers need to act
 * on the current worktree.
 */
export async function resolveSessionContext(
  opts: ResolveSessionOptions = {},
): Promise<SessionContext> {
  const cwd = opts.cwd;
  // Resolve git in the caller's directory by passing `cwd` straight to the git
  // runner instead of mutating the process-wide `process.cwd()`. The daemon is
  // long-lived and serves many worktrees concurrently; a global `process.chdir`
  // both races between requests and breaks when the worktree it left the cwd in
  // is removed (a later `chdir` fails with ENOENT because the old cwd is gone).
  const gitRunner =
    opts.gitRunner ?? (cwd ? gitRunnerInCwd(cwd) : defaultGitRunner);
  const { worktreeRoot } = await ensureCurrentWorktree(gitRunner);
  const worktrees = await listWorktrees(gitRunner);
  const source = selectSourceWorktree(worktrees);
  const config = await loadConfig(source.path, worktreeRoot);
  const projectName = computeProjectName(worktreeRoot, source.path);
  const sessionName = sessionNameForWorktree(worktreeRoot);
  const sessionRoot = sessionRootForWorktree(worktreeRoot);
  const state = await readState(stateFilePath(worktreeRoot));
  return {
    worktreeRoot,
    source,
    config,
    projectName,
    sessionName,
    sessionRoot,
    state,
  };
}

