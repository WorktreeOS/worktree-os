# wos Codex plugin

Maps Codex hooks to `AgentActivityEvent` emissions delivered fire-and-forget to
the wos daemon. It mirrors `packages/plugin-claude`: Codex's plugin system is a
near-clone of Claude Code's (`.codex-plugin/plugin.json` manifest, an
auto-detected `hooks/hooks.json`, and a `codex plugin` marketplace CLI), so the
two plugins share the same shape and the same delivery binary.

## Binary-backed hooks (cross-platform)

The plugin is a pure manifest: `hooks/hooks.json` wires every Codex hook to the
command `wos agent-hook <event> --agent codex` — the wos binary itself does the
work (reads the hook JSON from stdin, maps it to an `AgentActivityEvent` tagged
`agent: "codex"`, POSTs it). There are no shell scripts and no
`bash`/`jq`/`curl`/`bun`/`node` dependency, so the hooks run identically on
Windows, macOS, and Linux. The command string is platform-neutral (no shell
syntax, no `$VAR`/`%VAR%` expansion); the daemon injects
`WOS_DAEMON_URL`/`WOS_AGENT_TOKEN`/`WOS_TERMINAL_SESSION_ID` into the session
environment, which the hook inherits, and the binary falls back to `~/.wos/`
(`daemon.json` web URL + `agent-token`) outside a wos terminal.

The hook-to-event mapping the `--agent codex` flag selects:

| Codex hook | Event | Notes |
|---|---|---|
| `SessionStart` | `session_start` | binds the rollout transcript (`detail.transcriptPath` ← `transcript_path`, `detail.source` ← `trigger`, `detail.model` ← `model`) |
| `UserPromptSubmit` | `prompt_submit` | summary/title from `prompt` |
| `Stop` | `stop` | turn end → idle (always main-turn-scoped; no `agent_id` sniffing) |
| `SubagentStop` | `heartbeat` | subagent liveness, never a main-turn idle |
| `PostToolUse` | `heartbeat` | liveness after every tool call |
| `PermissionRequest` | `permission_request` | `severity: needs-attention` → awaiting-input |

Every Codex hook carries a `model` field, which the binary stamps onto the
emitted event's `detail.model`.

## Install / update model

The plugin is a real, versioned Codex plugin. The repository root is a local
Codex plugin marketplace (`.agents/plugins/marketplace.json`, name
`worktreeos`) exposing this package as the plugin `wos`. The daemon installs and
updates it exclusively through the headless CLI:

```sh
codex plugin marketplace add <repo-or-remote-source>
codex plugin add wos@worktreeos
# remove: codex plugin remove wos@worktreeos
```

The marketplace source defaults to the local repository; set
`WOS_CODEX_MARKETPLACE_SOURCE` (a path, URL, or GitHub repo) to distribute wos
outside the source checkout.

The daemon detects install state from `codex plugin list --json` and flags
`pluginOutdated` when the listing surfaces an installed semver older than
`.codex-plugin/plugin.json` here (codex records the manifest semver, e.g.
`0.1.0`, so the outdated comparison works for local installs too). The web UI
offers Install / Update
near terminal sessions; with the `autoInjectAgentPlugins` setting enabled the
daemon keeps the plugin installed and current automatically. Updates apply to
new Codex sessions.

## No executable scripts

Like `plugin-claude`, this plugin ships no `scripts/` directory and no
executable hook files — the `agent-hook` handler lives in the wos binary, not in
the installed plugin. A contract test verifies that every `hooks.json` command
is `wos agent-hook <known-event> --agent codex`.
