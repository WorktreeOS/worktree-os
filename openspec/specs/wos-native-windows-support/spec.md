# wos-native-windows-support Specification

## Purpose
TBD - created by archiving change windows-native-support. Update Purpose after archive.

## Requirements
### Requirement: Native Windows Host Support
The system SHALL support running the wos daemon and CLI as native Windows processes without requiring WSL for the daemon process.

#### Scenario: Daemon starts outside WSL on Windows
- **WHEN** a Windows user starts the daemon from PowerShell, Command Prompt, Windows Terminal, or a native `.exe`
- **THEN** the daemon SHALL run as a native Windows process
- **AND** it SHALL expose the same local HTTP management listener used by macOS and Linux
- **AND** it SHALL NOT require a WSL distribution to host the daemon process

#### Scenario: CLI controls native Windows daemon
- **WHEN** a Windows user runs CLI commands that require daemon coordination
- **THEN** the CLI SHALL discover and call the native daemon over the configured daemon HTTP API
- **AND** it SHALL NOT require Unix domain sockets, WSL path translation, or WSL process execution

#### Scenario: Existing POSIX hosts remain supported
- **WHEN** a macOS or Linux user runs the daemon and CLI after this change
- **THEN** the system SHALL continue to support daemon startup, CLI commands, Web UI, Docker-backed modes, shell mode, and terminal sessions
- **AND** the system SHALL use the same daemon HTTP API contract as Windows
### Requirement: Native Windows Feature Parity
Native Windows support SHALL cover daemon lifecycle, Web UI, CLI worktree operations, Docker-backed modes, shell mode, terminal sessions, and release binaries.

#### Scenario: Windows user runs daemon lifecycle commands
- **WHEN** a Windows user runs `wos start`, `wos stop`, `wos restart`, or `wos web`
- **THEN** those commands SHALL work through daemon HTTP metadata and health checks
- **AND** they SHALL NOT depend on Unix socket files

#### Scenario: Windows user runs worktree lifecycle commands
- **WHEN** a Windows user runs `wos up`, `wos down`, `wos status`, or `wos wait` inside a Git worktree
- **THEN** the CLI SHALL submit or inspect the operation through the daemon HTTP API
- **AND** it SHALL preserve the existing worktree guard and user-facing command semantics

#### Scenario: Windows terminal support is available
- **WHEN** the daemon runs on Windows under a Bun runtime that provides `Bun.Terminal` with ConPTY support
- **THEN** the default terminal backend SHALL be available unless another required cleanup guarantee is missing

#### Scenario: Windows persistent terminal sessions are available
- **WHEN** a Windows host has psmux installed and `terminalBackend` is `"tmux"`
- **THEN** daemon-owned terminal sessions SHALL survive daemon restarts through psmux sessions
- **AND** the tmux backend contract SHALL behave the same as with tmux on POSIX hosts

#### Scenario: Docker Desktop is available
- **WHEN** the daemon runs on Windows with Docker Desktop exposing the Docker Engine API
- **THEN** Docker-backed WorktreeOS features SHALL use the Windows Docker Engine transport without requiring `/var/run/docker.sock`
### Requirement: Native Windows Validation Boundary
The repository SHALL include automated and smoke coverage that prevents native Windows support from regressing to Unix-only assumptions.

#### Scenario: Windows CI smoke starts daemon
- **WHEN** Windows CI or release smoke runs the native Windows binary or source command
- **THEN** it SHALL verify that the daemon can start, bind the configured HTTP listener, answer `/ui/v1/health`, and stop cleanly

#### Scenario: Socket dependency is detected
- **WHEN** Windows tests exercise CLI daemon lifecycle commands
- **THEN** the tests SHALL fail if those commands require Unix domain socket files or Bun `fetch(..., { unix })`

#### Scenario: Windows path tests run
- **WHEN** cross-platform unit tests validate session names, clone volume parsing, Compose volume parsing, and metadata paths
- **THEN** they SHALL include Windows drive-letter and invalid-filename-character cases

#### Scenario: Missing Windows prerequisite is reported
- **WHEN** a Windows host lacks Docker Desktop, a supported terminal runtime, or a supported shell executable
- **THEN** the system SHALL return a clear diagnostic for that missing prerequisite
- **AND** unrelated daemon and Web UI functionality SHALL continue when possible
