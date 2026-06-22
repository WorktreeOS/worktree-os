---
title: Remove a worktree
description: Tear down a secondary worktree's deployment, session state, and the Git worktree itself with wos worktree remove.
---

import { Aside } from "@astrojs/starlight/components";

`wos worktree remove` removes the **current secondary** Git worktree through the
daemon. It is the only command that combines WorktreeOS state cleanup with
`git worktree remove`.

<Aside type="danger" title="Destructive">
This deletes the worktree directory via Git. With `--force`, uncommitted work in
that worktree is lost. Confirm the target and consequences before running.
</Aside>

## What it does

In order:

1. Tears down WorktreeOS-deployed resources for the current worktree
   (containers, port assignments, registered tunnel routes).
2. Deletes persistent WorktreeOS session artifacts for the current worktree
   under `<wos-home>/sessions/<session-name>`.
3. Invokes `git worktree remove` for the current worktree path.

Contrast this with [`wos down`](/guides/run-a-worktree/), which keeps the
session, the generated Compose file, and the worktree itself.

## Usage

```bash
# Remove the current secondary worktree if it is clean and linked.
wos worktree remove

# Force removal of a dirty or unlinked worktree
# (passes --force to git worktree remove).
wos worktree remove --force
```

## Constraints

- The **source/primary worktree cannot be removed** through WorktreeOS. Run the
  command from inside a secondary worktree, or target one with `--cwd`:

  ```bash
  wos --cwd /var/www/feature-login worktree remove
  ```

- `--force` is forwarded to `git worktree remove`. It removes worktrees with
  uncommitted changes or worktrees Git considers unlinked. Do not use it
  casually.
- Removal goes through the daemon, so the daemon must be reachable. If it is
  unhealthy, fix that first (see [Daemon errors](/troubleshooting/daemon-errors/)).

## Safe removal flow

1. Confirm the worktree should be deleted, including any uncommitted work.
2. Run `wos status` to see what is currently deployed.
3. Optionally run `wos down` for a clean, observable Compose shutdown first.
4. Check the worktree's Git status to decide whether `--force` is required;
   prefer non-`--force` removal when the worktree is clean.
5. Run `wos --cwd <secondary-path> worktree remove [--force]` and report the
   outcome.

<Aside type="caution">
Never bypass WorktreeOS by running `git worktree remove` directly when a
deployment exists — WorktreeOS needs to release ports, unregister tunnels, and
clean session state first.
</Aside>
