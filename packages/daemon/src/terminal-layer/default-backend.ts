/**
 * Default terminal backend.
 *
 * Wraps the daemon-owned PTY runtime (typically `bunTerminalRuntime`) so the
 * existing Bun terminal behavior is preserved: each session owns a fresh PTY
 * process, daemon shutdown and explicit terminate both kill the process tree,
 * and no sessions are restored after daemon restart.
 */

import type {
  TerminalBackendAdapter,
  TerminalBackendCreateOptions,
  TerminalBackendCreateResult,
  TerminalBackendSession,
  TerminalBackendTransport,
} from "./backend";
import {
  TerminalRuntimeUnavailableError,
  type TerminalRuntime,
} from "./runtime";
import { loginShellArgs } from "./session-env";

export interface DefaultTerminalBackendOptions {
  runtime: TerminalRuntime;
}

export function createDefaultTerminalBackend(
  opts: DefaultTerminalBackendOptions,
): TerminalBackendAdapter {
  const runtime = opts.runtime;
  return {
    id: "default",
    label: "Default",
    isAvailable() {
      const available = runtime.isAvailable();
      return available
        ? { available: true }
        : {
            available: false,
            reason: `terminal runtime ${runtime.name} is not available on this host`,
          };
    },
    async createSession(
      createOpts: TerminalBackendCreateOptions,
    ): Promise<TerminalBackendCreateResult> {
      if (!runtime.isAvailable()) {
        throw new TerminalRuntimeUnavailableError(
          `terminal runtime ${runtime.name} is not available`,
        );
      }
      // `createOpts.env` is already the manager-composed env (session allowlist
      // + agent bindings for the default shell, or the explicit program's own
      // env). Launch the default interactive shell in login mode (POSIX `-l`)
      // so dotfiles rebuild PATH; an explicit program passes through unchanged.
      const args = loginShellArgs(createOpts, process.platform === "win32");
      const transport: TerminalBackendTransport = runtime.spawn({
        shell: createOpts.shell,
        ...(args.length > 0 ? { args } : {}),
        cwd: createOpts.cwd,
        env: createOpts.env,
        cols: createOpts.cols,
        rows: createOpts.rows,
      });
      const session: TerminalBackendSession = {
        id: createOpts.id,
        backend: "default",
        worktreePath: createOpts.worktreePath,
        cwd: createOpts.cwd,
        shell: createOpts.shell,
        cols: createOpts.cols,
        rows: createOpts.rows,
        createdAt: createOpts.createdAt,
      };
      return { session, transport };
    },
    async captureScreenSnapshot() {
      // The default PTY backend keeps no addressable screen grid (output is a
      // raw byte stream owned by the browser emulator), so there is nothing to
      // flatten into rows. Report no snapshot; Mission Control renders a
      // metadata-only fallback pane and offers focus-to-attach instead.
      return {
        available: false as const,
        reason: "default terminal backend keeps no screen grid",
      };
    },
    async onDaemonShutdown(
      _session: TerminalBackendSession,
      transport: TerminalBackendTransport | null,
    ): Promise<void> {
      if (!transport) return;
      try {
        transport.kill();
      } catch {
        /* swallow — daemon shutdown is best-effort */
      }
    },
    async terminateSession(
      _session: TerminalBackendSession,
      transport: TerminalBackendTransport | null,
      signal?: string,
    ): Promise<void> {
      if (!transport) return;
      try {
        transport.kill(signal);
      } catch {
        /* swallow — exit listener reconciles */
      }
    },
  };
}
