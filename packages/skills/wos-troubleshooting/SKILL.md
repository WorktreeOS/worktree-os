---
name: wos-troubleshooting
description: Diagnose common wos CLI failures in a structured order before retrying or escalating.
tags: [cli, troubleshooting, diagnostics]
---

# wos-troubleshooting

Use this skill when **any wos CLI command fails or behaves unexpectedly**. It establishes a diagnostic order so you do not retry destructive commands blindly.

## When to use this skill

- A `wos ...` command exited non-zero.
- A command hangs or times out.
- Output mentions the worktree guard, daemon startup, session conflict, port conflict, or healthcheck failure.

## Diagnostic order

Walk these checks in order. Stop as soon as you have an actionable cause.

### 1. Worktree guard

If the error message says wos must be run from inside a Git worktree:

- Confirm the current directory with `pwd` or check the `--cwd <path>` value.
- Either move into a worktree (`cd <worktree>`), or pass `wos --cwd <worktree> <command>`.
- Worktree-scoped commands: `up`, `down`, `status`, `wait`, `worktree remove`.
- Non-worktree commands: `web`, `start`, `start --foreground`, `stop`, `restart`, `help`. They will not fail with this guard.

### 2. Configuration errors from the deploy config

If the error names a deploy-config field, missing config, or migration:

- The CLI reads the deploy config from the **primary/source worktree**'s `.wos/` directory on every command (`deploy.yaml` for the source/root worktree, `deploy.worktree.yaml` for secondary worktrees). Confirm the relevant file exists there.
- Migration errors mention legacy fields (`volumes`, `init-script`, `publish`). The fix is to switch to `clone_volumes`, `app`, `deps`, or to use explicit `mode: compose`. See `wos-config` for the schema overview.
- Healthcheck and port validation errors point at specific keys (for example `app.services.api.ports[0]`). Treat the error message as the source of truth and ask the user to update the deploy config.

### 3. Daemon health

If the error mentions daemon startup, socket, or connect failures:

- Run `wos restart`. It handles socket and metadata cleanup and waits for the replacement daemon to become healthy.
- If restart fails, run `wos start --foreground` in another terminal to inspect startup logs.
- See `wos-daemon` for the full daemon flow.

### 4. Session busy

If the daemon reports that a mutating operation is already active for the current session:

- The CLI prints the active operation id. Do **not** retry in a loop. Do **not** invoke Docker Compose directly to bypass wos.
- Wait for the in-flight operation to finish (watch the web UI or rerun `wos status`) or report the conflict to the user.

### 5. Docker Compose / port conflicts

If startup fails with a host-port bind error:

- wos retries port reassignment internally. If it gives up, the error explains that host-port allocation could not be completed.
- Check the configured `host_ports.range` in the deploy config (default `20000..29999`). The range may be too narrow or fully occupied on the host.
- Other Docker Compose failures (image pull, container exit) surface as standard Compose errors. Use the web UI for container logs.

### 6. Healthcheck failures

If `wos up` fails after Compose startup with a healthcheck error, or `wos status` shows `failed` healthchecks:

- Compare expected vs observed HTTP status in the output.
- Check the app's healthcheck endpoint, configured URL, and timeout/`start_period`/`retries` in the deploy config (see `wos-config`).
- If the failure is acceptable, the user can set `allow_failure: true` for that port.

### 7. Volume copy / init script failures

On first `wos up` or `wos up --force`:

- A failure copying a `clone_volumes` source means the source path does not exist in the primary worktree. The error names the missing path.
- An `app.init_script` failure stops setup and leaves the worktree **un-initialized**. wos will retry init on the next `wos up` (no extra flag needed).

### 8. Tunnel failures

If global tunneling is enabled and the error mentions tunnel registration:

- `wos up` treats tunnel failure as **non-fatal**; deployment continues with `localhost` hostnames.
- `wos status` marks the failed tunnel. Investigate global tunneling config separately rather than retrying `up` in a loop.

## When to escalate

Escalate to the user (do not retry blindly) when:

- The fix requires editing the deploy config or any user-owned file.
- The fix requires deciding whether to lose uncommitted work (for example, `wos worktree remove --force`).
- The daemon foreground logs reveal an environment problem (Docker not running, missing image, network policy) outside wos's control.

## Read-only checks you can run freely

These commands never mutate deployments and are safe to chain while diagnosing:

- `wos status` — current worktree's deployment state and healthchecks.
- `wos wait --timeout <duration>` — readiness gate with a bounded wait.
- `wos web --no-open` — print the web UI URL for log inspection.
- `git worktree list --porcelain` — verify which worktree wos will resolve.

## Safety guidance

- Never re-run `wos up --force` or `wos worktree remove` "just to see if it works". Confirm the root cause first.
- Never bypass the daemon with raw `docker compose ...` against wos-managed projects.
- When in doubt about state, prefer `wos status` over assumptions from earlier output — state may have changed since the failure.
