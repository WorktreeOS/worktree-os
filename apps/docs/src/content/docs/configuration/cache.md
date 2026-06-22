---
title: Cache
description: Cache first-run initialization artifacts like node_modules globally, keyed explicitly or by lockfile contents, and reuse them across worktrees.
---

`cache` is a list of global cache entries for first-run initialization artifacts
(for example, `node_modules`). Each entry binds an identifying key to one or more
relative paths inside the worktree. The cache is stored globally under
`<wos-home>/cache` and reused across worktrees.

## Entry fields

- **`key: <string>`** — an explicit string key. Use it when dependencies are
  determined by a tool version (for example, `ruby-bundle-v1`).
- **`key.files: [<rel-path>, ...]`** — a list of files inside the worktree (for
  example, `yarn.lock`) from which WorktreeOS deterministically computes the key.
  All files must exist at initialization time; otherwise setup fails.
- **`paths: [<rel-path>, ...]`** — paths whose content should be cached. Must be
  relative and stay within the worktree. Wildcard patterns are supported (for
  example, `packages/*/node_modules`) — on save/restore they expand to concrete
  paths that exist in the worktree.

## Examples

```yaml
cache:
  - key:
      files:
        - yarn.lock
    paths:
      - node_modules
  - key: ruby-bundle-v1
    paths:
      - vendor/bundle
  # Monorepo: cache node_modules of every package with a single entry
  - key:
      files:
        - yarn.lock
    paths:
      - packages/*/node_modules
```

## How the cache fits into first-run setup

During first-run initialization (and every `wos up --force`):

1. `clone_volumes` are copied (skipped in source-worktree mode).
2. For every `cache` entry, WorktreeOS looks up the global cache under the
   computed key. On a **hit**, the target paths are replaced by the cached copy;
   on a **miss**, the path is left as-is.
3. `app.init_script` runs.
4. After `app.init_script` **succeeds**, every existing `paths` entry is
   atomically saved into the global cache. If init fails, the cache is **not**
   written and the worktree remains uninitialized.

This restore-before-init / save-after-successful-init order is the same under
`wos up --force`.

## Related

- [Deployment lifecycle](/concepts/deployment-lifecycle/)
- [Clone volumes](/configuration/clone-volumes/)
