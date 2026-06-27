---
title: Deploy configuration reference
description: Every top-level deploy-config key, the three deployment modes, and the template expressions available in environment values.
---

The deploy configuration lives in the source worktree's `.wos/` directory and
describes how to deploy each worktree:

- `.wos/deploy.yaml` configures the source/primary/root worktree.
- `.wos/deploy.worktree.yaml` configures every secondary worktree.

Both files live in the **source worktree** — secondary checkouts don't carry
their own copy. This page is a field index; the
[Configuration](/configuration/generated-mode/) section explains each area in
depth.

## Modes

The `mode` field selects the deployment mode:

- **`mode: generated`** (the default, may be omitted) — WorktreeOS generates the
  Docker Compose file from `app`, `deps`, and `host_ports`. See
  [Generated mode](/configuration/generated-mode/).
- **`mode: compose`** — WorktreeOS uses your existing Compose file via
  `compose.config` and publishes only the ports in `compose.expose`. The `app`
  and `deps` fields are forbidden. See [Compose mode](/configuration/compose-mode/).
- **`mode: shell`** — WorktreeOS runs `app.services` as host shell processes
  instead of Docker containers. Docker-only fields (`app.image`, per-service
  `image`/`volumes`, `deps`, package-manager cache mounts, `compose`) are
  forbidden. See [Shell mode](/configuration/shell-mode/).

:::caution[Early preview]
`mode: compose` and `mode: shell` are **early-preview** features — they may be
unstable or not work at all in some setups. `mode: generated` is the stable
default.
:::

## Top-level keys

| Key | Mode | Purpose |
| --- | --- | --- |
| `mode` | all | `generated` (default), `compose`, or `shell`. |
| `clone_volumes` | all | Files copied from the source worktree on first run. [→](/configuration/clone-volumes/) |
| `host_ports.range` | all | Host-port pool (`start`/`end`, default `20000..29999`). |
| `dynamic_ports` | all | Allocate host ports dynamically (`true`, default) or pin each declared port to a fixed host port (`false`). |
| `cache` | all | Global cache of first-run artifacts. [→](/configuration/cache/) |
| `app` | generated, shell | Init container (generated) or host processes (shell) + app services. |
| `deps` | generated | External dependencies. [→](/configuration/dependencies/) |
| `targets` | generated, shell | Named service sets for `--target`. [→](/configuration/targets/) |
| `arguments` | generated, shell | Runtime argument names for `--arg`. [→](/configuration/arguments/) |
| `compose` | compose | `config`, `expose`, `env_file`, `environment`. [→](/configuration/compose-mode/) |

## `app` fields (generated mode)

- `app.image` — default image for services and the one-shot init container.
- `app.init_script` — first-time init commands, run once per worktree (each in
  its own subshell).
- `app.connect_npm_cache` / `connect_yarn_cache` / `connect_bun_cache` — mount
  host package-manager caches into the init container read-write. `true` enables
  auto-detection; a string sets an explicit absolute or `~/...` path. Exposed
  inside the container via `NPM_CONFIG_CACHE`, `YARN_CACHE_FOLDER`,
  `BUN_INSTALL_CACHE_DIR`.

  ```yaml
  app:
    image: node:22
    connect_npm_cache: true
    connect_yarn_cache: "~/Library/Caches/Yarn/v6"
    connect_bun_cache: "~/.bun/install/cache"
    init_script:
      - bun install
  ```

### `app.services.<name>` fields

- `image` — per-service image override (init container still uses `app.image`).
- `script` — startup commands (joined with `&&`).
- `cwd` — container working directory for `script` (relative resolves inside
  `/workspace`; default `/workspace`).
- `init_script` — service-specific first-time commands, run after the global
  `app.init_script`, only when the service is in the final startup set.
- `ports` — container ports to publish; number or
  `{ port, healthcheck?, allow_failure? }`. [→](/configuration/healthchecks/)
- `dependencies` — names of services this one depends on. [→](/configuration/dependencies/)
- `volumes` — extra Docker Compose volume strings (beyond the `/workspace`
  mount).
