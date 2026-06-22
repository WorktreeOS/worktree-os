/**
 * Backend → stability-warning decision for the web terminal surface.
 *
 * Mirrors the CLI's `OUTSIDE_TMUX_WARNING` literal (defined in
 * `apps/cli/commands/init-logic.ts`); the two are kept byte-identical and
 * guarded by tests on both sides so the copy can never drift. The frontend
 * cannot import across the app/bundle boundary, so the constant is duplicated
 * here the same way other `apps/web/src/lib` modules mirror `@worktreeos/core`.
 */

import type { SettingsTerminalBackend } from "@/lib/ui-api";

/** Single source of the warning copy for the web surface. */
export const OUTSIDE_TMUX_WARNING =
  "Running outside tmux/psmux — terminal sessions may be unstable.";

/**
 * The stability warning to show for the active terminal backend, or `null` when
 * none applies. The `default` backend warns; `tmux` is silent.
 */
export function terminalBackendWarning(
  backend: SettingsTerminalBackend | undefined,
): string | null {
  return backend === "default" ? OUTSIDE_TMUX_WARNING : null;
}
