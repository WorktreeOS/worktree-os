---
name: wos-service-status
description: Inspect the current worktree deployment and wait for readiness using wos status and wos wait --timeout.
tags: [cli, status, readiness, healthcheck, wait]
---

# wos-service-status

Use this skill when the user wants to **see what is running**, **wait for readiness**, or **interpret healthcheck results** for the current worktree deployment. Both commands are worktree-scoped and daemon-backed.

## When to use this skill

- The user asks "is it up?", "what is running?", "are services healthy?".
- The user wants to block until a deployment becomes ready.
- You need to confirm state before running a destructive command from `wos-service-lifecycle` or `wos-worktree`.

## Preconditions

- Run from inside a Git worktree, or use `wos --cwd <path> status` / `wos --cwd <path> wait` to target another worktree.
- The deploy config is read fresh from the primary/source worktree.
- Both commands operate on the **current worktree session** only. They do not aggregate state across worktrees.

## `wos status`

`wos status` prints the persisted deployment state for the current worktree:

```sh
wos status
```

What it reports:

- Each Docker Compose service that wos is managing for the worktree, including its current status and published host ports.
- App-port HTTP healthcheck results for **services that are actually deployed** (selective startup is respected).
- Tunnel URLs when global tunneling is enabled and routes are registered.

Healthcheck states you may see:

- `healthy` — the configured URL returned the expected status before the budget expired.
- `waiting` — wos is still polling within the configured `start_period`, total `timeout`, and `retries`.
- `failed` — the budget expired without a healthy response and `allow_failure` is false.
- `failed (allowed)` — a healthcheck failed but the port is configured with `allow_failure: true`.
- `disabled` — the port is configured with `healthcheck: false`.

If the worktree has no session state, `wos status` reports that **no wos deployment has been initialized** for the current worktree. That is not an error; it just means you must run `wos up` first (see `wos-service-lifecycle`).

## `wos wait [--timeout <duration>]`

`wos wait` blocks until the current worktree deployment reports ready, or until the timeout elapses.

```sh
# Default timeout is 1 minute.
wos wait

# Wait up to 5 minutes.
wos wait --timeout 5m

# Explicit milliseconds.
wos wait --timeout 90000ms
```

Duration syntax:

- Raw number is treated as **milliseconds**.
- Suffixes accepted: `ms`, `s`, `m`.

Use `wos wait` after `wos up -d` (detached startup) or when you need a deterministic readiness gate in a script.

## Common patterns

- **Quick health check:** `wos status`.
- **Block until ready, then continue:** `wos up -d` → `wos wait --timeout 3m` → `wos status`.
- **Pre-flight before a destructive command:** `wos status` → confirm with the user → then run the destructive command.

## Interpreting failures

- **"No wos deployment for this worktree."** Run `wos up` first.
- **`waiting` lingers past the expected start time.** The app inside the container is slow to come up, or its healthcheck URL/status is misconfigured. Consider checking container logs in the web UI or via Docker directly; review `wos-config` for healthcheck options.
- **`failed` with an HTTP status mismatch.** The app responded but with the wrong status code. Compare expected vs observed status reported in the output.
- **`failed (allowed)`.** Treat as informational unless the user expects the port to succeed.
- **Worktree guard error.** You are outside a Git worktree — change directory or use `--cwd <path>`.

## Safety guidance

- `wos status` and `wos wait` are **read-only** observations of state — they do not mutate deployments. Use them freely before destructive actions.
- Do not poll `wos status` in a tight loop to simulate `wos wait`. Use `wos wait` with an explicit `--timeout` instead.
- When a healthcheck is `failed (allowed)`, do not silently treat the deployment as broken. Surface the failure to the user along with the `allow_failure` configuration.