- `env_file` — path to a `.env` file (relative resolves against the worktree).
- `environment` — environment variables (coerced to strings).

## `deps.<name>` fields (generated mode)

`image`, `environment`, `volumes`, and `ports` (numbers only; no healthcheck).

## `dynamic_ports`

`dynamic_ports` is a top-level boolean that defaults to `true`:

- **`true`** (default) — wos allocates host ports from `host_ports.range` and
  retries on conflict, so every worktree gets its own non-clashing ports.
- **`false`** — wos publishes/binds each declared managed port to the **same**
  host port, ignoring `host_ports.range`. Duplicate or unavailable ports fail
  instead of being reallocated.

`dynamic_ports: false` suits a fixed-port source/root worktree (for example a
shell-mode app that must bind a well-known port), while secondary worktrees keep
`dynamic_ports: true` so they can run side by side without port clashes.

## `compose` fields (compose mode)

- `compose.config` — path to the Docker Compose file (must exist at `wos up`).
- `compose.expose` — required, non-empty list; each entry is `service:port` or
  `{ name, port, tunnel? }`.
- `compose.env_file` — env files for the `docker compose` process (later files
  override earlier ones).
- `compose.environment` — inline variables overriding `env_file`, with template
  substitution.

## `app` fields (shell mode)

Shell mode reuses the `app.services` shape but runs each service as a host
process. Supported keys: `app.init_script` and, per service,
`app.services.<name>.{script, cwd, ports, env_file, environment, init_script,
dependencies}`. `script` is required. Docker-only keys (`app.image`,
per-service `image`/`volumes`, `deps`, `connect_*_cache`) are rejected. See
[Shell mode](/configuration/shell-mode/).

Each shell service automatically receives `WOS_SERVICE_PORT` and
`WOS_SERVICE_HOSTNAME` for its **first** configured port (the allocated host
port and its tunnel hostname / `localhost`). The process must bind the allocated
host port itself.

`WOS_SERVICE_PORT` and `WOS_SERVICE_HOSTNAME` are a shared cross-mode contract:
generated Docker mode injects the same pair into each app service container with
a configured port, and compose mode injects it for each `compose.expose` service
through the wos-owned overlay. The pair describes **only the first** managed
port and always overrides user-supplied values for those keys; for additional
ports use the exact `hostPort[<port>]` / `hostname[<port>]` templates below.

## Template expressions in `environment`

Templates may be embedded in plain text; references to non-existent services,
ports, or undeclared arguments fail before Docker Compose starts.

Generated mode:

- `${app.services.<service>.containerName}`
- `${app.services.<service>.hostPort[<containerPort>]}`
- `${app.services.<service>.hostname[<port>]}` — active tunnel hostname, or
  `localhost` when no tunnel is open. App services only, declared ports only.
- `${app.services.<service>.url[<port>]}` — full reachable URL (scheme, host
  and port): the public tunnel URL when a tunnel is open, otherwise
  `http://localhost:<hostPort>`. App services only, declared ports only.
- `${deps.<service>.containerName}`
- `${deps.<service>.hostPort[<containerPort>]}`
- `${ARG}` / `${ARG:-default}` — declared runtime arguments.

Compose mode:

- `${expose.<service>.hostPort[<port>]}`
- `${expose.<service>.hostname[<port>]}`
- `${expose.<service>.url[<port>]}` — full reachable URL, or
  `http://localhost:<hostPort>` when no tunnel is open.

Shell mode:

- `${app.services.<service>.hostPort[<port>]}` — allocated host port for a
  configured port.
- `${app.services.<service>.hostname[<port>]}` — active tunnel hostname for a
  configured port, or `localhost` when no tunnel is open.
- `${app.services.<service>.url[<port>]}` — full reachable URL for a configured
  port, or `http://localhost:<hostPort>` when no tunnel is open.
- `${ARG}` / `${ARG:-default}` — declared runtime arguments.

## Global configuration

Healthcheck timing defaults, the web UI port, and tunnel/SSL settings live in
`<wos-home>/config.json`, not in the deploy config. See
[Daemon behavior](/reference/daemon/) and
[Healthchecks](/configuration/healthchecks/).
