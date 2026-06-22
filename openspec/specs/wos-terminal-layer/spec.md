# wos-terminal-layer Specification

## Purpose
TBD - created by archiving change rewrite-terminal-layer.
## Requirements
### Requirement: Terminal Layer Boundary
The system SHALL provide a dedicated terminal layer that separates terminal control state from raw PTY data transport.

#### Scenario: Client fetches terminal state
- **WHEN** a client needs the current list or detail state for terminal sessions
- **THEN** it SHALL use terminal snapshot/control APIs
- **AND** the response SHALL be authoritative for current daemon-owned terminal sessions

#### Scenario: Client attaches to terminal data
- **WHEN** a client attaches to an interactive terminal session
- **THEN** raw PTY output, input, resize, replay, and attachment liveness SHALL use the terminal data-plane WebSocket
- **AND** PTY bytes SHALL NOT be delivered through unified SSE event streams

### Requirement: Terminal Session Actor Lifecycle
The daemon SHALL manage each visible terminal session through a single session actor that owns lifecycle state, attachments, replay buffers, backend session handles, and cleanup while delegating backend-specific process ownership behavior to the selected terminal backend adapter.

#### Scenario: Terminal session is created
- **WHEN** a client creates a terminal session for a valid worktree
- **THEN** the daemon SHALL create a stable terminal session id
- **AND** the selected terminal backend adapter SHALL start or restore a terminal-backed session with its working directory set to the selected worktree root or an allowed descendant
- **AND** the session actor SHALL report the session as running after the backend session is ready for attachment

#### Scenario: Terminal process exits
- **WHEN** the backend terminal session exits
- **THEN** the session actor SHALL transition the session to exited exactly once
- **AND** it SHALL preserve exit code or signal information when available
- **AND** it SHALL notify attached clients of the exit state

#### Scenario: Daemon shuts down with default backend
- **WHEN** the daemon stops while default-backend terminal sessions are running
- **THEN** the terminal layer SHALL terminate daemon-owned terminal process trees
- **AND** it SHALL close terminal attachments
- **AND** it SHALL NOT restore those terminal sessions after daemon restart

#### Scenario: Daemon shuts down with tmux backend
- **WHEN** the daemon stops while tmux-backed terminal sessions are running
- **THEN** the terminal layer SHALL detach or dispose daemon-owned tmux attachment processes
- **AND** it SHALL close terminal attachments
- **AND** it SHALL NOT kill the underlying tmux sessions solely because of daemon shutdown

#### Scenario: User terminates a tmux-backed session
- **WHEN** a user requests termination of a running tmux-backed terminal session
- **THEN** the terminal layer SHALL terminate the corresponding tmux session
- **AND** it SHALL remove persisted metadata for that terminal session
- **AND** it SHALL mark the terminal session as exited after the tmux session is gone

### Requirement: Terminal PTY Runtime Port
The terminal layer SHALL depend on a runtime-neutral PTY port and use a Bun-native terminal runtime when supported.

#### Scenario: Bun terminal runtime is available
- **WHEN** the daemon runs under Bun and `Bun.Terminal` is available
- **THEN** the terminal runtime SHALL use the Bun-native PTY backend
- **AND** session actors SHALL interact with it only through the runtime-neutral terminal process interface

#### Scenario: Runtime cannot provide PTY cleanup guarantees
- **WHEN** the platform or runtime cannot provide required process-tree cleanup semantics
- **THEN** terminal session startup SHALL fail with a clear terminal-unavailable error
- **AND** the daemon SHALL NOT expose a partially functional terminal runtime

#### Scenario: Terminal process is resized
- **WHEN** the session actor applies a terminal resize request
- **THEN** the runtime SHALL resize the PTY to the requested columns and rows
- **AND** the session actor SHALL retain the current terminal dimensions

### Requirement: Terminal Active Command Metadata
The terminal layer SHALL expose best-effort active command metadata for daemon-owned PTY sessions when the host runtime can inspect the process tree.

#### Scenario: Runtime exposes terminal process id
- **WHEN** a terminal session runtime exposes the root PTY process id
- **THEN** terminal session metadata SHALL include that process id
- **AND** the terminal layer MAY inspect the root process tree to identify the current foreground command

#### Scenario: Known agent command is active
- **WHEN** the active foreground command or its arguments match a known terminal agent command family
- **THEN** terminal session metadata SHALL include active command details
- **AND** it SHALL include the recognized agent identifier for `claude`, `opencode`, or `codex`

