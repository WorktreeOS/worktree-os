---
title: Config errors
description: Diagnose deploy-config validation errors, the worktree guard, and migration errors from legacy fields.
---

When a command names a deploy-config field, missing config, or a migration, treat
the error message as the source of truth and fix the file in the **source
worktree**.

## Where the deploy config is read from

The CLI reads the deploy config from the **primary/source worktree** on every
command — not from the secondary worktree you may be standing in. The source
worktree's `.wos/` directory holds `deploy.yaml` (source/root worktree) and
`deploy.worktree.yaml` (secondary worktrees); confirm the relevant file exists
there.

## The worktree guard

Worktree-scoped commands (`up`, `down`, `status`, `wait`, `worktree remove`)
refuse to run outside a Git worktree:

- Confirm the directory with `pwd`, or check the `--cwd <path>` value.
- Move into a worktree (`cd <worktree>`) or pass `wos --cwd <worktree> <command>`.
- The non-worktree commands (`web`, `start`, `stop`, `restart`, `help`) never
  fail with this guard.

## Field validation errors

Validation errors point at specific keys (for example, `app.services.api.ports[0]`):

- Healthcheck and port errors name the offending field — update the deploy
  config accordingly. See [Healthchecks](/configuration/healthchecks/) and
  [Services and ports](/configuration/services-and-ports/).
- The `compose.expose` "bare service name" error means an entry lacks a port;
  use `service:port`. See [Compose mode](/configuration/compose-mode/).
- Selective startup in `mode: compose` is rejected — drop the service list /
  `--target`, or switch to generated mode.
- Template errors (`${UNKNOWN}`, `hostname[...]` / `url[...]` on a dependency or
  unconfigured port) fail before Docker Compose starts. See the
  [Deploy configuration reference](/reference/deploy-config/).

## Migration errors

Migration errors mention legacy fields. Switch to the current schema
(`clone_volumes`, `app`, `deps`, or an explicit `mode: compose`). For the old
bare-name `compose.expose`, move to `service:port` entries.

## When to escalate

Fixes that require editing the deploy config or any user-owned file are not
something to retry blindly — make the edit (or surface it to the file's owner)
rather than re-running the command.

## Related

- [Deploy configuration reference](/reference/deploy-config/)
- [Generated mode](/configuration/generated-mode/)
