# wos-docs-site Specification

## Purpose
TBD - created by archiving change add-starlight-docs-site. Update Purpose after archive.
## Requirements
### Requirement: Standalone Starlight docs app
The repository SHALL provide a standalone documentation application under `apps/docs` using Astro Starlight.

#### Scenario: Docs app is present in the monorepo
- **WHEN** a developer inspects the workspace applications
- **THEN** `apps/docs` SHALL exist as a workspace application
- **AND** it SHALL contain Astro/Starlight configuration for building the documentation site

#### Scenario: Docs app builds independently
- **WHEN** a developer runs the docs build command
- **THEN** the documentation site SHALL build without requiring the wos daemon or web UI to be running

### Requirement: First-run onboarding content
The documentation site SHALL provide a simple Get Started path for a new wos user.

#### Scenario: User opens Get Started
- **WHEN** a user opens the Get Started documentation page
- **THEN** the page SHALL explain the prerequisites for using wos
- **AND** it SHALL distinguish Docker-backed mode prerequisites from shell-mode host process usage
- **AND** it SHALL show how to install dependencies
- **AND** it SHALL include a minimal `wos.yaml` example
- **AND** it SHALL show how to run `wos up`, open `wos web`, and stop services with `wos down`

#### Scenario: User opens the docs homepage
- **WHEN** a user opens the documentation homepage
- **THEN** the page SHALL describe what wos does
- **AND** it SHALL link to the Get Started path
- **AND** it SHALL surface the main documentation areas for concepts, the Worktree Runtime deployment area, guides, reference, and troubleshooting

### Requirement: Task-oriented documentation structure
The documentation site SHALL organize pages around common user tasks and wos concepts.

#### Scenario: User scans sidebar navigation
- **WHEN** a user views the docs sidebar
- **THEN** it SHALL include sections for Start Here, Concepts, Worktree Runtime, Guides, Reference, Troubleshooting, and Development
- **AND** the Worktree Runtime section SHALL group the deployment-related documentation: the deployment lifecycle, deployment startup guides, the deploy/runtime configuration pages, the deploy-config reference, and deployment troubleshooting
- **AND** the Start Here section SHALL put Get Started before deeper reference content

#### Scenario: User needs configuration help
- **WHEN** a user navigates to the Worktree Runtime configuration documentation
- **THEN** the docs SHALL include pages or sections for generated mode, compose mode, shell mode, services and ports, healthchecks, dependencies, clone volumes, cache, targets, and runtime arguments

#### Scenario: User needs operational help
- **WHEN** a user navigates to the Worktree Runtime, guides, or troubleshooting documentation
- **THEN** the docs SHALL cover running a worktree, using the web UI, selective startup, detached startup, daemon basics, common config errors, port conflicts, healthcheck failures, and init or volume failures

### Requirement: Existing in-app docs remain contextual
The new documentation site SHALL NOT replace the existing in-app `wos.yaml` documentation route.

#### Scenario: Web UI config state links to in-app docs
- **WHEN** the web UI renders setup or worktree configuration states that link to `/docs/wos-yaml`
- **THEN** those links SHALL remain valid
- **AND** the in-app documentation page SHALL continue to provide compact contextual `wos.yaml` help

### Requirement: Bun-compatible docs workflow
The documentation site SHALL provide Bun-compatible commands for local development and builds.

#### Scenario: Developer starts docs locally
- **WHEN** a developer runs the docs development command
- **THEN** the command SHALL start the Astro/Starlight development server for `apps/docs`

#### Scenario: Developer builds docs
- **WHEN** a developer runs the docs build command
- **THEN** the command SHALL use Bun-compatible workspace scripts
- **AND** it SHALL produce the static documentation build output for deployment

### Requirement: Shell Mode Documentation
The documentation site SHALL explain how to configure and operate `mode: shell` projects.

#### Scenario: User opens shell mode documentation
- **WHEN** a user opens the shell mode configuration page
- **THEN** the page SHALL include a copyable `mode: shell` `wos.yaml` example
- **AND** it SHALL explain that WorktreeOS starts configured app services as host shell processes instead of Docker containers

