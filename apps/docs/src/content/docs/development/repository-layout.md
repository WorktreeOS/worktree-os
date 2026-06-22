---
title: Repository layout
description: How the WorktreeOS Bun monorepo is organized across apps and packages.
---

WorktreeOS is organized as a Bun monorepo
(`workspaces: ["apps/*", "packages/*"]`).

## Apps

- **`apps/cli`** — the CLI (`@worktreeos/cli`); the `index.ts` entry point is
  the cross-platform `wos` bin (a `#!/usr/bin/env bun` shebang lets npm/Bun
  generate the right shim per OS). The CLI is a launcher and a text-based status
  tool on top of the daemon; the interactive UI is no longer part of the CLI.
- **`apps/web`** — the React frontend (`@worktreeos/web`), built with Bun's
  bundler from `index.html`. The web UI is the main interface for observing
  deployments.
- **`apps/docs`** — this Astro Starlight documentation site (`@worktreeos/docs`).

## Packages

- **`packages/core`** — configuration, paths, state, events, git/worktree,
  project-name, session-context.
- **`packages/compose`** — Compose generation, runner, `ps` parser, host-port
  allocator.
- **`packages/runtime`** — orchestration (`runUpProgram`, `runDownOperation`, …),
  setup, caches, healthchecks, tunnels, service logs.
- **`packages/daemon`** — daemon server/client/protocol, operation registry, web
  listener.
- **`packages/ui`** — formatting, log-format, host-link, and text renderers
  (`plainRenderer`, `detachedRenderer`).
- **`packages/skills`** — the [AI skills catalog](/reference/skills/).

## Related

- [Build and test workflow](/development/build-and-test/)
- [Architecture](/development/architecture/)
