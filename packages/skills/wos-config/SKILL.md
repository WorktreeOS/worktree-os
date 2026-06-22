---
name: wos-config
description: Deploy-config concepts an AI agent needs to operate the wos CLI safely — modes, services, ports, healthchecks, and clone volumes.
tags: [cli, config, deploy-config]
---

# wos-config

Use this skill when you need to **read or reason about the deploy config** while operating the CLI. It focuses on the concepts an agent needs to understand commands like `wos up app,api` or to interpret healthcheck output — not on writing a full configuration from scratch.

## When to use this skill

- The user mentions the deploy config, service names, healthchecks, host ports, clone volumes, init scripts, or target groups.
- You need to interpret a wos validation error.
- You need to choose service names for `wos up <services>` or `wos up --target <name>`.

## Where the files live

- The deploy config lives in the **primary/source worktree**'s `.wos/` directory: `.wos/deploy.yaml` configures the source/root worktree, and `.wos/deploy.worktree.yaml` configures every secondary worktree.
- wos reads it **fresh from disk on every command** — there is no separate "reload" step.
- Secondary worktrees do not carry their own copy; wos still reads both files from the primary worktree.

If a worktree-scoped command fails with a "config not found" error, the missing file is in the primary worktree's `.wos/` directory, not the current secondary worktree.

## Deployment modes

wos supports three modes:

- **Generated compose** (default; or explicit `mode: generated`). wos generates the Docker Compose file from `app`, `deps`, `clone_volumes`, and `host_ports`. App services run as Docker containers. Required for selective startup (`wos up app,api`, `wos up --target <name>`) and app-port healthchecks.
- **Explicit compose** (`mode: compose`). wos uses a user-provided Compose file (`compose.config`) plus an overlay for exposed ports and env. Selective startup and app-port healthchecks are not supported; `wos status` only shows services listed in `compose.expose`.
- **Shell** (`mode: shell`). wos runs each `app.services.<name>` as a **host shell process** (started with `Bun.spawn` in its own process group) instead of a Docker container. There is no Docker daemon dependency. It keeps the full worktree lifecycle — first-run setup, clone volumes, caches, selective startup, targets, runtime arguments, host-port allocation, app-port healthchecks, tunnels, and status/logs/stop/restart.

Mode selection: use **generated** for Dockerized apps with managed dependency containers (the default and most capable mode); **compose** when the user owns a hand-written Compose file wos should not rewrite; **shell** for projects that already run locally with native commands (`bun run dev`, `cargo run`, `python manage.py runserver`) and do not want Docker images, dependency containers, or volumes.

If you are unsure which mode the user is in, look at the top of the deploy config for a `mode:` key, or for the presence of `compose:` (compose mode) vs `app:` / `deps:` (generated mode). Shell mode is always explicit (`mode: shell`).

Legacy fields (`volumes`, `init-script`, `publish`, `compose` without `mode: compose`) are rejected with a migration error. If you see that error, the user must migrate to the current schema before running wos.

## Generated-compose concepts (most common)

### Services: `app` and `deps`

- `app.image` is the default image for app services. Each entry under `app.services.<name>` is an app service. A service can override the image with `app.services.<name>.image`.
- Each app service can declare `script` (commands run inside the mounted worktree), `environment`, `env_file`, and `ports`.
- `deps.<name>` declares dependency services (databases, caches). They use their own image and configured environment/volumes/ports.

When you run `wos up app,api`, the names map to keys under `app.services` and `deps`. wos includes transitive dependencies automatically.

### Targets

- `targets.<name>` declares a named set of services. `wos up --target <name>` deploys that target plus its transitive dependencies.
- Use targets when the user has a stable group they refer to by name (for example, `--target backend`).

### Ports and host port range

- Container ports are declared per service under `ports`. Numeric entries (`3000`) use defaults; object entries can disable or customize healthchecks (see below).
- wos publishes container ports with **wos-assigned host ports** from `host_ports.range` (default `20000..29999`).
- Host ports are persisted in the worktree's session state and reused across runs when still valid. wos retries on bind conflicts automatically.

### App-port healthchecks (generated mode only)

A numeric port like `3000` gets these defaults:

