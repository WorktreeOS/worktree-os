# wos-claude-transcript-telemetry Specification

## Purpose
TBD - created by archiving change claude-jsonl-telemetry. Update Purpose after archive.
## Requirements
### Requirement: Transcript binding lifecycle
The daemon SHALL bind a Claude Code transcript file to a terminal session when a `session_start` agent activity event arrives carrying a `transcriptPath` in its detail, keyed by the event's terminal session id. The latest `session_start` for a terminal session SHALL win: a subsequent event with a different `transcriptPath` (e.g. after `/clear` or `/resume`) MUST rebind the session to the new file and stop tailing the old one. The binding SHALL be removed when the terminal session ends.

#### Scenario: Initial bind on session start
- **WHEN** a `session_start` event with `transcriptPath` arrives for terminal session T
- **THEN** the daemon begins reading that transcript file for T

#### Scenario: Rebind on /clear
- **WHEN** a later `session_start` event with `source: "clear"` and a new `transcriptPath` arrives for T
- **THEN** the daemon switches to the new file and derived context usage restarts from the new file's records

#### Scenario: Compact does not reset spent totals
- **WHEN** a `session_start` event with `source: "compact"` arrives for T
- **THEN** cumulative spent-token totals for T are preserved across the rebind

### Requirement: Tolerant tail-based JSONL reading
The transcript reader SHALL read bound files incrementally from a persisted byte offset, parsing only appended complete lines, with a one-time full scan at bind time to seed totals. It MUST ignore unknown record types and unknown fields, MUST skip lines that fail JSON parsing without advancing past incomplete trailing data, and MUST treat a missing or unreadable file as "no telemetry" rather than a session error. The reader SHALL be strictly read-only over transcript files.

#### Scenario: Unknown record types are ignored
- **WHEN** the file contains service records such as `attachment`, `ai-title`, or unrecognized future types
- **THEN** the reader skips them and derives telemetry only from `assistant` records

#### Scenario: Partial trailing line is retried
- **WHEN** a read catches a partially written final line
- **THEN** the reader resumes from the same offset on the next read and parses the line once complete

#### Scenario: Missing transcript degrades silently
- **WHEN** the bound transcript path does not exist or cannot be read
- **THEN** no telemetry block is published and the terminal session remains fully functional

### Requirement: Telemetry derivation from assistant records
From `assistant` records bearing `message.usage`, the reader SHALL derive per agent session: `model` (the `message.model` of the latest non-sidechain assistant record in the main transcript, ignoring `<synthetic>`), `mainTokens` (sum of `output_tokens` plus `cache_creation_input_tokens` over main-transcript assistant records), and `contextUsed` (`input_tokens + cache_read_input_tokens + cache_creation_input_tokens` of the latest main-transcript assistant record). `contextWindow` SHALL be reported as 1048576 for all models.

#### Scenario: Context usage tracks the latest assistant record
- **WHEN** a new assistant record with usage is appended to the main transcript
- **THEN** `contextUsed` equals that record's input + cache_read + cache_creation token sum

#### Scenario: Synthetic model ignored
- **WHEN** the latest assistant record has `model: "<synthetic>"`
- **THEN** the reported model remains that of the latest real assistant record

### Requirement: Subagent token accounting
The reader SHALL discover sibling `agent-*.jsonl` transcripts associated with the bound session and accumulate their assistant-record token usage into a separate `subagentTokens` total. Subagent records MUST NOT affect the reported `model` or `contextUsed`.

#### Scenario: Subagent usage counted separately
- **WHEN** a subagent transcript accrues assistant records with usage
- **THEN** `subagentTokens` grows while `mainTokens` and `contextUsed` are unaffected

### Requirement: Telemetry publication on session metadata
Derived telemetry SHALL be published as the optional `agentTelemetry` block on `TerminalSessionMetadata` and emitted over the existing UI event stream, debounced to at most one update per second per session.

