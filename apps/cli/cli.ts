import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { globalConfigPath } from "@worktreeos/core/global-config";
import {
  runDownViaDaemon,
  runStatusViaDaemon,
  runUpViaDaemon,
  runWorktreeRemoveViaDaemon,
} from "./commands/daemon-mode";
import { runStart, runStop, runRestart } from "./commands/start";
import { runWaitViaDaemon } from "./commands/wait";
import { runWeb } from "./commands/web";
import { runExec } from "./commands/exec";
import { runInit } from "./commands/init";
import { requiresConfig } from "./commands/init-logic";

const USAGE = `wos [--cwd <path>] <command>

Global options:
  --cwd <path>      Use <path> as the directory for resolving the current
                    Git worktree (instead of process.cwd()). Applies only
                    to worktree-scoped commands.

Commands:
  init               Run the setup wizard (also launched by bare 'wos'): bind
                     address, port, terminal backend, and agent-plugin setup.
                     Use 'wos init --yes [--host <h>] [--port <p>] [--backend
                     <default|tmux>] [--install-tmux]' for non-interactive setup.
  up [services] [--target <name>] [--force]
                     Deploy the current worktree via Docker Compose.
                       Without -d: foreground text mode — the CLI streams
                       deployment steps to stderr, prints a service table
                       and the worktree web UI URL on success, and then
                       exits. The web UI is the place to watch logs and
                       service status.
                       Selective startup (generated-compose mode):
                       'wos up app,api' — start only app and api plus
                       their transitive dependencies;
                       'wos up --target app' — start a target from
                       the deploy config. Without arguments starts all services.
  up -d [--force]    Daemon-detached startup: the CLI submits up to the
                       daemon and exits immediately after the operation is
                       accepted, printing the worktree web UI URL.
                       Watch further progress, logs, and result in the web UI.
  down               Stop and remove wos containers for the current worktree
  status             Show the deployment state for the current worktree
  exec <service> [--] <command...>
                     Run a command inside a running Docker-backed service for
                     the current worktree (like 'docker compose exec'). Use
                     '--' to separate a command that starts with a flag, e.g.
                     'wos exec api -- bun test'. Not supported in shell mode.
  wait [--timeout <duration>]
                     Wait for the current worktree deployment to become ready.
                     Default timeout is 1m. duration accepts milliseconds
                     and ms/s/m suffixes.
  web [--no-open]    Open the daemon web UI in the browser (default http://127.0.0.1:4949, or https:// when web.ssl is enabled).
                       --no-open prints the URL without opening a browser.
  worktree remove [--force]
                     Remove the current secondary Git worktree via the daemon.
                     Cleans up deployed wos resources, removes persistent
                     session artifacts, and invokes 'git worktree remove'.
                     --force allows removal of a worktree with dirty or
                     unmerged state (passed through to
                     'git worktree remove --force').
                     The source/primary worktree cannot be removed.
  start              Start the local daemon (or report it is already running)
  start --foreground Run the local daemon attached to the current terminal
  stop               Stop the local daemon (does not stop deployed services)
  restart            Restart the local daemon
  help               Show this message
`;

export interface GlobalOptions {
  /** Absolute path passed via `--cwd <path>`. */
  cwd?: string;
}

export interface ParsedArgs {
  global: GlobalOptions;
  command?: string;
  rest: string[];
}

export interface ParseGlobalArgsError {
  error: string;
}

/**
 * Parses global options (`--cwd <path>`) that precede the command name.
 * Returns either the parsed options with remaining args or a parse error
 * (for example, a missing value for `--cwd`).
 */
export function parseGlobalArgs(
  argv: string[],
): ParsedArgs | ParseGlobalArgsError {
  const global: GlobalOptions = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === "--cwd") {
      const value = argv[i + 1];
      if (
        value === undefined ||
        value.startsWith("-") ||
        isKnownCommand(value)
      ) {
        return { error: "--cwd requires a path argument" };
      }
      global.cwd = resolve(value);
      i += 2;
      continue;
    }
    if (arg.startsWith("--cwd=")) {
      const value = arg.slice("--cwd=".length);
      if (value.length === 0) {
        return { error: "--cwd requires a path argument" };
      }
      global.cwd = resolve(value);
      i += 1;
      continue;
    }
    // First non-global token is the command.
    return { global, command: arg, rest: argv.slice(i + 1) };
  }
  return { global, rest: [] };
}

