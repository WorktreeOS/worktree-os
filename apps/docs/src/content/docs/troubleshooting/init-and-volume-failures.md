---
title: Init and volume failures
description: Recover from clone_volumes copy errors and app.init_script failures during first-run setup.
---

First-run setup (and every `wos up --force`) copies `clone_volumes`, restores
caches, and runs `app.init_script`. Failures here leave the worktree
un-initialized — but they're safe to recover from.

## Clone-volume copy failures

A failure copying a `clone_volumes` source means the **source path does not
exist** in the source worktree. The error names the missing path.

- Confirm the source path exists in the source worktree (relative `source`
  paths resolve there).
- Remember that in source-worktree mode the copy step is skipped entirely.
- In secondary worktrees, `wos up --force` removes each resolved destination
  before copying again.

See [Clone volumes](/configuration/clone-volumes/).

## init_script failures

An `app.init_script` failure stops setup and leaves the worktree
**un-initialized**:

- The cache is **not** written when init fails (the save step only runs after
  init succeeds), so a half-built `node_modules` won't be cached.
- WorktreeOS retries init on the next `wos up` automatically — no extra flag
  needed.
- Each `init_script` command runs in its own subshell, so a `cd` in one line
  does not carry to the next. For monorepos, write `cd packages/<pkg> && yarn`
  on a separate line per package.

See the [deployment lifecycle](/concepts/deployment-lifecycle/) and
[Cache](/configuration/cache/).

## Cache lookups

A cache **miss** is not a failure — the target path is simply left as-is and
populated by `init_script`. Cache `key.files` must exist at initialization time;
a missing key file fails setup with the named path.

## Related

- [Clone volumes](/configuration/clone-volumes/)
- [Cache](/configuration/cache/)
- [Deployment lifecycle](/concepts/deployment-lifecycle/)
