/**
 * `wos init` — the first-run / reconfigure setup wizard.
 *
 * Reachable as bare `wos` and `wos init`. Prompts interactively only when stdin
 * is a TTY and `--yes` was not passed; otherwise it applies defaults + flags
 * without prompting (the path that keeps the config gate from deadlocking CI /
 * Dockerfiles). All branching decisions live in the pure helpers in
 * `init-logic.ts`; this module wires them to readline, `Bun.which`,
 * child-process installs, and the reused core/daemon routines.
 */

import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  buildManagementSnapshot,
  loadGlobalConfig,
  saveGlobalConfig,
  globalConfigPath,
  type GlobalConfigDraft,
} from "@worktreeos/core/global-config";
import { detectTerminalBackendAvailability } from "@worktreeos/daemon/terminal-layer/tmux-backend";
import {
  ensureClaudePluginInstalled,
  getAgentPluginStatus,
  injectOpencodePlugin,
} from "@worktreeos/daemon/agent-plugin-install";
import { runStart } from "./start";
import { runWeb } from "./web";
import {
  OUTSIDE_TMUX_WARNING,
  detectPackageManager,
  isLoopbackHost,
  parseInitArgs,
  resolveBackendDecision,
  selectNextFreePort,
  type BackendDecision,
  type ParsedInitArgs,
} from "./init-logic";

const USAGE = `wos init [options]

Run the wos setup wizard. With no flags on a TTY it prompts; with --yes (or when
stdin is not a TTY) it applies defaults and the provided flags without prompting.

Options:
  --host <addr>            Daemon bind address (default 127.0.0.1)
  --port <port>            Daemon web UI port (default 4949)
  --backend <default|tmux> Terminal backend to configure
  --install-tmux           Attempt to install tmux/psmux via a host package manager
  --yes                    Non-interactive: apply defaults + flags, no prompts
`;

const write = (text: string) => process.stdout.write(text);
const writeErr = (text: string) => process.stderr.write(text);

/** Synchronous port-free probe via a throwaway bind — fits the pure helper's
 * predicate shape. Advisory only; the daemon's own bind stays authoritative. */
function probePortFree(port: number, host: string): boolean {
  try {
    const server = Bun.listen({
      hostname: host,
      port,
      socket: { data() {}, open() {}, close() {}, error() {} },
    });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

/** Verify Docker + Docker Compose v2 are usable before collecting settings. */
async function preflightDocker(): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!Bun.which("docker")) {
    return {
      ok: false,
      message:
        "Docker is required but was not found on PATH.\n" +
        "Install Docker Desktop or Docker Engine: https://docs.docker.com/get-docker/\n",
    };
  }
  const probe = await Bun.$`docker compose version`.quiet().nothrow();
  if (probe.exitCode !== 0) {
    return {
      ok: false,
      message:
        "Docker Compose v2 is required but `docker compose version` failed.\n" +
        "Install the Docker Compose plugin: https://docs.docker.com/compose/install/\n",
    };
  }
  return { ok: true };
}

/** Run a package-manager install command; returns whether it exited cleanly. */
async function runInstallCommand(
  command: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  try {
    const res =
      platform === "win32"
        ? await Bun.$`cmd /c ${command}`.nothrow()
        : await Bun.$`sh -c ${command}`.nothrow();
    return res.exitCode === 0;
  } catch {
    return false;
  }
}

interface Prompter {
  ask(prompt: string, fallback: string): Promise<string>;
  confirm(prompt: string, fallback: boolean): Promise<boolean>;
  close(): void;
}

function createPrompter(): Prompter {
  const rl = readline.createInterface({ input, output });
  return {
    async ask(prompt, fallback) {
      const answer = (await rl.question(`${prompt} [${fallback}]: `)).trim();
      return answer.length > 0 ? answer : fallback;
    },
    async confirm(prompt, fallback) {
      const hint = fallback ? "Y/n" : "y/N";
      const answer = (await rl.question(`${prompt} (${hint}) `)).trim().toLowerCase();
      if (answer.length === 0) return fallback;
      return answer === "y" || answer === "yes";
    },
    close() {
      rl.close();
    },
  };
}

