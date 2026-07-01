/**
 * `wos init` — non-interactive setup for CI / Docker / automation.
 *
 * Reachable only as the explicit `wos init` command (bare `wos` now starts the
 * daemon). It NEVER prompts: it applies built-in defaults plus any provided
 * flags and persists `<wos-home>/config.json`, whether or not stdin is a TTY.
 * First-run onboarding for humans lives in the web UI; this command is the
 * scriptable escape hatch. All branching decisions live in the pure helpers in
 * `init-logic.ts` and the shared `@worktreeos/daemon/setup-environment` module;
 * this module wires them to `Bun.which`, child-process installs, and the reused
 * core/daemon routines.
 */

import {
  buildManagementSnapshot,
  loadGlobalConfig,
  saveGlobalConfig,
  globalConfigPath,
  type GlobalConfigDraft,
} from "@worktreeos/core/global-config";
import { detectTerminalBackendAvailability } from "@worktreeos/daemon/terminal-layer/tmux-backend";
import {
  OUTSIDE_TMUX_WARNING,
  detectPackageManager,
  runInstallCommand,
} from "@worktreeos/daemon/setup-environment";
import {
  ensureClaudePluginInstalled,
  getAgentPluginStatus,
  injectOpencodePlugin,
} from "@worktreeos/daemon/agent-plugin-install";
import { ensurePersistentCli } from "@worktreeos/daemon/launch-mode";
import {
  isLoopbackHost,
  parseInitArgs,
  resolveBackendDecision,
  type BackendDecision,
  type ParsedInitArgs,
} from "./init-logic";

const USAGE = `wos init [options]

Non-interactive setup. Applies defaults + the provided flags and writes the
global config without prompting (safe for CI and Dockerfiles). Human first-run
onboarding happens in the web UI — run 'wos' to start the daemon and open it.

Options:
  --host <addr>            Daemon bind address (default 127.0.0.1)
  --port <port>            Daemon web UI port (default 4949)
  --backend <default|tmux> Terminal backend to configure
  --install-tmux           Attempt to install tmux/psmux via a host package manager
  --install-plugins        Install wos agent plugins for detected agents
  --yes                    Accepted for backward compatibility (no-op)
`;

const write = (text: string) => process.stdout.write(text);
const writeErr = (text: string) => process.stderr.write(text);

/**
 * Resolve the terminal backend (and whether to warn) from flags + the host
 * probe. `--backend default` forces the default backend; otherwise tmux is
 * used when already available, or installed via `--install-tmux` when a package
 * manager is present and the install succeeds.
 */
async function resolveBackend(
  args: ParsedInitArgs,
  platform: NodeJS.Platform,
): Promise<BackendDecision> {
  if (args.backend === "default") return { backend: "default", warn: true };

  const availability = detectTerminalBackendAvailability();
  if (availability.available) {
    return resolveBackendDecision({
      available: true,
      packageManager: null,
      installAccepted: false,
      installOk: false,
    });
  }

  const pkg = detectPackageManager(platform, (name) => Bun.which(name));
  let installAccepted = false;
  let installOk = false;
  if (pkg && args.installTmux) {
    installAccepted = true;
    write(`Running: ${pkg.command}\n`);
    const ok = await runInstallCommand(pkg.command, platform);
    // Re-probe so a clean exit that still left no usable binary counts as a
    // failed install rather than a false success.
    installOk = ok && detectTerminalBackendAvailability().available;
    if (!installOk) writeErr("tmux/psmux install did not succeed.\n");
  } else if (!pkg && args.installTmux) {
    writeErr("No supported package manager found to install tmux/psmux.\n");
  }

  return resolveBackendDecision({
    available: false,
    packageManager: pkg,
    installAccepted,
    installOk,
  });
}

/**
 * Non-interactive agent-plugin install (the `--install-plugins` path). For each
 * detected agent missing its wos plugin, install it without prompting. Codex is
 * intentionally skipped (no wos codex integration plugin yet). Best-effort: one
 * agent's failure must not abort init.
 */
async function installAgentPluginsNonInteractive(): Promise<void> {
  if (Bun.which("claude") && !getAgentPluginStatus("claude").installed) {
    try {
      const res = await ensureClaudePluginInstalled();
      write(
        res.ok
          ? "Installed the wos Claude Code plugin.\n"
          : `Claude plugin install failed: ${res.message}\n`,
      );
    } catch (e) {
      writeErr(`Claude plugin install failed: ${(e as Error).message}\n`);
    }
  }

  if (Bun.which("opencode") && !getAgentPluginStatus("opencode").installed) {
    try {
      injectOpencodePlugin();
      write("Installed the wos OpenCode plugin.\n");
    } catch (e) {
      writeErr(`OpenCode plugin install failed: ${(e as Error).message}\n`);
    }
  }
}

export async function runInit(argv: string[]): Promise<number> {
  const args = parseInitArgs(argv);
  if ("error" in args) {
    writeErr(`wos init: ${args.error}\n${USAGE}`);
    return 2;
  }

  const platform = process.platform;

  // When launched ephemerally (`bunx @worktreeos/cli`), establish a persistent
  // `wos` on the login PATH before wiring agent plugins, so the static
  // `wos agent-hook` hook command resolves in future shells. No-op for the
  // compiled binary, a global install, or a source checkout. Best-effort.
  await ensurePersistentCli({ log: write });

  const existing = await loadGlobalConfig();
  const host = args.host ?? existing.web.host;
  const port = args.port ?? existing.web.port;
  if (!isLoopbackHost(host)) {
    writeErr(
      `Warning: ${host} is not a loopback address — the daemon control plane ` +
        `(exec / attach) would be reachable from the local network.\n`,
    );
  }

  const decision = await resolveBackend(args, platform);
  if (decision.warn) write(`${OUTSIDE_TMUX_WARNING}\n`);

  // Persist through the validating save routine. Merge onto the existing raw
  // draft so a reconfigure never clobbers settings this command does not manage
  // (tunnel, SSL, AI providers, …).
  const snapshot = await buildManagementSnapshot();
  const base: GlobalConfigDraft = snapshot.raw ?? {};
  const request: GlobalConfigDraft = {
    ...base,
    web: { ...(base.web ?? {}), host, port },
    terminalBackend: decision.backend,
  };
  const saved = await saveGlobalConfig(request);
  if (!saved.ok) {
    writeErr("wos init: could not save configuration:\n");
    for (const err of saved.errors) {
      writeErr(`  ${err.field || "(root)"}: ${err.message}\n`);
    }
    return 1;
  }
  write(`Saved configuration to ${globalConfigPath()}\n`);

  if (args.installPlugins) {
    await installAgentPluginsNonInteractive();
  }

  return 0;
}
