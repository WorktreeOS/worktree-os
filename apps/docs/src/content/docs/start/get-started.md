---
title: Get Started
description: Install WorktreeOS, write a minimal deploy config, and run your first deployment with wos up, wos web, and wos down.
---

This page takes you from nothing to a running worktree: prerequisites, install,
a minimal deploy config, and your first `wos up`, `wos web`, and `wos down`.

## Prerequisites

- **[Bun](https://bun.sh)** — the monorepo and CLI run on Bun. (A standalone
  compiled binary is also available; see [Release binary](/reference/release-binary/).)
- **Docker** with **Docker Compose** — required for the Docker-backed
  [generated](/configuration/generated-mode/) and
  [compose](/configuration/compose-mode/) modes, which drive `docker compose`
  under the hood, so the Docker daemon must be running.
  [Shell mode](/configuration/shell-mode/) runs services as host processes and
  does not need Docker.
- **Git** — `wos` deploys the *current Git worktree*, so you run it from inside
  a checked-out repository.

## Install

The quickest path is a global install with Bun (Bun is the only runtime
requirement):

```bash
bun install -g @worktreeos/cli    # global install → `wos` on your PATH
```

Or run from a source checkout. Install workspace dependencies from the
repository root:

```bash
bun install
bun link            # optional: put `wos` on your PATH
```

You can then run the CLI through Bun:

```bash
bun run wos <command>
```

The rest of these docs write commands as `wos <command>`. If you have not put
`wos` on your `PATH` (via `bun install -g` or `bun link`), read that as
`bun run wos <command>`.

## Write a minimal deploy config

Add a `.wos/deploy.yaml` to the source worktree of your repository (secondary
worktrees are configured by `.wos/deploy.worktree.yaml` alongside it). The
smallest useful config describes one app service and the container port to
publish:

```yaml
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
```

This uses the default `mode: generated`: WorktreeOS generates the Docker Compose
file for you from the `app` section. `init_script` runs once per worktree, then
each service's `script` starts it. WorktreeOS picks a stable host port for
container port `3000`. See [Generated mode](/configuration/generated-mode/) for
the full set of fields.

## Run `wos up`

From inside the worktree:

```bash
wos up
```

`wos up` submits the deployment to the local daemon (starting it automatically
if needed), streams the steps — prepare → first-run setup → init script →
start (`docker compose up`, or host processes in
[shell mode](/configuration/shell-mode/)) → status → healthcheck — and on
success prints a service table with the published address for each port and the
worktree's detail-page URL in the web UI.

## Open the web UI with `wos web`

The web UI is the main place to watch logs, status, and progress:

```bash
wos web
```

This opens the daemon web UI in your browser (default `http://127.0.0.1:4949`).
The daemon starts automatically if it is not already running. Use
`wos web --no-open` to print the URL without launching a browser.

## Check status

```bash
wos status
```

shows the service state and published ports for the current worktree without
re-deploying.

## Stop with `wos down`

When you're done, stop the worktree's services:

```bash
wos down
```

In Docker-backed modes this stops and removes the worktree's containers; in
shell mode it terminates the host service processes. Either way it affects only
the current worktree; the local daemon keeps running for your other worktrees.

## Next steps

- [Run a worktree](/guides/run-a-worktree/) — the full day-to-day workflow.
- [Using the web UI](/guides/web-ui/) — what lives on the detail page.
- [Configuration](/configuration/generated-mode/) — services, ports,
  healthchecks, dependencies, and more.
