---
title: Services and ports
description: Declare service ports, volumes, env files, and environment variables, and reference generated container names and host ports.
---

In [generated mode](/configuration/generated-mode/), each app service declares
the container ports to publish, plus optional volumes, env files, and
environment variables. WorktreeOS assigns a stable host port for each container
port.

[Shell mode](/configuration/shell-mode/) reuses the same `app.services.<name>`
shape — `ports`, `env_file`, and `environment` work the same way — but runs each
service as a host process. There are no containers or `volumes`, and the service
process must bind the allocated host port itself (via `WOS_SERVICE_PORT` or the
`hostPort` template). See the shell-mode page for that contract.

## Ports

`app.services.<name>.ports` lists container ports for which WorktreeOS picks a
stable host port from `host_ports.range`. Each element is either a number
(container port) or an object with `port` (required), `healthcheck`, and
`allow_failure`:

```yaml
app:
  services:
    api:
      ports:
        - 3000                # default healthcheck GET / -> < 500
        - port: 3002
          healthcheck:
            url: /health
            status: 204
        - port: 4000
          healthcheck: false  # port without a check
        - port: 5000
          allow_failure: true # a failed check does not abort up
```

The healthcheck behavior is covered in detail under
[Healthchecks](/configuration/healthchecks/).

`deps.<name>.ports` takes **numbers only** — no healthcheck is performed for
dependency ports.

## Host port range

`host_ports.range` defines the pool host ports are assigned from
(default `20000..29999`):

```yaml
host_ports:
  range:
    start: 20000
    end: 29999
```

The range must be large enough for all configured port mappings.

## Stable container names and ports

`wos up` assigns each service a deterministic container name
`<projectName>-<serviceName>` (where `projectName` is `wos-<repo>-<hash>`) and a
stable host port per container port. Assignments are saved in the worktree state
and reused across runs while the port stays available; when unavailable,
WorktreeOS reallocates and may retry `docker compose up -d` (up to three
attempts).

Reference the generated values in a service's `environment`:

- `${app.services.<service>.containerName}`
- `${app.services.<service>.hostPort[<containerPort>]}`
- `${deps.<service>.containerName}`
- `${deps.<service>.hostPort[<containerPort>]}`

Templates can be embedded in plain text; references to non-existent services or
ports fail validation before Docker Compose starts.

```yaml
environment:
  DATABASE_URL: postgres://postgres:111111@${deps.db.containerName}:5432/api
  DB_HOST_PORT: ${deps.db.hostPort[5432]}
```

## Automatic service environment

In generated mode, each app service container with a configured port
automatically receives `WOS_SERVICE_PORT` and `WOS_SERVICE_HOSTNAME` for its
**first** configured port — the same convenience pair
[shell mode](/configuration/shell-mode/) provides, so service code can read it
without branching by runtime mode:

- **`WOS_SERVICE_PORT`** — the allocated host port for the first configured
  port. This is the host port (consistent with public routing), not necessarily
  the container port the process binds inside Docker.
- **`WOS_SERVICE_HOSTNAME`** — the active tunnel hostname for that port, or
  `localhost` when no tunnel is active.

These automatic `WOS_*` values are applied after the resolved `environment` and
always **override** user-supplied values for the same keys. Dependency
containers and app services without configured ports do not receive them. For
additional ports, reference them exactly with
`${app.services.<name>.hostPort[<port>]}` and
`${app.services.<name>.hostname[<port>]}`.

## Volumes

`app.services.<name>.volumes` is an optional list of Docker Compose volume
strings, added in addition to the automatic worktree mount at `/workspace`.
Relative host paths (starting with `./`) resolve against the current worktree;
absolute paths and named Docker volumes pass through unchanged.

```yaml
app:
  services:
    api:
      volumes:
        - ./.data/uploads:/workspace/uploads
        - api-cache:/cache
        - /host/sockets:/run/sockets
```

## Env files and environment

- **`app.services.<name>.env_file`** — an optional path to a `.env` file,
  emitted as `env_file` in the generated Compose. Relative paths resolve against
  the current worktree. Inline `environment` overrides values from `env_file`
  (standard Docker Compose semantics). WorktreeOS templates inside the `.env`
  file are **not** resolved — they work only in inline `environment`.

  ```yaml
  app:
    services:
      api:
        env_file: .env
        environment:
          NODE_ENV: development
  ```

- **`app.services.<name>.environment`** — environment variables for the service.
  Strings, numbers, and booleans are coerced to strings.

## Related

- [Dependencies](/configuration/dependencies/)
- [Healthchecks](/configuration/healthchecks/)
- [Arguments](/configuration/arguments/) — runtime values referenced in
  `environment`.
