<div align="center">

# WorktreeOS

**One control plane for every worktree, every project, every agent.**

Navigate every worktree, run agents in integrated terminals, stay informed,
review and ship your Git changes, deploy with Docker Compose, and expose any
service — all from one place.

![Platforms](https://img.shields.io/badge/platforms-macOS%20·%20Linux%20·%20Windows-555)
![Runtime](https://img.shields.io/badge/runtime-Bun-000)
![Status](https://img.shields.io/badge/status-pre--release%20v0.0.1-orange)

[⚡ Quick Start](#-quick-start) • [🧭 Capabilities](#-capabilities) • [💻 CLI](#-the-wos-cli) • [📖 Docs](apps/docs) • [🐙 GitHub](https://github.com/WorktreeOS/worktree-os)

</div>

> **Early development (v0.0.1).** WorktreeOS works today for local, parallel,
> agent-driven development. Native remote authentication and a productized
> "install on your servers" story are still on the [roadmap](#-roadmap).

## 🤔 Why WorktreeOS?

**Parallel, agent-driven development gets messy fast:**

- ❌ **Many worktrees, no single view** — you lose track of what's running where.
- ❌ **Agents scattered across terminal tabs** — easy to miss when Claude Code or Codex needs you.
- ❌ **Every worktree needs its own compose file** — and ports collide between them.
- ❌ **Sharing a preview is manual** — tunnels, certificates, DNS.
- ❌ **You learn a deploy failed only when you go looking.**
- ❌ **Chained to your desk** — step away and you can't check a run or unblock an agent.

**WorktreeOS gives you one control plane:**

- ✅ **Control from anywhere** — drive your terminals, agents, and deploys from your phone or any browser, remotely.
- ✅ **See everything** — Mission Control and a worktree board show every worktree of every project with live status.
- ✅ **Work where the code lives** — agent-integrated terminals (Claude Code, Codex, OpenCode) next to each worktree.
- ✅ **Stay informed** — notifications when an agent needs you or a deploy changes state (Telegram · Web Push · Sound).
- ✅ **Ship from the UI** — review your Git changes and commit with a generated message.
- ✅ **Deploy with one command** — `wos up` builds the Compose file for you and allocates host ports automatically.
- ✅ **Expose anything** — publish a service over an HTTPS tunnel with one flag.

> **🎮 Remote control — the killer feature.** Expose the web UI through a tunnel
> and your entire workspace — terminals, agents, deploys, logs — is in any
> browser on any device, behind a shared-secret HTTPS login. Your dev machine,
> in your pocket.

## ⚡ Quick Start

**Install the `wos` binary** (no Bun, no source checkout required):

```bash
# macOS · Linux
curl -fsSL https://raw.githubusercontent.com/WorktreeOS/worktree-os/main/install.sh | sh
```

```powershell
# Windows (PowerShell) — native, no WSL
irm https://raw.githubusercontent.com/WorktreeOS/worktree-os/main/install.ps1 | iex
```

**Deploy your first worktree** — run from inside any Git checkout:

```bash
cd your-repo
wos up        # deploy the current worktree via Docker Compose
wos web       # open the dashboard at http://127.0.0.1:4949
wos down      # stop and remove its containers
```

`wos up` generates the Compose file from `.wos/deploy.yaml`, allocates a stable
host port per service, runs healthchecks, and prints the worktree's detail-page
URL in the web UI. See [Get started](apps/docs/src/content/docs/start/get-started.md)
for a minimal config and a full walkthrough.

<details>
<summary><b>🧰 Run from source instead</b></summary>

```bash
git clone https://github.com/WorktreeOS/worktree-os
cd worktree-os
bun install
bun run wos up          # run the CLI through Bun
bun run build:binary    # or compile a standalone dist/wos
```

</details>

## 🧭 Capabilities

WorktreeOS layers its features around the day in the life of parallel
development — find work, do work, stay informed, ship, run, expose:

| | Capability | What it does |
|---|---|---|
| 👀 | **SEE** | Mission Control + worktree board — navigate every worktree of every project. |
| ⌨️ | **WORK** | Terminals with integrated agents — Claude Code, Codex, OpenCode. |
| 🔔 | **KNOW** | Notifications — Telegram · Web Push · Sound. |
| 🚢 | **SHIP** | Git review + auto-generated commit message. |
| 🐳 | **RUN** | Docker Compose deploy + automatic host-port allocation. |
| 🌐 | **EXPOSE** | Public HTTPS tunnels — self-signed, your own certs, or Let's Encrypt. |

The `wos` CLI focuses on **RUN** and **EXPOSE**; the **SEE / WORK / KNOW / SHIP**
capabilities live in the web UI (`wos web`).

## 💻 The `wos` CLI

| Command | Description |
|---|---|
| `wos up` | Deploy the current worktree, stream steps and logs, print a service table. |
| `wos up -d` | Submit the deployment and return immediately; watch progress in the web UI. |
| `wos down` | Stop and remove this worktree's containers. |
| `wos status` | Show service state and published ports. |
| `wos exec <service> -- <cmd>` | Run a command inside a running service (like `docker compose exec`). |
| `wos web [--no-open]` | Open (or just print) the dashboard URL. |
| `wos start` · `wos stop` · `wos restart` | Manage the local daemon. |

`up`, `down`, and `status` talk to a local daemon over HTTP (`http://127.0.0.1:4949`
by default), starting it automatically if needed. The daemon owns Docker
operations, sessions, and log followers, and serves multiple clients at once.
Selective startup (`wos up app,api`, `wos up --target backend`), runtime
arguments (`--arg KEY=VALUE`), and `--force` / `--no-tunnel` are documented in
the [CLI reference](apps/docs/src/content/docs/reference/cli.md).

## 🖥️ Supported platforms

Runs natively on macOS, Linux, and Windows 10/11 — **no WSL required** for the
Windows daemon. The daemon control plane is HTTP on every platform.

| Platform | Daemon + CLI | Default terminal | Persistent terminal | Docker modes |
|---|---|---|---|---|
| macOS arm64 | ✅ | ✅ PTY | tmux | ✅ Unix socket |
| Linux amd64 | ✅ | ✅ PTY | tmux | ✅ Unix socket |
| Windows amd64 | ✅ native (no WSL) | ✅ ConPTY | psmux | ✅ Docker Desktop named pipe |

Windows prerequisites and path/shell differences live in the
[Native Windows guide](apps/docs/src/content/docs/guides/windows.md).

## ⚙️ Deploy configuration

The deploy config lives in the source worktree's `.wos/` directory —
`deploy.yaml` for the root worktree and `deploy.worktree.yaml` for secondary
ones. It supports three modes:

- **`generated`** (default) — WorktreeOS generates the Compose file from `app`,
  `deps`, and `host_ports`. No hand-written `docker-compose.yaml`.
- **`compose`** _(early preview)_ — plug into your repository's existing Compose
  file and publish only the ports you list under `compose.expose`. May be
  unstable or not work in some setups.
- **`shell`** _(early preview)_ — run services as host processes (via
  `Bun.spawn`), no Docker daemon required. May be unstable or not work in some
  setups.

<details>
<summary><b>📄 Minimal <code>generated</code> example</b></summary>

```yaml
host_ports:
  range: { start: 20000, end: 29999 }

app:
  image: node:22
  init_script:
    - bun install
  services:
    api:
      ports: [3000]
      script: [bun dev]
      environment:
        DATABASE_URL: postgres://postgres:111111@${deps.db.containerName}:5432/api

deps:
  db:
    image: postgres:13
    ports: [5432]
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: 111111
      POSTGRES_DB: api
```

</details>

The full field reference — clone volumes, caches, healthchecks, targets,
runtime arguments, tunnels, and HTTPS / Let's Encrypt — is in the
[deploy config reference](apps/docs/src/content/docs/reference/deploy-config.md)
and the [configuration guides](apps/docs/src/content/docs/configuration/).

## ❓ FAQ

<details>
<summary><b>Do I need Docker?</b></summary>

Only for the `generated` and `compose` modes, which drive `docker compose`.
`shell` mode runs services as plain host processes and needs no Docker daemon.

</details>

<details>
<summary><b>Does it really work on Windows without WSL?</b></summary>

Yes. The daemon and CLI run natively on Windows 10/11 with a ConPTY terminal and
HTTP control plane. Docker Desktop is needed only for the Docker-backed modes;
psmux provides the persistent terminal backend.

</details>

<details>
<summary><b>Which agents are supported?</b></summary>

Claude Code, Codex, and OpenCode today, running inside agent-integrated
terminals attached to each worktree.

</details>

<details>
<summary><b>Can I control everything remotely?</b></summary>

Yes — publish the web UI through the built-in tunnel and reach your full
workspace from any browser, on any device. With `terminalEnabled`, you can drive
terminals and agents remotely after logging in. The local daemon listener stays
on loopback (`127.0.0.1`) by default; the tunnel's shared-secret login (over
HTTPS) is the only gate, so only publish over a tunnel you trust. See the
[tunnel configuration](apps/docs/src/content/docs/reference/deploy-config.md).

</details>

## 🛠️ Tech stack

- **Runtime:** [Bun](https://bun.sh) — single toolchain for the CLI, daemon, bundler, and tests.
- **Web UI:** React 19 + [react-router](https://reactrouter.com), bundled by Bun.
- **Docs:** [Astro Starlight](https://starlight.astro.build) (`apps/docs`).
- **Deploy:** Docker Compose — generated, or layered over your own Compose file.
- **Terminals:** native PTY / ConPTY, with tmux (psmux on Windows) for persistence.
- **Tunnel & HTTPS:** a daemon-owned HTTP server routed by hostname, with self-signed, file-based, or Let's Encrypt (DNS-01) certificates.
- **Distribution:** a single standalone executable compiled with `bun --compile`.

## 📂 Repository layout

A Bun monorepo (`workspaces: ["apps/*", "packages/*"]`):

<details>
<summary><b>Show packages</b></summary>

- `apps/cli` — the cross-platform `wos` bin and text-based status tool.
- `apps/web` — the React web UI (the main interface for observing deployments).
- `apps/docs` — the Astro Starlight documentation site.
- `packages/core` — config, paths, state, events, git/worktree helpers.
- `packages/compose` — Compose generation, runner, `ps` parser, host-port allocator.
- `packages/runtime` — orchestration, setup, caches, healthchecks, tunnels, service logs.
- `packages/daemon` — daemon server/client/protocol, operation registry, web listener.
- `packages/ui` — formatting and text renderers.

**Scripts:** `bun install` · `bun run wos …` · `bun run build:web` · `bun run docs` · `bun run build:binary` · `bun test`.

</details>

## 🗺️ Roadmap

Not yet shipped: native remote authentication/hardening for the daemon, and a
productized "install on your own servers" deployment. These are future work, not
current features.

## 📄 License

WorktreeOS is in early development; a license has not been published yet.
