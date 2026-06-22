---
title: Architecture
description: A high-level view of how the CLI, daemon, runtime, and web UI fit together.
---

At a high level, WorktreeOS is a thin CLI and web UI over a local daemon that
owns all Docker operations and per-worktree state.

## The pieces

- **CLI (`apps/cli`)** — a launcher and text status tool. Worktree-scoped
  commands (`up`, `down`, `status`, `wait`, `worktree remove`) submit operations
  to the daemon over a Unix socket and stream results back. The CLI does not run
  Docker Compose directly.
- **Daemon (`packages/daemon`)** — the control plane. It owns Docker operations,
  session files, and service-log followers; coordinates mutating operations per
  session (one `up`/`down` at a time); serves multiple clients; and hosts the web
  listener.
- **Runtime (`packages/runtime`)** — the orchestration the daemon drives:
  `runUpProgram`, `runDownOperation`, first-run setup, caches, healthchecks,
  tunnels, and service logs.
- **Compose (`packages/compose`)** — Compose generation, the runner, the `ps`
  output parser, and the host-port allocator.
- **Core (`packages/core`)** — configuration parsing, paths, state, the event
  bus, git/worktree resolution, project-name derivation, and session context.
- **Web UI (`apps/web`)** — the React frontend the daemon serves on loopback. It
  observes operation progress, logs, and status, and offers stop/restart
  controls.

## Data flow for `wos up`

1. The CLI resolves the current worktree and submits an `up` operation to the
   daemon (auto-starting it if needed).
2. The daemon runs the runtime's `runUpProgram`: prepare → first-run setup →
   init script → `docker compose up` (via `packages/compose`) → status →
   healthcheck.
3. Progress, logs, and status flow over the event bus to every connected client
   — the CLI's stderr stream and any open web UI tabs.
4. State (project name, allocated host ports, the initialization flag) is
   persisted under `<wos-home>/sessions/<session-name>/`.

## Control plane vs. data plane

The daemon is the **control plane** — restarting it (`wos restart`) never stops
running containers. The Docker services are the **data plane** and persist
until an explicit `wos down`. This separation is why closing the web UI or
restarting the daemon leaves your deployment running.

## Related

- [Daemon and web UI](/concepts/daemon-and-web-ui/)
- [Storage and sessions](/reference/storage-and-sessions/)
- [Repository layout](/development/repository-layout/)
