# @worktreeos/skills

WorktreeOS AI skills catalog. This workspace package ships **documentation-only** playbooks (`SKILL.md` files) that teach AI agents how to operate the `wos` CLI safely and effectively.

The catalog does not add new runtime commands or change existing CLI behavior. It is a versioned reference shipped alongside the CLI so agents can ground their actions in current wos workflows instead of guessing.

## How agents use this catalog

1. Read `index.json` to discover the available skills, their descriptions, tags, and entry-file paths.
2. Load the `SKILL.md` for the workflow at hand (for example, starting services or checking readiness).
3. Follow the skill's instructions, preferring documented wos CLI commands and the safety guidance each skill provides for destructive operations.

`wos-cli` is the recommended orientation entry point. Other skills focus on specific workflows.

## Shipped skills

| Skill | Purpose |
| --- | --- |
| [`wos-cli`](./wos-cli/SKILL.md) | General orientation for agents using the wos CLI: command map, global options, daemon-backed behavior. |
| [`wos-service-lifecycle`](./wos-service-lifecycle/SKILL.md) | Starting and stopping services: `wos up`, `wos up -d`, selective startup, `--force` refresh, `wos down`. |
| [`wos-service-status`](./wos-service-status/SKILL.md) | Inspecting deployment state and waiting for readiness: `wos status`, `wos wait --timeout <duration>`. |
| [`wos-daemon`](./wos-daemon/SKILL.md) | Daemon start, stop, restart, and foreground diagnostics for the daemon control plane. |
| [`wos-web-ui`](./wos-web-ui/SKILL.md) | Opening the wos web UI: `wos web`, `wos web --no-open`, worktree detail URLs. |
| [`wos-worktree`](./wos-worktree/SKILL.md) | Worktree-scoped execution, the global `--cwd <path>` option, and safe `wos worktree remove [--force]`. |
| [`wos-troubleshooting`](./wos-troubleshooting/SKILL.md) | Common wos CLI failures and a diagnostic order to follow before retrying. |
| [`wos-config`](./wos-config/SKILL.md) | Deploy-config concepts an agent needs to understand to operate the CLI. |

## Scope

- The catalog teaches **how to use** `wos-cli`.
- It does not document internal implementation details, daemon HTTP APIs, or web UI APIs beyond what an agent needs to drive the CLI.
- Skills are written in English so they remain portable across agent runtimes.

## Layout

```
packages/skills/
  README.md              # this file
  index.json             # machine-readable catalog
  wos-cli/SKILL.md
  wos-service-lifecycle/SKILL.md
  wos-service-status/SKILL.md
  wos-daemon/SKILL.md
  wos-web-ui/SKILL.md
  wos-worktree/SKILL.md
  wos-troubleshooting/SKILL.md
  wos-config/SKILL.md
```
