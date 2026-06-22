---
title: Using the web UI
description: Open the worktree detail page to watch logs, status, and operation progress, and to stop or restart a deployment.
---

The web UI is the main interface for observing deployments. Init logs, service
logs, operation progress, deployment status, and control buttons
(down/restart) all live there — the CLI is a launcher and a text status tool.

## Open it

```bash
wos web
```

This opens the daemon web UI in your default browser. The daemon starts
automatically if it is not already running. It listens on
`http://127.0.0.1:4949` by default (loopback only).

Print the URL without opening a browser:

```bash
wos web --no-open
```

The CLI also prints a direct link to the current worktree's **detail page**
after every successful `wos up` and `wos up -d`, so you can jump straight to it.

## What's on the detail page

- **Operation progress** for the running or last `up`/`down`.
- **Init logs** from `app.init_script` and first-run setup.
- **Service logs**, streamed live by daemon-owned followers.
- **Status** for each service, including published host ports and app-port
  healthcheck results.
- **Tunnel URLs** when global tunneling is enabled and routes are registered.
- **Controls** to stop (`down`) or restart the deployment.

Closing the browser tab does not stop Docker services or kill the log
followers — services keep running until an explicit `wos down`.

## Change the port

Set `web.port` in `<wos-home>/config.json` and run `wos restart`:

```jsonc
{
  "web": {
    "port": 4949
  }
}
```

If the port is busy at daemon startup, the web UI is disabled while the
Unix-socket API keeps working. Update the file and run `wos restart` to pick up
the change.

## Settings page

The web UI exposes a Settings page at `/settings` for managing every supported
`config.json` key — `web.port`, `web.public.*`, `tunnel.*`, and `healthcheck.*`
— without editing the file by hand. It validates submissions, writes formatted
JSON to `<wos-home>/config.json`, and shows a banner telling you to run
`wos restart` for the changes to take effect.

The Settings page and its backing API are **local-only**: requests reaching the
daemon through `web.public` are rejected with `403 forbidden`, and the Settings
nav is hidden in public sessions.

## Reaching the UI from outside WSL

If you run WorktreeOS inside WSL, see [WSL access](/guides/wsl-access/) for the
Windows port-forwarding setup.
