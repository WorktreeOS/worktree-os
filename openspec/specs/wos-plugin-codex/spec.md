# wos-plugin-codex Specification

## Purpose
TBD - created by archiving change add-codex-agent-plugin. Update Purpose after archive.
## Requirements
### Requirement: Codex hook coverage
The Codex CLI plugin in `packages/plugin-codex` SHALL be a real Codex plugin defined by a `.codex-plugin/plugin.json` manifest (`name: "wos"`, semantic `version`, `description`, `author`) and SHALL register hooks via its auto-detected bundled manifest `hooks/hooks.json` for `SessionStart`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `PostToolUse`, and `PermissionRequest`, mapping them to `AgentActivityEvent` values `session_start`, `prompt_submit`, `stop`, a working-activity (`heartbeat`) signal, and `permission_request` respectively. Each hook's `command` SHALL be the platform-neutral invocation `wos agent-hook <event> --agent codex` (kebab-case event keyword: `session-start`, `prompt-submit`, `stop`, `subagent-stop`, `post-tool-use`, `permission-request`), with no shell-specific syntax and no environment-variable expansion in the command string. The `wos agent-hook <event> --agent codex` subcommand SHALL read the Codex hook input JSON from stdin and produce the mapped `AgentActivityEvent` tagged `agent: "codex"`. The plugin SHALL ship no executable hook scripts. A contract test SHALL verify that every `hooks.json` command invokes `wos agent-hook` with a known event keyword and the `--agent codex` flag.

Because Codex exposes `SubagentStop` as a distinct hook event and its `Stop` hook is always main-turn-scoped, the plugin SHALL map every `Stop` hook to `stop` (no subagent discrimination on the `Stop` event), and SHALL map `SubagentStop` and `PostToolUse` to `heartbeat`, so subagent activity and tool calls keep the bound terminal session `working`.

#### Scenario: Session start binds the rollout transcript
- **WHEN** the `SessionStart` hook runs `wos agent-hook session-start --agent codex` with the hook JSON on stdin
- **THEN** a `session_start` event is POSTed carrying the agent session id, cwd, `detail.transcriptPath` from the hook's `transcript_path`, `detail.source` from the hook's `trigger`, and `detail.model` from the hook's `model`

#### Scenario: Prompt submission emits working signal
- **WHEN** the user submits a prompt and the `UserPromptSubmit` hook runs `wos agent-hook prompt-submit --agent codex` with the hook JSON on stdin
- **THEN** a `prompt_submit` event is POSTed carrying the agent session id, cwd, and a truncated query summary derived from the hook's `prompt`

#### Scenario: Main-thread stop emits idle signal
- **WHEN** the `Stop` hook runs `wos agent-hook stop --agent codex`
- **THEN** a `stop` event is POSTed so the bound terminal session becomes idle

#### Scenario: Subagent stop emits a heartbeat, not idle
- **WHEN** the `SubagentStop` hook runs `wos agent-hook subagent-stop --agent codex`
- **THEN** a `heartbeat` event is POSTed and no `stop` event is produced, so the bound terminal session stays `working`

#### Scenario: Tool use emits working signal
- **WHEN** the `PostToolUse` hook runs `wos agent-hook post-tool-use --agent codex`
- **THEN** a `heartbeat` (working-activity) event is POSTed via the shared fire-and-forget sender

#### Scenario: Permission request emits a needs-attention event
- **WHEN** the `PermissionRequest` hook runs `wos agent-hook permission-request --agent codex`
- **THEN** a `permission_request` event is POSTed with `severity: "needs-attention"` so the bound terminal session enters `awaiting-input`

#### Scenario: Manifest references only binary commands
- **WHEN** the contract test enumerates `hooks/hooks.json` entries
- **THEN** every command is `wos agent-hook <event> --agent codex` for a known event keyword, and the plugin package contains no `scripts/` hook files

### Requirement: Codex event tagging and model carry
The `wos agent-hook <event> --agent codex` subcommand SHALL produce `AgentActivityEvent`s with `agent: "codex"` and a unique `eventId` distinguishable from the claude path. When the Codex hook stdin carries a non-empty `model` field, the subcommand SHALL include it as `detail.model` on the emitted event. Omitting the `--agent` flag SHALL preserve the existing claude behavior byte-for-byte, so the shared fast-path remains backward compatible with the Claude plugin's `hooks.json`.

#### Scenario: Codex events are tagged codex
- **WHEN** a Codex hook fires `wos agent-hook <event> --agent codex`
- **THEN** the emitted event has `agent: "codex"`

#### Scenario: Default agent stays claude
- **WHEN** `wos agent-hook <event>` runs with no `--agent` flag (the Claude plugin's command)
- **THEN** the emitted event has `agent: "claude"` exactly as before

#### Scenario: Model is carried when present
- **WHEN** the Codex hook stdin includes a non-empty `model`
- **THEN** the emitted event includes that value as `detail.model`

### Requirement: Repo marketplace registration
The repository SHALL register the Codex wos plugin in a committed Codex marketplace catalog at `.agents/plugins/marketplace.json`, sourcing `./packages/plugin-codex`, so the headless `codex plugin marketplace add` resolved against the repository root can discover and install it (the analogue of `.claude-plugin/marketplace.json` for Claude). The catalog entry SHALL declare the plugin `name` matching the manifest and a `version` consistent with the bundled manifest.

#### Scenario: Marketplace catalog lists the codex plugin
- **WHEN** the daemon registers the marketplace from the repository root and lists available plugins
- **THEN** the wos codex plugin is discoverable and sources `./packages/plugin-codex`

### Requirement: Fire-and-forget delivery
The `wos agent-hook` subcommand (for both claude and codex) SHALL send events to `${WOS_DAEMON_URL}/ui/v1/agent-events` with bearer token `WOS_AGENT_TOKEN` and a short timeout (~1s), MUST exit successfully regardless of delivery outcome, and MUST NOT block or alter Codex behavior. When `WOS_DAEMON_URL` or the token is absent from the environment, the subcommand SHALL recover them from the daemon state path (`~/.wos/daemon.json` web URL and `~/.wos/agent-token`); when still unavailable, it SHALL skip sending silently. The subcommand SHALL run on a lightweight code path that does not load the daemon or embedded web bundle, so that `post-tool-use` heartbeats stay cheap. Codex injects `WOS_TERMINAL_SESSION_ID`, `WOS_AGENT_TOKEN`, and `WOS_DAEMON_URL` into hook processes by inheritance from the PTY the daemon spawned, so attribution to the terminal session works without any plugin-side configuration.

#### Scenario: Daemon unreachable is silent
- **WHEN** a Codex hook fires while the daemon is not running
- **THEN** `wos agent-hook <event> --agent codex` exits 0 with no output that affects Codex

#### Scenario: Event attributes to the terminal session via inherited env
- **WHEN** a Codex hook fires inside a wos-spawned PTY carrying `WOS_TERMINAL_SESSION_ID`
- **THEN** the emitted event carries that terminal session id and the daemon attributes activity to that session

