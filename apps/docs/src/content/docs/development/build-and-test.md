---
title: Build and test workflow
description: Install, run, build, and test WorktreeOS with Bun, including the docs site.
---

WorktreeOS uses Bun for everything — install, scripts, bundling, and tests.

## Install

```bash
bun install
```

installs workspace dependencies from the repository root.

## Run the CLI

```bash
bun run wos <command>
```

is equivalent to running `apps/cli/index.ts`.

## Build commands

- **`bun run build:web`** — build `apps/web` → `apps/web/dist`. The daemon
  serves static assets from there over loopback.
- **`bun run build:binary`** — build a single standalone executable `dist/wos`
  via `bun --compile`. It embeds the CLI, the daemon, the workspace packages,
  and the web UI; running it needs neither Bun, nor `apps/web/dist`, nor the
  source checkout. See [Release binary](/reference/release-binary/).
- **`bun run dist`** — build the web UI and restart the daemon.

## Docs site

The documentation site lives in `apps/docs` and uses Astro Starlight:

```bash
bun run --filter @worktreeos/docs dev      # local dev server
bun run --filter @worktreeos/docs build    # static build
bun run --filter @worktreeos/docs preview   # preview the build
```

## Tests

Run the full suite from the repository root:

```bash
bun test
```

The repository also exposes `bun run test`, which wraps `bun test` in
`scripts/run-tests.ts`. That wrapper provisions an isolated `WOS_HOME` temporary
directory for the run and cleans up test-owned Docker Compose processes
afterward, so tests don't touch your real `~/.wos`.

## Related

- [Repository layout](/development/repository-layout/)
- [Architecture](/development/architecture/)
