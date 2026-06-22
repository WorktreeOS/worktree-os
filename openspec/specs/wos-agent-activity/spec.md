# wos-agent-activity Specification

## Purpose
Define the agent-agnostic agent activity event schema, the daemon ingest endpoint, token-based binding of events to terminal sessions, and the derived per-session agent activity state machine.
## Requirements
### Requirement: Agent activity event schema
The system SHALL define a versioned, agent-agnostic `AgentActivityEvent` schema in `packages/core` with fields: `v` (protocol version), `eventId` (unique per emission), `agent`, `event` (`session_start` | `prompt_submit` | `stop` | `question_asked` | `permission_request` | `permission_replied`), `agentSessionId`, optional `terminalSessionId`, `cwd`, `at` (ISO timestamp), `severity` (`info` | `needs-attention`), optional `summary` (≤200 chars), optional `title` (≤80 chars, proposed display title for the bound terminal session), and optional `detail`. Validation MUST accept unknown extra fields and unknown `agent` values for forward compatibility.

#### Scenario: Valid event passes validation
- **WHEN** an event with all required fields and `v: 1` is validated
- **THEN** validation succeeds and the typed event is returned

#### Scenario: Unknown agent and extra fields are tolerated
- **WHEN** an event arrives with `agent: "future-agent"` and an unrecognized extra field
- **THEN** validation succeeds and the unknown field is preserved

#### Scenario: Missing required field is rejected
- **WHEN** an event without `eventId` or `event` is validated
- **THEN** validation fails with a descriptive error

#### Scenario: Event with title passes validation
- **WHEN** an event carries `title` within the length limit
- **THEN** validation succeeds and the title is preserved on the typed event

#### Scenario: Event without title remains valid
- **WHEN** an event omits `title`
- **THEN** validation succeeds unchanged

### Requirement: Daemon ingest endpoint
The daemon SHALL expose `POST /ui/v1/agent-events` accepting a single `AgentActivityEvent` JSON body. The endpoint MUST require `Authorization: Bearer <token>` matching the daemon's agent token and MUST respond within a bounded time so plugins are never blocked. Invalid auth SHALL return 401; malformed bodies SHALL return 400; accepted events SHALL return 200 even when they cannot be attributed to a session or worktree.

#### Scenario: Authorized event is accepted
- **WHEN** a plugin POSTs a valid event with the correct bearer token
- **THEN** the daemon responds 200 and processes the event

#### Scenario: Missing or wrong token is rejected
- **WHEN** a POST arrives without a token or with a wrong token
- **THEN** the daemon responds 401 and does not process the event

#### Scenario: Unattributable event is accepted and dropped
- **WHEN** a valid event resolves to no terminal session and no known worktree
- **THEN** the daemon responds 200, logs at debug level, and changes no state

### Requirement: Agent token injection
The daemon SHALL generate an agent token per daemon run, persist it in the daemon state directory with owner-only permissions, and inject `WOS_DAEMON_URL`, `WOS_TERMINAL_SESSION_ID`, and `WOS_AGENT_TOKEN` into the environment of every PTY it spawns. The daemon SHALL additionally make its own `wos` binary resolvable from spawned PTYs by prepending the directory of the running executable (`dirname(process.execPath)`) to the session `PATH`, so binary-backed agent hooks can invoke `wos` even when it is not on the global `PATH`. The prepend MUST preserve the inherited `PATH` entries and MUST be platform-neutral (a `PATH` environment entry, not a shell-specific command rewrite).

#### Scenario: Spawned terminal carries binding environment
- **WHEN** the daemon spawns a terminal session for a worktree
- **THEN** the child process environment contains `WOS_DAEMON_URL`, `WOS_TERMINAL_SESSION_ID` matching the session id, and `WOS_AGENT_TOKEN`

#### Scenario: Spawned terminal can resolve the wos binary
- **WHEN** the daemon spawns a terminal session
- **THEN** the child process `PATH` begins with the directory of the running daemon executable, so `wos agent-hook <event>` resolves to that binary without relying on the global `PATH`

### Requirement: Event-to-session resolution
The daemon SHALL bind an incoming event to a terminal session via `terminalSessionId` when present and valid. When absent, the daemon SHALL fall back to matching `cwd` against known worktree paths and attribute the event to the worktree without claiming a specific terminal session.

