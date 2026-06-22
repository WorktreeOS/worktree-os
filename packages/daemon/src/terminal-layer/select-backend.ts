/**
 * Select a terminal backend adapter based on the effective global config.
 *
 * The selector is async because the tmux backend's bootstrap may need to
 * inspect filesystem state (wos-home, persisted metadata) before the
 * adapter is usable. The default backend is synchronous internally but the
 * call returns a Promise so callers always await this single entry point.
 */

import type { TerminalBackendId } from "@worktreeos/core/global-config";
import type { TerminalBackendAdapter } from "./backend";
import { createDefaultTerminalBackend } from "./default-backend";
import type { TerminalRuntime } from "./runtime";
import { createTmuxTerminalBackend } from "./tmux-backend";

export interface SelectTerminalBackendOptions {
  backendId: TerminalBackendId;
  runtime: TerminalRuntime;
  /** Override the wos-home root for tmux metadata (tests). */
  wosHome?: string;
  /** Optional environment override (tests). */
  env?: NodeJS.ProcessEnv;
}

export async function selectTerminalBackend(
  opts: SelectTerminalBackendOptions,
): Promise<TerminalBackendAdapter> {
  if (opts.backendId === "tmux") {
    return createTmuxTerminalBackend({
      runtime: opts.runtime,
      ...(opts.wosHome ? { wosHome: opts.wosHome } : {}),
      ...(opts.env ? { env: opts.env } : {}),
    });
  }
  return createDefaultTerminalBackend({ runtime: opts.runtime });
}