#### Scenario: Active command cannot be determined
- **WHEN** the host process table is unavailable, the process exits during inspection, only an idle shell is foreground, or no command can be selected safely
- **THEN** the terminal layer SHALL omit active command metadata
- **AND** terminal session listing, attachment, input, resize, and termination behavior SHALL continue without failing

#### Scenario: Agent detection is extended
- **WHEN** a future agent command family is added
- **THEN** it SHALL be added through the active command recognition mapping
- **AND** existing `claude`, `opencode`, and `codex` recognition SHALL remain compatible

### Requirement: Terminal WebSocket Protocol
The terminal data-plane WebSocket SHALL use a typed attachment protocol with handshake, sequence-numbered output, input, resize, acknowledgement, status, and error messages.

#### Scenario: Client opens terminal attachment
- **WHEN** a client opens a terminal attachment WebSocket
- **THEN** the client SHALL send a hello message that identifies the target terminal session, desired dimensions, last seen output sequence when available, and desired control mode
- **AND** the daemon SHALL respond with session status, current dimensions, replay boundaries, and control ownership information

#### Scenario: Terminal emits output
- **WHEN** a PTY process emits output bytes
- **THEN** the terminal layer SHALL assign each output chunk a daemon-local terminal output sequence number
- **AND** it SHALL deliver output chunks to attached clients in sequence order

#### Scenario: Client acknowledges output
- **WHEN** an attached client reports the last output sequence it has processed
- **THEN** the terminal layer SHALL record the acknowledgement for diagnostics and backpressure decisions

#### Scenario: Protocol error occurs
- **WHEN** a client sends an invalid terminal protocol message
- **THEN** the daemon SHALL send a typed terminal error message
- **AND** it SHALL close or downgrade only the affected attachment according to the error severity

### Requirement: Terminal Replay And Checkpoints
The terminal layer SHALL provide reconnect replay from bounded output history and reserve an interface for server-side terminal screen checkpoints.

#### Scenario: Client reconnects with retained sequence
- **WHEN** a client reconnects to a running terminal session with a last seen output sequence that is still retained
- **THEN** the daemon SHALL replay output after that sequence before switching the attachment to live output
- **AND** the replayed output SHALL preserve PTY control sequences

#### Scenario: Client reconnects after history gap
- **WHEN** a client reconnects with a last seen output sequence older than retained history
- **THEN** the daemon SHALL either restore from the latest compatible terminal checkpoint plus subsequent output or report that a full visual replay is unavailable
- **AND** the client SHALL still be able to attach to live output when the session is running

#### Scenario: Terminal output exceeds history capacity
- **WHEN** terminal output history exceeds the configured bounded capacity
- **THEN** the terminal layer SHALL discard the oldest retained output chunks
- **AND** it SHALL keep sequence metadata that lets clients detect replay gaps

### Requirement: Terminal Attachment Control Ownership
The terminal layer SHALL allow many clients to view a terminal session while only one attachment controls input and resize at a time.

#### Scenario: Controller sends input
- **WHEN** the controlling attachment sends keyboard or paste input
- **THEN** the terminal layer SHALL write the input bytes to the PTY process

#### Scenario: Viewer sends input
- **WHEN** a non-controlling viewer attachment sends input
- **THEN** the terminal layer SHALL reject or ignore the input
- **AND** it SHALL notify the viewer that it does not currently control the terminal

#### Scenario: Controller resizes terminal
- **WHEN** the controlling attachment sends terminal dimensions
- **THEN** the terminal layer SHALL resize the PTY process
- **AND** it SHALL publish the updated dimensions to other attached viewers

#### Scenario: Control is transferred
- **WHEN** terminal control is granted to a different attachment
- **THEN** the previous controller SHALL stop being allowed to send input or resize
- **AND** all attached clients SHALL receive updated control ownership state

### Requirement: Terminal Output Isolation
The terminal layer SHALL keep terminal output separate from deployment operation logs, service logs, and unified event history.

#### Scenario: Terminal emits PTY output
- **WHEN** a terminal session emits raw output
- **THEN** the output SHALL be stored only in terminal replay/history structures and delivered only through terminal attachments
- **AND** it SHALL NOT be appended to deployment log channels
- **AND** it SHALL NOT be published as unified event payload data

