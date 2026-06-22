---
title: Shell mode
description: Run app services as host shell processes with mode shell — no Docker images, containers, or volumes, while keeping the WorktreeOS lifecycle.
---

`mode: shell` runs your app services as **host shell processes** instead of
Docker containers. Use it for projects that already run locally with native
commands (`bun run dev`, `cargo run`, `python manage.py runserver`, …) and do
not need Docker images, dependency containers, or volumes.

Shell mode keeps the full WorktreeOS worktree lifecycle — first-run setup, clone
volumes, caches, service selection, targets, runtime arguments, host-port
allocation, healthchecks, tunnels, status, logs, and stop/restart actions — but
each service is started with `Bun.spawn` in its own process group rather than
through `docker compose`. There is no Docker daemon dependency.

Shell mode shares the `app.services` shape with [generated
mode](/configuration/generated-mode/), so the two pages overlap; this page
focuses on what differs because services run as host processes.

## A complete example

```yaml
mode: shell

clone_volumes:
  - .env.local

host_ports:
  range:
    start: 20000
    end: 29999

app:
  init_script:
    - bun install
  services:
    api:
      cwd: packages/api
      ports:
        - 3000
      script:
        - bun run dev
      env_file: .env
      environment:
        NODE_ENV: development
        DATABASE_URL: postgres://localhost:5432/api
    web:
      cwd: packages/web
      ports:
        - 5173
      script:
        - bun run dev
      dependencies:
        - api
      environment:
        API_URL: http://localhost:${app.services.api.hostPort[3000]}

targets:
  frontend:
    - web

arguments:
  - API_TOKEN
```

## Supported fields

Per-service fields under `app.services.<name>`:

- **`script`** — **required**; one or more startup commands. Commands are joined
  with `&&` and run via `sh -lc` in a detached process group from the worktree
  root (or the service `cwd`).
- **`cwd`** — working directory for `script` and the service `init_script`. A
  relative path resolves against the worktree root; an absolute path is used
  as-is. Defaults to the worktree root.
- **`ports`** — logical service ports WorktreeOS allocates host ports for. A
  number or `{ port, healthcheck?, allow_failure? }`, exactly as in generated
  mode. See [the port binding contract](#port-binding-contract) below.
- **`env_file`** — path to a `.env` file (relative resolves against the
  worktree). Loaded into the process environment before inline `environment`.
- **`environment`** — inline environment variables for the process. They
  override `env_file` and support WorktreeOS template substitution.
- **`init_script`** — first-time commands specific to one service, run on the
  host after the global `app.init_script` and only when the service ends up in
  the final startup set.
- **`dependencies`** — names of other services this one depends on (used for
  selective startup).

Supported related top-level sections:

- **`app.init_script`** — first-run commands, run once per worktree as host
  shell commands from the worktree root.
- [`clone_volumes`](/configuration/clone-volumes/) — files copied from the
  source worktree on first run.
- [`cache`](/configuration/cache/) — global cache of first-run artifacts.
- [`targets`](/configuration/targets/) — named service sets for selective
  startup.
- [`arguments`](/configuration/arguments/) — runtime arguments passed with
  `--arg`.
- `host_ports.range` — the pool host ports are allocated from.

## Rejected Docker-only fields

Because nothing runs in a container, fields that only make sense for Docker are
rejected with a clear validation error in shell mode:

- `app.image` and `app.services.<name>.image` — shell mode runs host processes,
  not images.
- `deps` — dependency containers are not available; run datastores yourself or
  declare them as additional `app.services`.
- `app.services.<name>.volumes` — there is no container filesystem to mount
  into.
- `connect_npm_cache`, `connect_yarn_cache`, `connect_bun_cache` — package
  manager cache mounts require a Docker build/run.

The `compose` section is also rejected; it belongs to
[compose mode](/configuration/compose-mode/).

## Port binding contract

A configured shell-service port is a **logical port** for which WorktreeOS
allocates a stable host port from `host_ports.range`. Nothing rewrites the
process's listening port, so **the service process must bind the allocated host
port itself**. To make that possible, WorktreeOS injects two convenience
variables into each service environment, describing its **first** configured
port:

- **`WOS_SERVICE_PORT`** — the allocated host port for the first configured
  service port.
- **`WOS_SERVICE_HOSTNAME`** — the resolved hostname for that port: the service
  tunnel hostname when tunnels are active, `localhost` otherwise.

These automatic `WOS_*` variables are written last, so they always win over
user-supplied values, and the `WOS_*` namespace is reserved. The same pair is a
shared cross-mode contract: Docker-backed
[generated mode](/configuration/generated-mode/) injects identical
`WOS_SERVICE_PORT` / `WOS_SERVICE_HOSTNAME` values into app service containers,
so the same service code works in both modes. The binding detail differs only
in that a shell process must bind the host port itself, whereas in Docker mode
the process binds the container port and WorktreeOS publishes the host port.

A typical single-port service reads `WOS_SERVICE_PORT` when it starts:

```yaml
app:
  services:
    api:
      ports:
        - 3000
      script:
        - bun run dev --port "$WOS_SERVICE_PORT"
```

For a service with **multiple ports**, `WOS_SERVICE_PORT` describes only the
first one. Reference the others exactly with templates in `environment`:

- `${app.services.<name>.hostPort[<port>]}` — the allocated host port for a
  specific configured port.
- `${app.services.<name>.hostname[<port>]}` — the active tunnel hostname for a
  specific configured port, or `localhost` when no tunnel is open.
- `${app.services.<name>.url[<port>]}` — the full reachable URL (scheme, host
  and port) for a specific configured port: the public tunnel URL when a tunnel
  is open, or `http://localhost:<hostPort>` otherwise.

```yaml
app:
  services:
    api:
      ports:
        - 3000
        - 9090
      script:
        - bun run serve --http "$WOS_SERVICE_PORT" --metrics "$METRICS_PORT"
      environment:
        METRICS_PORT: ${app.services.api.hostPort[9090]}
```

Templates and runtime arguments (`${NAME}` / `${NAME:-default}`) resolve before
the process starts; references to unknown services, unconfigured ports, or
undeclared arguments fail loudly.

## Related

- [Generated mode](/configuration/generated-mode/) — the Docker-backed
  counterpart sharing the `app.services` shape.
- [Services and ports](/configuration/services-and-ports/)
- [Healthchecks](/configuration/healthchecks/)
- [Deploy configuration reference](/reference/deploy-config/)
