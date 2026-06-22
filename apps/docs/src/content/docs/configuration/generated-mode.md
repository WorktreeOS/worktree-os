---
title: Generated mode
description: The default deploy-config mode — WorktreeOS generates the Docker Compose file from your app, deps, and host_ports sections.
---

The deploy config supports two deployment modes, selected by the `mode` field.
**Generated mode** (`mode: generated`, the default — you can omit `mode`) is the
one to start with: WorktreeOS generates the Docker Compose file itself from the
`app`, `deps`, and `host_ports` sections.

The alternative, [compose mode](/configuration/compose-mode/), reuses an
existing `docker-compose.yaml`.

## A complete example

```yaml
clone_volumes:
  - .data
  - .env.local

host_ports:
  range:
    start: 20000
    end: 29999

app:
  image: node:22
  init_script:
    - bun install
  services:
    api:
      ports:
        - 3000
      script:
        - bun dev
      volumes:
        - ./.data/uploads:/workspace/uploads
        - api-cache:/cache
      environment:
        NODE_ENV: development
        DATABASE_URL: postgres://postgres:111111@${deps.db.containerName}:5432/api
        DB_HOST_PORT: ${deps.db.hostPort[5432]}
    worker:
      image: python:3.12
      script:
        - python worker.py

deps:
  db:
    image: postgres:13
    ports:
      - 5432
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: 111111
      POSTGRES_DB: api
    volumes:
      - ./.data/postgres:/var/lib/postgresql/data
```

## The `app` section

- **`app.image`** — the default image for services that don't set their own
  `image`, and the image for the one-shot init container. Required if
  `app.init_script` is set or at least one service does not specify its own
  `image`.
- **`app.services.<name>.image`** — an optional per-service image override. The
  init container always uses `app.image`. If every service sets its own `image`
  and `app.init_script` is not configured, `app.image` may be omitted.
- **`app.init_script`** — first-time initialization commands, executed inside
  the container via `docker compose run --rm` once per worktree. Each command
  runs in its own subshell, so a `cd` in one command does not affect the next.
  For monorepo packages, write `cd packages/<pkg> && yarn` on a separate line
  per package:

  ```yaml
  init_script:
    - yarn install
    - cd packages/api && yarn
    - cd packages/app && yarn
  ```

- **`app.services.<name>.script`** — service startup commands (joined with
  `&&`).
- **`app.services.<name>.cwd`** — the container working directory for `script`.
  A relative path resolves inside `/workspace` (`packages/api` →
  `/workspace/packages/api`); an absolute path is used as-is. Defaults to
  `/workspace`.
- **`app.services.<name>.init_script`** — first-time commands specific to one
  service. They run after the global `app.init_script` and only when the service
  ends up in the final startup set. Requires `app.image`.

For ports, healthchecks, volumes, env files, and environment variables, see
[Services and ports](/configuration/services-and-ports/) and
[Healthchecks](/configuration/healthchecks/).

## The `deps` section

`deps.<name>` describes external dependencies (databases, caches, etc.) with
their own images, environment variables, volumes, and ports. `deps.<name>.ports`
takes numbers only and no healthcheck is performed for them. See
[Dependencies](/configuration/dependencies/).

## Host ports

`host_ports.range` is the range of host ports WorktreeOS assigns publications
from. The default is `20000..29999`. The range must be large enough for all
configured port mappings. See [Services and ports](/configuration/services-and-ports/).

## Dynamic ports

`dynamic_ports` is a top-level boolean that defaults to `true`: wos allocates
host ports from `host_ports.range` and retries on conflict, so every worktree
gets its own non-clashing ports.

Set `dynamic_ports: false` to publish/bind each declared managed port to the
**same** host port, ignoring `host_ports.range`. Duplicate or unavailable ports
then fail instead of being reallocated. This is well-suited to a fixed-port
source/root worktree (for example a shell-mode app that must bind a well-known
port), while secondary worktrees keep `dynamic_ports: true` so they can run side
by side without port clashes.

## Other top-level sections

- [`clone_volumes`](/configuration/clone-volumes/) — files copied from the
  source worktree on first run.
- [`cache`](/configuration/cache/) — global cache of first-run artifacts.
- [`targets`](/configuration/targets/) — named service sets for selective
  startup.
- [`arguments`](/configuration/arguments/) — runtime arguments passed with
  `--arg`.

For every field in one place, see the [Deploy configuration reference](/reference/deploy-config/).
