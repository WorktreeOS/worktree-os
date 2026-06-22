---
title: Compose mode
description: Plug WorktreeOS into your existing docker-compose.yaml with mode compose, publishing only the ports you list.
---

`mode: compose` plugs WorktreeOS into your repository's existing Docker Compose
file instead of generating its own. Use it when your project already describes
its topology through `docker-compose.yaml` and you want WorktreeOS sessions,
status, logs, and the UI on top of it without duplicating definitions.

In this mode the `app` and `deps` fields are **forbidden**. `host_ports`,
`clone_volumes`, and `cache` continue to work.

## Example

```yaml
mode: compose

clone_volumes:
  - .env.local

host_ports:
  range:
    start: 20000
    end: 29999

compose:
  config: docker-compose.yaml
  expose:
    - api:3000
    - api:4000
    - name: web
      port: 5173
      tunnel: true
  env_file:
    - .env.compose
    - .env.compose.local
  environment:
    DEPLOY_TAG: dev
    API_HOST_PORT: ${expose.api.hostPort[3000]}
    WEB_HOSTNAME: ${expose.web.hostname[5173]}
    WEB_URL: ${expose.web.url[5173]}
```

## Fields

- **`compose.config`** — path to the Docker Compose file. Relative paths resolve
  against the worktree root; absolute paths are used as-is. The file must exist
  at `wos up` time, and the user-owned file itself is never overwritten.
- **`compose.expose`** — required, non-empty list of exposed ports. Each entry
  is either the string `service:port` or an object `{ name, port, tunnel? }`.
  Bare service names without a port (`api`) are **not** supported and cause a
  validation error (see migration below). Only these services appear in
  `wos status`, in the UI, have active log subscriptions, and accept
  stop/restart actions.
- **`compose.env_file`** — env files passed to the `docker compose` process.
  Loaded in order; later files override earlier ones. `KEY=value` lines, blank
  lines, and `#` comments are supported; unparseable lines fail with the file
  and line number.
- **`compose.environment`** — inline environment variables that override
  `compose.env_file`. They support WorktreeOS template substitution:
  `${expose.<service>.hostPort[<port>]}`,
  `${expose.<service>.hostname[<port>]}` and
  `${expose.<service>.url[<port>]}` (the full reachable URL — the public tunnel
  URL when a tunnel is open, otherwise `http://localhost:<hostPort>`).

## What WorktreeOS does in compose mode

- Assigns a stable host port for each `compose.expose` entry (same allocator and
  `host_ports` as generated mode).
- Writes two WorktreeOS-owned copies under `<wos-home>/sessions/<session>/`:
  - `compose-base.yaml` — a copy of your Compose file with `services.*.ports`
    removed (original publications are dropped to avoid cross-worktree
    conflicts);
  - `compose-overlay.yaml` — an overlay publishing only the `compose.expose`
    ports on WorktreeOS-assigned host ports.
- Runs Docker Compose with `-f compose-base.yaml -f compose-overlay.yaml` for
  every command (`up`, `down`, `ps`, `logs`, `stop`, `rm`).
- Resolves `compose.environment` after port allocation and tunnel preparation.
- Injects `WOS_SERVICE_PORT` and `WOS_SERVICE_HOSTNAME` into each
  `compose.expose` service through the WorktreeOS-owned overlay, describing the
  service's **first** exposed port (the allocated host port and its active
  tunnel hostname, or `localhost` when no tunnel is active). The overlay is
  merged after `compose-base.yaml`, so these wos-owned values win over any
  values set for the same keys in your Compose file.
- Registers tunnel routes for each `compose.expose` entry when tunneling is
  enabled and the run is not `--no-tunnel`.
- Retries `docker compose up -d` on a WorktreeOS-managed port conflict (up to
  three attempts), reallocating and rewriting the overlay each time.

## What compose mode does NOT do

- Does not modify the user-owned Compose file.
- Does not publish ports missing from `compose.expose`; any `services.*.ports`
  in the source file is dropped.
- Does not inject `compose.environment` into each container — that environment
  is the `docker compose ...` command environment only (useful for `${VAR}`
  substitution inside the Compose file), not a per-container injection
  mechanism. Per-container service variables come from the wos-owned overlay
  (`WOS_SERVICE_PORT` / `WOS_SERVICE_HOSTNAME`, above) and your Compose file.
- Does not run app-port healthchecks and does not execute `app.init_script`
  (the `app` and `deps` fields are forbidden here).
- Does not support selective startup — running with an explicit service list or
  a target in compose mode is rejected.

## Migrating from bare service names

Earlier versions accepted bare service names in `compose.expose`:

```yaml
compose:
  expose:
    - api
    - worker
```

Now every entry must specify a concrete container port:

```yaml
compose:
  expose:
    - api:3000
    - worker:5000
```

Bare names fail validation with a message stating the required `service:port`
format. If a service has multiple ports, list them as separate entries.
