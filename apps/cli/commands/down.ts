import {
  defaultGitRunner,
  ensureCurrentWorktree,
  NotInsideWorktreeError,
  type GitRunner,
} from "@worktreeos/core/git";
import { readState, stateFilePath } from "@worktreeos/core/state";
import {
  composeDown,
  defaultDockerRunner,
  type DockerRunner,
} from "@worktreeos/compose/compose";

export interface RunDownOptions {
  gitRunner?: GitRunner;
  composeRunner?: DockerRunner;
}

export async function runDown(
  _args: string[],
  opts: RunDownOptions = {},
): Promise<number> {
  const gitRunner = opts.gitRunner ?? defaultGitRunner;

  let worktreeRoot: string;
  try {
    ({ worktreeRoot } = await ensureCurrentWorktree(gitRunner));
  } catch (e) {
    if (e instanceof NotInsideWorktreeError) {
      process.stderr.write(`${e.message}\n`);
      return 1;
    }
    process.stderr.write(`wos down failed: ${(e as Error).message}\n`);
    return 1;
  }

  try {
    const statePath = stateFilePath(worktreeRoot);
    const state = await readState(statePath);
    if (!state || !state.initialized) {
      process.stdout.write(
        "no wos deployment has been initialized for the current worktree\n",
      );
      return 0;
    }
    const composeRunner = opts.composeRunner ?? defaultDockerRunner;
    await composeDown(
      { projectName: state.projectName, composeFile: state.composeFile },
      { removeOrphans: true },
      composeRunner,
    );
    return 0;
  } catch (e) {
    process.stderr.write(`wos down failed: ${(e as Error).message}\n`);
    return 1;
  }
}
