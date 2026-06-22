# wos-daemon-logging Specification

## Purpose
TBD - created by archiving change daemon-file-logging. Update Purpose after archive.
## Requirements
### Requirement: Opt-In Daemon File Logging
The daemon SHALL provide opt-in, file-based logging that is disabled by default and enabled through `<wos-home>/config.json`.

#### Scenario: Logging is disabled by default
- **WHEN** the daemon starts with no `logging` settings in `config.json`
- **THEN** the daemon SHALL NOT open or write a log file
- **AND** logging calls SHALL be no-ops with no measurable overhead

#### Scenario: Logging is enabled via config
- **WHEN** `config.json` sets `logging.enabled` to `true`
- **THEN** the daemon SHALL write log records to the configured file (default `<wos-home>/logs/daemon.log`)

#### Scenario: A log write failure never affects the daemon
- **WHEN** a log write fails (e.g. the file is unwritable)
- **THEN** the daemon SHALL continue running normally
- **AND** the failure SHALL NOT propagate to agents or request handling

### Requirement: JSON-Lines Log Records
Each log record SHALL be a single JSON object on its own line, appended to the log file.

#### Scenario: Record carries stable fields plus structured data
- **WHEN** the daemon emits a log record
- **THEN** the record SHALL include `ts`, `level`, `module`, and `msg` keys
- **AND** any caller-supplied structured fields SHALL be merged into the same object

#### Scenario: Records are appended, not rotated
- **WHEN** logging is enabled across the daemon lifetime
- **THEN** records SHALL be appended to the existing file
- **AND** the daemon SHALL NOT rotate or truncate the file during the run

### Requirement: Log Levels And Per-Module Filtering
The logger SHALL support the ordered levels `off`, `error`, `warn`, `info`, `debug`, and `trace`, with a global level and optional per-module overrides.

#### Scenario: Records below the threshold are dropped
- **WHEN** a module's effective level is `info`
- **THEN** `debug` and `trace` records from that module SHALL be dropped
- **AND** `info`, `warn`, and `error` records SHALL be written

#### Scenario: A module override takes precedence over the global level
- **WHEN** the global level is `info` and `logging.modules` sets `agent-activity` to `trace`
- **THEN** `agent-activity` `trace` records SHALL be written
- **AND** other modules SHALL still apply the global `info` threshold

#### Scenario: A module set to off is silenced
- **WHEN** a module's effective level is `off`
- **THEN** no records from that module SHALL be written

### Requirement: Agent Activity Ingest Diagnostics
When logging is enabled, the daemon SHALL log how each agent activity event is received and attributed.

#### Scenario: Event ingest is logged
- **WHEN** an agent activity event is accepted by the ingest endpoint
- **THEN** the daemon SHALL log the event's agent, event kind, event id, and resolved attribution target

#### Scenario: A dropped event is logged with its reason
- **WHEN** an event cannot be attributed to a terminal session or a managed worktree
- **THEN** the daemon SHALL log that the event was dropped together with the reason and the offending `cwd`

#### Scenario: Heartbeat events are logged only at trace
- **WHEN** a `heartbeat` event is ingested
- **THEN** the daemon SHALL log it only at `trace` level

### Requirement: Status Transition Diagnostics
When logging is enabled, the daemon SHALL log every derived agent-activity status transition with the cause.

#### Scenario: A transition records previous and next state
- **WHEN** an event causes the derived block to change state
- **THEN** the daemon SHALL log the previous state, the next state (including idle provenance), and the triggering event and event id

#### Scenario: A non-transition is not logged at info
- **WHEN** an event produces no state change
- **THEN** the daemon SHALL NOT log a transition at `info`
- **AND** it MAY log the non-transition at `trace`

### Requirement: Unread Decision Diagnostics
When logging is enabled, the daemon SHALL log why a session was or was not marked unread.

#### Scenario: Marking unread is logged with the qualifying state
- **WHEN** a transition marks a detached session unread
- **THEN** the daemon SHALL log the unread marking together with the qualifying state (a hook-driven `stop` idle or `awaiting-input`)

#### Scenario: Suppressed marking is logged with the reason
- **WHEN** a transition does not mark the session unread
- **THEN** the daemon SHALL log the suppression together with the reason (the session is attached, the idle is a soft stale idle, or the state did not change)

### Requirement: Prompt Redaction
The logger SHALL omit free-text user prompt content from records by default.

#### Scenario: Prompt text is redacted by default
- **WHEN** `logging.redactPrompts` is unset or `true` and a record would include prompt, query, summary, or title text
- **THEN** the daemon SHALL omit that text from the record
- **AND** it MAY record a non-identifying marker such as a length

#### Scenario: Prompt text is included when redaction is disabled
- **WHEN** `logging.redactPrompts` is `false`
- **THEN** the daemon SHALL include the prompt/query/summary/title text in the record

### Requirement: Performance Spans
When performance logging is enabled, the daemon SHALL time instrumented operations and record their duration on completion.

#### Scenario: A completed span records its duration
- **WHEN** an instrumented operation (`git`, `compose`, `docker-http`, `process-detect`, `attach`, or `resolve-session`) completes
- **THEN** the daemon SHALL log a `perf` record with the operation, a label, the duration in milliseconds, and whether it succeeded

#### Scenario: A slow operation is elevated to warn
- **WHEN** an instrumented operation's duration is at or above its configured `slowMs` threshold
- **THEN** the daemon SHALL log the span at `warn` and mark it as slow

#### Scenario: Performance logging can be disabled independently
- **WHEN** `logging.perf.enabled` is `false`
- **THEN** the daemon SHALL run instrumented operations without emitting `perf` spans or arming watchdogs

### Requirement: Stuck Span Watchdog
When the stuck-span watchdog is enabled, the daemon SHALL report an in-flight operation that exceeds its threshold before the operation completes.

#### Scenario: A hung operation is reported while still running
- **WHEN** `logging.perf.stuckWatchdog` is enabled and an instrumented operation runs longer than its `slowMs` threshold without settling
- **THEN** the daemon SHALL log a `span.stuck` record with the elapsed time before the operation completes

#### Scenario: A fast operation never emits a stuck record
- **WHEN** an instrumented operation settles before its `slowMs` threshold
- **THEN** the daemon SHALL NOT log a `span.stuck` record for it

### Requirement: Console Diagnostics Capture
When logging is enabled, daemon diagnostics previously written to the process console SHALL be captured in the log file.

#### Scenario: Daemon warnings and errors reach the log file
- **WHEN** a daemon subsystem (such as ACME, Docker, tunnels, or the terminal layer) reports a warning or error and logging is enabled
- **THEN** the corresponding record SHALL be written to the log file with the originating module