#### Scenario: User checks shell mode fields
- **WHEN** a user reads the shell mode configuration page
- **THEN** the page SHALL list the supported shell-mode service fields: `script`, `cwd`, `ports`, `env_file`, `environment`, `init_script`, and `dependencies`
- **AND** it SHALL list the supported related top-level sections: `app.init_script`, `clone_volumes`, `cache`, `targets`, `arguments`, and `host_ports`
- **AND** it SHALL explain that `script` is required for each shell service

#### Scenario: User checks rejected Docker-only fields
- **WHEN** a user reads the shell mode configuration page
- **THEN** the page SHALL explain that `app.image`, `app.services.*.image`, `deps`, `app.services.*.volumes`, `connect_npm_cache`, `connect_yarn_cache`, and `connect_bun_cache` are not supported in shell mode

#### Scenario: User configures shell service ports
- **WHEN** a user reads the shell mode configuration page
- **THEN** the page SHALL explain that a configured shell service port is a logical port for which WorktreeOS allocates a host port
- **AND** it SHALL explain that the service process must bind the allocated host port
- **AND** it SHALL document the injected `WOS_SERVICE_PORT` and `WOS_SERVICE_HOSTNAME` environment variables for the first configured port
- **AND** it SHALL explain that multi-port services can use `${app.services.<name>.hostPort[<port>]}` and `${app.services.<name>.hostname[<port>]}` templates for exact port references

### Requirement: Runtime-Neutral Documentation Wording
Shared documentation pages SHALL avoid describing all WorktreeOS deployments as Docker-backed when shell mode is supported.

#### Scenario: User reads deployment mode reference
- **WHEN** a user reads the `wos.yaml` reference
- **THEN** the docs SHALL list `generated`, `compose`, and `shell` as supported deployment modes
- **AND** it SHALL link to the dedicated page for each mode

#### Scenario: User reads shared lifecycle documentation
- **WHEN** a user reads lifecycle or command documentation that applies to more than one deployment mode
- **THEN** the docs SHALL distinguish Docker-backed container behavior from shell-mode host process behavior where the distinction affects user expectations

### Requirement: Native Windows Documentation
The standalone documentation site SHALL explain how to install, configure, and troubleshoot native Windows usage without WSL.

#### Scenario: User reads Windows setup guide
- **WHEN** a user opens the Windows setup documentation
- **THEN** the docs SHALL explain native daemon usage outside WSL
- **AND** they SHALL list Windows prerequisites for Bun/source usage, the `.exe` release asset, Git, Docker Desktop for Docker-backed modes, and supported shells for shell mode

#### Scenario: User reads daemon docs
- **WHEN** a user reads daemon or Web UI documentation
- **THEN** the docs SHALL explain that daemon control uses the HTTP listener and daemon metadata
- **AND** they SHALL not instruct users to remove or inspect `daemon.sock`

#### Scenario: User reads bind host docs
- **WHEN** a user reads global config documentation for `web.host`
- **THEN** the docs SHALL state that the default is `127.0.0.1`
- **AND** they SHALL explain that values such as `0.0.0.0` expose the listener according to the user's network environment
- **AND** they SHALL state that wos does not add an automatic loopback check for this setting

#### Scenario: User reads Windows path docs
- **WHEN** a user reads configuration documentation for paths, clone volumes, or Compose volumes
- **THEN** the docs SHALL include Windows drive-letter examples
- **AND** they SHALL recommend object-form `clone_volumes` entries when a string form would be ambiguous

#### Scenario: User reads Windows troubleshooting
- **WHEN** a user opens troubleshooting documentation on Windows
- **THEN** the docs SHALL cover HTTP listener bind failures, stale daemon metadata, Docker Desktop named-pipe failures, terminal runtime unavailability, and shell process cleanup diagnostics

### Requirement: Native Windows Release Documentation
The docs site SHALL document native Windows release assets and source-install wrappers.

#### Scenario: User reads release binary docs
- **WHEN** a user opens release binary documentation
- **THEN** the docs SHALL list the Windows amd64 `.exe` asset alongside macOS and Linux assets
- **AND** they SHALL explain how to run `wos.exe` from PowerShell or Command Prompt

#### Scenario: User reads CLI docs
- **WHEN** a Windows user reads CLI reference documentation
- **THEN** the docs SHALL describe Windows browser launch behavior, HTTP daemon discovery, and daemon lifecycle commands without Unix socket assumptions
