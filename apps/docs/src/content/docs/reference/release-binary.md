---
title: Release binary
description: Build a single standalone wos executable that embeds the CLI, daemon, packages, and web UI.
---

WorktreeOS can be compiled into a single standalone executable with Bun's
`--compile`. The binary embeds the CLI, the daemon, the workspace packages, and
the web UI, so running it requires neither Bun, nor `apps/web/dist`, nor the
source checkout.

## Build it

```bash
bun run build:binary
```

This produces `dist/wos` via `bun --compile`.

## Release assets

Each tagged release publishes standalone executables for three platforms, built
with the same `build:binary` path (Bun cross-compiles every target):

| Platform | Asset |
| --- | --- |
| macOS arm64 | `wos-<tag>-macos-arm64` |
| Linux amd64 | `wos-<tag>-linux-amd64` |
| Windows amd64 | `wos-<tag>-windows-amd64.exe` |

The Windows `.exe` is smoke-tested on a native Windows runner before the release
is published, so a broken Windows build blocks the release.

### Running `wos.exe` on Windows

Run the executable directly from PowerShell or Command Prompt — no Bun, no WSL:

```powershell
.\wos-<tag>-windows-amd64.exe start
.\wos-<tag>-windows-amd64.exe up
```

Rename it to `wos.exe` and put it on your `PATH` to use it as `wos`. See the
[Native Windows guide](/guides/windows/) for prerequisites.

## What it includes

- The CLI entry point (`apps/cli`).
- The daemon and all workspace packages (`packages/*`).
- The built web UI.

Because the web UI is embedded, `wos web` works from the binary without a
separate `bun run build:web` step.

## Related

- [Build and test workflow](/development/build-and-test/)
- [Repository layout](/development/repository-layout/)