#### Scenario: Deployment operation emits logs
- **WHEN** an `up`, `down`, service operation, or worktree removal operation emits logs
- **THEN** those logs SHALL continue using deployment log streams
- **AND** they SHALL NOT be routed into terminal replay/history structures

### Requirement: Terminal Access Boundary
The terminal layer SHALL expose terminal session creation and attachment only on trusted local surfaces by default, and SHALL permit public-web access only when the daemon's public terminal policy explicitly allows it.

#### Scenario: Local UI client opens terminal
- **WHEN** a trusted local UI client requests terminal session creation or attachment
- **THEN** the daemon SHALL allow the request when the selected worktree and terminal policy are valid

#### Scenario: Public tunnel attempts terminal access by default
- **WHEN** a request reaches the daemon through a public tunnel or remote API exposure path
- **AND** public terminal access has not been explicitly enabled
- **THEN** terminal session creation and attachment SHALL be denied by default
- **AND** the denial SHALL be explicit rather than falling through to a partially working terminal connection

#### Scenario: Public tunnel opens terminal when enabled and authenticated
- **WHEN** a request reaches the daemon through a public tunnel or remote API exposure path
- **AND** public terminal access is explicitly enabled by configuration
- **AND** the request is authenticated by the public web auth boundary
- **THEN** the daemon SHALL allow terminal session creation or attachment when the selected worktree and terminal policy are valid

#### Scenario: Terminal cwd is resolved
- **WHEN** the daemon starts a terminal session for a worktree
- **THEN** the terminal layer SHALL validate that the process working directory is the selected worktree root or an allowed descendant
- **AND** it SHALL reject path escapes outside the selected worktree boundary

### Requirement: Terminal Backend Adapter Boundary
The terminal layer SHALL select terminal behavior through a backend adapter identified by the effective global `terminalBackend` value.

#### Scenario: Default backend is selected
- **WHEN** the effective global config has `terminalBackend` equal to `"default"`
- **THEN** the terminal layer SHALL use the default backend adapter
- **AND** the default adapter SHALL preserve the current Bun terminal runtime behavior for session create, attach, input, resize, replay, terminate, and daemon shutdown

#### Scenario: Tmux backend is selected
- **WHEN** the effective global config has `terminalBackend` equal to `"tmux"`
- **THEN** the terminal layer SHALL use the tmux backend adapter
- **AND** terminal session lifecycle decisions that differ by backend SHALL be routed through the adapter boundary rather than hard-coded in the session manager

#### Scenario: Selected backend is unavailable
- **WHEN** the selected terminal backend cannot provide terminal sessions on the host
- **THEN** terminal session creation SHALL fail with a clear terminal-unavailable error naming the selected backend
- **AND** the daemon SHALL continue running for non-terminal API behavior

### Requirement: Tmux Terminal Backend
The tmux terminal backend SHALL manage wos terminal sessions through a tmux-compatible multiplexer while preserving the existing terminal HTTP and WebSocket data-plane contracts. On POSIX hosts the multiplexer binary SHALL resolve to tmux; on Windows hosts it SHALL resolve to psmux, a tmux-command-language-compatible multiplexer built on ConPTY.

#### Scenario: Tmux session is created
- **WHEN** a client creates a terminal session while `terminalBackend` is `"tmux"`
- **THEN** the terminal layer SHALL create a wos-owned multiplexer session scoped to the selected worktree
- **AND** it SHALL persist backend metadata containing the wos terminal id, backend id, worktree path, cwd, shell, multiplexer session name, and created timestamp
- **AND** it SHALL report the terminal session as running when the multiplexer-backed session is ready for attachment

#### Scenario: Client attaches to tmux session
- **WHEN** a client attaches to a running multiplexer-backed terminal session
- **THEN** the terminal data-plane WebSocket SHALL use the existing terminal protocol for hello, output, input, resize, acknowledgement, control, status, and error messages
- **AND** input and resize requests accepted from the controlling attachment SHALL be applied to the multiplexer attachment for that session

#### Scenario: Daemon starts with tmux metadata
- **WHEN** the daemon starts with `terminalBackend` equal to `"tmux"`
- **AND** persisted terminal metadata references a multiplexer session that still exists
- **THEN** the terminal layer SHALL restore a terminal session snapshot for that multiplexer session
- **AND** clients SHALL be able to attach to the restored terminal through the normal terminal data-plane WebSocket