/** Resolve the bind address, warning + confirming on a non-loopback choice. */
async function resolveHost(
  args: ParsedInitArgs,
  defaultHost: string,
  prompter: Prompter | null,
): Promise<string> {
  let host = args.host ?? defaultHost;
  if (prompter && args.host === undefined) {
    host = await prompter.ask("Daemon bind address", defaultHost);
  }
  if (!isLoopbackHost(host)) {
    writeErr(
      `Warning: ${host} is not a loopback address — the daemon control plane ` +
        `(exec / attach) would be reachable from the local network.\n`,
    );
    if (prompter) {
      const confirmed = await prompter.confirm(
        `Bind to ${host} anyway?`,
        false,
      );
      if (!confirmed) {
        host = "127.0.0.1";
        write(`Using loopback ${host} instead.\n`);
      }
    }
  }
  return host;
}

/** Resolve the port, probing for a conflict and offering the next free port. */
async function resolvePort(
  args: ParsedInitArgs,
  defaultPort: number,
  host: string,
  prompter: Prompter | null,
): Promise<number> {
  let port = args.port ?? defaultPort;
  if (prompter && args.port === undefined) {
    const raw = await prompter.ask("Daemon web UI port", String(defaultPort));
    const parsed = Number(raw);
    port = Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : defaultPort;
  }
  if (probePortFree(port, host)) return port;

  const suggested = selectNextFreePort(port, (p) => probePortFree(p, host));
  if (prompter) {
    write(`Port ${port} is already in use.\n`);
    const accept = await prompter.confirm(`Use port ${suggested} instead?`, true);
    return accept ? suggested : port;
  }
  write(`Port ${port} is already in use; using ${suggested} instead.\n`);
  return suggested;
}

/** Resolve the terminal backend (and whether to warn) across both paths. */
async function resolveBackend(
  args: ParsedInitArgs,
  prompter: Prompter | null,
  platform: NodeJS.Platform,
): Promise<BackendDecision> {
  if (args.backend === "default") return { backend: "default", warn: true };

  const availability = detectTerminalBackendAvailability();
  const which = (name: string) => Bun.which(name);

  if (availability.available) {
    if (prompter) {
      const useTmux = await prompter.confirm(
        "tmux/psmux detected. Use the tmux terminal backend?",
        true,
      );
      if (!useTmux) return { backend: "default", warn: true };
    }
    return resolveBackendDecision({
      available: true,
      packageManager: null,
      installAccepted: false,
      installOk: false,
    });
  }

  const pkg = detectPackageManager(platform, which);
  let installAccepted = false;
  let installOk = false;
  if (pkg) {
    const wantInstall = args.installTmux || (prompter !== null);
    let accepted = args.installTmux;
    if (prompter) {
      write(
        `tmux/psmux is not installed. It is strongly recommended for stable ` +
          `terminal sessions.\n`,
      );
      accepted = await prompter.confirm(
        `Install it now with \`${pkg.command}\`?`,
        true,
      );
    }
    if (wantInstall && accepted) {
      installAccepted = true;
      write(`Running: ${pkg.command}\n`);
      const ok = await runInstallCommand(pkg.command, platform);
      // Re-probe so a clean exit that still left no usable binary counts as a
      // failed install rather than a false success.
      installOk = ok && detectTerminalBackendAvailability().available;
      if (!installOk) {
        writeErr("tmux/psmux install did not succeed.\n");
      }
    }
  } else if (prompter) {
    write("No supported package manager found to install tmux/psmux.\n");
  }

  return resolveBackendDecision({
    available: false,
    packageManager: pkg,
    installAccepted,
    installOk,
  });
}

