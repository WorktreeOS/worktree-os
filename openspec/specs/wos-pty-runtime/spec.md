# wos-pty-runtime Specification

## Purpose
TBD - created by archiving change replace-pty-adapter-with-bun-terminal.

## Requirements

### Requirement: Bun Terminal PTY Runtime
The system SHALL provide a Bun-native PTY runtime adapter for daemon-owned terminal sessions when `Bun.Terminal` is available on a supported host platform, including Windows ConPTY support.

#### Scenario: Bun Terminal is available
- **WHEN** the daemon loads its default PTY factory under Bun and `Bun.Terminal` is available
- **THEN** the daemon SHALL use the Bun Terminal PTY adapter
- **AND** it SHALL NOT require `node-pty` to create terminal sessions

#### Scenario: Bun Terminal is available on Windows
- **WHEN** the daemon runs on Windows under Bun and `Bun.Terminal` provides ConPTY support
- **THEN** the daemon SHALL treat the Bun Terminal PTY adapter as available
- **AND** it SHALL NOT fail terminal backend initialization solely because `process.platform` is `win32`

#### Scenario: Bun Terminal is unavailable
- **WHEN** the daemon runtime cannot provide `Bun.Terminal`
- **THEN** the daemon SHALL fail terminal backend initialization with a clear terminal-unavailable error
- **AND** it SHALL NOT expose a partially initialized PTY backend

### Requirement: Bun Terminal Session I/O
The Bun Terminal PTY adapter SHALL satisfy the existing daemon PTY process contract for terminal session input, output, resize, and listener lifecycle.

#### Scenario: Terminal emits output
- **WHEN** a command running inside a Bun Terminal-backed session emits terminal output or control sequences
- **THEN** the adapter SHALL deliver the raw output to registered data listeners
- **AND** it SHALL preserve output in a form suitable for xterm-compatible clients

#### Scenario: Client sends input
- **WHEN** the daemon writes input to a Bun Terminal-backed PTY process
- **THEN** the adapter SHALL forward the input to the terminal process

#### Scenario: Client resizes terminal
- **WHEN** the daemon resizes a Bun Terminal-backed PTY process
- **THEN** the adapter SHALL resize the terminal to the requested columns and rows
- **AND** it SHALL expose the updated dimensions through the PTY process contract

#### Scenario: Listener unsubscribes
- **WHEN** a data or exit listener unsubscribes from a Bun Terminal-backed PTY process
- **THEN** the adapter SHALL stop delivering future events to that listener
- **AND** it SHALL continue serving remaining listeners

### Requirement: Bun Terminal Exit Reporting
The Bun Terminal PTY adapter SHALL report the spawned subprocess exit status exactly once.

#### Scenario: Process exits with non-zero status
- **WHEN** a Bun Terminal-backed process exits with a non-zero exit code
- **THEN** the adapter SHALL notify exit listeners exactly once
- **AND** the notification SHALL include the subprocess exit code

#### Scenario: Process exits from signal
- **WHEN** a Bun Terminal-backed process exits due to an available signal
- **THEN** the adapter SHALL notify exit listeners exactly once
- **AND** the notification SHALL include the available signal information

#### Scenario: Terminal stream closes before process status is finalized
- **WHEN** the Bun Terminal stream lifecycle changes before the subprocess exit status is finalized
- **THEN** the adapter SHALL wait for the subprocess exit status before reporting PTY process exit

### Requirement: Bun Terminal Process Cleanup
The Bun Terminal PTY adapter SHALL terminate daemon-owned terminal process trees without leaving child processes behind on supported host platforms.

#### Scenario: POSIX terminal session has background children
- **WHEN** a Bun Terminal-backed shell on a supported POSIX platform has spawned background child processes
- **AND** the daemon kills the PTY process
- **THEN** the adapter SHALL signal the terminal process group when supported
- **AND** it SHALL NOT leave daemon-owned child processes running after the session exits

#### Scenario: Windows terminal session has child processes
- **WHEN** a Bun Terminal-backed shell on Windows has spawned child processes
- **AND** the daemon terminates the terminal session
- **THEN** the adapter SHALL use a Windows-compatible process-tree cleanup strategy
- **AND** it SHALL NOT leave daemon-owned child processes running after forced cleanup completes

#### Scenario: Process tree cleanup is unavailable
- **WHEN** the runtime or platform cannot provide equivalent process-tree cleanup semantics
- **THEN** the adapter SHALL fail clearly or disable that raw PTY backend path
- **AND** it SHALL NOT silently provide weaker cleanup behavior for daemon-owned terminal sessions
