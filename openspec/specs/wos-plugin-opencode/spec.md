# wos-plugin-opencode Specification

## Purpose
The OpenCode plugin that maps OpenCode events to AgentActivityEvent emissions delivered fire-and-forget to the wos daemon, filtering out subagent sessions.
## Requirements
### Requirement: OpenCode event coverage
The OpenCode plugin in `packages/plugin-opencode` SHALL subscribe to `session.created`, `chat.message`, `session.idle`, `permission.asked`/`permission.updated`, `permission.replied`, and `tool.execute.before` for the question tool, mapping them to `AgentActivityEvent` values `session_start`, `prompt_submit`, `stop`, `permission_request`, `permission_replied`, and `question_asked` respectively.

#### Scenario: Session idle emits idle signal
- **WHEN** OpenCode finishes responding and `session.idle` fires
- **THEN** the plugin POSTs a `stop` event for that session

#### Scenario: Question tool emits question event
- **WHEN** `tool.execute.before` fires with the question tool
- **THEN** the plugin POSTs a `question_asked` event with `severity: "needs-attention"`

### Requirement: Subagent filtering
The plugin SHALL suppress events from subagent sessions, detected via the session's `parentID` through the OpenCode SDK, caching lookups to avoid repeated API calls.

#### Scenario: Subagent events are suppressed
- **WHEN** an event belongs to a session whose `parentID` is set
- **THEN** the plugin emits no `AgentActivityEvent`

### Requirement: Non-blocking delivery and schema conformance
The plugin SHALL reuse the `AgentActivityEvent` schema from `packages/core`, deliver events fire-and-forget to `${WOS_DAEMON_URL}/ui/v1/agent-events` with the bearer token, MUST NOT await delivery in a way that can block OpenCode's plugin loader, and MUST silently skip sending when the daemon URL or token is unavailable.

#### Scenario: Plugin load is never blocked by delivery
- **WHEN** the plugin initializes while the daemon is unreachable
- **THEN** OpenCode starts normally and the plugin registers its handlers

#### Scenario: Emitted payloads pass schema validation
- **WHEN** unit tests run the payload builder over sample events
- **THEN** every payload passes `AgentActivityEvent` validation