#### Scenario: Daemon starts with stale tmux metadata
- **WHEN** the daemon starts with `terminalBackend` equal to `"tmux"`
- **AND** persisted terminal metadata references a multiplexer session that no longer exists
- **THEN** the terminal layer SHALL discard or mark stale metadata so the session is not listed as running
- **AND** stale metadata SHALL NOT prevent other terminal sessions from being restored

#### Scenario: Default backend ignores tmux metadata
- **WHEN** the daemon starts with `terminalBackend` equal to `"default"`
- **THEN** the terminal layer SHALL NOT restore multiplexer-backed terminal sessions
- **AND** default terminal session listing SHALL include only sessions owned by the current daemon process

#### Scenario: Multiplexer binary resolves per platform
- **WHEN** the tmux backend resolves its multiplexer binary without a `TMUX_BINARY` override
- **THEN** on POSIX hosts it SHALL probe for `tmux` on the PATH
- **AND** on Windows hosts it SHALL probe for `psmux` (including its installed aliases) on the PATH
- **AND** an explicit `TMUX_BINARY` value SHALL take precedence on every platform

#### Scenario: Multiplexer is unavailable on Windows
- **WHEN** the daemon runs on Windows with `terminalBackend` equal to `"tmux"`
- **AND** no psmux binary can be resolved
- **THEN** terminal session creation SHALL fail with a clear terminal-unavailable error naming psmux as the missing prerequisite
- **AND** the daemon SHALL continue running for non-terminal API behavior

#### Scenario: Multiplexer compatibility is probed before use
- **WHEN** the tmux backend initializes with a resolved multiplexer binary
- **THEN** it SHALL verify the binary answers the version probe used for availability detection
- **AND** backend operations SHALL use only multiplexer commands verified to behave compatibly across tmux and psmux (session lifecycle, options, pane listing, client listing and refresh)

### Requirement: Terminal Session Title Metadata
The terminal layer SHALL expose an optional title on terminal session metadata together with a `titleSource` provenance of `user` or `agent`, and SHALL allow the title to be updated without changing terminal lifecycle, PTY transport, replay, attachments, or control ownership. Titles set through the rename API SHALL carry `user` provenance; titles applied from agent activity SHALL carry `agent` provenance. Agent-sourced updates MUST NOT replace a user-sourced title. Clearing the title SHALL remove both the title and its provenance, returning the session to automatic naming.

#### Scenario: Session title is set
- **WHEN** a trusted client sets a non-empty title for an existing terminal session
- **THEN** the terminal layer SHALL update the session metadata title with `titleSource: "user"`
- **AND** subsequent session snapshots SHALL include the normalized title and its provenance
- **AND** the session SHALL remain attached, running, and controlled according to its prior terminal state

#### Scenario: Session title is cleared
- **WHEN** a trusted client clears the title for an existing terminal session
- **THEN** the terminal layer SHALL remove the title and `titleSource` from session metadata
- **AND** subsequent session snapshots SHALL omit the title
- **AND** terminal input, output, replay, resize, and control ownership SHALL continue unaffected

#### Scenario: Invalid session title is rejected
- **WHEN** a trusted client submits a terminal session title containing control characters or exceeding the supported length
- **THEN** the terminal layer SHALL reject the update with a validation error
- **AND** it SHALL preserve the previous session title and terminal state

#### Scenario: Agent-sourced title is applied with provenance
- **WHEN** the daemon applies an agent-derived title to a session without a user-sourced title
- **THEN** the session metadata title is updated with `titleSource: "agent"`

#### Scenario: Agent-sourced title cannot replace a user title
- **WHEN** the daemon attempts to apply an agent-derived title to a session whose `titleSource` is `user`
- **THEN** the title and provenance remain unchanged

### Requirement: Backend-Persisted Terminal Titles
The terminal layer SHALL route terminal session title persistence through the selected backend when that backend can restore sessions after daemon restart, persisting `titleSource` alongside the title. A restored title without recorded provenance SHALL be treated as user-sourced.

#### Scenario: Tmux-backed session title is persisted
- **WHEN** a trusted client renames a tmux-backed terminal session
- **THEN** the terminal layer SHALL persist the title and its `titleSource` in that session's tmux backend metadata
- **AND** daemon restart SHALL restore the title and provenance when the underlying tmux session still exists

#### Scenario: Default backend session title is daemon-lifetime
- **WHEN** a trusted client renames a default-backend terminal session
- **THEN** the terminal layer SHALL keep the title in the current daemon-owned session metadata
- **AND** daemon restart SHALL omit that session according to default backend lifetime behavior

