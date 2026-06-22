# wos-terminal-sessions Specification

## Purpose
TBD - created by archiving change add-managed-worktrees-and-terminals.
## Requirements
### Requirement: Worktree Terminal Session Lifecycle
The system SHALL manage long-running terminal sessions scoped to a selected Git worktree while the daemon process is running.

#### Scenario: Terminal session is created
- **WHEN** a user starts a terminal session for a valid worktree
- **THEN** the daemon SHALL create a terminal session record with a stable terminal session id
- **AND** it SHALL start a PTY-backed process whose working directory is the selected worktree root
- **AND** it SHALL report the session as running

#### Scenario: Terminal session exits
- **WHEN** the PTY-backed process exits
- **THEN** the daemon SHALL mark the terminal session as exited
- **AND** it SHALL preserve the exit code or signal when available
- **AND** it SHALL NOT remove the containing Git worktree

#### Scenario: Terminal session is killed
- **WHEN** a user requests termination of a running terminal session
- **THEN** the daemon SHALL terminate the PTY-backed process
- **AND** it SHALL mark the session as exited after the process exits

### Requirement: PTY-Based Terminal Emulation
The system SHALL use a PTY backend suitable for interactive terminal programs and TUI interfaces.

#### Scenario: Interactive program writes output
- **WHEN** a command running inside a terminal session writes terminal control sequences
- **THEN** the daemon SHALL stream the raw PTY output to attached clients without line-buffering it as deployment logs

#### Scenario: User sends input
- **WHEN** an attached client sends keyboard input for a terminal session
- **THEN** the daemon SHALL write that input to the PTY process

#### Scenario: User resizes terminal
- **WHEN** an attached client sends terminal dimensions
- **THEN** the daemon SHALL resize the PTY process to the requested columns and rows

### Requirement: Terminal Session Attachment
The system SHALL allow browser clients to attach, detach, and reattach to running terminal sessions while the daemon is running.

#### Scenario: Client attaches to running session
- **WHEN** a browser client attaches to an existing running terminal session
- **THEN** the daemon SHALL begin streaming live PTY output to that client
- **AND** it SHALL accept input from that client

#### Scenario: Client disconnects
- **WHEN** all browser clients disconnect from a running terminal session
- **THEN** the daemon SHALL keep the PTY process running
- **AND** it SHALL keep the terminal session available for later attachment

#### Scenario: Client reattaches
- **WHEN** a browser client reattaches to a running terminal session after a prior disconnect
- **THEN** the daemon SHALL attach the client to the same PTY process
- **AND** it SHALL provide a bounded recent output history when available before live output

### Requirement: Terminal Session Daemon Lifetime
The system SHALL treat terminal session restart behavior as backend-specific: default-backend sessions are daemon-lifetime resources, while tmux-backed sessions are eligible for restoration after daemon restart when the underlying tmux session still exists.

#### Scenario: Daemon is running
- **WHEN** the daemon remains running after a browser tab closes
- **THEN** running terminal sessions SHALL remain available for reattachment

#### Scenario: Daemon restarts with default backend
- **WHEN** the daemon process stops or restarts while `terminalBackend` is `"default"`
- **THEN** terminal session records from the previous daemon process SHALL NOT be restored
- **AND** clients SHALL recover by fetching the current terminal session list, which SHALL omit the previous live sessions

#### Scenario: Daemon restarts with tmux backend
- **WHEN** the daemon process stops or restarts while `terminalBackend` is `"tmux"`
- **AND** a previous tmux-backed terminal session still exists in tmux
- **THEN** clients SHALL recover by fetching the current terminal session list, which SHALL include the restored tmux-backed terminal session
- **AND** clients SHALL be able to reattach to the restored session

#### Scenario: Tmux session is gone after daemon restart
- **WHEN** the daemon process restarts while `terminalBackend` is `"tmux"`
- **AND** a previous tmux-backed terminal session no longer exists in tmux
- **THEN** clients SHALL recover by fetching the current terminal session list, which SHALL omit that stale session

### Requirement: Terminal Session Isolation From Deployment Logs
The system SHALL keep terminal session output separate from wos deployment operation logs.

#### Scenario: Terminal emits output
- **WHEN** a terminal session emits output
- **THEN** the output SHALL be delivered through terminal session transport
- **AND** it SHALL NOT be appended to `init` or `service:<name>` deployment log channels

#### Scenario: Deployment operation emits logs
- **WHEN** an `up`, `down`, service operation, or worktree removal operation emits logs
- **THEN** those logs SHALL continue using existing operation and worktree log streams
- **AND** they SHALL NOT be routed into terminal session output

### Requirement: User-Named Terminal Sessions
The system SHALL let users assign, change, and clear human-readable names for worktree-scoped terminal sessions.

#### Scenario: User names a running terminal session
- **WHEN** a user assigns a name to a running terminal session
- **THEN** the terminal session record SHALL expose that name as the session title
- **AND** the session SHALL remain scoped to the same Git worktree

#### Scenario: User changes terminal session name
- **WHEN** a user changes the name of an already-named terminal session
- **THEN** the terminal session record SHALL replace the previous title with the new normalized title
- **AND** the terminal process SHALL continue running without restart

#### Scenario: User clears terminal session name
- **WHEN** a user clears a terminal session name
- **THEN** the terminal session record SHALL remove the custom title
- **AND** clients SHALL fall back to automatic terminal labeling

