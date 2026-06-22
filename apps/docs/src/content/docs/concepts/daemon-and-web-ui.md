---
title: Daemon and Web UI
description: The local daemon owns Docker operations and session state; the web UI is the main interface for logs, status, and controls.
---

WorktreeOS has two long-lived pieces beyond the CLI: a **local daemon** that
owns Docker operations, and a **web UI** that the daemon serves for observing
deployments.

## The local daemon

`wos up`, `wos down`, and `wos status` transparently use the local daemon via a
Unix socket at `<wos-home>/daemon.sock`. If the daemon is not running, the CLI
starts it in the background and waits for readiness through `/v1/health`.

The daemon:

- owns Docker operations, session files, and the followers for service logs;
- coordinates mutating operations (`up`/`down`) per session — only one can be
  active per session at a time;
- serves multiple clients (CLI and browser tabs) at once.

Closing the web UI or a CLI client does **not** stop Docker services or kill the
daemon-owned log followers. Services keep running until an explicit `wos down`.

There is **one daemon per `<wos-home>`**. Setting `WOS_HOME` gives each value its
own daemon, which isolates CI and local environments from each other. See
[Daemon behavior](/reference/daemon/) for lifecycle and troubleshooting details.

## The web UI as the main interface

Init logs, service logs, operation progress, deployment status, and control
buttons (down/restart) live in the web UI — not in the CLI. The CLI prints a
direct link to the current worktree's detail page after every successful
`wos up` and `wos up -d`, so you can open it immediately.

Open it any time with:

```bash
wos web
```

It listens on `http://127.0.0.1:4949` by default (loopback only). The port is
configurable via `web.port` in `<wos-home>/config.json`. If the daemon was built
without the web UI, or the port is busy at startup, the CLI still prints the
service table and reports that the web UI URL is unavailable.

## Optional remote access

By default the web UI is loopback-only HTTP. WorktreeOS can optionally expose a
public tunnel listener and a secret-protected public web UI, with optional
HTTPS. That surface is configured globally in `<wos-home>/config.json`, not in
the deploy config. See the [Deploy configuration reference](/reference/deploy-config/)
and [Daemon behavior](/reference/daemon/) for the relevant settings.

## Related

- [Using the web UI](/guides/web-ui/)
- [Deployment lifecycle](/concepts/deployment-lifecycle/)
