# wos-plugin-claude Specification

## Purpose
The Claude Code plugin that maps Claude Code hooks to AgentActivityEvent emissions delivered fire-and-forget to the wos daemon.
## Requirements
### Requirement: Claude Code hook coverage
The Claude Code plugin in `packages/plugin-claude` SHALL register hooks via its executed manifest `hooks/hooks.json` for `SessionStart`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `Notification`, `PermissionRequest`, `PreToolUse` matched on the `AskUserQuestion` tool, and `PostToolUse`, mapping them to `AgentActivityEvent` values `session_start`, `prompt_submit`, `stop`, `permission_request`, `question_asked`, and a working-activity (`heartbeat`) signal respectively. Each hook's `command` SHALL be the platform-neutral invocation `wos agent-hook <event>` (kebab-case event keyword: `session-start`, `prompt-submit`, `stop`, `subagent-stop`, `notification`, `permission-request`, `ask-user-question`, `post-tool-use`), with no shell-specific syntax and no environment-variable expansion in the command string. The `wos agent-hook <event>` subcommand SHALL read the Claude Code hook input JSON from stdin and produce the mapped `AgentActivityEvent`. The plugin SHALL ship no executable hook scripts. A contract test SHALL verify that every `hooks.json` command invokes `wos agent-hook` with a known event keyword and that no hook table duplicating `hooks.json` exists outside the plugin package.

The plugin SHALL treat hook events originating inside a subagent as liveness, never as session idle, discriminating them by the presence of a non-empty `agent_id` field in the hook input (Claude Code includes `agent_id` "only when the hook fires inside a subagent call"). Specifically: a `Stop` hook whose input carries a non-empty `agent_id` SHALL emit a `heartbeat` event, not `stop`; the `SubagentStop` hook SHALL always emit a `heartbeat` event; and only a `Stop` hook with no `agent_id` (a main-thread turn end) SHALL emit `stop`. `PostToolUse` SHALL emit a `heartbeat` regardless of `agent_id`, so subagent-internal tool calls keep the bound terminal session `working`.

#### Scenario: Prompt submission emits working signal
- **WHEN** the user submits a prompt and the `UserPromptSubmit` hook runs `wos agent-hook prompt-submit` with the hook JSON on stdin
- **THEN** a `prompt_submit` event is POSTed carrying the agent session id, cwd, and a truncated query summary

#### Scenario: AskUserQuestion emits question event
- **WHEN** the `PreToolUse` hook for the `AskUserQuestion` tool runs `wos agent-hook ask-user-question`
- **THEN** a `question_asked` event is POSTed with `severity: "needs-attention"` and a question summary when available

#### Scenario: Main-thread stop emits idle signal
- **WHEN** the `Stop` hook runs `wos agent-hook stop` with `stop_hook_active` not set and no `agent_id` in the input
- **THEN** a `stop` event is POSTed

#### Scenario: Subagent stop emits a heartbeat, not idle
- **WHEN** the `Stop` hook runs with a non-empty `agent_id`, or the `SubagentStop` hook runs `wos agent-hook subagent-stop`
- **THEN** a `heartbeat` event is POSTed and no `stop` event is produced, so the bound terminal session stays `working`

#### Scenario: Tool use emits working signal
- **WHEN** the `PostToolUse` hook runs `wos agent-hook post-tool-use`, including for a tool call made inside a subagent
- **THEN** a `heartbeat` (working-activity) event is POSTed via the shared fire-and-forget sender

#### Scenario: Manifest references only binary commands
- **WHEN** the contract test enumerates `hooks/hooks.json` entries
- **THEN** every command is `wos agent-hook <event>` for a known event keyword, and the plugin package contains no `scripts/` hook files

### Requirement: Fire-and-forget delivery
The `wos agent-hook` subcommand SHALL send events to `${WOS_DAEMON_URL}/ui/v1/agent-events` with bearer token `WOS_AGENT_TOKEN` and a short timeout (~1s), MUST exit successfully regardless of delivery outcome, and MUST NOT block or alter Claude Code behavior. When `WOS_DAEMON_URL` or the token is absent from the environment, the subcommand SHALL recover them from the daemon state path (`~/.wos/daemon.json` web URL and `~/.wos/agent-token`); when still unavailable, it SHALL skip sending silently. The subcommand SHALL run on a lightweight code path that does not load the daemon or embedded web bundle, so that `post-tool-use` heartbeats stay cheap.

#### Scenario: Daemon unreachable is silent
- **WHEN** a hook fires while the daemon is not running
- **THEN** `wos agent-hook` exits 0 with no output that affects Claude Code

#### Scenario: Outside a wos terminal without token
- **WHEN** hooks fire in an environment with no `WOS_AGENT_TOKEN` and no readable daemon state
- **THEN** `wos agent-hook` performs no network call and exits 0

#### Scenario: Hook path stays lightweight
- **WHEN** `wos agent-hook <event>` runs
- **THEN** it resolves the payload and sender using `@worktreeos/core` only and does not import the embedded web/daemon bundle

