# WorktreeOS

**One control plane for every worktree, every project, every agent.**

WorktreeOS is a control plane for parallel, agent-driven development across
worktrees and projects. It gives you one place to navigate every worktree of
every project, run agent-integrated terminals, stay informed through
notifications, review and ship Git changes, deploy via Docker Compose with
automatic host-port allocation, and expose any service through Cloudflare
tunnels with HTTPS. Docker deployment is one capability among several, not the
whole product.

## Capability map

| Layer    | Capability |
| -------- | ---------- |
| **SEE**    | Mission Control + worktree board — navigate every worktree of every project |
| **WORK**   | Terminal + agents (Claude Code, OpenCode today) |
| **KNOW**   | Notifications (Telegram · Web Push · Sound) |
| **SHIP**   | Git review + auto commit message |
| **RUN**    | Docker deploy + automatic host-port allocation |
| **EXPOSE** | Cloudflare tunnels + HTTPS certificates |

## Remote access

Remote access works today by exposing the web UI through a Cloudflare tunnel
using the existing EXPOSE capability — reach your dashboard from anywhere. The
local daemon defaults to loopback (`127.0.0.1`) and ships no built-in remote
authentication layer.

## Roadmap

Not yet shipped: native remote authentication/hardening and a productized
"install on your own servers" deployment.
