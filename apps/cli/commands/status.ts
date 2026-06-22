import { loadConfig } from "@worktreeos/core/config";
import {
  effectiveHealthcheckDefaults,
  loadGlobalConfig,
} from "@worktreeos/core/global-config";
import {
  defaultGitRunner,
  ensureCurrentWorktree,
  listWorktrees,
  NotInsideWorktreeError,
  selectSourceWorktree,
  type GitRunner,
} from "@worktreeos/core/git";
import { readState, stateFilePath } from "@worktreeos/core/state";
import { composePs } from "@worktreeos/compose/compose";
import { parseComposePs } from "@worktreeos/compose/ps";
import { formatStatusTable } from "@worktreeos/ui/format";
import { INIT_SERVICE_NAME } from "@worktreeos/compose/generated-compose";
import {
  deployedAppServiceNames,
  runAppPortHealthchecks,
} from "@worktreeos/runtime/healthchecks";

export interface RunStatusOptions {
  gitRunner?: GitRunner;
}

export async function runStatus(
  _args: string[],
  opts: RunStatusOptions = {},
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
    process.stderr.write(`wos status failed: ${(e as Error).message}\n`);
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
    const ctx = { projectName: state.projectName, composeFile: state.composeFile };
    const psOutput = await composePs(ctx);
    const services = parseComposePs(psOutput).filter(
      (s) => s.service !== INIT_SERVICE_NAME,
    );
    const worktrees = await listWorktrees(gitRunner);
    const source = selectSourceWorktree(worktrees);
    const config = await loadConfig(source.path, worktreeRoot);
    const globalConfig = await loadGlobalConfig();
    const healthchecks = await runAppPortHealthchecks({
      config,
      services,
      defaults: effectiveHealthcheckDefaults(globalConfig),
      selectedServices: deployedAppServiceNames(services),
    });
    process.stdout.write(
      formatStatusTable(services, healthchecks, [], {
        hyperlinks: Boolean(process.stdout.isTTY),
      }) + "\n",
    );
    return 0;
  } catch (e) {
    process.stderr.write(`wos status failed: ${(e as Error).message}\n`);
    return 1;
  }
}