#### Scenario: Env-bound event reaches its session
- **WHEN** an event carries a `terminalSessionId` of a live session
- **THEN** the event updates that session's agent activity state

#### Scenario: cwd fallback attributes to worktree only
- **WHEN** an event has no `terminalSessionId` but its `cwd` lies inside a managed worktree
- **THEN** the event is attributed to that worktree and no terminal session's state is modified

### Requirement: Derived agent activity state machine
The daemon SHALL derive a per-session `agentActivity` state from the event stream: `prompt_submit` → `working`; `stop` → `idle`; `question_asked` and `permission_request` → `awaiting-input` with the pending question/permission `summary` recorded; `permission_replied` or a subsequent `prompt_submit` → `working` and the pending summary cleared. When the detected agent process exits, the daemon SHALL clear the session's `agentActivity` block.

The daemon SHALL distinguish two kinds of `idle`: a **hook-stop idle** produced by a real `stop` event, and a **staleness idle** produced by the staleness sweep's synthetic demotion. A hook-stop idle is sticky: only a `prompt_submit` (or `permission_replied` from `awaiting-input`) resumes `working`, and `heartbeat` events leave it `idle` while refreshing its freshness timestamp. A staleness idle is soft and resurrectable: any liveness signal — a `heartbeat` event, or a freshness refresh driven by main- or subagent-transcript growth — SHALL resume `working` for it. Entering `working` from any path SHALL reset the staleness/idle-kind marker.

`heartbeat` events in `working` SHALL refresh the activity block's freshness timestamp without changing its state or pending summary. A `heartbeat` in `awaiting-input` SHALL resume `working` and clear the pending question — a tool execution can only follow the user answering, so it is the resume signal for both `question_asked` and `permission_request` waits.

When a `heartbeat` event arrives for a session that has **no** activity block (e.g. the in-memory block was lost to a daemon restart while the agent kept working), the daemon SHALL bootstrap a fresh `working` block from it. A `heartbeat` maps to a `post-tool-use` (or subagent-stop) hook, which fires only while the agent is executing a tool, so it is unambiguous evidence the agent is working and is a safe signal to (re)establish `working` from nothing. This is the only liveness path that may create a block from no prior state: a freshness refresh driven by transcript growth SHALL NOT bootstrap `working` from an absent block, because trailing summary/title records are appended after a real `stop` and would falsely resurrect a finished turn.

#### Scenario: Question moves session to awaiting-input
- **WHEN** a `question_asked` event arrives for a session in `working`
- **THEN** the session's state becomes `awaiting-input` and the question summary is stored

#### Scenario: Stop maps to a sticky idle
- **WHEN** a `stop` event arrives
- **THEN** the session's state becomes a hook-stop `idle` that is not resumed by heartbeat or transcript growth

#### Scenario: Heartbeat refreshes without state change
- **WHEN** a `heartbeat` event arrives for a session in `working`
- **THEN** the state remains `working`, the freshness timestamp updates, and no state transition is published

#### Scenario: Heartbeat after a reply resumes working
- **WHEN** a `heartbeat` event arrives for a session in `awaiting-input`
- **THEN** the state becomes `working`, the pending question is cleared, and the transition is published

#### Scenario: Liveness resurrects a staleness idle
- **WHEN** a session is in a staleness `idle` and a `heartbeat` event arrives, or main- or subagent-transcript growth refreshes its freshness
- **THEN** the state returns to `working` and the transition is published

#### Scenario: Heartbeat does not resurrect a hook-stop idle
- **WHEN** a session is in a hook-stop `idle` and a `heartbeat` event arrives
- **THEN** the state remains `idle`, only the freshness timestamp updates, and no transition is published

#### Scenario: Heartbeat bootstraps working after a daemon restart
- **WHEN** a `heartbeat` event arrives for a session that has no activity block (its in-memory block was cleared by a daemon restart while the agent kept working)
- **THEN** the daemon creates a fresh `working` block and publishes the transition

#### Scenario: Transcript growth does not bootstrap working from no block
- **WHEN** a freshness refresh driven by transcript growth occurs for a session that has no activity block
- **THEN** no activity block is created and the session remains without an `agentActivity` block

