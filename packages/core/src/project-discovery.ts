import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { wosHome, SESSIONS_DIRNAME, SESSION_STATE_FILENAME } from "./paths";
import { readState } from "./state";
import {
  loadProjects,
  registerProjectBySourcePath,
  type ProjectRecord,
} from "./project-registry";
import {
  defaultWorktreeGitRunner,
  parseWorktreeList,
  selectSourceWorktree,
  type WorktreeGitRunner,
} from "./git";

export interface DiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  /** Override sessions directory (tests). */
  sessionsDir?: string;
  /** Override projects.json path (tests). */
  projectsFilePath?: string;
  /** Override git runner (tests). */
  gitRunner?: WorktreeGitRunner;
  /** Override clock (tests). */
  now?: () => Date;
  /** Override id generator (tests). */
  newId?: () => string;
}

export interface DiscoveryResult {
  registered: ProjectRecord[];
  skipped: number;
}

/**
 * Scan `<wos-home>/sessions/*` for known deployments and register any
 * resolvable primary/source worktrees that are not yet present in the project
 * registry. Best-effort: missing/unreadable state files are skipped silently.
 *
 * Source path resolution order:
 *  1. `state.sourcePath` if present (written by recent `up` flows).
 *  2. `state.worktreeRoot` if present — re-run `git -C worktreeRoot worktree list`
 *     and pick the source entry.
 */
export async function discoverProjectsFromSessions(
  opts: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const env = opts.env ?? process.env;
  const sessionsDir = opts.sessionsDir ?? resolve(wosHome(env), SESSIONS_DIRNAME);
  const gitRunner = opts.gitRunner ?? defaultWorktreeGitRunner;

  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return { registered: [], skipped: 0 };
  }

  const existing = await loadProjects({
    env,
    filePath: opts.projectsFilePath,
  });
  const known = new Set(existing.map((p) => p.sourcePath));

  const registered: ProjectRecord[] = [];
  let skipped = 0;

  for (const name of entries) {
    const sessionRoot = resolve(sessionsDir, name);
    let s: Awaited<ReturnType<typeof stat>>;
    try {
      s = await stat(sessionRoot);
    } catch {
      skipped += 1;
      continue;
    }
    if (!s.isDirectory()) {
      skipped += 1;
      continue;
    }
    const statePath = resolve(sessionRoot, SESSION_STATE_FILENAME);
    let state;
    try {
      state = await readState(statePath);
    } catch {
      state = null;
    }
    if (!state || !state.initialized) {
      skipped += 1;
      continue;
    }
    const sourcePath = await resolveSourcePathFromState(state, gitRunner);
    if (!sourcePath) {
      skipped += 1;
      continue;
    }
    const normalized = resolve(sourcePath);
    if (known.has(normalized)) {
      skipped += 1;
      continue;
    }
    try {
      const result = await registerProjectBySourcePath(normalized, {
        env,
        filePath: opts.projectsFilePath,
        now: opts.now,
        newId: opts.newId,
      });
      if (result.created) registered.push(result.project);
      known.add(result.project.sourcePath);
    } catch {
      skipped += 1;
    }
  }

  return { registered, skipped };
}

/**
 * Resolve the repository primary/source worktree path for a persisted session
 * state. Tries the recorded `sourcePath` first (written by `up` flows since the
 * field was added), then falls back to listing worktrees from
 * `state.worktreeRoot` and selecting the source entry. Returns `null` when
 * neither path is available or git cannot enumerate the worktrees.
 */
export async function resolveSourcePathFromState(
  state: { sourcePath?: string; worktreeRoot?: string },
  gitRunner: WorktreeGitRunner,
): Promise<string | null> {
  if (state.sourcePath && state.sourcePath.length > 0) return state.sourcePath;
  if (!state.worktreeRoot) return null;
  try {
    const out = await gitRunner(state.worktreeRoot, [
      "worktree",
      "list",
      "--porcelain",
    ]);
    const entries = parseWorktreeList(out);
    if (entries.length === 0) return null;
    return selectSourceWorktree(entries).path;
  } catch {
    return null;
  }
}