#### Scenario: Tmux title persistence fails
- **WHEN** a trusted client renames a tmux-backed terminal session and backend metadata persistence fails
- **THEN** the terminal layer SHALL return an error for the rename
- **AND** the authoritative session snapshot SHALL preserve the previous title

#### Scenario: Legacy persisted title defaults to user provenance
- **WHEN** the daemon restores a tmux-backed session whose persisted title has no provenance metadata
- **THEN** the session metadata reports `titleSource: "user"`

### Requirement: Explicit Program Terminal Sessions
The terminal layer SHALL support daemon-created terminal sessions that spawn an explicit program and argv rather than only the default worktree shell.

#### Scenario: Terminal session starts explicit program
- **WHEN** the daemon creates a terminal session with explicit program `docker` and Compose exec argv
- **THEN** the terminal layer SHALL spawn that program in a PTY-backed session
- **AND** it SHALL expose the session through the existing terminal metadata and WebSocket attach protocol

#### Scenario: Explicit program session forwards input and resize
- **WHEN** a client attaches to an explicit program terminal session
- **THEN** input frames SHALL be forwarded to the spawned process
- **AND** resize frames SHALL resize the PTY for the spawned process

#### Scenario: Explicit program session reports exit code
- **WHEN** the explicit program exits with a numeric exit code
- **THEN** the terminal layer SHALL include that exit code in the terminal exit frame
- **AND** attached clients SHALL be able to distinguish process exit from attach transport failure

#### Scenario: Explicit program session keeps worktree boundary
- **WHEN** the daemon creates an explicit program terminal session for worktree path `/repo`
- **THEN** the terminal layer SHALL keep the same cwd validation boundary used by regular terminal sessions
- **AND** it SHALL NOT allow a requested cwd to escape the selected worktree

### Requirement: Windows Terminal Host Behavior
The terminal layer SHALL support terminal session creation and attachment on Windows when the selected backend and runtime can provide the required PTY semantics.

#### Scenario: Windows default backend starts terminal
- **WHEN** the effective global config has `terminalBackend` equal to `"default"`
- **AND** the daemon runs on Windows with Bun Terminal ConPTY support
- **THEN** the terminal layer SHALL create terminal sessions through the default backend
- **AND** clients SHALL attach through the existing terminal data-plane WebSocket protocol

#### Scenario: Windows default shell is selected
- **WHEN** a Windows terminal session is created without an explicit shell
- **THEN** the terminal layer SHALL select a Windows-compatible shell from configured environment values or available system defaults
- **AND** it SHALL NOT default to `/bin/bash`

#### Scenario: Windows terminal resize and input
- **WHEN** a Windows terminal attachment sends input or resize messages
- **THEN** the terminal layer SHALL forward them through the same runtime-neutral terminal process interface used on other platforms

### Requirement: Windows Active Command Metadata
The terminal layer SHALL expose best-effort active command metadata on Windows without making terminal control depend on process-table support.

#### Scenario: Windows process tree can be inspected
- **WHEN** the Windows host exposes process tree and command-line information for a daemon-owned PTY session
- **THEN** terminal session metadata MAY include active command details
- **AND** known agent command recognition SHALL use the same agent identifiers as other platforms

#### Scenario: Windows process tree cannot be inspected
- **WHEN** PowerShell, CIM, process permissions, or runtime support cannot provide active command information
- **THEN** the terminal layer SHALL omit active command metadata
- **AND** terminal session listing, attachment, input, resize, and termination behavior SHALL continue without failing

### Requirement: Windows Shell Process Lifecycle
The terminal-adjacent host process lifecycle used by shell mode SHALL provide Windows-compatible process start, liveness, and cleanup semantics.

#### Scenario: Shell service starts on Windows
- **WHEN** a shell-mode service starts on Windows
- **THEN** the host process boundary SHALL use a Windows-compatible shell invocation
- **AND** it SHALL write stdout and stderr to the same session log file contract used on other platforms

#### Scenario: Shell service stops on Windows
- **WHEN** a shell-mode service is stopped on Windows
- **THEN** the host process boundary SHALL terminate the service process tree after the configured grace behavior
- **AND** it SHALL update persisted shell runtime state consistently with other platforms

