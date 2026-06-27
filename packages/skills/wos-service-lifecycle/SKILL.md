---
name: wos-service-lifecycle
description: Start, restart, and stop wos-managed services for the current worktree using wos up, wos up -d, selective startup, --force refresh, and wos down.
tags: [cli, lifecycle, up, down, compose]
---

# wos-service-lifecycle

Use this skill when the user wants to **start, restart, refresh, or stop** wos-managed services for the current worktree. Pair with `wos-service-status` once the deployment is running so the user can verify readiness.

## When to use this skill

- The user asks to start the local environment, "spin up services", or restart containers.
- The user wants to deploy only a subset of services (selective startup).
- The user wants a clean re-init of cloned volumes and init scripts (`--force`).
- The user wants to stop or tear down wos-managed containers (`wos down`).

## Preconditions

- Run the command from inside a Git worktree (use `--cwd <path>` to target another worktree).
- The deploy config lives in the primary/source worktree's `.wos/` directory (`deploy.yaml` for the source/root worktree, `deploy.worktree.yaml` for secondary worktrees). It is read fresh on every `up`.
- The local daemon is auto-started by the CLI when needed.

## Starting services: `wos up`

`wos up` is the foreground deployment command. It is **non-interactive** — the CLI streams progress to stderr and prints a final service summary plus the web UI worktree detail URL on success.

```sh
wos up
```

What happens under the hood (high level):

1. The CLI submits an `up` operation to the local daemon for the current worktree.
2. On first run, wos copies any configured `clone_volumes` and runs `app.init_script` inside an app-image container.
3. wos generates or rewrites the Compose file, assigns deterministic host ports, runs `docker compose down` for the previous deployment, then `docker compose up -d --force-recreate`.
4. wos polls configured app-port HTTP healthchecks until they pass, time out, or exhaust retries.
5. On success, the CLI prints deployed services with addresses and the worktree detail URL.

### Selective startup (generated mode only)

You can deploy a subset of configured app/dep services. wos includes their transitive dependencies automatically.

```sh
# Deploy only app and api, plus everything they transitively depend on.
wos up app,api

# Deploy a named target declared under `targets:` in the deploy config.
wos up --target app
```

Notes:

- Service names are comma-separated; do not add spaces.
- `--target <name>` resolves the named target from the deploy config.
- With no arguments, wos deploys all configured services.
- Healthchecks during status/wait will only run for the services actually deployed.

### Detached startup: `wos up -d`

`-d` is for fire-and-forget startup. The CLI submits the operation to the daemon and exits as soon as the operation is **accepted**. It does not stream deployment progress and does not print the final service table.

```sh
wos up -d
```

After `-d`:

- Watch progress, logs, and final status in the web UI (the CLI prints the worktree detail URL when available).
- `wos up -d --force` is allowed and preserves `--force` semantics.

### Forced refresh: `wos up --force`

`--force` is a **destructive refresh** of first-run setup. It removes the resolved `clone_volumes` destinations, copies sources again, and re-runs `app.init_script` before Docker Compose startup.

Before running `--force`:

1. Confirm with the user that re-cloning configured volume destinations is acceptable for this worktree.
2. Prefer `wos status` first to inspect the current state.

```sh
# Re-run first-run setup (cloned volumes + init scripts) before redeploying.
wos up --force
```

Without `--force`, wos keeps cloned volumes and skips init scripts on subsequent `up` runs.

## Stopping services: `wos down`

`wos down` runs `docker compose down --remove-orphans` for the current worktree's stored project and compose file set.

```sh
wos down
```

Behavior to remember:

- Leaves wos session state, generated compose files, cloned volumes, and Docker named volumes intact. It does **not** wipe state.
- Reports "no wos deployment" if no session state exists for the current worktree.
- Fails with the standard worktree-guard error when run outside a Git worktree.

Use `wos down` when the user wants to free host ports and stop containers, but keep the next `wos up` incremental.

## Recommended flows

- **Start a fresh worktree:** `wos up` → wait for the success summary → use `wos-service-status` if the user wants to verify readiness later.
- **Restart containers without re-init:** `wos up` (re-runs Docker Compose startup with the latest deploy config, but skips clone volume copies and init scripts).
- **Re-init after a broken state:** `wos down` → `wos up --force` (confirm with the user first).
- **Background deployment:** `wos up -d` and then point the user at the printed web UI URL.
- **Stop services for now:** `wos down`.

## Safety guidance

- Never run `wos up --force` or `wos down` without telling the user what those commands will do.
- Never invoke `docker compose up` / `docker compose down` directly to bypass wos — wos owns project names, compose file paths, host port assignments, and tunnel registrations.
- If the daemon reports that the session is busy, do not retry in a loop. Surface the active operation id to the user and let them decide.
- Selective startup names must match the deploy config. If you are unsure which services exist, ask the user or inspect the deploy config rather than guessing.
