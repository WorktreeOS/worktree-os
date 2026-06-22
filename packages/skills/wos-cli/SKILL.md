---
name: wos-cli
description: General orientation for AI agents using the wos CLI. Start here before drilling into a workflow-specific skill.
tags: [cli, orientation, entrypoint]
---

# wos-cli

Use this skill as your **entry point** for any task that drives the wos CLI. It explains the command surface, the global `--cwd` option, and the daemon-backed execution model. Switch to a focused skill (`wos-service-lifecycle`, `wos-service-status`, etc.) once you know which workflow you need.

## When to use this skill

- The user asks you to "use wos" or to run any `wos ...` command.
- You need to choose between subcommands.
- You need to understand whether a command requires a Git worktree.

## Mental model

- **Worktree-scoped CLI.** Most commands operate on the current Git worktree. They read the deploy config from the primary/source worktree and store per-worktree state under `<wos-home>/sessions/<session-name>`.
- **Daemon-backed.** Worktree-scoped CLI commands talk to a local `wos` daemon. The CLI auto-starts the daemon if no healthy one is responding on the wos socket.
- **Non-interactive output.** Foreground commands stream text to stderr/stdout; they do not open a TUI.

## First-run setup gate

wos requires a global config file (`<wos-home>/config.json`, default `~/.wos/config.json`) before it will run worktree or daemon commands. Until it exists, **every command except the wizard entrypoints and help** fails with:

```
wos: no configuration found. Run `wos init` to set up.
```

- Bare `wos` (no arguments) and `wos init` always launch the setup wizard (bare `wos` no longer prints usage — use `wos help` / `-h` / `--help`).
- The wizard collects the daemon bind address, port, terminal backend (tmux vs default — see `wos-config`), and agent-plugin integration, then writes the config. With an existing config it runs as a reconfigure flow, pre-filling current values.
- **Headless / CI / Dockerfiles**: use the non-interactive path so the gate never blocks automation:

  ```sh
  # Apply defaults without prompting.
  wos init --yes

  # Fully specified non-interactive setup.
  wos init --host 127.0.0.1 --port 4949 --backend tmux --install-tmux --yes
  ```

  With `--yes` (or whenever stdin is not a TTY) the wizard applies defaults plus any provided flags and persists without prompting.

## Command map

| Command | What it does | Worktree required |
| --- | --- | --- |
| `wos init` (also bare `wos`) | Run the first-run / reconfigure setup wizard; writes the global config. `--yes` for non-interactive. | No |
| `wos up [services] [--target <name>] [--force]` | Deploy the current worktree via Docker Compose (foreground stream). | Yes |
| `wos up -d [--force]` | Submit deployment to the daemon and return immediately. | Yes |
| `wos down` | Stop and remove wos-managed containers for the current worktree. | Yes |
| `wos status` | Show deployment state, service addresses, and healthcheck results for the current worktree. | Yes |
| `wos wait [--timeout <duration>]` | Wait until the current worktree deployment is ready (default `1m`). | Yes |
| `wos web [--no-open]` | Print the web UI URL and open it in the default browser. | No |
| `wos worktree remove [--force]` | Remove the current secondary worktree via the daemon. | Yes (must be secondary) |
| `wos start` | Start the local daemon (or report it is already running). | No |
| `wos start --foreground` | Run the local daemon in the foreground for diagnostics. | No |
| `wos stop` | Stop the local daemon (does not stop deployed services). | No |
| `wos restart` | Restart the local daemon for the current `<wos-home>`. | No |
| `wos help` | Print CLI usage. | No |

Refer to the workflow-specific skills for full option semantics and safety guidance.

## Global option: `--cwd <path>`

`--cwd <path>` is the only global option. It overrides the directory used to resolve the current Git worktree for worktree-scoped commands. The option must appear **before** the subcommand.

```sh
# Run status against a specific worktree without changing the shell's cwd.
wos --cwd /var/www/feature-login status

# Selective startup in a different worktree.
wos --cwd /var/www/feature-login up app,api
```

`--cwd` has no effect on commands that do not require a worktree (`wos init`, `wos web`, `wos start`, `wos stop`, `wos restart`, `wos help`).

## Daemon-backed execution

The CLI delegates worktree-scoped operations to the local daemon:

- If a healthy daemon is reachable on the wos socket, the CLI reuses it.
- Otherwise, the CLI starts a local daemon process and waits for its health check before submitting the operation.
- If the daemon reports that a mutating operation is already running for the current session, the CLI prints a "session busy" diagnostic that includes the active operation id; do not bypass it by invoking Docker Compose directly.

## How to pick the next skill

| If the user wants to... | Load this skill |
| --- | --- |
| Start, stop, or selectively start services | `wos-service-lifecycle` |
| Check deployment state or wait for readiness | `wos-service-status` |
| Manage the local daemon | `wos-daemon` |
| Open the web UI | `wos-web-ui` |
| Run commands across worktrees or remove a worktree | `wos-worktree` |
| Investigate an error | `wos-troubleshooting` |
| Understand the deploy config | `wos-config` |

## Safety rules for any wos session

1. Prefer `wos status` before any destructive command so you know the current deployment state.
2. Do not run `wos down`, `wos up --force`, or `wos worktree remove` without confirming the worktree and the consequences with the user.
3. Do not invoke Docker Compose directly to bypass wos's daemon — wos owns the project name, compose files, and persisted port assignments.
4. Do not run worktree-scoped commands outside a Git worktree; the CLI will refuse them with an actionable error.
