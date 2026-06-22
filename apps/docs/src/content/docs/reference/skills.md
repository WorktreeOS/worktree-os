---
title: Skills catalog
description: The @worktreeos/skills package ships documentation-only playbooks that teach AI agents how to operate the wos CLI safely.
---

`@worktreeos/skills` (`packages/skills`) is a versioned, **documentation-only**
catalog of `SKILL.md` playbooks that teach AI agents how to operate the `wos`
CLI safely and effectively. It ships no runtime commands and changes no CLI
behavior.

## How agents use the catalog

1. Read `index.json` to discover the available skills, their descriptions, tags,
   and entry-file paths.
2. Load the `SKILL.md` for the workflow at hand (for example, starting services
   or checking readiness).
3. Follow the skill's instructions, preferring documented `wos` commands and the
   safety guidance each skill provides for destructive operations.

`wos-cli` is the recommended orientation entry point; the others focus on
specific workflows.

## Shipped skills

| Skill | Purpose |
| --- | --- |
| `wos-cli` | General orientation: command map, global options, daemon-backed behavior. |
| `wos-service-lifecycle` | Starting and stopping services: `wos up`, `wos up -d`, selective startup, `--force`, `wos down`. |
| `wos-service-status` | Inspecting state and waiting for readiness: `wos status`, `wos wait --timeout`. |
| `wos-daemon` | Daemon start, stop, restart, and foreground diagnostics. |
| `wos-web-ui` | Opening the web UI: `wos web`, `wos web --no-open`, worktree detail URLs. |
| `wos-worktree` | Worktree-scoped execution, the global `--cwd` option, and safe `wos worktree remove`. |
| `wos-troubleshooting` | Common failures and a diagnostic order to follow before retrying. |
| `wos-config` | The deploy-config concepts an agent needs to operate the CLI. |

## Scope

The catalog teaches **how to use** the `wos` CLI. It does not document internal
implementation details, daemon HTTP APIs, or web UI APIs beyond what an agent
needs to drive the CLI. Skills are written in English so they stay portable
across agent runtimes.

The catalog lives at `packages/skills/` in the repository, alongside its
`index.json` and `README.md`.
