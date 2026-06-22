---
title: Daemon errors
description: Recover from daemon startup failures, stale sockets, and busy-session conflicts.
---

If a command mentions daemon startup, the socket, a connect failure, or a busy
session, the problem is in the control plane — not your deployment.

## Startup and connect failures

1. Run `wos restart`. It stops the current daemon (by the health-check PID),
   removes `daemon.sock` and `daemon.json`, starts a fresh instance, and waits
   for its health check. Docker services keep running.
2. If restart fails, run `wos start --foreground` in another terminal to inspect
   startup logs interactively.

A daemon that doesn't become healthy before the startup timeout usually points
at an environment problem (Docker not running, a missing image, a network
policy) outside WorktreeOS's control.

## Stale socket

If the socket exists but doesn't answer health, it's a leftover from a crashed
daemon. The CLI removes it and starts fresh on the next call. For an explicit
cleanup use `wos restart`, or remove the files manually:

```bash
rm <wos-home>/daemon.sock <wos-home>/daemon.json
```

## Busy session

Only one mutating operation (`up` or `down`) can be active per session. A
concurrent `up`/`down` responds with 409 and the active operation id; the CLI
writes `session <name> is busy (active op <id>)`:

- **Do not** retry in a loop, and **do not** run Docker Compose directly to
  bypass WorktreeOS.
- Wait for the in-flight operation to finish — watch the web UI or rerun
  `wos status` — or surface the conflict.

## Scope reminder

The daemon is scoped to the current `<wos-home>` (default `~/.wos`, overridden
by `WOS_HOME`). Lifecycle commands only affect that home's daemon — confirm the
environment when in doubt.

`wos stop` and `wos restart` are safe with respect to deployed services: they do
**not** stop containers. They do disrupt in-flight CLI operations attached to the
previous daemon, so don't run them mid-operation.

## Related

- [Daemon behavior](/reference/daemon/)
- [Daemon and web UI](/concepts/daemon-and-web-ui/)
