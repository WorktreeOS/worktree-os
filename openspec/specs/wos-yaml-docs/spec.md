# wos-yaml-docs Specification

## Purpose
TBD - created by archiving change add-first-run-web-setup. Update Purpose after archive.
## Requirements
### Requirement: WorktreeOS YAML Documentation Page
The web frontend SHALL provide an in-app documentation page that explains how to create and configure project deploy configuration files under the repository-local `.wos/` directory.

#### Scenario: User opens deploy config docs route
- **WHEN** a browser opens the project deploy configuration documentation route
- **THEN** the web UI SHALL render documentation for project deployment configuration
- **AND** it SHALL be reachable through the client-side router without leaving the app shell

#### Scenario: Documentation explains root and worktree config files
- **WHEN** the documentation page is rendered
- **THEN** it SHALL explain that `.wos/deploy.yaml` configures the selected primary/source worktree
- **AND** it SHALL explain that `.wos/deploy.worktree.yaml` configures secondary worktrees
- **AND** it SHALL distinguish repository-local `.wos/` project configuration from `$WOS_HOME` runtime storage

#### Scenario: Documentation covers generated mode
- **WHEN** the documentation page is rendered
- **THEN** it SHALL include a minimal generated-mode deploy config example
- **AND** it SHALL explain `app.image`, `app.init_script`, `app.services`, service `script`, service `ports`, `deps`, and app-port healthcheck basics

#### Scenario: Documentation covers compose mode
- **WHEN** the documentation page is rendered
- **THEN** it SHALL include a minimal `mode: compose` example
- **AND** it SHALL explain the required `compose.config` and `compose.expose` fields

#### Scenario: Documentation covers shell mode
- **WHEN** the documentation page is rendered
- **THEN** it SHALL include a minimal `mode: shell` example
- **AND** it SHALL explain that shell mode runs app services as host shell processes
- **AND** it SHALL explain supported shell service fields, rejected Docker-only fields, and the injected `WOS_SERVICE_PORT` / `WOS_SERVICE_HOSTNAME` port binding contract at a concise overview level

#### Scenario: Documentation covers dynamic ports
- **WHEN** the documentation page is rendered
- **THEN** it SHALL explain that `dynamic_ports` defaults to `true`
- **AND** it SHALL explain that `dynamic_ports: false` publishes or binds each declared managed port to the same host port and fails on conflicts instead of reallocating

#### Scenario: Documentation covers first-run helpers
- **WHEN** the documentation page is rendered
- **THEN** it SHALL explain `clone_volumes`, `cache`, package-manager cache connection fields, service `init_script`, `targets`, and `arguments` at a concise overview level
- **AND** it SHALL distinguish shell-mode host init behavior from Docker-backed init behavior where needed

#### Scenario: Missing config state links to docs
- **WHEN** the web UI renders a missing project deploy config state
- **THEN** it SHALL provide navigation to the project deploy configuration documentation page

#### Scenario: Invalid config state links to docs
- **WHEN** the web UI renders an invalid project deploy config state
- **THEN** it SHALL provide navigation to the project deploy configuration documentation page

### Requirement: In-App Windows Configuration Notes
The in-app `wos.yaml` documentation page SHALL include concise Windows-specific notes where path syntax affects configuration.

#### Scenario: User reads clone volume docs in app
- **WHEN** the in-app `wos.yaml` documentation explains `clone_volumes`
- **THEN** it SHALL mention that Windows drive-letter paths are supported
- **AND** it SHALL show or link to object-form `clone_volumes` for unambiguous source/destination mappings

#### Scenario: User reads generated mode volume docs in app
- **WHEN** the in-app documentation explains generated-mode app or dependency volumes
- **THEN** it SHALL mention that Windows host paths with drive letters are parsed as host paths, not as container separators

#### Scenario: User reads shell mode docs in app
- **WHEN** the in-app documentation explains `mode: shell`
- **THEN** it SHALL state that shell commands run as host processes using a host-compatible shell
- **AND** it SHALL distinguish Windows shell execution from POSIX `sh -lc` behavior at a concise overview level
