---
title: Run a worktree
description: The day-to-day workflow for deploying, inspecting, and stopping the current Git worktree with wos.
---

This is the everyday loop for a single worktree: bring it up, watch it, and
stop it.

## Bring it up

From inside the worktree:

```bash
wos up
```

`wos up` is a non-interactive launcher. The CLI submits the `up` operation to
the local daemon (starting it if needed), streams deployment steps and service
logs to stderr (Docker Compose logs in Docker-backed modes), and shows an
active-phase spinner. On success it prints a service table with published
addresses to stdout and the worktree detail-page URL in the web UI, then exits.
Services keep running until an explicit `wos down`.

If the daemon was built without the web UI, or `web.port` is not bound, the CLI
still prints the service table and reports that the web UI URL is unavailable.

### Force a fresh first run

```bash
wos up --force
```

`--force` re-runs first-run setup: it restores caches, re-runs `app.init_script`,
and (in secondary worktrees) removes and re-copies `clone_volumes` destinations
before copying again. See the [deployment lifecycle](/concepts/deployment-lifecycle/).

## Check state

```bash
wos status
```

shows the managed services, their status, published host ports, and app-port
healthcheck results for the current worktree — without re-deploying. If the
worktree has no session yet, it reports that no deployment has been initialized;
run `wos up` first.

## Wait for readiness

```bash
wos wait --timeout 3m
```

`wos wait` blocks until the current worktree deployment reports ready, or until
the timeout elapses (default `1m`). Durations accept a raw number of
milliseconds or `ms` / `s` / `m` suffixes. This is the deterministic readiness
gate to use after detached startup or in scripts.

## Target another worktree

Every worktree-scoped command accepts the global `--cwd <path>` option, which
must appear **before** the subcommand:

```bash
wos --cwd /var/www/feature-login status
wos --cwd /var/www/feature-login up app,api
wos --cwd /var/www/feature-login down
```

Prefer `--cwd` over `cd` in scripts: it keeps your working directory stable and
produces clearer command logs.

## Stop it

```bash
wos down
```

stops the WorktreeOS services for the current worktree — removing the containers
in Docker-backed modes, or terminating the host processes in
[shell mode](/configuration/shell-mode/). It keeps the worktree's session state,
generated Compose file, and the worktree itself — contrast this with
[removing a worktree](/guides/remove-a-worktree/).

## Related

- [Selective startup](/guides/selective-startup/)
- [Detached startup](/guides/detached-startup/)
- [Using the web UI](/guides/web-ui/)
