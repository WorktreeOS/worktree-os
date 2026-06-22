# wos-codex-transcript-telemetry Specification

## Purpose
TBD - created by archiving change add-codex-agent-plugin. Update Purpose after archive.
## Requirements
### Requirement: Agent-aware Codex rollout binding
The daemon's transcript telemetry reader SHALL be agent-aware: the bind operation SHALL carry the originating agent (`claude` or `codex`), threaded from the `session_start` agent activity event and recorded on the persisted binding, so each binding selects the correct transcript parser. When the bound session's agent is `codex`, the reader SHALL parse the bound file as a Codex rollout JSONL (`~/.codex/sessions/.../rollout-*.jsonl`) rather than a Claude transcript. The daemon SHALL bind a Codex rollout file to a terminal session when a `session_start` event tagged `agent: "codex"` arrives carrying a `transcriptPath` in its detail, keyed by the event's terminal session id; the latest `session_start` for a terminal session SHALL win (a subsequent event with a different `transcriptPath` MUST rebind to the new file and stop tailing the old one). The binding SHALL be removed when the terminal session ends.

#### Scenario: Codex session binds the rollout file
- **WHEN** a `session_start` event with `agent: "codex"` and a `transcriptPath` arrives for terminal session T
- **THEN** the daemon begins reading that file for T using the Codex rollout parser

#### Scenario: Claude binding still uses the Claude parser
- **WHEN** a `session_start` event with `agent: "claude"` and a `transcriptPath` arrives for terminal session T
- **THEN** the daemon reads that file with the Claude transcript parser, unchanged by this capability

#### Scenario: Rebind on a new rollout file
- **WHEN** a later `session_start` event for codex session T carries a different `transcriptPath`
- **THEN** the daemon switches to the new file and stops tailing the previous one

### Requirement: Tolerant rollout reading
The Codex rollout reader SHALL read bound files incrementally from a persisted byte offset, parsing only appended complete lines, with a one-time full scan at bind time to seed totals. It MUST ignore unknown record `type`/`payload` shapes and unknown fields, MUST skip lines that fail JSON parsing without advancing past incomplete trailing data, and MUST treat a missing or unreadable file as "no telemetry" rather than a session error. The reader SHALL be strictly read-only over rollout files. Because the Codex rollout format is documented as "not a stable interface," any unrecognized envelope or token shape SHALL degrade silently to no telemetry and MUST NOT error the session or affect derived agent activity state.

#### Scenario: Unknown record types are ignored
- **WHEN** the rollout contains records whose `type` is not `event_msg` or `session_meta`, or future unrecognized payload types
- **THEN** the reader skips them and derives telemetry only from recognized records

#### Scenario: Partial trailing line is retried
- **WHEN** a read catches a partially written final line
- **THEN** the reader resumes from the same offset on the next read and parses the line once complete

#### Scenario: Missing rollout degrades silently
- **WHEN** the bound rollout path does not exist or cannot be read
- **THEN** no telemetry block is published and the terminal session remains fully functional

### Requirement: Telemetry derivation from Codex token_count records
From the Codex rollout `{timestamp,type,payload}` envelope, the reader SHALL derive per agent session: `model` (from a `session_meta` record's model field, falling back to the `detail.model` carried on the `session_start` event when the rollout has not yet recorded one), `mainTokens`, and `contextUsed` from `event_msg` records whose `payload.type` is `token_count`. Because Codex `token_count` totals are cumulative for the session, the reader SHALL take the **latest** `total_token_usage` rather than summing per record: `mainTokens` from the latest `output_tokens` plus `reasoning_output_tokens`, and `contextUsed` from the latest `input_tokens` plus `cached_input_tokens`. Any missing sub-field SHALL be treated as 0. This cumulative "latest wins" accounting is the inverse of the Claude reader's per-record summation and MUST NOT be applied to Claude transcripts.

#### Scenario: Context and tokens track the latest token_count
- **WHEN** a new `event_msg`/`token_count` record is appended with a higher cumulative `total_token_usage`
- **THEN** `mainTokens` and `contextUsed` reflect that latest record's totals, not the sum of all token_count records

#### Scenario: Model comes from session_meta or the hook fallback
- **WHEN** the rollout has recorded a `session_meta` model
- **THEN** the reported `model` is that value; and when no `session_meta` model has been read yet, the reader reports the `detail.model` carried on the codex `session_start` event

#### Scenario: Missing usage sub-field counts as zero
- **WHEN** a `token_count` record omits `reasoning_output_tokens` or `cached_input_tokens`
- **THEN** the reader treats the missing sub-field as 0 without erroring

### Requirement: Per-model context window
The reported `contextWindow` SHALL be derived from a per-model lookup keyed by the session's `model`, replacing the previous flat constant as the single source of the window. Claude models SHALL continue to report the 1M (1048576) window. Codex/GPT models SHALL report their model-appropriate window from the lookup, and an unknown or unrecognized model SHALL report a safe default window rather than failing. The lookup SHALL be data, not control flow, so a new model id is a one-line addition.

#### Scenario: Codex model reports its own window
- **WHEN** telemetry is derived for a codex session whose `model` is a known Codex/GPT model
- **THEN** the reported `contextWindow` is that model's window, not 1048576

#### Scenario: Claude model window is unchanged
- **WHEN** telemetry is derived for a claude session
- **THEN** the reported `contextWindow` remains 1048576

#### Scenario: Unknown model uses a safe default
- **WHEN** telemetry is derived for a session whose `model` is not in the lookup
- **THEN** the reported `contextWindow` is the safe default and no error is raised

### Requirement: Codex telemetry publication and persistence
Derived Codex telemetry SHALL be published as the optional `agentTelemetry` block on `TerminalSessionMetadata` over the existing UI event stream, debounced to at most one update per second per session, identically to the Claude path so the UI renders it with the same chrome. The daemon SHALL persist the Codex binding (the bound `transcriptPath`, `agentSessionId`, and the originating agent) so telemetry can be recomputed by a full rescan after a daemon restart on backends with cross-restart session persistence; it SHALL NOT persist derived telemetry or the read byte offset. Backends without cross-restart persistence SHALL persist nothing and perform no re-bind.

#### Scenario: Telemetry update reaches subscribers
- **WHEN** new cumulative usage is read from a bound codex rollout
- **THEN** subscribed UI clients receive an updated session snapshot containing `agentTelemetry` within the debounce window

#### Scenario: Binding records the agent for restart recompute
- **WHEN** the reader binds a codex rollout to terminal session T
- **THEN** the daemon persists the bound `transcriptPath`, `agentSessionId`, and `agent: "codex"` for T, and persists no derived token figures

#### Scenario: Telemetry recomputed on daemon restart
- **WHEN** the daemon restarts and re-adopts a codex session with a persisted binding on a persistence-capable backend
- **THEN** the daemon re-binds the rollout with the Codex parser and recomputes `agentTelemetry` from the file before any client attaches