#### Scenario: Telemetry update reaches subscribers
- **WHEN** new usage is read from a bound transcript
- **THEN** subscribed UI clients receive an updated session snapshot containing `agentTelemetry` within the debounce window

### Requirement: Transcript binding persistence and restore

The daemon SHALL persist the transcript binding for a terminal session so that telemetry survives a daemon restart on backends with cross-restart session persistence. The persisted binding SHALL contain only the bound `transcriptPath`, the `agentSessionId`, and the compact-carry token totals (`mainCarry`, `subagentCarry`); it SHALL NOT store derived telemetry (`model`, `mainTokens`, `subagentTokens`, `contextUsed`) or the read byte offset. The binding SHALL be written whenever it is established or rebound and removed when the binding is removed.

On daemon restart, for each restored terminal session that carries a persisted transcript binding, the daemon SHALL eagerly re-bind that transcript and recompute telemetry by a full transcript rescan — without waiting for a fresh `session_start` hook event — seeding compact-carry totals from the persisted record. Backends without cross-restart session persistence (e.g. the default backend) SHALL persist nothing and SHALL perform no re-bind.

#### Scenario: Binding persisted on bind

- **WHEN** the reader binds or rebinds a transcript to terminal session T
- **THEN** the daemon persists the bound `transcriptPath`, `agentSessionId`, and current compact-carry totals for T
- **AND** it persists no derived model or token figures

#### Scenario: Telemetry recomputed on daemon restart

- **WHEN** the daemon restarts and re-adopts a terminal session that has a persisted transcript binding
- **THEN** the daemon re-binds that transcript and recomputes `agentTelemetry` from the transcript file before any client attaches
- **AND** it does so without requiring a new `session_start` event

#### Scenario: Compact carry survives restart

- **WHEN** a session compacted before the restart is re-bound from its persisted record
- **THEN** the recomputed `mainTokens` includes the persisted compact-carry total rather than resetting to the active transcript's tokens alone

### Requirement: Transcript growth as a liveness signal
The transcript telemetry reader SHALL treat any growth of the bound main transcript or any discovered subagent (`agent-*.jsonl`) transcript as a liveness signal for the session's derived agent activity, independently of whether the appended records carry assistant usage. On observing such growth the reader SHALL refresh the freshness of a `working` activity block and SHALL resurrect a staleness-sourced `idle` block back to `working` through the agent activity state machine. Transcript growth MUST NOT alter a hook-stop `idle` block, an `awaiting-input` block, or a session that has no agent activity block. This keeps a session marked `working` during long generation stretches and while the main agent waits on a subagent that has no main-transcript writes and emits no hooks.

#### Scenario: Main transcript growth keeps working alive
- **WHEN** the bound main transcript gains bytes while the session's activity is `working`
- **THEN** the reader refreshes the block's freshness timestamp and the session stays `working`

#### Scenario: Subagent transcript growth keeps the session alive
- **WHEN** a discovered subagent transcript gains bytes while the main transcript is quiet and the session's activity is `working`
- **THEN** the reader refreshes the block's freshness timestamp and the session stays `working`

#### Scenario: Subagent transcript growth resurrects a staleness idle
- **WHEN** a session is in a staleness-sourced `idle` and a subagent transcript gains bytes
- **THEN** the reader resurrects the block to `working`

#### Scenario: Transcript growth does not disturb a hook-stop idle
- **WHEN** a session is in a hook-stop `idle` and the bound transcript gains bytes (e.g. a trailing summary or title record written after the turn ended)
- **THEN** the session remains `idle`

#### Scenario: Missing transcript after restart degrades silently

- **WHEN** a restored session's persisted `transcriptPath` no longer exists or cannot be read
- **THEN** no telemetry block is published and the terminal session remains fully functional
- **AND** the binding self-heals on the next real `session_start` event

#### Scenario: Default backend performs no restore

- **WHEN** the daemon restarts while the terminal backend has no cross-restart session persistence
- **THEN** no transcript bindings are persisted or re-bound