/** Interactive agent-plugin offers (claude / opencode / codex) + auto-inject. */
async function resolveAgentPlugins(
  prompter: Prompter,
  defaultAutoInject: boolean,
): Promise<boolean> {
  const claude = Bun.which("claude");
  const opencode = Bun.which("opencode");
  const codex = Bun.which("codex");

  if (claude && !getAgentPluginStatus("claude").installed) {
    const ok = await prompter.confirm(
      "Claude Code detected without the wos plugin. Install it?",
      true,
    );
    if (ok) {
      try {
        const res = await ensureClaudePluginInstalled();
        write(
          res.ok
            ? "Installed the wos Claude Code plugin.\n"
            : `Plugin install failed: ${res.message}\n`,
        );
      } catch (e) {
        writeErr(`Claude plugin install failed: ${(e as Error).message}\n`);
      }
    }
  }

  if (opencode && !getAgentPluginStatus("opencode").installed) {
    const ok = await prompter.confirm(
      "OpenCode detected without the wos plugin. Install it?",
      true,
    );
    if (ok) {
      try {
        injectOpencodePlugin();
        write("Installed the wos OpenCode plugin.\n");
      } catch (e) {
        writeErr(`OpenCode plugin install failed: ${(e as Error).message}\n`);
      }
    }
  }

  if (codex) {
    write("Codex detected — no wos codex integration plugin is available yet.\n");
  }

  return prompter.confirm(
    "Auto-inject agent plugins for new agents?",
    defaultAutoInject,
  );
}

export async function runInit(argv: string[]): Promise<number> {
  const args = parseInitArgs(argv);
  if ("error" in args) {
    writeErr(`wos init: ${args.error}\n${USAGE}`);
    return 2;
  }

  const interactive = Boolean(process.stdin.isTTY) && !args.yes;
  const platform = process.platform;

  const preflight = await preflightDocker();
  if (!preflight.ok) {
    writeErr(preflight.message);
    return 1;
  }

  const existing = await loadGlobalConfig();
  const reconfigure = await Bun.file(globalConfigPath()).exists();
  if (interactive) {
    write(
      reconfigure
        ? "Reconfiguring wos. Press Enter to keep each current value.\n\n"
        : "Welcome to wos. Let's set things up.\n\n",
    );
  }

  const prompter = interactive ? createPrompter() : null;
  let decision: BackendDecision;
  let host: string;
  let port: number;
  let autoInject = existing.autoInjectAgentPlugins;
  try {
    host = await resolveHost(args, existing.web.host, prompter);
    port = await resolvePort(args, existing.web.port, host, prompter);
    decision = await resolveBackend(args, prompter, platform);
    if (decision.warn) write(`${OUTSIDE_TMUX_WARNING}\n`);
    if (prompter) {
      autoInject = await resolveAgentPlugins(prompter, existing.autoInjectAgentPlugins);
    }
  } finally {
    prompter?.close();
  }

  // Persist through the validating save routine. Merge onto the existing raw
  // draft so a reconfigure never clobbers settings the wizard does not manage
  // (tunnel, SSL, AI providers, …).
  const snapshot = await buildManagementSnapshot();
  const base: GlobalConfigDraft = snapshot.raw ?? {};
  const request: GlobalConfigDraft = {
    ...base,
    web: { ...(base.web ?? {}), host, port },
    terminalBackend: decision.backend,
    autoInjectAgentPlugins: autoInject,
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

  if (interactive) {
    const startNow = await confirmStandalone("Start the wos daemon now?", true);
    if (startNow) {
      const code = await runStart([]);
      if (code === 0) {
        const open = await confirmStandalone("Open the web UI in your browser?", true);
        if (open) await runWeb([]);
      }
    }
  }

  return 0;
}

/** A one-off confirm used after the main prompter is closed (daemon/web offers). */
async function confirmStandalone(prompt: string, fallback: boolean): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  try {
    const hint = fallback ? "Y/n" : "y/N";
    const answer = (await rl.question(`${prompt} (${hint}) `)).trim().toLowerCase();
    if (answer.length === 0) return fallback;
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
