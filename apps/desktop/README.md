# @worktreeos/desktop

Native desktop app for WorktreeOS, built on [Electrobun](https://electrobun.dev)
(Bun-native main process + system webview).

It is a thin native shell over the existing self-hosting daemon: on launch it
**adopts** a running daemon or **hosts** one in-process, then loads the same
`apps/web` UI over the daemon's loopback HTTP listener. No separate frontend, no
RPC — the frontend is byte-identical to the browser build.

See `openspec/changes/add-desktop-app/` for the proposal, design (decisions
D1–D8), and spec.

## Architecture

- **Adopt-or-host** (`src/daemon-host.ts`) — reuses `createDaemonBootstrap().discover()`;
  adopts a healthy daemon, hosts one in-process via `startDaemon()` when absent.
- **Loopback window** (`src/main.ts`) — system webview at `127.0.0.1:<port>`.
- **Tray-decoupled lifecycle** (`runtime.exitOnLastWindowClosed: false`) —
  closing the window keeps the daemon running; Quit stops it only when we host.
- **CLI provisioning** (`src/cli-provision.ts`) — keeps `wos` on PATH
  (idempotent, non-destructive) so agent hooks reach the daemon.
- **Finder-launch PATH** (`src/login-path.ts`) — resolves the login-shell PATH
  so the hosted daemon finds `git` / `docker` / `claude`.

## Build & run

Prerequisites: macOS 14+. Icon compilation needs Xcode Command Line Tools.

```sh
# From the repo root. Builds the web UI + the bundled `wos` binary, then packages.
bun run build:desktop

# Dev (requires apps/web/dist and dist/wos to exist — run build:web + build:binary first):
bun run --filter @worktreeos/desktop dev
```

## Support matrix

| Platform | Status |
| --- | --- |
| macOS 14+ (arm64/x64) | target |
| Windows 11+ | follow-up |
| Ubuntu 22.04+ | follow-up |

## Known follow-ups

- GUI spikes still to verify on a Mac: WKWebView over loopback HTTP (ATS),
  WebSocket/SSE, and the xterm WebGL addon.
- On-disk plugin-root resolution (`tasks.md` 7.2) — the daemon resolves plugin
  source dirs relative to its own module path; in a bundled app this likely
  needs a small daemon-side override. See the design note.
- Single-instance enforcement and Electrobun auto-update are not yet wired.