const KNOWN_COMMANDS = new Set([
  "init",
  "up",
  "down",
  "status",
  "exec",
  "wait",
  "web",
  "worktree",
  "start",
  "stop",
  "restart",
  "help",
  "--help",
  "-h",
]);

function isKnownCommand(token: string): boolean {
  return KNOWN_COMMANDS.has(token);
}

/**
 * Injectable seams for `main` so the config gate and wizard routing can be
 * tested without touching the filesystem or running the real wizard. Both
 * default to production behaviour.
 */
export interface MainDeps {
  /** Whether the global config file exists (gate input). */
  hasGlobalConfig?: () => boolean;
  /** Setup-wizard entrypoint invoked by bare `wos` and `wos init`. */
  runInit?: (argv: string[]) => Promise<number>;
}

export async function main(
  argv: string[],
  deps: MainDeps = {},
): Promise<number> {
  const hasGlobalConfig =
    deps.hasGlobalConfig ?? (() => existsSync(globalConfigPath()));
  const runInitFn = deps.runInit ?? runInit;

  const parsed = parseGlobalArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`wos: ${parsed.error}\n${USAGE}`);
    return 2;
  }
  const { global, command, rest = [] } = parsed;

  // Config gate: every command other than the wizard entrypoints (bare `wos`,
  // `init`) and help requires the global config file to exist. Enforced here,
  // before any worktree resolution, daemon contact, or auto-start.
  if (requiresConfig(command) && !hasGlobalConfig()) {
    process.stderr.write(
      "wos: no configuration found. Run `wos init` to set up.\n",
    );
    return 1;
  }

  switch (command) {
    case undefined:
    case "init":
      return runInitFn(rest);
    case "up":
      return runUpViaDaemon(rest, { cwd: global.cwd });
    case "down":
      return runDownViaDaemon(rest, { cwd: global.cwd });
    case "status":
      return runStatusViaDaemon(rest, { cwd: global.cwd });
    case "exec":
      return runExec(rest, { cwd: global.cwd });
    case "wait":
      return runWaitViaDaemon(rest, { cwd: global.cwd });
    case "web":
      return runWeb(rest);
    case "worktree":
      return runWorktreeCommand(rest, { cwd: global.cwd });
    case "start":
      return runStart(rest);
    case "stop":
      return runStop();
    case "restart":
      return runRestart();
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`unknown command: ${command}\n${USAGE}`);
      return 2;
  }
}

const WORKTREE_USAGE = `wos worktree <subcommand>

Subcommands:
  remove [--force]   Remove the current secondary Git worktree via the daemon.
                     --force passes --force to 'git worktree remove', allowing
                     removal of dirty or unmerged worktrees.
`;

export interface ParsedWorktreeRemoveArgs {
  force: boolean;
}

export interface WorktreeRemoveArgsError {
  error: string;
}

export function parseWorktreeRemoveArgs(
  argv: string[],
): ParsedWorktreeRemoveArgs | WorktreeRemoveArgsError {
  let force = false;
  for (const arg of argv) {
    if (arg === "--force") {
      force = true;
      continue;
    }
    return { error: `unknown argument: ${arg}` };
  }
  return { force };
}

async function runWorktreeCommand(
  argv: string[],
  opts: { cwd?: string } = {},
): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case "remove": {
      const parsed = parseWorktreeRemoveArgs(rest);
      if ("error" in parsed) {
        process.stderr.write(
          `wos worktree remove: ${parsed.error}\n${WORKTREE_USAGE}`,
        );
        return 2;
      }
      return runWorktreeRemoveViaDaemon(parsed, { cwd: opts.cwd });
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(WORKTREE_USAGE);
      return 0;
    default:
      process.stderr.write(
        `wos worktree: unknown subcommand: ${sub}\n${WORKTREE_USAGE}`,
      );
      return 2;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
