---
title: Worktrees
description: How WorktreeOS maps a Git worktree to an isolated deployment with a stable project name and host ports.
---

WorktreeOS deploys the **current Git worktree**. Everything it does — generating
Compose, allocating ports, storing state — is scoped to the worktree you run
`wos` from. This is what lets several branches run side by side.

## A deployment per worktree

When you run `wos up`, WorktreeOS assigns each service:

- a deterministic **container name** of the form `<projectName>-<serviceName>`,
  where `projectName` is a stable worktree prefix (`wos-<repo>-<hash>`);
- a stable **host port** for every container port. Assignments are saved in the
  worktree state and reused across runs as long as the port stays available.
  When a port is unavailable, WorktreeOS reallocates and, if necessary, retries
  `docker compose up -d` with new ports (up to three attempts).

Because the project name and ports are derived from the worktree path, two
worktrees of the same repository never collide.

## Source worktree vs. secondary worktrees

WorktreeOS distinguishes the **source worktree** (the original checkout) from
**secondary worktrees** (additional `git worktree` checkouts):

- In the source worktree, the `clone_volumes` copy step is skipped — the files
  are already in place — and `wos up --force` does not delete `clone_volumes`
  destinations.
- In secondary worktrees, `wos up --force` removes each resolved
  `clone_volumes` destination before copying again.

See [Clone volumes](/configuration/clone-volumes/) for the copy rules.

## Referencing generated values

Because container names and host ports are generated, you reference them in a
service's `environment` with templates instead of hardcoding:

- `${app.services.<service>.containerName}`
- `${app.services.<service>.hostPort[<containerPort>]}`
- `${deps.<service>.containerName}`
- `${deps.<service>.hostPort[<containerPort>]}`

Templates can be embedded in plain text; references to non-existent services or
ports fail validation before Docker Compose starts. See
[Services and ports](/configuration/services-and-ports/).

## Related

- [Storage and sessions](/reference/storage-and-sessions/) — where per-worktree
  state lives under the WorktreeOS home.
- [Remove a worktree](/guides/remove-a-worktree/) — tearing one down safely.