#### Scenario: Shell init commands run on Windows
- **WHEN** shell-mode host init commands run on Windows
- **THEN** the system SHALL execute configured commands in order
- **AND** a directory change in one command SHALL NOT leak into a later command

### Requirement: Terminal Session Unread Marker
Terminal session metadata SHALL include an optional `unreadSince` field (ISO-8601 timestamp). The daemon SHALL set `unreadSince` to the current time when a session's agent activity state transitions into a **hook-driven** `idle` (a real `stop` event) or `awaiting-input` while the session has zero attachments. The daemon SHALL NOT set the marker for a staleness-sourced `idle` produced by the staleness sweep's synthetic demotion — a guessed stop is not a "result is waiting" signal. The daemon SHALL NOT set the marker when the transition occurs while at least one attachment is present, and SHALL NOT refresh the timestamp on repeated events that do not change the activity state. The daemon SHALL clear `unreadSince` when any client attaches to the session; detaching SHALL NOT re-set it. Changes to `unreadSince` SHALL be observable by UI clients through existing unified event bus events that carry or trigger refetch of session metadata.

#### Scenario: Agent finishes while terminal is closed
- **WHEN** a session's agent activity transitions from `working` to a hook-stop `idle` (a real `stop` event) and the session has no attachments
- **THEN** the session metadata gains `unreadSince` set to the transition time and an event is published on the unified event bus

#### Scenario: Agent asks a question while terminal is closed
- **WHEN** a session's agent activity transitions to `awaiting-input` and the session has no attachments
- **THEN** the session metadata gains `unreadSince`

#### Scenario: Staleness demotion does not mark unread
- **WHEN** the staleness sweep demotes a session to a staleness-sourced `idle` while the session has no attachments
- **THEN** `unreadSince` remains unset

#### Scenario: Agent finishes while terminal is open
- **WHEN** a session's agent activity transitions to `idle` while at least one attachment is present
- **THEN** `unreadSince` remains unset

#### Scenario: Attaching marks the session read
- **WHEN** a client attaches to a session whose metadata has `unreadSince` set
- **THEN** `unreadSince` is cleared and the cleared state is observable by other UI clients

#### Scenario: Repeat idle event does not refresh the marker
- **WHEN** a session already marked unread receives another agent event that leaves the activity state `idle`
- **THEN** `unreadSince` keeps its original timestamp

#### Scenario: Non-agent sessions are unaffected
- **WHEN** a session has no agent activity block
- **THEN** the daemon never sets `unreadSince` for it

### Requirement: Backend-Persisted Unread Marker
The tmux terminal backend SHALL persist `unreadSince` in its on-disk session record alongside the session title, writing it back on every set and clear, and SHALL restore it when sessions are re-adopted after a daemon restart. A failed persistence write SHALL be logged and SHALL NOT fail the in-memory state change. The in-process backend SHALL NOT persist the marker, as its sessions do not survive daemon restarts.

#### Scenario: Unread marker survives daemon restart
- **WHEN** a tmux-backed session is marked unread and the daemon restarts
- **THEN** the restored session metadata still carries the original `unreadSince`, even though its agent activity block is empty until new plugin events arrive

#### Scenario: Cleared marker stays cleared after restart
- **WHEN** a client attaches to an unread tmux-backed session and the daemon later restarts
- **THEN** the restored session metadata has no `unreadSince`

### Requirement: Tmux Backend Scroll Behavior
The tmux terminal backend SHALL configure wos-owned tmux sessions so that scroll input from web clients scrolls content instead of being translated into arrow-key presses, and SHALL resynchronize client screen state after a replay gap.

#### Scenario: Mouse mode applied on attach
- **WHEN** the tmux backend attaches a transport to a wos-owned tmux session (initial create or reconnect)
- **THEN** it SHALL apply the session-scoped tmux option `mouse on` to that session
- **AND** it SHALL apply the option best-effort, never failing the attach if the option command fails

#### Scenario: Scrollback history limit at creation
- **WHEN** the tmux backend creates a new wos-owned tmux session
- **THEN** it SHALL configure the session so its first pane has a scrollback history limit of at least 50000 lines

#### Scenario: Screen state resync after replay gap
- **WHEN** a client attaches to a running tmux-backed terminal session
- **AND** the byte-journal replay plan reports a gap
- **THEN** the terminal layer SHALL request a full client refresh from tmux (`refresh-client`) for that session so the screen state, including alternate-screen mode, is re-emitted
- **AND** the refresh SHALL be best-effort and SHALL NOT fail the attachment if it cannot be performed

