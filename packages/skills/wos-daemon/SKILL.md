---
name: wos-daemon
description: Manage the local wos daemon — start, stop, restart, and foreground diagnostics for the daemon control plane.
tags: [cli, daemon, operations]
---

# wos-daemon

Use this skill when the user wants to **operate on the local daemon itself** — starting, stopping, or restarting it, running it in the foreground for diagnostics, or understanding why CLI commands talk to a daemon at all.

## When to use this skill

- The user asks to "restart wos", "restart the daemon", "stop the daemon", or "run the daemon in the foreground".
- A worktree-scoped command failed with a daemon-startup error and you need to diagnose it.
- You need to explain why the CLI auto-starts a background process.

## Daemon-backed CLI execution

Worktree-scoped commands (`wos up`, `wos down`, `wos status`, `wos wait`, `wos worktree remove`) talk to a local daemon:

- The CLI connects to the daemon via the wos socket.
- If the daemon is already healthy, the CLI reuses it.
- If no healthy daemon responds, the CLI auto-starts a local daemon (`start --foreground` in the background) and waits for the health check before submitting the operation.
- The daemon owns mutating per-session operations; if a session is busy, the CLI returns a diagnostic with the active operation id instead of running Docker Compose directly.

For most users, the daemon is invisible. You only invoke daemon lifecycle commands explicitly when something is wrong, or you want to attach to the daemon's log stream.

## `wos start`

Starts the local daemon for the current `<wos-home>` (or reports that it is already running). Does **not** require a Git worktree.

```sh
wos start
```

Behavior:

- If a healthy daemon already responds, wos reports it and exits successfully without starting another one.
- Otherwise wos removes any stale socket/metadata files and spawns `start --foreground` in the background, waiting for the health check to succeed.

## `wos start --foreground`

Runs the daemon in the foreground attached to your terminal. It does **not** require a Git worktree.

```sh
wos start --foreground
```

When to use it:

- The CLI fails to auto-start the daemon and you need to see startup logs interactively.
- You want to tail daemon activity while another shell runs CLI commands.
- You are debugging an issue and want to reproduce it without daemon backgrounding.

Foreground mode keeps the daemon attached to the current process — closing the terminal stops the daemon. Use `Ctrl+C` to exit gracefully.

## `wos stop`

Stops the local daemon for the current `<wos-home>`.

```sh
wos stop
```

Behavior:

- If a healthy daemon is running, wos stops it using the PID reported by health check and removes the socket and metadata files.
- If no healthy daemon responds, wos still removes any stale socket/metadata files and exits successfully.
- It does **not** require a Git worktree.
- It does **not** run Docker Compose shutdown commands, and it does **not** remove wos session state. Deployed Docker services keep running unless something else stops them.

## `wos restart`

Restarts the local daemon for the current `<wos-home>`.

```sh
wos restart
```

Behavior:

- If a healthy daemon is running, wos stops it using the PID reported by health check, removes the socket and metadata files, then starts a fresh `start --foreground` in the background.
- If no healthy daemon is running, wos still removes any stale socket/metadata and starts a new daemon.
- It waits for the replacement daemon's health check to succeed before exiting.
- It does **not** require a Git worktree.
- It does **not** run Docker Compose shutdown commands, and it does **not** remove wos session state. Deployed Docker services keep running unless something else stops them.

If the replacement daemon does not become healthy before the startup timeout, the command exits non-zero with an actionable error.

When to use it:

- After upgrading or rebuilding the `wos` binary so the running daemon process matches the new code.
- After changing global configuration that the daemon caches at startup.
- When CLI commands are timing out against the daemon and you have already inspected the foreground output.

## When to escalate to daemon commands

A typical escalation order:

1. Run `wos status` to confirm the symptom is daemon-related (and not, for example, a missing worktree session).
2. Try `wos restart` if commands hang on daemon connect.
3. If restart fails, run `wos start --foreground` in a separate terminal to inspect startup logs.
4. Only after that, consider deeper diagnostics from `wos-troubleshooting`.

## Safety guidance

- `wos stop` and `wos restart` are safe with respect to deployed services — they do **not** stop containers. Still, tell the user what you are about to do before stopping or restarting, because in-flight CLI operations attached to the previous daemon will be disrupted.
- Do not kill the daemon process manually if a CLI operation is mid-flight. Wait or use `wos stop` / `wos restart`, which handle socket and metadata cleanup.
- The daemon scope is the current `<wos-home>` (default `~/.wos`, override with `WOS_HOME`). If the user sets `WOS_HOME` for a session, daemon lifecycle commands only affect that home directory's daemon — confirm the environment with the user when in doubt.
