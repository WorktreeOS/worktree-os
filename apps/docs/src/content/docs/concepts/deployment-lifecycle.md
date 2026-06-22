---
title: Deployment lifecycle
description: What happens during wos up — the deployment steps and the first-run initialization order.
---

A `wos up` runs through a fixed sequence of steps, and the **first** run of a
worktree also performs one-time initialization. Understanding both makes logs
and failures easier to read.

## Deployment steps

`wos up` streams these steps to stderr (with an active-phase spinner):

1. **prepare** — resolve the worktree, session, project name, and ports.
2. **first-run setup** — clone volumes, restore caches (first run only — see
   below).
3. **init script** — run `app.init_script` (first run only).
4. **start** — start the services: `docker compose up` for the Docker-backed
   [generated](/configuration/generated-mode/) and
   [compose](/configuration/compose-mode/) modes, or host processes in
   [shell mode](/configuration/shell-mode/).
5. **status** — read back service state and published ports.
6. **healthcheck** — poll each app port until required checks pass.

On success the CLI prints a service table with published addresses and the
worktree detail-page URL, then exits. Services keep running (as containers, or
as host processes in shell mode) until an explicit
[`wos down`](/guides/run-a-worktree/).

## First-run initialization order

The first time a worktree is brought up (and on every `wos up --force`),
WorktreeOS performs initialization in this order:

1. `clone_volumes` are copied (skipped in source-worktree mode).
2. For every `cache` entry, WorktreeOS looks up the global cache under the
   computed key. On a hit, the target paths are replaced by the cached copy; on
   a miss, the path is left as-is.
3. `app.init_script` runs.
4. After `app.init_script` succeeds, every existing `cache` `paths` entry is
   atomically saved into the global cache. **If init fails, the cache is not
   written and the worktree remains uninitialized.**

`wos up --force` follows the same restore-before-init and
save-after-successful-init order.

## Healthchecks gate success

For each app port WorktreeOS runs an HTTP healthcheck after the services start
and only completes `wos up` once every *required* healthcheck has passed. While
a check is in progress the status reads `waiting` (yellow); if it ends without a
successful response, it reads `FAILED`. A port can opt out
(`healthcheck: false`) or be marked non-blocking (`allow_failure: true`). See
[Healthchecks](/configuration/healthchecks/) for the full model.

## Detached vs. foreground

- **Foreground** (`wos up`) streams every step and waits for healthchecks
  before printing the final table.
- **Detached** (`wos up -d`) submits the operation and exits immediately, so
  you watch the rest in the web UI or via `wos status` / `wos wait`.

See [Detached startup](/guides/detached-startup/).

## Related

- [Clone volumes](/configuration/clone-volumes/)
- [Cache](/configuration/cache/)
- [Healthchecks](/configuration/healthchecks/)
