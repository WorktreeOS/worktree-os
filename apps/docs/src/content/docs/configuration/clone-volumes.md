---
title: Clone volumes
description: Copy files like .data or .env.local from the source worktree into a new worktree on first run.
---

`clone_volumes` is a list of paths copied from the **source worktree** to the
**current worktree** on the first `wos up`. Use it for local data and secrets
that aren't in Git but a new worktree needs to start.

```yaml
clone_volumes:
  - .data
  - .env.local
  - .env.local:.env
```

## Entry forms

Each entry can be:

- **a plain path** (for example, `.data`) — copies from the same relative path
  in the source worktree to the same relative path in the current worktree;
- **a `source:destination` mapping** (for example, `.env.local:.env`) — copies
  from `source` to `destination`. The separator is the first `:` in the string.

Relative `source` is resolved against the source worktree, relative
`destination` against the current worktree. Absolute paths are used as-is.
`destination` is the **exact target path**, not a directory into which `source`
is copied.

## Source worktree vs. secondary worktrees

- When `wos up` runs from the **source worktree** (source-worktree mode), the
  clone-volumes step is skipped entirely — the files are already in place.
  `wos up --force` in source-worktree mode also does **not** delete
  clone-volume destinations.
- In **secondary worktrees**, `wos up --force` removes each resolved
  destination (including absolute destination paths) before copying again.

## Order during first-run setup

`clone_volumes` are copied **first**, before cache restore and `app.init_script`.
See the [deployment lifecycle](/concepts/deployment-lifecycle/) for the full
ordering.

## Related

- [Worktrees](/concepts/worktrees/)
- [Cache](/configuration/cache/)