### Requirement: Payload conformance
Events emitted by the `wos agent-hook` subcommand SHALL conform to the `AgentActivityEvent` schema (including `eventId` uniqueness, `terminalSessionId` from `WOS_TERMINAL_SESSION_ID` when present, and field truncation limits), verified by contract tests that run the subcommand's handler against sample hook inputs and validate the result against the schema in `packages/core`.

#### Scenario: Contract test validates emitted payloads
- **WHEN** the `agent-hook` handler runs against sample Claude Code hook inputs in tests
- **THEN** every produced payload passes `AgentActivityEvent` validation

### Requirement: Versioned plugin packaging
The plugin SHALL be packaged as an installable Claude Code plugin: `.claude-plugin/plugin.json` declares the plugin name `wos` and a semver `version` that serves as the installed-cache key, and the repository root SHALL carry a `.claude-plugin/marketplace.json` declaring the `worktreeos` marketplace exposing the plugin from `packages/plugin-claude`. The plugin's shipped content consists of its manifest and `hooks/hooks.json` (no executable scripts); the content hash SHALL cover that content, and any change to it MUST be accompanied by a `plugin.json` version bump, enforced by an automated check.

#### Scenario: Marketplace manifest is valid
- **WHEN** the repository is added as a marketplace via the plugin CLI
- **THEN** the `wos` plugin is discoverable and installable from it

#### Scenario: Content change without version bump fails the check
- **WHEN** the plugin manifest or `hooks/hooks.json` is modified but `plugin.json` version is unchanged
- **THEN** the automated check fails

### Requirement: Hybrid title emission
The Claude Code plugin SHALL include a `title` field on emitted events using a hybrid source: on `prompt_submit`, the first line of the user prompt, whitespace-collapsed and truncated to 80 characters; on `stop`, the most recent `type: "summary"` entry read from the hook payload's `transcript_path`. Title extraction MUST be best-effort: when the transcript is missing, unreadable, or contains no summary entry, or when the prompt is empty, the event SHALL be sent without `title` and the hook SHALL still exit successfully.

#### Scenario: Prompt submit carries a prompt-derived title
- **WHEN** the `UserPromptSubmit` hook fires with a non-empty prompt
- **THEN** the emitted `prompt_submit` event includes a `title` equal to the first prompt line truncated to 80 characters

#### Scenario: Stop carries the transcript summary
- **WHEN** the `Stop` hook fires and the transcript at `transcript_path` contains summary entries
- **THEN** the emitted `stop` event includes a `title` equal to the latest summary text

#### Scenario: Missing summary degrades silently
- **WHEN** the `Stop` hook fires and the transcript has no summary entry or cannot be read
- **THEN** the emitted `stop` event omits `title` and the hook exits 0

### Requirement: SessionStart transcript binding payload
The `SessionStart` hook script SHALL include in the emitted `session_start` event's detail the hook input's `transcript_path` (as `transcriptPath`) and hook `source` (`startup` | `resume` | `clear` | `compact`) when present. Absence of either field MUST NOT prevent the event from being sent.

#### Scenario: SessionStart carries transcript path
- **WHEN** the `SessionStart` hook fires with `transcript_path` in its input
- **THEN** the emitted `session_start` event detail includes `transcriptPath` and `source`

#### Scenario: Missing transcript path still emits
- **WHEN** the hook input lacks `transcript_path`
- **THEN** the plugin emits the `session_start` event without the binding fields

### Requirement: SessionStart hook fires on all session sources

The Claude Code plugin's `SessionStart` hook registration in `hooks/hooks.json` SHALL be configured so the `wos agent-hook session-start` command runs for every `SessionStart` source the daemon depends on for transcript rebind: `startup`, `resume`, `clear`, and `compact`. The registration MUST NOT restrict the hook to a subset of sources (e.g. a `startup|resume` matcher) that would suppress the `clear` and `compact` sources, because suppressing them prevents the `session_start` rebind event from reaching the daemon and leaves the session's agent telemetry frozen on the pre-clear/pre-compact transcript.

A contract test SHALL verify that the `SessionStart` registration covers the `clear` and `compact` sources, independently of the `buildHookPayload` payload-mapping test (which exercises the mapping function directly and cannot observe whether Claude Code would invoke the hook for a given source).

#### Scenario: Clear delivers a rebind event
- **WHEN** Claude Code fires `SessionStart` with `source: "clear"` and a new `transcript_path`
- **THEN** the plugin's registered hook command runs and emits a `session_start` event carrying the new `transcriptPath` and `source: "clear"`

#### Scenario: Compact delivers a rebind event
- **WHEN** Claude Code fires `SessionStart` with `source: "compact"` and a new `transcript_path`
- **THEN** the plugin's registered hook command runs and emits a `session_start` event carrying the new `transcriptPath` and `source: "compact"`

#### Scenario: Contract test asserts source coverage
- **WHEN** the plugin contract test inspects `hooks/hooks.json`
- **THEN** it asserts the `SessionStart` registration is configured to fire for `clear` and `compact`, not only `startup` and `resume`