#### Scenario: Default backend unaffected by resync hook
- **WHEN** a replay gap occurs for a session on a backend that does not implement screen-state refresh
- **THEN** the terminal layer SHALL behave as before, sending only the existing `replay-gap` error

### Requirement: Tmux backend transcript binding persistence

The tmux terminal backend SHALL persist the transcript binding (`transcriptPath`, `agentSessionId`, and compact-carry token totals) in its on-disk session record alongside the session title and unread marker, writing it back whenever the binding is set and removing it when the binding is cleared, and SHALL restore it when sessions are re-adopted after a daemon restart. A failed persistence write SHALL be logged and SHALL NOT fail the in-memory telemetry state. The in-process backend SHALL NOT persist the binding, as its sessions do not survive daemon restarts.

#### Scenario: Binding survives daemon restart

- **WHEN** a transcript is bound to a tmux-backed session and the daemon restarts
- **THEN** the re-adopted session record still carries the persisted `transcriptPath`, `agentSessionId`, and compact-carry totals
- **AND** the daemon can re-bind and recompute telemetry from them without a new plugin event

#### Scenario: Cleared binding stays cleared after restart

- **WHEN** a tmux-backed session's transcript binding is removed and the daemon later restarts
- **THEN** the re-adopted session record carries no transcript binding

#### Scenario: Record predating the binding field is tolerated

- **WHEN** the backend restores a session record written before the transcript binding field existed
- **THEN** it restores the session without a transcript binding and does not error

### Requirement: Reusable Multiplexer Availability Detection

The terminal layer SHALL expose multiplexer availability detection as a standalone on-demand probe that callers can invoke without constructing a terminal backend adapter, so that other subsystems can report whether the tmux backend can run.

#### Scenario: Detection resolves and probes the multiplexer

- **WHEN** a caller invokes the standalone multiplexer availability detection
- **THEN** the detection SHALL resolve the multiplexer binary using the same resolution rules as the tmux backend (tmux on POSIX, psmux on Windows, `TMUX_BINARY` override on every platform)
- **AND** it SHALL run the version probe used for availability detection
- **AND** it SHALL return whether the multiplexer is available

#### Scenario: Unavailable detection reports a reason

- **WHEN** the standalone detection runs and the multiplexer cannot be resolved or fails its version probe
- **THEN** the detection SHALL return an unavailable result with a human-readable reason
- **AND** on Windows the reason SHALL name psmux as the missing prerequisite

#### Scenario: Detection is independent of adapter lifecycle

- **WHEN** the standalone detection is invoked repeatedly
- **THEN** each invocation SHALL reflect the current state of the multiplexer on the host
- **AND** it SHALL NOT depend on a previously cached backend-adapter availability result

### Requirement: Terminal Screen Snapshot Capture
The terminal backend adapter SHALL expose an optional capability to capture the current visible screen of a session as flat SGR-colored rows (the rendered grid, with color/attribute escapes only and no cursor-addressing or alternate-screen control sequences), together with the session's screen geometry (columns and rows). Capture SHALL be non-blocking and SHALL NOT use a synchronous, event-loop-blocking subprocess call.

#### Scenario: tmux backend captures the current screen
- **WHEN** a snapshot is requested for a session on the tmux/psmux backend
- **THEN** the backend SHALL return the current visible screen as flat SGR-colored rows captured via `tmux capture-pane -p -e`
- **AND** the result SHALL reflect the session's alternate-screen content when a full-screen TUI is running
- **AND** the capture SHALL run asynchronously without blocking the daemon event loop

#### Scenario: Default backend cannot snapshot
- **WHEN** a snapshot is requested for a session on a backend that maintains no screen grid (the default PTY backend)
- **THEN** the backend SHALL report that no snapshot is available rather than returning corrupted output

#### Scenario: Capture avoids repeated process spawning
- **WHEN** snapshots are captured repeatedly for the same session at a cadence
- **THEN** the implementation SHOULD reuse a persistent backend connection rather than spawning a new subprocess per capture

### Requirement: Snapshot Geometry Reporting
A captured screen snapshot SHALL report the geometry it was captured at (columns and rows), reflecting the backend pane size, so that consumers can normalize differing pane geometries for display.

#### Scenario: Snapshot includes geometry
- **WHEN** a snapshot is produced for a session
- **THEN** it SHALL include the column and row count of the captured screen

