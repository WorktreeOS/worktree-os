---
name: wos-worktree
description: Operate wos commands across Git worktrees safely — global --cwd <path>, source vs secondary worktrees, and wos worktree remove [--force].
tags: [cli, worktree, git, safety]
---

# wos-worktree

Use this skill when the user needs to **target a specific Git worktree**, run wos across multiple worktrees, or **remove** a secondary worktree through wos. Worktree operations are the most destructive of the CLI surface, so safety guidance here is mandatory.

## When to use this skill

- The user wants to run a wos command for a worktree other than the current shell's cwd.
- The user wants to remove a secondary worktree and clean up its wos session.
- You need to explain the difference between the source/primary worktree and secondary worktrees.

## Worktree model

- wos resolves the **source/primary worktree** by parsing `git worktree list --porcelain`. The deploy config (the source worktree's `.wos/` directory, holding `deploy.yaml` for the source/root worktree and `deploy.worktree.yaml` for secondary worktrees) lives in the source worktree.
- Every worktree (primary or secondary) gets its own wos session under `<wos-home>/sessions/<session-name>` where `<session-name>` is derived from the worktree path.
- Worktree-scoped commands run **against the current worktree session** — they read the deploy config from the primary worktree but persist and act on state for the current worktree.

If you are unsure which worktree wos will pick, run `git worktree list --porcelain` to see the candidates and verify the agent's current working directory.

## Global `--cwd <path>`

`--cwd <path>` overrides the directory used to resolve the current Git worktree. It must appear **before** the subcommand:

```sh
wos --cwd /var/www/feature-login status
wos --cwd /var/www/feature-login up app,api
wos --cwd /var/www/feature-login down
```

Notes:

- The path is resolved to an absolute path internally.
- `--cwd` applies only to worktree-scoped commands. It has no effect on `wos web`, `wos daemon ...`, or `wos help`.
- `--cwd=<path>` (with `=`) is also accepted; either form is fine.
- The value must not look like a CLI flag (`-foo`) or a known subcommand (`up`, `down`, etc.) — the parser rejects those to avoid ambiguity.

Prefer `--cwd` over `cd <path>` in scripts or automation: it keeps the agent's working directory stable and produces clearer command logs.

## `wos worktree remove [--force]`

`wos worktree remove` removes the **current secondary** Git worktree through the daemon. It is the only command that combines wos state cleanup with `git worktree remove`.

What it does, in order:

1. Tears down wos-deployed resources for the current worktree (containers, port assignments, registered tunnel routes).
2. Deletes persistent wos session artifacts for the current worktree under `<wos-home>/sessions/<session-name>`.
3. Invokes `git worktree remove` for the current worktree path.

```sh
# Remove the current secondary worktree if it is clean and linked.
wos worktree remove

# Force removal of a dirty or unlinked worktree (passes --force to git worktree remove).
wos worktree remove --force
```

Important constraints:

- The **source/primary worktree** cannot be removed through wos. The command must be run from inside a secondary worktree (use `--cwd <secondary-path>` if needed).
- `--force` is the same `--force` flag forwarded to `git worktree remove`. It lets you remove worktrees with uncommitted changes or worktrees Git considers unlinked. Do **not** use `--force` casually — uncommitted work in that worktree will be lost.
- Removal goes through the daemon, so the daemon must be reachable. If the daemon is unhealthy, fix that first (`wos-daemon`) before removing.

## Safe removal flow

1. Confirm with the user that the worktree should be deleted, including any uncommitted work.
2. Run `wos status` first to see what is currently deployed in the worktree.
3. Optionally run `wos down` if you want a clean Docker Compose shutdown observable to the user (the remove operation also tears down resources, but a prior `down` makes the change explicit).
4. Decide whether `--force` is required by checking the worktree's Git status (`git -C <path> status`, `git worktree list`). Prefer non-`--force` removal when the worktree is clean.
5. Run `wos --cwd <secondary-path> worktree remove [--force]` and report the outcome to the user.

## Common pitfalls

- **Running from inside the source worktree.** The remove command will refuse — wos will not delete the primary worktree.
- **Forgetting `--cwd`.** If you run `wos worktree remove` without changing directory or passing `--cwd`, wos operates on the **shell's current** worktree. Verify the target before running.
- **Confusing `wos down` with `wos worktree remove`.** `down` keeps wos state, generated compose files, and the worktree itself. `worktree remove` deletes all of it and removes the worktree from Git.

## Safety guidance

- Treat `wos worktree remove` as a **destructive** operation. Always confirm intent with the user and tell them the worktree directory will be removed by Git.
- Never combine `--force` with worktrees that contain uncommitted changes unless the user has explicitly accepted the loss.
- Never bypass wos by running `git worktree remove` directly when a deployment exists — wos needs to release ports, unregister tunnels, and clean session state. Run the wos command first.
- Always run `wos status` (and consider `wos down`) before remove for any worktree the user has been using recently.