- URL: `/`
- Expected HTTP status: `200`
- Total timeout: `60000` ms
- Start period: `10000` ms
- Interval: `10000` ms
- Retries: `3`
- `allow_failure`: `false`

Custom configuration:

```yaml
app:
  services:
    api:
      ports:
        - { port: 3000, healthcheck: { url: "/health/check", status: 204, timeout: "45s", start_period: "5s", interval: "2.5s", retries: 5 } }
        - { port: 4000, healthcheck: false }
        - { port: 5000, allow_failure: true }
```

- `healthcheck: false` disables the check (`disabled` in status output).
- `allow_failure: true` makes a failed check non-fatal but still surfaced as `failed (allowed)`.
- Dependency ports (`deps.<name>.ports`) are **numeric only** — they do not support healthchecks.

### Clone volumes

`clone_volumes` lists files or directories to copy from the source worktree into the current worktree on first run (or every time when `--force` is used).

Forms:

- `path/to/file` — copies from the same relative path in the source worktree.
- `src/path:dst/path` — copies `src/path` (in the source worktree) to `dst/path` (in the current worktree).
- Either side may be an absolute path.

If any source path is missing, `wos up` fails before init scripts and service startup (Docker Compose in generated/compose modes, host processes in shell mode). The worktree is not marked initialized on failure. `clone_volumes` works identically across all modes.

### Init scripts

`app.init_script` is an ordered list of shell commands. On first run (or with `--force`), wos executes them inside a container built from `app.image` in generated/compose modes, or directly on the host from the worktree root in shell mode. Each command runs in its own subshell, so `cd` in one command does not leak into the next.

Use the init script for installs, codegen, or database seeding the user wants wos to manage. Init scripts can be cached via the top-level `cache` field; see the wos spec for cache details when the user asks about cache behavior.

### Environment templates

wos resolves these templates inside service environment values before writing the generated Compose file:

- `${app.services.<name>.containerName}`, `${deps.<name>.containerName}` — deterministic container name (`<project>-<service>`).
- `${app.services.<name>.hostPort[<port>]}`, `${deps.<name>.hostPort[<port>]}` — wos-assigned host port.
- `${app.services.<name>.hostname[<port>]}` — tunnel hostname when global tunneling is active for that port, otherwise `localhost`. Dependency services do not support hostname templates.

Templates that reference unknown services or ports fail validation with an actionable error.

## Compose-mode concepts

When the user is in `mode: compose`:

- `compose.config` points to the user-owned Compose file. wos never rewrites it.
- wos writes a sanitized base file and an overlay (managed exposed ports, env). Both are used at startup.
- `compose.expose` lists service names to surface in `wos status`. Services not in this list are hidden from status output.
- `compose.env_file` and `compose.environment` provide overlay env. Inline `environment` overrides values from `env_file`.

Selective startup and app-port healthchecks are not available in compose mode. Use `wos status` to see what is exposed.

## Shell-mode concepts

When the user is in `mode: shell`, each `app.services.<name>` is a host process, not a container. The `app.services` shape is the same as generated mode, so most concepts (services, targets, healthchecks, clone volumes) carry over; the differences below are what changes because nothing runs in Docker.

### Supported shell-service fields

Per-service fields under `app.services.<name>`:

- **`script`** — **required**. One or more startup commands, joined with `&&` and run via `sh -lc` in a detached process group from the worktree root (or `cwd`).
- **`cwd`** — working directory for `script` and the service `init_script` (relative resolves against the worktree root; absolute is used as-is).
- **`ports`** — logical service ports wos allocates host ports for. A number or `{ port, healthcheck?, allow_failure? }`, exactly as in generated mode.
- **`env_file`** — `.env` file loaded into the process environment before inline `environment`.
- **`environment`** — inline env vars; they override `env_file` and support the same template substitution as generated mode.
- **`init_script`** — first-time commands specific to one service, run on the host after the global `app.init_script` and only when the service ends up in the final startup set.
- **`dependencies`** — names of other app services this one depends on (used for selective startup; wos pulls in transitive dependencies automatically).

### Supported related top-level sections

- **`app.init_script`** — first-run commands, run once per worktree as host shell commands from the worktree root (not in a container).
- **`clone_volumes`** — files copied from the source worktree on first run.
- **`cache`** — global cache of first-run artifacts.
- **`targets`** — named service sets for selective startup (`wos up --target <name>`).
- **`arguments`** — runtime arguments passed with `--arg`.
- **`host_ports.range`** — the pool host ports are allocated from.