#### Scenario: Agent exit clears activity
- **WHEN** process detection reports the agent process is no longer running in the session
- **THEN** the `agentActivity` block is removed from the session metadata

### Requirement: Event deduplication
The daemon SHALL deduplicate incoming events by `eventId` within a bounded recent window, so retried or duplicated hook invocations do not produce repeated state transitions or repeated unified events.

#### Scenario: Duplicate eventId is ignored
- **WHEN** two events with the same `eventId` arrive within the dedup window
- **THEN** only the first changes state and emits a unified event

### Requirement: Working-state staleness expiry
The daemon SHALL demote an agent activity block from `working` to `idle` when no event (of any kind, including `heartbeat`) has refreshed it for a staleness TTL (default 3 minutes), **but only when the session has been attached at some point since it last entered `working`** (it currently has at least one attachment, or it had one while in the current `working` stretch). A `working` block that has never been attached during its current `working` stretch SHALL NOT be demoted by staleness; it remains `working` until a real `stop` event, a new `prompt_submit`, or agent process exit. A staleness demotion SHALL publish an `agent.activity.changed` event and SHALL mark the resulting `idle` block as staleness-sourced (a soft, resurrectable idle — see the state machine requirement), distinct from a hook `stop` idle. The TTL MUST NOT apply to `awaiting-input` or `idle` states.

The rationale for attachment-gating: the sweep exists only to recover a turn interrupted with no `stop` event (e.g. Esc in Claude Code), and such an interrupt requires a human at the keyboard, so it can only occur on a session that was attached. A purely-detached silent `working` block is almost certainly still working (thinking, running a long tool, or waiting on a subagent), not interrupted.

#### Scenario: Interrupted attached turn expires to idle
- **WHEN** a session enters `working` while attached and no further events arrive within the TTL
- **THEN** the daemon demotes the session to a staleness-sourced `idle` and publishes `agent.activity.changed`

#### Scenario: Detached working session is not demoted by silence
- **WHEN** a session enters `working` and has never been attached during this `working` stretch, and no events arrive for longer than the TTL
- **THEN** the session remains `working` and no demotion is published

#### Scenario: Attached-then-detached session can still expire
- **WHEN** a session was attached while `working`, the client then detached, and no events arrive for longer than the TTL
- **THEN** the daemon demotes the session to a staleness-sourced `idle`

#### Scenario: Heartbeats keep working alive
- **WHEN** a session in `working` receives `heartbeat` events more frequently than the TTL
- **THEN** the session remains `working` and is not demoted

#### Scenario: Awaiting-input never expires
- **WHEN** a session sits in `awaiting-input` for longer than the TTL
- **THEN** the session remains `awaiting-input`

### Requirement: Agent title application
When an event bound to a live terminal session carries a `title`, the daemon SHALL normalize it with the terminal layer's title validation and apply it as an agent-sourced title under these precedence rules: a `prompt_submit` title applies only when the session has no title; a `stop` title applies when the session has no title or the existing title is agent-sourced; no agent title SHALL ever replace a user-sourced title. A `session_start` event SHALL clear an existing agent-sourced title on its bound session. Titles that are empty after normalization or fail validation SHALL be dropped silently without failing event ingestion.

#### Scenario: First prompt names an untitled session
- **WHEN** a `prompt_submit` event with a title arrives for a session without a title
- **THEN** the session's title is set to the normalized title with agent provenance

#### Scenario: Later prompt does not rename
- **WHEN** a `prompt_submit` event with a title arrives for a session that already has any title
- **THEN** the session's title is unchanged

#### Scenario: Summary upgrades an agent-set title
- **WHEN** a `stop` event with a title arrives for a session whose title is agent-sourced
- **THEN** the session's title is replaced by the normalized summary title with agent provenance

#### Scenario: User title is never overwritten
- **WHEN** any event with a title arrives for a session whose title is user-sourced
- **THEN** the session's title is unchanged

#### Scenario: New agent session resets stale auto-title
- **WHEN** a `session_start` event arrives for a session whose title is agent-sourced
- **THEN** the agent-sourced title is cleared and the session falls back to its default label

#### Scenario: Invalid title does not break ingestion
- **WHEN** an event carries a title that fails terminal title validation
- **THEN** the title is ignored and the rest of the event is processed normally

