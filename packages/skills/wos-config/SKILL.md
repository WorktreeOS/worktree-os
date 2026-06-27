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

## Deployment mode

This skill covers **generated mode** (the default; or explicit `mode: generated`) — the stable, fully supported mode. wos generates the Docker Compose file from `app`, `deps`, `clone_volumes`, and `host_ports`; app services run as Docker containers. Generated mode is required for selective startup (`wos up app,api`, `wos up --target <name>`) and app-port healthchecks.

Two other modes (`mode: compose` and `mode: shell`) are **early-preview** features — they may be unstable or not work at all, are out of scope for this skill, and are documented on the docs site. Assume generated mode unless the deploy config explicitly sets one of them.

Legacy fields (`volumes`, `init-script`, `publish`) are rejected with a migration error. If you see that error, the user must migrate to the current schema before running wos.

## Generated-mode concepts

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

If any source path is missing, `wos up` fails before init scripts and service startup. The worktree is not marked initialized on failure.

### Init scripts

`app.init_script` is an ordered list of shell commands. On first run (or with `--force`), wos executes them inside a container built from `app.image`. Each command runs in its own subshell, so `cd` in one command does not leak into the next.

Use the init script for installs, codegen, or database seeding the user wants wos to manage. Init scripts can be cached via the top-level `cache` field; see the wos spec for cache details when the user asks about cache behavior.

### Environment templates

wos resolves these templates inside service environment values before writing the generated Compose file:

- `${app.services.<name>.containerName}`, `${deps.<name>.containerName}` — deterministic container name (`<project>-<service>`).
- `${app.services.<name>.hostPort[<port>]}`, `${deps.<name>.hostPort[<port>]}` — wos-assigned host port.
- `${app.services.<name>.hostname[<port>]}` — tunnel hostname when global tunneling is active for that port, otherwise `localhost`. Dependency services do not support hostname templates.

Templates that reference unknown services or ports fail validation with an actionable error.

## Global setup: terminal backend (tmux vs default)

Separate from the per-repo deploy config, wos keeps a **global config** at `<wos-home>/config.json` (default `~/.wos/config.json`), written by `wos init` (see `wos-cli`). The `terminalBackend` setting controls how web/CLI terminal sessions are hosted:

- **`tmux`** (recommended): sessions run inside tmux (POSIX) or psmux (Windows), so they survive daemon restarts and reconnects. `wos init` detects tmux/psmux and, when missing, insistently offers to install it via a host package manager (`brew` / `apt` / `dnf` / `pacman` / `winget` / `scoop`).
- **`default`**: a direct PTY with no multiplexer. Used when tmux/psmux is unavailable or declined. It works but terminal sessions are less stable across reconnects.

When the effective backend is `default`, wos emits the literal warning **`Running outside tmux/psmux — terminal sessions may be unstable.`** at three points: in the `wos init` wizard (on declining tmux), on `wos start`, and in the web UI when a terminal session is created (a local accent, not global chrome). The `tmux` backend produces no warning. The experimental `host` backend is never offered by the wizard.

## Quick navigation

| Concept | Where to look in the deploy config |
| --- | --- |
| Deployment mode | top-level `mode:` (`app:` / `deps:` presence ⇒ generated) |
| Service names for selective startup | `app.services.*`, `deps.*` |
| Named groups | `targets.*` |
| Runtime arguments | `arguments` (passed with `--arg`) |
| Host port range | `host_ports.range` |
| App-port healthchecks | `app.services.<name>.ports` |
| First-run files | `clone_volumes`, `app.init_script` |

## Safety guidance

- Treat the deploy config as **user-owned configuration**. Do not edit it without asking, and prefer to surface validation errors verbatim so the user can decide on the fix.
- When you do not know which services exist, do not guess for `wos up app,api` — open the deploy config or ask the user.
- Defaults documented here are stable for current wos but may evolve. If output disagrees with defaults shown above, trust the output and the active wos spec, not this skill.
