---
title: CLI commands
description: The full wos command surface — deployment, status, the web UI, worktree removal, and daemon control.
---

`wos` is a worktree-scoped, daemon-backed CLI. Most commands operate on the
current Git worktree, read the deploy config from the source worktree, and store
per-worktree state under `<wos-home>/sessions/<session-name>`.

## Command map

| Command | What it does | Worktree required |
| --- | --- | --- |
| `wos up [services] [--target <name>] [--force] [--arg K=V] [--no-tunnel]` | Deploy the current worktree (foreground stream). | Yes |
| `wos up -d [--force] …` | Submit deployment to the daemon and return immediately. | Yes |
| `wos down` | Stop and remove WorktreeOS containers for the current worktree. | Yes |
| `wos status` | Show deployment state, addresses, and healthcheck results. | Yes |
| `wos exec <service> [--] <command...>` | Run a command inside a running Docker-backed service (like `docker compose exec`). | Yes |
| `wos wait [--timeout <duration>]` | Wait until the deployment is ready (default `1m`). | Yes |
| `wos web [--no-open]` | Open (or print) the web UI URL. | No |
| `wos worktree remove [--force]` | Remove the current secondary worktree via the daemon. | Yes (secondary) |
| `wos start` | Start the local daemon (or report it is already running). | No |
| `wos start --foreground` | Run the daemon attached to the terminal for diagnostics. | No |
| `wos stop` | Stop the local daemon (does not stop deployed services). | No |
| `wos restart` | Restart the local daemon for the current `<wos-home>`. | No |
| `wos help` | Print CLI usage. | No |

## Deployment commands

- **`wos up`** — foreground, non-interactive launcher. Submits `up` to the
  daemon, streams deployment steps and Docker Compose logs to stderr, and on
  success prints a service table with published addresses plus the worktree
  detail-page URL, then exits. Containers keep running until `wos down`.
  Supports [selective startup](/guides/selective-startup/): an explicit list
  (`wos up app,api`) or a named target (`wos up --target app`).
- **`wos up -d`** — [detached startup](/guides/detached-startup/): submits `up`
  and exits immediately. Watch progress in the web UI or via `wos status` /
  `wos wait`.
- **`wos down`** — stops and removes the worktree's containers, keeping session
  state and the worktree itself.

### `wos up` flags

- `--force` — re-run first-run setup (cache restore, `app.init_script`, and in
  secondary worktrees re-copy `clone_volumes`).
- `--target <name>` — start a named [target](/configuration/targets/).
- `--arg KEY=VALUE` (or `--arg=KEY=VALUE`) — pass a runtime
  [argument](/configuration/arguments/). Repeatable.
- `--no-tunnel` — skip tunnel route registration for this run.
- `-d` — detached startup.

## Status commands

- **`wos status`** — prints managed services, their status, published host
  ports, and app-port healthcheck results for the current worktree. If the
  worktree has no session, reports that no deployment has been initialized.
- **`wos wait [--timeout <duration>]`** — blocks until the deployment reports
  ready or the timeout elapses (default `1m`). Durations accept a raw number of
  milliseconds or `ms` / `s` / `m` suffixes.

## Run a command in a service

- **`wos exec <service> [--] <command...>`** — runs a one-off command inside a
  running Docker-backed service for the current worktree, the wos equivalent of
  `docker compose exec`. It reuses the worktree's persisted Compose project name
  and file set (so you don't have to reconstruct them), runs
  `docker compose exec <service> <command...>`, forwards your terminal — stdin,
  output, and resize — interactively, and exits with the command's exit code.

  The first token after `exec` is the service name. Use `--` to separate a
  command that begins with a flag so wos does not parse it:

  ```bash
  wos exec api -- bun test        # run the test suite inside the api container
  wos exec api -- --version       # '--' keeps --version as the command
  wos exec api -- sh              # open an interactive shell
  ```

  `wos exec` routes through the daemon web listener and requires it to be
  available; if the web listener is not bound, run `wos restart` (or fix
  `web.port`). The target must be a managed, initialized service — the internal
  init service and, in compose mode, services not listed in `compose.expose`
  are rejected. Exec is **not supported for shell-mode deployments** in this
  release.

## Web UI

- **`wos web [--no-open]`** — opens the daemon web UI in the default browser
  (default `http://127.0.0.1:4949`), starting the daemon if needed. `--no-open`
  prints the URL without launching a browser. On Windows the browser is launched
  with the OS default handler the same way as macOS/Linux. See
  [Using the web UI](/guides/web-ui/).

:::note[Cross-platform daemon discovery]
On every platform the CLI discovers the daemon by reading
`<wos-home>/daemon.json` and calling `GET /ui/v1/health` over HTTP — it never
uses a Unix domain socket. Native Windows is fully supported without WSL; see the
[Native Windows guide](/guides/windows/).
:::

## Worktree removal

- **`wos worktree remove [--force]`** — tears down the current secondary
  worktree's deployment, deletes its session, and runs `git worktree remove`.
  The source worktree cannot be removed this way. `--force` is forwarded to
  `git worktree remove`. See [Remove a worktree](/guides/remove-a-worktree/).

## Daemon control

- **`wos start`** / **`wos start --foreground`** / **`wos stop`** /
  **`wos restart`** — manage the local daemon. See
  [Daemon behavior](/reference/daemon/).

## Global option: `--cwd <path>`

`--cwd <path>` overrides the directory used to resolve the current Git worktree.
It must appear **before** the subcommand and applies only to worktree-scoped
commands (it has no effect on `wos web`, `wos start/stop/restart`, or
`wos help`). The `--cwd=<path>` form is also accepted.

```bash
wos --cwd /var/www/feature-login status
wos --cwd /var/www/feature-login up app,api
```

## Running through Bun

If `wos` is not on your `PATH`, run any command through Bun from the repository
root: `bun run wos <command>` (equivalent to `apps/cli/index.ts`).
