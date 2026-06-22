# wos Claude Code plugin

Maps Claude Code hooks to `AgentActivityEvent` emissions delivered
fire-and-forget to the wos daemon.

## Binary-backed hooks (cross-platform)

The plugin is a pure manifest: `hooks/hooks.json` wires every Claude Code hook
to the command `wos agent-hook <event>` — the wos binary itself does the work
(reads the hook JSON from stdin, maps it to an `AgentActivityEvent`, POSTs it).
There are no shell scripts and no `bash`/`jq`/`curl`/`bun`/`node` dependency, so
the hooks run identically on Windows, macOS, and Linux. The command string is
platform-neutral (no shell syntax, no `$VAR`/`%VAR%` expansion); the daemon
injects `WOS_DAEMON_URL`/`WOS_AGENT_TOKEN`/`WOS_TERMINAL_SESSION_ID` into the
session environment, which the hook inherits, and falls back to `~/.wos/`
(`daemon.json` web URL + `agent-token`) outside a wos terminal.

Hook execution is shell-wrapped by Claude Code (`sh -c` on POSIX, Git Bash on
Windows), so a bare `wos` resolves via `PATH`. For sessions the wos daemon
spawns this is guaranteed: the daemon prepends its own binary directory to the
session `PATH`. For Claude sessions **not** started by the wos daemon, `wos`
must be on the global `PATH` for the hooks to report (otherwise they no-op
silently — they never affect Claude Code).

## Install / update model

The plugin is a real, versioned Claude Code plugin. The repository root is a
local plugin marketplace (`.claude-plugin/marketplace.json`, name
`worktreeos`) exposing this package as the plugin `wos`. The daemon installs
and updates it exclusively through the headless CLI:

```sh
claude plugin marketplace add <repo-or-remote-source>
claude plugin install wos@worktreeos --scope user
# update: refresh the marketplace first, then the plugin (full key required)
claude plugin marketplace update worktreeos
claude plugin update wos@worktreeos
```

The marketplace source defaults to the local repository; set
`WOS_CLAUDE_MARKETPLACE_SOURCE` (a path, URL, or GitHub repo) to distribute
wos outside the source checkout.

The daemon detects install state from `~/.claude/plugins/installed_plugins.json`
and flags `pluginOutdated` when the installed version is older than
`.claude-plugin/plugin.json` here. The web UI offers Install / Update near
terminal sessions; with the `autoInjectAgentPlugins` setting enabled the
daemon keeps the plugin installed and current automatically. Updates apply to
new Claude Code sessions (or after `/plugin reload`).

## Versioning discipline

Claude Code caches installed plugins by the `version` in
`.claude-plugin/plugin.json` — content changes do NOT reach users until the
version is bumped. Any change to the shipped content (`.claude-plugin/` or
`hooks/`) must therefore bump the version and refresh the committed content
manifest:

```sh
bun scripts/update-plugin-manifest.ts
```

The contract test (`tests/plugin-claude-contract.test.ts`) fails when the
shipped content changes without a bump, and verifies that every `hooks.json`
command is `wos agent-hook <known-event>`. (The `agent-hook` handler itself
lives in `src/` and ships inside the wos binary, not in the installed plugin.)

## Migration from legacy hook injection

Older wos versions injected raw hook entries (absolute script paths) into
`~/.claude/settings.json`. The daemon removes those entries (recognized by the
`plugin-claude/scripts` path marker) whenever it installs or updates the
plugin; they no longer count as "installed". Rollback: the plugin can be
removed with `claude plugin uninstall wos@worktreeos`.
