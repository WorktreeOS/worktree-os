# worktreeos-brand-contract Specification

## Purpose
WorktreeOS is positioned as a control plane for parallel, agent-driven development across worktrees and projects — "one control plane for every worktree, every project, every agent." Docker deployment is one capability among several (navigation, agent-integrated terminals, notifications, Git review, deployment, and exposure), never the headline category. This spec governs the product's brand identity and the canonical positioning narrative so user-facing copy stays consistent and honest: the binary is `wos`, project config is `wos.yaml`, global state lives under `~/.wos`, packages use the `@worktreeos/*` scope, runtime artifacts use the `dev.wos.*` / `wos` technical namespace, and positioning copy may not silently drift back to deployment-first framing.
## Requirements
### Requirement: Production brand identity
The system SHALL present the product as `WorktreeOS` in user-facing application copy, documentation, metadata, package descriptions, skill descriptions, and release-facing text.

#### Scenario: User-facing product name
- **WHEN** a user reads application UI, documentation, package descriptions, generated help text, app metadata, release workflow labels, or agent skill descriptions
- **THEN** the product name SHALL be `WorktreeOS`
- **AND** the public domain SHALL be represented as `worktree.dev` where a production domain is required

### Requirement: Command-line contract
The system SHALL expose `wos` as the command-line binary and SHALL document all command examples with `wos`.

#### Scenario: CLI command examples
- **WHEN** a user reads help output, README examples, docs, skills, tests, or release notes for command-line usage
- **THEN** commands SHALL use the `wos` binary name
- **AND** no legacy binary alias SHALL be documented or installed

### Requirement: Project configuration contract
The system SHALL read project configuration from `wos.yaml` and SHALL use `wos.yaml` in UI labels, API messages, docs, tests, and validation errors.

#### Scenario: Project config is required
- **WHEN** the CLI, daemon, or UI resolves a worktree whose source worktree does not contain `wos.yaml`
- **THEN** startup SHALL be unavailable with a message that names `wos.yaml`
- **AND** no fallback to a legacy config filename SHALL be attempted

### Requirement: Global storage contract
The system SHALL use `~/.wos` as the default global home directory and `WOS_HOME` as the environment variable override.

#### Scenario: Default home resolution
- **WHEN** `WOS_HOME` is unset
- **THEN** WorktreeOS SHALL store global managed state under `~/.wos`

#### Scenario: Home override
- **WHEN** `WOS_HOME` is set
- **THEN** WorktreeOS SHALL use that value as the global home directory
- **AND** no legacy home environment variable SHALL be read

### Requirement: Package namespace contract
The monorepo SHALL use `@worktreeos/*` as the workspace package scope and TypeScript import namespace.

#### Scenario: Internal package import
- **WHEN** application, package, or test code imports another workspace package
- **THEN** the import specifier SHALL use the `@worktreeos/*` scope
- **AND** TypeScript path aliases and workspace dependency declarations SHALL match that scope

### Requirement: Runtime ownership contract
Generated runtime artifacts SHALL use the `wos` technical namespace for ownership labels, generated service environment variables, ACME hook environment variables, Compose internals, cache paths, and project names.

#### Scenario: Generated Compose ownership
- **WHEN** WorktreeOS writes generated or overlay Compose artifacts
- **THEN** WorktreeOS-owned Docker labels SHALL use the `dev.wos.*` namespace
- **AND** generated internal service/profile names SHALL use `wos` naming
- **AND** generated cache paths SHALL use `wos` naming

#### Scenario: Service tunnel environment
- **WHEN** WorktreeOS injects service tunnel hostnames into a Compose service
- **THEN** the environment variables SHALL use `WOS_SERVICE_HOSTNAME` and `WOS_SERVICE_HOSTNAME_<port>`

#### Scenario: ACME hook environment
- **WHEN** WorktreeOS invokes a certificate DNS hook command
- **THEN** hook metadata SHALL be exposed through `WOS_ACME_*` environment variables

### Requirement: Web application naming contract
The web application SHALL use WorktreeOS/wos naming for app metadata, browser storage keys, asset names, route names, docs links, and visible UI copy.

#### Scenario: Web app metadata
- **WHEN** the browser loads the web application manifest, document title, service worker cache name, or persistent UI storage keys
- **THEN** those identifiers SHALL use WorktreeOS or the `wos` technical namespace as appropriate

#### Scenario: Config docs route
- **WHEN** a user opens in-app configuration documentation
- **THEN** the route SHALL be `/docs/wos-yaml`
- **AND** links and tests SHALL reference the same route

### Requirement: Repository-wide removal of retired naming
The repository SHALL contain no remaining occurrences of the retired development codename or its common case and separator variants after implementation.

#### Scenario: Repository search verification
- **WHEN** implementation is complete
- **THEN** a repository-wide case-insensitive search for the retired codename and its common separator variants SHALL return no matches
- **AND** this check SHALL include source code, tests, docs, scripts, assets paths, OpenSpec current specs, active changes, archived changes, and agent skill files

### Requirement: Product positioning narrative

User-facing positioning copy SHALL present WorktreeOS as a control plane for parallel, agent-driven development across projects — "one control plane for every worktree, every project, every agent" — and SHALL NOT frame the product primarily as a Docker/worktree deployment tool. Deployment SHALL be presented as one capability among several, never as the headline category. This requirement governs framing only; it SHALL NOT weaken the existing brand, CLI, configuration, storage, package-namespace, or runtime-ownership requirements.

#### Scenario: Headline category is the control plane, not deployment
- **WHEN** a reader opens a primary positioning surface (the README opening, the documentation homepage hero, the site description, or `openspec/project.md`)
- **THEN** the headline SHALL describe WorktreeOS as a control plane / operating layer for parallel, agent-driven development across worktrees and projects
- **AND** it SHALL NOT lead with "a CLI for deploying the current Git worktree via Docker Compose" or an equivalent deployment-first framing

#### Scenario: Capabilities are presented with navigation first and deployment demoted
- **WHEN** a positioning surface enumerates what WorktreeOS does
- **THEN** it SHALL present navigation across every worktree of every project (Mission Control and the worktree board) before deployment
- **AND** it SHALL include agent-integrated terminals, notifications, and Git review as first-class capabilities alongside Docker deployment with automatic host-port allocation and Cloudflare tunnels with HTTPS
- **AND** Docker deployment SHALL appear as one capability in that set rather than as the framing of the whole product

#### Scenario: Remote access is described honestly
- **WHEN** positioning copy mentions remote access or remote control
- **THEN** it SHALL describe remote access as exposing the web UI through a Cloudflare tunnel using the existing tunnel capability
- **AND** it SHALL NOT claim a built-in remote authentication layer or a productized "install on your own servers" deployment as a shipped feature
- **AND** any native remote auth, remote hardening, or server-install capability SHALL appear only under a clearly labeled Roadmap or future-work section

#### Scenario: Deployment technical documentation is preserved
- **WHEN** the positioning is applied across documentation
- **THEN** the deploy-config reference and configuration pages (generated mode, compose mode, shell mode, services and ports, healthchecks, dependencies, clone volumes, cache, targets, arguments) SHALL retain their technical content
- **AND** only their framing or introductory lines MAY change to fit the control-plane narrative
