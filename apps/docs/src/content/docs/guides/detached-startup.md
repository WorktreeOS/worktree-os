---
title: Detached startup
description: Submit a deployment to the daemon and return immediately with wos up -d, then watch progress in the web UI.
---

`wos up -d` means "submit the operation to the daemon and exit immediately." Use
it in scripts, pre-commit hooks, and CI where you need to push a deployment
without blocking the terminal.

## How it differs from foreground `wos up`

`wos up -d` sends the `up` operation to the daemon, prints a short "deployment
started in the background" message together with the worktree detail-page URL,
and exits. It does **not**:

- wait for deployment steps,
- print a final service table,
- request final status.

Watch further progress, logs, and service state in the web UI (`wos web`) or via
`wos status` / `wos wait`.

```bash
wos up -d
```

## Compatible flags

`-d` combines freely with the other `up` flags:

```bash
wos up -d --force
wos up -d --target backend
wos up -d --target lk-zup --arg API_URL=https://empl-stage.test-wa.ru
```

## A readiness gate for scripts

Because `-d` returns before services are ready, pair it with `wos wait` when a
later step depends on the deployment being up:

```bash
wos up -d
wos wait --timeout 3m
wos status
```

`wos wait` blocks until the deployment reports ready or the timeout elapses
(default `1m`; durations accept `ms` / `s` / `m` suffixes or a raw number of
milliseconds).

## Related

- [Run a worktree](/guides/run-a-worktree/)
- [Deployment lifecycle](/concepts/deployment-lifecycle/)
- [Arguments](/configuration/arguments/)