#### Scenario: Restored tmux session keeps name
- **WHEN** the daemon process restarts while `terminalBackend` is `"tmux"`
- **AND** a previous named tmux-backed terminal session still exists in tmux
- **THEN** clients SHALL recover by fetching the current terminal session list
- **AND** the restored terminal session SHALL include the previously assigned title

### Requirement: Agent activity block on session metadata
`TerminalSessionMetadata` SHALL carry an optional derived `agentActivity` block containing: `state` (`working` | `idle` | `awaiting-input`), `lastEvent`, optional pending `question` (`summary`, `askedAt`), optional `lastQuery`, and `at` (timestamp of last transition). The block SHALL be present only while an agent with an activity-reporting plugin is active in the session and SHALL be removed when the agent process exits.

#### Scenario: Activity block appears with first event
- **WHEN** the first agent activity event is bound to a session
- **THEN** the session snapshot includes `agentActivity` with the derived state

#### Scenario: Activity block included in snapshots
- **WHEN** a client fetches or subscribes to terminal session snapshots
- **THEN** sessions with active agent reporting include the `agentActivity` block

#### Scenario: Block removed on agent exit
- **WHEN** the agent process in the session terminates
- **THEN** subsequent snapshots omit `agentActivity`

### Requirement: Agent telemetry block on session metadata
`TerminalSessionMetadata` SHALL carry an optional derived `agentTelemetry` block containing: `model`, `mainTokens`, `subagentTokens`, `contextUsed`, `contextWindow`, and `updatedAt`. The block SHALL be present only while a transcript is bound to the session and telemetry has been derived, and SHALL be removed when the binding is removed.

#### Scenario: Telemetry block appears after first derived usage
- **WHEN** the transcript reader derives usage for a bound session
- **THEN** session snapshots include `agentTelemetry` with model and token figures

#### Scenario: Block absent without binding
- **WHEN** a session has no bound transcript (e.g. a plain shell)
- **THEN** snapshots omit `agentTelemetry`

### Requirement: Terminal Session Environment Rebuilt From Login Shell And Session Allowlist

A spawned terminal session's environment SHALL be rebuilt from a login shell plus a narrow, daemon-provided session allowlist, rather than inherited wholesale from the daemon process.

The terminal session manager SHALL compose the spawned environment from only:
- a session allowlist of variables that do not live in user dotfiles but are needed for ssh/locale/proxy behavior — at minimum `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `TERM_PROGRAM`, `COLORTERM`, `LANG`, `LC_*`, `LANGUAGE`, `TZ`, `SSH_AUTH_SOCK`, `SSH_CONNECTION`, `SSH_CLIENT`, `DISPLAY`, `XAUTHORITY`, the proxy variables (`http_proxy`/`https_proxy`/`no_proxy`/`all_proxy` and uppercase variants), and `TMPDIR` — taken from the daemon's environment; and
- the deliberate agent-binding layer (`WOS_DAEMON_URL`, `WOS_TERMINAL_SESSION_ID`, `WOS_AGENT_TOKEN`), applied after the allowlist.

The spawned shell SHALL be a login shell, so that the user's dotfiles (`.zprofile`/`.zshrc` and platform equivalents, including the macOS `path_helper`) reconstruct `PATH` and all other user/product variables on every terminal. `PATH` SHALL NOT be passed from the daemon's environment; the daemon SHALL NOT prepend a binary directory to the terminal `PATH`.

Any daemon environment variable that is neither on the session allowlist nor part of the agent-binding layer SHALL be absent from the spawned terminal's environment. This guarantee SHALL be backend-agnostic: it applies whether the default PTY backend or the tmux backend hosts the session, and for tmux it covers the `new-session` client (which seeds the tmux server's global environment) and the attach client.

#### Scenario: Daemon-private variables never reach a terminal

- **WHEN** the daemon's process environment contains daemon-private variables such as `WOS_HOME` or `WOS_HOME_ALLOW_TMP` and a client opens a terminal session
- **THEN** the environment handed to the backend's session creation SHALL NOT contain those variables
- **AND** for the tmux backend the tmux server's global environment SHALL NOT be seeded with them
- **AND** a `wos` command or a new daemon launched inside that terminal SHALL resolve the default `~/.wos` home

#### Scenario: Fresh PATH reflects the current user environment

- **WHEN** a terminal session is created and the pane runs as a login shell
- **THEN** `PATH` SHALL be the one produced by the user's login dotfiles (and platform `path_helper`), not the daemon's snapshot
- **AND** a tool added to the user's dotfiles after the daemon started SHALL be present on `PATH`

#### Scenario: Deleted variables do not resurrect

- **WHEN** the daemon's frozen environment still carries a variable the user has since removed from their dotfiles, and that variable is not on the session allowlist
- **THEN** the spawned terminal's environment SHALL NOT contain that variable

#### Scenario: Session allowlist variables are preserved

- **WHEN** a terminal session is created and the daemon environment contains allowlist variables such as `SSH_AUTH_SOCK`, `LANG`, and `TERM`
- **THEN** those variables SHALL be present in the spawned terminal's environment so ssh and locale continue to work

#### Scenario: Agent bindings still reach the terminal

- **WHEN** a terminal session is created
- **THEN** the agent-binding variables (`WOS_TERMINAL_SESSION_ID`, `WOS_AGENT_TOKEN`, and, when configured, `WOS_DAEMON_URL`) SHALL be present in the spawned terminal's environment, layered after the allowlist

