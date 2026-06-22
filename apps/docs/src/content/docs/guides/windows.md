---
title: Native Windows
description: Run the WorktreeOS daemon and CLI natively on Windows 10/11 without WSL — prerequisites, path rules, shell differences, and troubleshooting.
---

WorktreeOS runs natively on Windows 10/11. The daemon and CLI are ordinary
Windows processes started from PowerShell, Command Prompt, Windows Terminal, or
the standalone `wos.exe` — **no WSL is required** to host the daemon. Existing
macOS and Linux behavior is unchanged.

## Prerequisites

| For… | You need |
| --- | --- |
| Running from source | [Bun](https://bun.sh) for Windows, and Git |
| Running the release binary | `wos-<tag>-windows-amd64.exe` (no Bun required) — see [Release binary](/reference/release-binary/) |
| Worktree operations | Git (worktrees are a Git feature) |
| Docker-backed modes (`generated` / `compose`) | [Docker Desktop](https://www.docker.com/products/docker-desktop/) with the Docker Engine API enabled |
| Persistent terminal sessions (`terminalBackend: "tmux"`) | [psmux](https://github.com/psmux/psmux) — a tmux-command-compatible multiplexer built on ConPTY |
| Shell mode (`mode: shell`) | A supported shell: PowerShell, `pwsh`, or `cmd.exe` (all ship with Windows) |

### Installing psmux

psmux is only needed for the persistent (`tmux`) terminal backend. The default
terminal backend uses Windows ConPTY directly and needs no extra install.

```powershell
winget install psmux          # winget
scoop install psmux           # scoop
cargo install psmux           # cargo (builds from source)
```

`terminalBackend: "tmux"` transparently uses psmux on Windows — there is no
separate backend name to configure. Set `TMUX_BINARY` to override the resolved
multiplexer on any platform.

## Daemon discovery uses HTTP, not a socket

The daemon binds a local HTTP listener and writes its address to
`<wos-home>/daemon.json`. The CLI and Web UI discover the daemon by reading that
file and calling `GET /ui/v1/health` — there is **no Unix domain socket** on any
platform. If a daemon looks stuck, inspect or delete `daemon.json` (never a
`daemon.sock`). See [The daemon](/reference/daemon/).

### Bind host

`web.host` defaults to `127.0.0.1` (loopback only). Setting it to `0.0.0.0`
exposes the listener according to your machine's network configuration and
Windows Firewall rules. WorktreeOS does **not** add an automatic loopback check
for this setting — choose the bind host deliberately.

## Path rules

Windows paths contain a drive-letter colon (`C:`) and backslashes, both of which
collide with the `source:destination` mapping syntax. WorktreeOS understands
drive-letter paths, but the **object form** is the unambiguous, recommended way
to write a mapping on Windows.

### `clone_volumes`

```yaml
clone_volumes:
  # Single path — copied to the same relative location.
  - C:\shared\.env

  # Mapped, object form (recommended on Windows): no colon ambiguity.
  - source: C:\shared\.env
    destination: .env
```

A bare `C:\shared\.env` is treated as a single absolute path, not split at the
drive-letter colon. See [Clone volumes](/configuration/clone-volumes/).

### Generated-mode volumes

In [generated mode](/configuration/generated-mode/), a host path with a drive
letter (`C:\cache:/cache`) is parsed as `<host>:<container>` — the leading
`C:\` is recognized as the host path and only the **mapping** colon is split.

## Shell mode on Windows

In [`mode: shell`](/configuration/shell-mode/), services and init commands run as
**host processes** through a Windows-compatible shell instead of POSIX
`sh -lc`. Commands run in order and each runs isolated (a `cd` in one command
does not leak into the next), matching POSIX semantics — but you must write
**Windows-compatible commands** in `wos.yaml` (e.g. `dir` not `ls`,
`set FOO=bar` not `export FOO=bar`). For complex logic, prefer a multi-entry
command array over a single fragile one-liner. Service process trees are stopped
with `taskkill` after the grace window.

## Troubleshooting

**HTTP listener bind failure on startup.** Another process holds the port, or
`web.host` points at an address this machine cannot bind. Pick a free port or a
valid bind host and retry. The daemon refuses to start rather than bind silently
elsewhere.

**Stale daemon metadata.** If `wos` reports a daemon that is not actually
running, remove `<wos-home>/daemon.json` and start again. The daemon rewrites it
with a fresh `daemonId` on every start.

**Docker named-pipe errors.** Docker-backed modes connect to Docker Desktop over
`npipe:////./pipe/docker_engine`. If you see a connection diagnostic naming the
named pipe, confirm Docker Desktop is running. Set `DOCKER_HOST` to a
`npipe://` or `tcp://` endpoint to point at a different engine. Non-Docker
features keep working when Docker is unreachable.

**Terminal runtime unavailable.** The default backend needs ConPTY (`Bun.Terminal`)
and `taskkill`; the `tmux` backend additionally needs psmux on `PATH`. The error
names the missing prerequisite (for the `tmux` backend it names psmux and its
install channels).

**Process cleanup diagnostics.** Daemon-owned terminal and shell-mode process
trees are reaped with `taskkill /T`. If `taskkill` is unavailable the runtime
reports a clear diagnostic instead of leaking child processes.

## Known differences

Windows has no foreground-process-group concept (`tpgid`), so active-command
detection — which powers terminal auto-titles and unread heuristics — is
best-effort on Windows: metadata is **omitted rather than guessed** when the
process tree cannot be inspected.