### Rejected Docker-only fields

Because nothing runs in a container, these fields fail validation in shell mode:

- `app.image` and `app.services.<name>.image` — shell mode runs host processes, not images.
- `deps` — dependency containers are not available; run datastores yourself or declare them as additional `app.services`.
- `app.services.<name>.volumes` — there is no container filesystem to mount into.
- `connect_npm_cache`, `connect_yarn_cache`, `connect_bun_cache` — package-manager cache mounts require a Docker build/run.
- `compose` — belongs to compose mode.

### Shell-mode port binding

A configured shell-service port is a **logical port** for which wos allocates a stable host port. Nothing rewrites the process's listening port, so **the service process must bind the allocated host port itself** (unlike Docker modes, where the process binds the container port and wos publishes the host port).

wos injects two convenience variables describing the service's **first** configured port:

- **`WOS_SERVICE_PORT`** — the allocated host port for the first configured service port.
- **`WOS_SERVICE_HOSTNAME`** — the resolved hostname: the tunnel hostname when tunnels are active, `localhost` otherwise.

The `WOS_*` variables are written last, so they always win over user-supplied values. The same pair is also injected into generated-mode containers, so service code works across both modes. For a service with multiple ports, `WOS_SERVICE_PORT` covers only the first; reference the others with exact templates in `environment`:

- `${app.services.<name>.hostPort[<port>]}` — the allocated host port for a specific configured port.
- `${app.services.<name>.hostname[<port>]}` — the active tunnel hostname for a specific configured port, or `localhost` when no tunnel is open.

## Global setup: terminal backend (tmux vs default)

Separate from the per-repo deploy config, wos keeps a **global config** at `<wos-home>/config.json` (default `~/.wos/config.json`), written by `wos init` (see `wos-cli`). The `terminalBackend` setting controls how web/CLI terminal sessions are hosted:

- **`tmux`** (recommended): sessions run inside tmux (POSIX) or psmux (Windows), so they survive daemon restarts and reconnects. `wos init` detects tmux/psmux and, when missing, insistently offers to install it via a host package manager (`brew` / `apt` / `dnf` / `pacman` / `winget` / `scoop`).
- **`default`**: a direct PTY with no multiplexer. Used when tmux/psmux is unavailable or declined. It works but terminal sessions are less stable across reconnects.

When the effective backend is `default`, wos emits the literal warning **`Running outside tmux/psmux — terminal sessions may be unstable.`** at three points: in the `wos init` wizard (on declining tmux), on `wos start`, and in the web UI when a terminal session is created (a local accent, not global chrome). The `tmux` backend produces no warning. The experimental `host` backend is never offered by the wizard.

## Quick navigation

| Concept | Where to look in the deploy config |
| --- | --- |
| Deployment mode | top-level `mode:` (or `compose:` / `app:` presence) |
| Service names for selective startup | `app.services.*`, `deps.*` |
| Named groups | `targets.*` |
| Runtime arguments | `arguments` (passed with `--arg`) |
| Host port range | `host_ports.range` |
| App-port healthchecks | `app.services.<name>.ports` |
| First-run files | `clone_volumes`, `app.init_script` |
| Env file (compose mode) | `compose.env_file`, `compose.environment` |
| Shell-mode service fields | `app.services.<name>.script` / `cwd` / `dependencies` (see Shell-mode concepts) |
| Shell-mode rejected fields | `app.image`, `deps`, service `image` / `volumes`, `connect_*_cache`, `compose` |
| Shell-mode port binding | `WOS_SERVICE_PORT` / `WOS_SERVICE_HOSTNAME`, `${app.services.<name>.hostPort[<port>]}` |

## Safety guidance

- Treat the deploy config as **user-owned configuration**. Do not edit it without asking, and prefer to surface validation errors verbatim so the user can decide on the fix.
- When you do not know which services exist, do not guess for `wos up app,api` — open the deploy config or ask the user.
- Defaults documented here are stable for current wos but may evolve. If output disagrees with defaults shown above, trust the output and the active wos spec, not this skill.
