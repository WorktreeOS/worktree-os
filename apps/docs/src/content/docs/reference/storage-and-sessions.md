---
title: Storage and sessions
description: The WorktreeOS home directory layout — global cache, per-worktree sessions, generated Compose files, and daemon files.
---

Every WorktreeOS-managed file lives under a shared root — the **WorktreeOS
home**. By default this is `~/.wos`. The `WOS_HOME` environment variable
overrides the root (both absolute paths and `~/...` are accepted).

## Layout under `<wos-home>`

- **`<wos-home>/cache/`** — global cache of [`cache[*]`](/configuration/cache/)
  entries, shared across worktrees.
- **`<wos-home>/sessions/<session-name>/`** — session for a specific worktree.
  `<session-name>` is deterministically derived from the absolute worktree path
  (the leading separator is dropped and the rest are replaced with `-`). For
  example, worktree `/var/www/repo-path` yields session `var-www-repo-path`.
- **`<wos-home>/daemon.sock`** — Unix socket the daemon listens on. Local
  clients only; no network port is opened.
- **`<wos-home>/daemon.json`** — metadata for the running daemon: pid, socket
  path, start time, protocol id, and (if the web listener came up) the web UI
  URL.
- **`<wos-home>/config.json`** — optional user configuration. See
  [Daemon behavior](/reference/daemon/).
- **`<wos-home>/certs/`** — persistent self-signed pairs and ACME state, when
  HTTPS is configured.

## Inside a session directory

- **`compose.yaml`** — the generated Docker Compose file for the worktree (only
  in `mode: generated`). `wos up` and `wos status` use this file; you don't edit
  it manually.
- **`compose-base.yaml`** and **`compose-overlay.yaml`** — WorktreeOS-owned files
  for `mode: compose`: a ports-stripped copy of the user Compose file and an
  overlay publishing WorktreeOS-managed ports. Rewritten on every `wos up`.
- **`state.json`** — worktree state: the initialization flag, project name, path
  to the Compose file, and allocated host ports.

Files inside a session are managed by WorktreeOS — you don't rewrite them or
check them into the repository.

## One home, one daemon

The daemon socket is bound to `<wos-home>`. If `WOS_HOME` is set, each value
gets its own daemon, which isolates CI and local environments from each other.

## Related

- [Worktrees](/concepts/worktrees/)
- [Daemon behavior](/reference/daemon/)
