# wos-cli-init-wizard Specification

## Purpose
TBD - created by archiving change add-cli-init-wizard. Update Purpose after archive.
## Requirements
### Requirement: First-Run Setup Wizard
The system SHALL provide an interactive setup wizard that is launched by bare `wos` (no arguments) and by `wos init`. The wizard SHALL run interactively only when standard input is a TTY; when standard input is not a TTY it SHALL NOT prompt and SHALL behave as the non-interactive path. When a global config file already exists the wizard SHALL run as a reconfigure flow, pre-filling each prompt's default with the value loaded from the existing global config.

#### Scenario: Bare wos with no config launches the wizard
- **WHEN** the user runs `wos` with no arguments and `~/.wos/config.json` does not exist
- **AND** standard input is a TTY
- **THEN** the system SHALL launch the interactive setup wizard
- **AND** the system SHALL NOT print the command usage text instead of the wizard

#### Scenario: wos init reconfigures with current values as defaults
- **WHEN** the user runs `wos init` and `~/.wos/config.json` already exists
- **AND** standard input is a TTY
- **THEN** the system SHALL launch the wizard with each prompt default taken from the loaded global config (bind address, port, terminal backend, auto-inject toggle)

#### Scenario: Wizard entrypoints are exempt from the configuration gate
- **WHEN** the user runs `wos` or `wos init` and no global config exists
- **THEN** the system SHALL launch the wizard
- **AND** the system SHALL NOT emit the no-configuration error used for other commands

#### Scenario: Wizard cancelled before save leaves no config
- **WHEN** the user aborts the wizard (e.g. Ctrl-C) before the persistence step
- **THEN** the system SHALL NOT write `~/.wos/config.json`
- **AND** the system SHALL exit without applying partial configuration

### Requirement: Wizard Environment Preflight
The wizard SHALL verify that Docker and Docker Compose are available before collecting configuration, and SHALL fail with an actionable error when they are not.

#### Scenario: Docker is missing
- **WHEN** the wizard runs its preflight and Docker or Docker Compose is not available on the host
- **THEN** the system SHALL print an actionable error naming the missing dependency and how to install it
- **AND** the system SHALL exit unsuccessfully without writing a config

#### Scenario: Docker is available
- **WHEN** the wizard runs its preflight and Docker and Docker Compose are available
- **THEN** the wizard SHALL continue to the configuration prompts

### Requirement: Wizard Bind Address and Port Configuration
The wizard SHALL prompt for the daemon bind address (default `127.0.0.1`) and port (default `4949`). The wizard SHALL warn and require explicit confirmation when the chosen bind address is not a loopback address, and SHALL detect when the chosen port is already in use and offer the next free port.

#### Scenario: Default loopback bind address
- **WHEN** the wizard prompts for the bind address and the user accepts the default
- **THEN** the resolved web host SHALL be `127.0.0.1`
- **AND** the wizard SHALL NOT show the non-loopback warning

#### Scenario: Non-loopback bind address requires confirmation
- **WHEN** the user enters a bind address that is not a loopback address
- **THEN** the wizard SHALL warn that the daemon control plane (exec / attach) would be reachable from the local network
- **AND** the wizard SHALL only accept the address after explicit confirmation

#### Scenario: Chosen port is already in use
- **WHEN** the user accepts or enters a port and a probe shows that port is already bound
- **THEN** the wizard SHALL report the conflict and offer the next free port as the default
- **AND** the persisted port SHALL be a port the probe found free

### Requirement: Wizard Terminal Backend and tmux Setup
The wizard SHALL detect tmux/psmux availability and configure the terminal backend accordingly. When tmux/psmux is available the wizard SHALL offer to set the `tmux` backend. When it is unavailable the wizard SHALL detect a host package manager (brew, apt, dnf, pacman, winget, scoop) and, when one is found, SHALL insistently offer to install tmux and set the `tmux` backend on success. When tmux/psmux remains unavailable, no package manager is found, the offer is declined, or installation fails, the wizard SHALL set the `default` backend and warn about reduced stability. The wizard SHALL NOT present or mention the experimental `host` backend.

#### Scenario: tmux already available
- **WHEN** the wizard detects that tmux (POSIX) or psmux (Windows) is available
- **THEN** the wizard SHALL offer to set the terminal backend to `tmux`
- **AND** accepting SHALL set `terminalBackend` to `tmux`

