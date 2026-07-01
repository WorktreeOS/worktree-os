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

## First-run startup and onboarding

wos runs on built-in defaults — **there is no config gate**. Commands work with no `config.json` present; `<wos-home>/config.json` (default `~/.wos/config.json`) is written lazily when settings are saved or onboarding completes.

- **Bare `wos` (no arguments) starts the local daemon** — it is equivalent to `wos start` and prints the web UI URL. It no longer launches a wizard or prints usage (use `wos help` / `-h` / `--help`).
- **First-run onboarding lives in the web UI**, not the CLI. Open the printed URL to a readiness checklist (web port · Docker · Docker Compose v2 · tmux/psmux · agent plugins), each with a status and an action. The CLI never prompts.
- If the configured/default port `4949` is busy, the daemon binds the next free port and records it in `<wos-home>/daemon.json`; the web UI shows a "port changed" notice.
- **Headless / CI / Dockerfiles**: `wos init` is a non-interactive command that applies defaults + flags and writes the config without prompting:

  ```sh
  # Apply defaults, no prompts.
  wos init

  # Fully specified non-interactive setup (--yes is accepted as a no-op).
  wos init --host 127.0.0.1 --port 4949 --backend tmux --install-tmux --install-plugins
  ```

  `wos init` never blocks on a missing Docker/Compose install (that surfaces later as a web onboarding item).

## Command map

| Command | What it does | Worktree required |
| --- | --- | --- |
| `wos` (bare) | Start the local daemon (≡ `wos start`) and print the web UI URL. First-run onboarding happens in the web UI. | No |
| `wos init` | Non-interactive setup for CI/automation: apply defaults + flags and write the global config without prompting. | No |
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