#### Scenario: tmux missing but a package manager is available
- **WHEN** tmux/psmux is not available and a supported host package manager is detected
- **THEN** the wizard SHALL insistently offer to install tmux using that package manager
- **AND** on a successful install the wizard SHALL set `terminalBackend` to `tmux`

#### Scenario: tmux missing and unresolved
- **WHEN** tmux/psmux is not available and either no supported package manager is detected, the install offer is declined, or installation fails
- **THEN** the wizard SHALL set `terminalBackend` to `default`
- **AND** the wizard SHALL print `Running outside tmux/psmux — terminal sessions may be unstable.`

#### Scenario: Host backend is never offered
- **WHEN** the wizard configures the terminal backend
- **THEN** the wizard SHALL NOT present `host` as a selectable backend
- **AND** the wizard SHALL NOT mention the `host` backend in its prompts

### Requirement: Wizard Agent Plugin Setup
The wizard SHALL detect installed agent binaries (claude, opencode, codex) and offer to install the matching integration plugin for claude and opencode when the binary is present and its plugin is not yet installed. For codex it SHALL only report that no plugin is available yet. The wizard SHALL offer to enable auto-injection of agent plugins for new agents.

#### Scenario: Claude or OpenCode present without plugin
- **WHEN** the wizard detects the `claude` or `opencode` binary on PATH and its integration plugin is not installed
- **THEN** the wizard SHALL offer to install the matching plugin
- **AND** accepting SHALL install the plugin using the existing plugin-install routine for that agent

#### Scenario: Codex present
- **WHEN** the wizard detects the `codex` binary on PATH
- **THEN** the wizard SHALL report that no codex integration plugin is available yet
- **AND** the wizard SHALL NOT offer a plugin install for codex

#### Scenario: No agent binaries present
- **WHEN** the wizard detects none of the supported agent binaries on PATH
- **THEN** the wizard SHALL skip the per-agent plugin offers

#### Scenario: Enable auto-injection
- **WHEN** the wizard offers to auto-inject agent plugins for new agents and the user accepts
- **THEN** the wizard SHALL set `autoInjectAgentPlugins` to `true` in the persisted config

### Requirement: Wizard Persistence and Daemon Start
The wizard SHALL persist the collected configuration via the global config save routine and SHALL then offer to start the daemon and open the web UI. Writing the config file SHALL be what satisfies the configuration gate for subsequent commands.

#### Scenario: Persist collected configuration
- **WHEN** the wizard completes its prompts
- **THEN** the system SHALL save `web.host`, `web.port`, `terminalBackend`, and `autoInjectAgentPlugins` to `~/.wos/config.json` through the validating global-config save routine
- **AND** after the file is written the configuration gate SHALL allow other commands to run

#### Scenario: Offer to start the daemon
- **WHEN** the wizard has saved the configuration
- **THEN** the wizard SHALL offer to start the local daemon
- **AND** accepting SHALL start the daemon using the standard daemon start path
- **AND** the wizard SHALL offer to open the web UI after the daemon is started

### Requirement: Non-Interactive Setup
The wizard SHALL support a non-interactive setup path so the configuration gate never permanently blocks automation. With `--yes` (or when standard input is not a TTY) the wizard SHALL apply defaults and provided flags without prompting. It SHALL accept `--host`, `--port`, `--backend <default|tmux>`, and `--install-tmux`.

#### Scenario: Fully non-interactive setup
- **WHEN** the user runs `wos init --host <h> --port <p> --backend tmux --install-tmux --yes`
- **THEN** the wizard SHALL apply the provided values without prompting
- **AND** it SHALL persist the configuration and exit successfully

#### Scenario: Non-interactive with defaults
- **WHEN** the user runs `wos init --yes` with no other flags
- **THEN** the wizard SHALL persist the default bind address, default port, and the resolved terminal backend without prompting

#### Scenario: Non-TTY input does not prompt
- **WHEN** bare `wos` or `wos init` runs and standard input is not a TTY
- **THEN** the wizard SHALL NOT block on a prompt
- **AND** it SHALL apply defaults and any provided flags and persist the configuration

