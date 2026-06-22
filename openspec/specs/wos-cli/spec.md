# wos-cli Specification

## Purpose
TBD - created by archiving change add-wos-mvp. Update Purpose after archive.
## Requirements
### Requirement: Worktree Command Guard
The system SHALL require commands that operate on worktree-scoped deployment state to run from inside a Git worktree.

#### Scenario: Up outside a Git worktree
- **WHEN** the user runs `wos up` from a directory that is not inside a Git worktree
- **THEN** the system SHALL report that wos must be run from inside a Git worktree
- **AND** the system SHALL NOT read `wos.yaml`
- **AND** the system SHALL NOT read or write wos state
- **AND** the system SHALL NOT write a generated Compose file
- **AND** the system SHALL NOT run init scripts or Docker Compose commands

#### Scenario: Status outside a Git worktree
- **WHEN** the user runs `wos status` from a directory that is not inside a Git worktree
- **THEN** the system SHALL report that wos must be run from inside a Git worktree
- **AND** the system SHALL NOT read wos state
- **AND** the system SHALL NOT run Docker Compose commands

#### Scenario: Commands inside a Git worktree
- **WHEN** the user runs `wos up` or `wos status` from inside a Git worktree
- **THEN** the system SHALL continue with the existing command-specific behavior for that worktree

### Requirement: Configuration File
The system SHALL read deployment configuration from the selected Git repository primary/source worktree's project-local `.wos` directory, SHALL read it fresh from disk for each command or daemon request that resolves command context, and SHALL use the file selected for the current worktree while deployment state remains scoped to the selected current worktree.

#### Scenario: Root deploy config is present for source worktree
- **WHEN** the user runs `wos up` or `wos status` inside the selected primary/source worktree
- **AND** the primary/source worktree contains `.wos/deploy.yaml`
- **THEN** the system SHALL parse `.wos/deploy.yaml` before performing command-specific behavior for the selected current worktree

#### Scenario: Worktree deploy config is present for secondary worktree
- **WHEN** the user runs `wos up` or `wos status` inside a secondary Git worktree
- **AND** the primary/source worktree contains `.wos/deploy.worktree.yaml`
- **THEN** the system SHALL parse `.wos/deploy.worktree.yaml` from the primary/source worktree before performing command-specific behavior for the selected current worktree
- **AND** the system SHALL NOT require a deploy config file inside the secondary worktree checkout

#### Scenario: Config file is read fresh for repeated up
- **WHEN** the user runs `wos up`
- **AND** changes the effective `.wos/deploy.yaml` or `.wos/deploy.worktree.yaml` in the primary/source worktree
- **AND** runs `wos up` again without restarting the daemon
- **THEN** the second `wos up` SHALL read the updated effective deploy config file from disk
- **AND** the second `wos up` SHALL NOT reuse a parsed config object from the earlier run

#### Scenario: Root deploy config is missing for source worktree
- **WHEN** the user runs `wos up` inside the selected primary/source worktree
- **AND** the primary/source worktree does not contain `.wos/deploy.yaml`
- **THEN** the system SHALL fail with an actionable error that names the missing `.wos/deploy.yaml` path

#### Scenario: Worktree deploy config is missing for secondary worktree
- **WHEN** the user runs `wos up` inside a secondary Git worktree
- **AND** the primary/source worktree does not contain `.wos/deploy.worktree.yaml`
- **THEN** the system SHALL fail with an actionable error that names the missing `.wos/deploy.worktree.yaml` path in the primary/source worktree

#### Scenario: Generated-compose config shape is present
- **WHEN** the effective deploy config omits `mode` or contains `mode: generated`
- **AND** it contains `clone_volumes`, `app`, `deps`, `host_ports`, or `dynamic_ports`
- **THEN** the system SHALL validate those fields according to the generated-compose configuration schema

#### Scenario: Explicit compose mode config shape is present
- **WHEN** the effective deploy config contains `mode: compose`
- **AND** it contains `compose.config`, `compose.expose`, `compose.env_file`, `compose.environment`, `host_ports`, or `dynamic_ports`
- **THEN** the system SHALL validate those fields according to the compose-mode configuration schema

### Requirement: Generated Compose File
In generated-compose mode, the system SHALL generate a Docker Compose file from the latest `wos.yaml`, store it in the current worktree's wos session directory, regenerate it for every `wos up`, and use that generated file for Docker Compose startup and status commands.

#### Scenario: App services are configured with inherited image
- **WHEN** `wos.yaml` contains `app.image` and `app.services`
- **THEN** the generated compose file SHALL contain one service per configured app service using `app.image` unless that app service configures its own image
- **AND** each app service SHALL run its configured `script` commands inside the mounted current worktree
- **AND** each app service SHALL preserve its configured environment after wos template resolution

#### Scenario: App service configures explicit image
- **WHEN** `wos.yaml` contains `app.image`, `app.services.api`, and `app.services.worker.image`
- **THEN** the generated compose file SHALL use `app.image` for service `api`
- **AND** the generated compose file SHALL use `app.services.worker.image` for service `worker`

#### Scenario: App services are configured only with service images
- **WHEN** every configured app service contains `app.services.<name>.image` and `app.image` is absent
- **THEN** the generated compose file SHALL contain one service per configured app service using each service's configured image
- **AND** each app service SHALL preserve its configured environment after wos template resolution

#### Scenario: Dependency services are configured
- **WHEN** `wos.yaml` contains `deps`
- **THEN** the generated compose file SHALL contain one service per dependency entry
- **AND** each dependency service SHALL preserve its configured image, environment, volumes, and published container ports after wos port assignment and template resolution

#### Scenario: Generated compose must be reused
- **WHEN** `wos up` generates a compose file for the current worktree
- **THEN** the system SHALL store the generated compose path in the current worktree's wos session state for later `wos status` commands
- **AND** the generated compose path SHALL be under `<wos-home>/sessions/<session-name>/compose.yaml`

#### Scenario: Up rewrites generated compose from current config
- **WHEN** the user runs `wos up` in generated-compose mode
- **AND** a generated compose file already exists for the current worktree session
- **THEN** the system SHALL rewrite that generated compose file from the freshly read `wos.yaml` before Docker Compose startup
- **AND** Docker Compose startup SHALL use the rewritten compose file

#### Scenario: Previous compose is used only for shutdown
- **WHEN** the user runs `wos up` for a worktree with an existing generated-compose deployment state
- **THEN** the system MAY use the previously stored generated compose file to stop the old deployment
- **AND** the system SHALL NOT use stale generated compose content for the new Docker Compose startup

#### Scenario: Generated services include Docker identity labels
- **WHEN** wos generates a Compose service for a managed app service or dependency service
- **THEN** the service SHALL include wos Docker identity labels sufficient for daemon Docker API filtering and session/service mapping
- **AND** these labels SHALL be present even when no tunnel is configured for that service

### Requirement: Source Worktree Detection
The system SHALL determine the source worktree by parsing `git worktree list --porcelain`, and SHALL detect source-worktree mode when the current worktree is the selected source worktree.

#### Scenario: Non-detached non-bare worktree exists
- **WHEN** Git reports at least one worktree entry that is not marked `detached` and not marked `bare`
- **THEN** the system SHALL use the first such entry as the source worktree for configured volume copies

#### Scenario: Only detached or bare entries exist
- **WHEN** Git reports no worktree entry that is both non-detached and non-bare
- **THEN** the system SHALL use the first worktree entry as the source worktree for configured volume copies

#### Scenario: Current worktree is the selected source worktree
- **WHEN** the current worktree root resolves to the selected source worktree path
- **THEN** the system SHALL treat `wos up` as running in source-worktree mode

### Requirement: First Run Volume Copy
On first `wos up` for a worktree, the system SHALL copy each configured `clone_volumes` source path to its configured destination path, including Windows absolute paths when running on Windows.

#### Scenario: First run with configured single-path clone volumes
- **WHEN** the user runs `wos up` in a worktree that has not completed first-run setup
- **AND** `clone_volumes` contains a single-path entry
- **THEN** the system SHALL copy every configured file or directory from the source worktree path to the same relative path in the current worktree

#### Scenario: First run with configured mapped clone volumes
- **WHEN** the user runs `wos up` in a worktree that has not completed first-run setup
- **AND** `clone_volumes` contains entry `.env.local:.env`
- **THEN** the system SHALL copy the file or directory from `.env.local` in the source worktree to `.env` in the current worktree

#### Scenario: First run with absolute clone volume source
- **WHEN** the user runs `wos up` in a worktree that has not completed first-run setup
- **AND** `clone_volumes` contains an entry whose source side is an absolute path
- **THEN** the system SHALL copy from that absolute source path instead of resolving the source path inside the source worktree

#### Scenario: First run with absolute clone volume destination
- **WHEN** the user runs `wos up` in a worktree that has not completed first-run setup
- **AND** `clone_volumes` contains an entry whose destination side is an absolute path
- **THEN** the system SHALL copy to that absolute destination path instead of resolving the destination path inside the current worktree

#### Scenario: First run with Windows absolute clone volume source
- **WHEN** the user runs `wos up` on Windows
- **AND** `clone_volumes` contains source path `C:\shared\.env`
- **THEN** the system SHALL treat `C:\shared\.env` as one absolute source path
- **AND** it SHALL NOT split the path at the drive-letter colon

#### Scenario: First run with Windows absolute clone volume destination
- **WHEN** the user runs `wos up` on Windows
- **AND** `clone_volumes` contains destination path `D:\worktree\.env`
- **THEN** the system SHALL treat `D:\worktree\.env` as one absolute destination path
- **AND** it SHALL NOT split the path at the drive-letter colon

#### Scenario: Clone volume source path is missing
- **WHEN** a configured `clone_volumes` source path does not exist
- **THEN** the system SHALL fail before running container init scripts or Docker Compose startup

### Requirement: First Run Init Scripts
On first `wos up` for a worktree, the system SHALL run `app.init_script` as an ordered array of shell commands inside a container created from `app.image`. The system SHALL execute the array as a single shell invocation in which each configured command runs in its own subshell so that working-directory changes made by one command do not leak into subsequent commands.

#### Scenario: Multiple init commands are configured
- **WHEN** `app.init_script` contains multiple commands
- **THEN** the system SHALL run them in the configured order inside the app init container

#### Scenario: Init command fails
- **WHEN** any container init command exits unsuccessfully
- **THEN** the system SHALL stop setup, return a failure, and SHALL NOT mark the worktree initialized

#### Scenario: Init script is omitted
- **WHEN** `app.init_script` is absent or empty
- **THEN** first-run setup SHALL skip container initialization commands

#### Scenario: Working directory is isolated between commands
- **WHEN** one command in `app.init_script` changes the working directory (for example `cd packages/api && yarn`) and a subsequent command also performs a relative `cd`
- **THEN** the subsequent command SHALL resolve its relative path from the container's original working directory, not from the directory left behind by the previous command

### Requirement: Worktree Initialization State
The system SHALL track whether first-run setup completed for each worktree using state scoped to that worktree and stored in that worktree's wos session directory.

#### Scenario: First-run setup succeeds
- **WHEN** clone volume copies and all container init scripts complete successfully
- **THEN** the system SHALL persist state indicating that the current worktree is initialized
- **AND** the state file SHALL be stored under `<wos-home>/sessions/<session-name>/state.json`

#### Scenario: Subsequent up command
- **WHEN** the user runs `wos up` in an initialized worktree
- **THEN** the system SHALL skip clone volume copying and container init scripts

### Requirement: Deployment Restart
The system SHALL run `docker compose down` for the current worktree project and selected Compose file set before starting a deployment with `wos up`, and SHALL start the deployment with Docker Compose recreate semantics.

#### Scenario: Up command restarts deployment
- **WHEN** the user runs `wos up`
- **THEN** the system SHALL execute Docker Compose `down` with the worktree-specific project name and selected Compose file set before executing Docker Compose startup
- **AND** the system SHALL execute Docker Compose startup as `up -d --force-recreate`

#### Scenario: Up command recreates containers after generated config change
- **WHEN** the user changes `wos.yaml` after a previous successful generated-compose `wos up`
- **AND** runs `wos up` again in generated-compose mode
- **THEN** the system SHALL regenerate the compose file from the updated config before startup
- **AND** the system SHALL recreate Compose-managed containers during startup

#### Scenario: Up command uses sanitized compose file and overlay in compose mode
- **WHEN** the user runs `wos up` with `mode: compose`
- **THEN** the system SHALL read the resolved `compose.config` file
- **AND** the system SHALL write a wos-owned sanitized base Compose file with service port bindings removed
- **AND** the system SHALL write a wos-owned overlay file for managed exposed ports
- **AND** Docker Compose startup SHALL use both the wos-owned sanitized base file and the wos-owned overlay file
- **AND** the system SHALL NOT rewrite the user-owned Compose file

### Requirement: Up Output
After a successful `wos up`, the system SHALL show the deployed services, their accessible host addresses, and app-port healthcheck status.

#### Scenario: Deployment starts successfully
- **WHEN** Docker Compose `up -d` succeeds
- **AND** required app-port healthchecks pass
- **THEN** the system SHALL read Compose status and print each service with its status and published host ports
- **AND** the system SHALL print healthcheck status for configured app service ports

#### Scenario: Deployment starts with allowed healthcheck failures
- **WHEN** Docker Compose `up -d` succeeds
- **AND** all failed app-port healthchecks have `allow_failure` true
- **THEN** the system SHALL print each service with its status and published host ports
- **AND** the system SHALL mark the failed app-port healthchecks as allowed failures

### Requirement: Status Command
The system SHALL provide `wos status` to report the current worktree deployment state from the current worktree's wos session, service addresses, and app-port healthcheck status using the stored Compose file set for the selected deployment mode.

#### Scenario: Worktree has deployment state
- **WHEN** the user runs `wos status` in a worktree with persisted wos session state
- **THEN** the system SHALL query Docker Compose for the stored project and stored Compose file set
- **AND** the system SHALL print service status and published host ports
- **AND** the system SHALL run enabled app-port healthchecks for the current published ports when the deployment mode has app-port healthchecks
- **AND** the system SHALL print app-port healthcheck status when healthcheck results exist

#### Scenario: Generated status healthchecks follow deployed services
- **WHEN** the user runs `wos status` after a selective generated-compose `up`
- **THEN** the system SHALL run app-port healthchecks only for configured app services present in the current stored Compose service snapshot
- **AND** the system SHALL NOT report healthcheck rows for configured app services absent from that snapshot

#### Scenario: Compose mode status filters exposed services
- **WHEN** the user runs `wos status` in a compose-mode worktree with persisted wos session state
- **THEN** the system SHALL query Docker Compose for the stored project, wos-owned sanitized base file, and wos-owned overlay file
- **AND** the system SHALL print only services whose names appear in `compose.expose`
- **AND** the system SHALL NOT run generated app-port healthchecks

#### Scenario: Worktree has no deployment state
- **WHEN** the user runs `wos status` in a worktree without persisted wos session state
- **THEN** the system SHALL report that no wos deployment has been initialized for the current worktree

### Requirement: App Port Healthcheck Configuration
The system SHALL support HTTP healthcheck configuration for app service ports and SHALL NOT support healthchecks for dependency service ports.

#### Scenario: Numeric app port uses default healthcheck
- **WHEN** `wos.yaml` contains `app.services.api.ports` with numeric entry `3000`
- **THEN** the system SHALL accept the entry as container port `3000`
- **AND** the system SHALL enable an HTTP healthcheck for that app port with URL `/`, expected status `200`, total timeout `60000` milliseconds, start period `10000` milliseconds, interval `10000` milliseconds, retries `3`, and `allow_failure` false

#### Scenario: App port disables healthcheck
- **WHEN** `wos.yaml` contains `app.services.api.ports` with entry `{ port: 3000, healthcheck: false }`
- **THEN** the system SHALL accept the entry as container port `3000`
- **AND** the system SHALL NOT run a healthcheck for that app port

#### Scenario: App port configures healthcheck
- **WHEN** `wos.yaml` contains `app.services.api.ports` with entry `{ port: 3000, healthcheck: { url: "/health/check", status: 204, timeout: "45s", start_period: "5s", interval: "2.5s", retries: 5 } }`
- **THEN** the system SHALL accept the entry as container port `3000`
- **AND** the system SHALL run the app port healthcheck against `/health/check`
- **AND** the system SHALL require HTTP status `204`
- **AND** the system SHALL use total timeout `45000` milliseconds, start period `5000` milliseconds, interval `2500` milliseconds, and retries `5`

#### Scenario: App port allows healthcheck failure
- **WHEN** `wos.yaml` contains `app.services.api.ports` with entry `{ port: 3000, allow_failure: true }`
- **THEN** the system SHALL accept the entry as container port `3000`
- **AND** a failed healthcheck for that app port SHALL NOT fail `wos up`
- **AND** status output SHALL still mark the healthcheck as failed and allowed

#### Scenario: Dependency ports do not support healthchecks
- **WHEN** `wos.yaml` contains a dependency service port under `deps.db.ports`
- **THEN** the system SHALL treat dependency ports as numeric container ports only
- **AND** the system SHALL NOT run healthchecks for dependency ports

#### Scenario: Invalid app port healthcheck config
- **WHEN** an app port object omits `port`, uses a port outside `1..65535`, uses a non-absolute healthcheck URL path, uses an invalid expected status, uses a non-positive or unparsable `timeout`, `start_period`, or `interval`, or uses non-positive `retries`
- **THEN** the system SHALL fail config validation with an actionable error before generating Docker Compose output

### Requirement: App Port Healthcheck Readiness
After Docker Compose startup, the system SHALL poll enabled app port healthchecks repeatedly until they pass, their configured total timeout elapses, or their configured post-start retries are exhausted, and SHALL surface a `waiting` state while polling is in progress.

#### Scenario: Healthcheck succeeds
- **WHEN** Docker Compose startup succeeds for app service `api`
- **AND** the published host port for configured app port `3000` responds to the configured healthcheck URL with the expected HTTP status before the configured total timeout or retry limit is exhausted
- **THEN** `wos up` SHALL continue successfully
- **AND** the healthcheck status for that app port SHALL be reported as healthy

#### Scenario: Healthcheck is still in progress
- **WHEN** Docker Compose startup succeeds for app service `api`
- **AND** the published host port for configured app port `3000` is being polled within the configured healthcheck total timeout and retry budget
- **THEN** the healthcheck status for that app port SHALL be reported as `waiting` until the window closes or an attempt succeeds

#### Scenario: Healthcheck start period ignores failures
- **WHEN** Docker Compose startup succeeds for app service `api`
- **AND** the enabled healthcheck for configured app port `3000` fails during the configured `start_period`
- **THEN** those failures SHALL NOT count against configured `retries`
- **AND** a successful response during `start_period` SHALL mark the healthcheck healthy immediately

#### Scenario: Healthcheck returns unexpected status
- **WHEN** Docker Compose startup succeeds for app service `api`
- **AND** the published host port for configured app port `3000` responds with an HTTP status different from the configured expected status after `start_period`
- **AND** configured `retries` are exhausted before a successful response
- **AND** `allow_failure` is false for that app port
- **THEN** `wos up` SHALL fail with an actionable healthcheck error
- **AND** the healthcheck status for that app port SHALL report the expected and observed status

#### Scenario: Healthcheck times out
- **WHEN** Docker Compose startup succeeds for app service `api`
- **AND** the published host port for configured app port `3000` does not return the expected response before the configured total timeout
- **AND** `allow_failure` is false for that app port
- **THEN** `wos up` SHALL fail with an actionable timeout error
- **AND** the healthcheck status for that app port SHALL report the timeout

#### Scenario: Healthcheck failure is allowed
- **WHEN** Docker Compose startup succeeds for app service `api`
- **AND** the enabled healthcheck for configured app port `3000` fails
- **AND** `allow_failure` is true for that app port
- **THEN** `wos up` SHALL complete successfully
- **AND** the healthcheck status for that app port SHALL be reported as failed and allowed

#### Scenario: Healthcheck is disabled
- **WHEN** Docker Compose startup succeeds for app service `api`
- **AND** configured app port `3000` has `healthcheck: false`
- **THEN** `wos up` SHALL NOT wait for an HTTP response from that app port
- **AND** the healthcheck status for that app port SHALL be reported as disabled when status is displayed

### Requirement: Forced Up Refresh
The system SHALL provide a `--force` option for `wos up` that removes configured cloned-volume destination paths and then runs the normal setup and deployment startup flow.

#### Scenario: Force refreshes configured single-path clone volumes
- **WHEN** the user runs `wos up --force` in an initialized worktree with configured single-path `clone_volumes`
- **THEN** the system SHALL remove each configured `clone_volumes` destination path from the current worktree
- **AND** the system SHALL copy each configured `clone_volumes` source path before Docker Compose startup
- **AND** the system SHALL run configured `app.init_script` commands before Docker Compose startup

#### Scenario: Force refreshes configured mapped clone volumes
- **WHEN** the user runs `wos up --force` in an initialized worktree with mapped `clone_volumes`
- **THEN** the system SHALL remove each resolved configured destination path
- **AND** the system SHALL copy each resolved configured source path to its configured destination before Docker Compose startup
- **AND** the system SHALL run configured `app.init_script` commands before Docker Compose startup

#### Scenario: Force preserves existing non-volume deployment behavior
- **WHEN** the user runs `wos up --force`
- **THEN** the system SHALL run the same Docker Compose shutdown, generated compose write, Docker Compose startup, status output, and state persistence flow used by `wos up`

#### Scenario: Force with missing clone volume source
- **WHEN** the user runs `wos up --force` and a configured `clone_volumes` source path is missing
- **THEN** the system SHALL fail before running container init scripts or Docker Compose startup
- **AND** the system SHALL NOT mark the worktree initialized

#### Scenario: Force with no configured clone volumes
- **WHEN** the user runs `wos up --force` and `clone_volumes` is empty
- **THEN** the system SHALL run configured `app.init_script` commands before Docker Compose startup

#### Scenario: Up without force remains incremental
- **WHEN** the user runs `wos up` without `--force` in an initialized worktree
- **THEN** the system SHALL skip clone volume copying and container init scripts

### Requirement: Foreground Up Progress
The system SHALL run `wos up` as a foreground non-interactive daemon-backed command that streams deployment progress until the daemon-owned `up` operation reaches a terminal state.

#### Scenario: Foreground up starts deployment
- **WHEN** the user runs `wos up` inside a valid Git worktree
- **THEN** the CLI SHALL submit an `up` operation to the local daemon for the current worktree
- **AND** the CLI SHALL stream daemon operation progress as non-interactive text output
- **AND** the CLI SHALL NOT open an interactive terminal UI

#### Scenario: Foreground up completes successfully
- **WHEN** the daemon-owned `up` operation submitted by `wos up` succeeds
- **THEN** the CLI SHALL print a concise summary of deployed services when service status is available
- **AND** the CLI SHALL print the web URL for the current worktree detail route
- **AND** the CLI SHALL exit with status code `0`

#### Scenario: Foreground up fails
- **WHEN** the daemon-owned `up` operation submitted by `wos up` fails
- **THEN** the CLI SHALL print failure output that identifies the failed operation
- **AND** the CLI SHALL exit with a non-zero status code
- **AND** the CLI SHALL NOT enter a post-start log or status UI

### Requirement: Up Web Worktree Link Output
The CLI SHALL print the web UI URL for the current worktree detail route when it successfully starts or completes an `up` operation.

#### Scenario: Foreground up prints detail URL
- **WHEN** `wos up` completes successfully
- **AND** the daemon metadata includes a web UI base URL
- **THEN** the CLI SHALL print a URL that opens the current worktree detail route in the web UI

#### Scenario: Detached up prints detail URL
- **WHEN** `wos up -d` is accepted by the daemon
- **AND** the daemon metadata includes a web UI base URL
- **THEN** the CLI SHALL print a success message containing a URL that opens the current worktree detail route in the web UI

#### Scenario: Web URL is unavailable
- **WHEN** the relevant `up` command succeeds or is accepted
- **AND** the daemon metadata does not include a web UI base URL
- **THEN** the CLI SHALL still report the command outcome
- **AND** the CLI SHALL state that the web URL is unavailable instead of failing the deployment command

### Requirement: Detached Up Progress
The system SHALL provide a `-d` option for `wos up` that submits deployment to the local daemon and returns immediately after the daemon accepts the operation.

#### Scenario: Detached up in an interactive terminal
- **WHEN** the user runs `wos up -d` with stdout attached to a TTY
- **THEN** the system SHALL NOT open an interactive terminal UI
- **AND** the system SHALL NOT wait for deployment progress after the daemon accepts the operation

#### Scenario: Detached up starts daemon operation
- **WHEN** the user runs `wos up -d` inside a valid Git worktree
- **THEN** the CLI SHALL submit an `up` operation to the local daemon for the current worktree
- **AND** the CLI SHALL exit with status code `0` after the daemon accepts the operation
- **AND** the deployed Docker services SHALL be managed by the daemon-owned operation

#### Scenario: Detached up prints accepted message
- **WHEN** `wos up -d` is accepted by the daemon
- **THEN** the system SHALL print that deployment was started successfully
- **AND** the message SHALL include the web URL for the current worktree detail route when available
- **AND** the command SHALL NOT print a final service summary before the operation has completed

#### Scenario: Detached up preserves force behavior
- **WHEN** the user runs `wos up -d --force`
- **THEN** the system SHALL submit an `up` operation with the same forced refresh behavior as `wos up --force`
- **AND** the CLI SHALL still return immediately after the daemon accepts the operation

### Requirement: Host Port Range Configuration
The system SHALL allow deployment configuration to constrain dynamically assigned host ports to an inclusive range, SHALL use a default range when no range is configured, and SHALL ignore the range for static port assignments.

#### Scenario: Host port range is configured
- **WHEN** the effective deploy config contains `host_ports.range.start` and `host_ports.range.end`
- **AND** `dynamic_ports` is omitted or set to `true`
- **THEN** the system SHALL validate both values as integer ports in `1..65535`
- **AND** the system SHALL allocate host ports only from that inclusive range

#### Scenario: Host port range is omitted
- **WHEN** the effective deploy config omits `host_ports`
- **AND** `dynamic_ports` is omitted or set to `true`
- **THEN** the system SHALL use the default inclusive host-port range `20000..29999`

#### Scenario: Static ports ignore host port range
- **WHEN** the effective deploy config contains `dynamic_ports: false`
- **THEN** the system SHALL NOT allocate host ports from `host_ports.range`
- **AND** each selected managed port SHALL use the declared port number as its host port

#### Scenario: Host port range is invalid
- **WHEN** `host_ports.range.start` is greater than `host_ports.range.end`
- **THEN** the system SHALL fail before generating Docker Compose output with an actionable validation error

#### Scenario: Host port range is too small
- **WHEN** `dynamic_ports` is omitted or set to `true`
- **AND** the configured host-port range contains fewer ports than the number of configured service port mappings
- **THEN** the system SHALL fail before Docker Compose startup with an actionable error

### Requirement: Deterministic Host Port Publishing
The system SHALL publish only configured service ports and SHALL resolve explicit host ports for those mappings before service startup.

#### Scenario: App service has configured ports with dynamic ports
- **WHEN** `app.services.api.ports` lists port `3000`
- **AND** `dynamic_ports` is omitted or set to `true`
- **THEN** the generated compose file SHALL publish container port `3000` for service `api` with an explicit wos-assigned host port from the configured range

#### Scenario: Dependency service has configured ports with dynamic ports
- **WHEN** `deps.db.ports` lists port `5432`
- **AND** `dynamic_ports` is omitted or set to `true`
- **THEN** the generated compose file SHALL publish container port `5432` for service `db` with an explicit wos-assigned host port from the configured range

#### Scenario: App service has configured ports with static ports
- **WHEN** `app.services.api.ports` lists port `3000`
- **AND** `dynamic_ports` is set to `false`
- **THEN** the generated compose file SHALL publish container port `3000` for service `api` as host port `3000`
- **AND** environment templates for `app.services.api.hostPort[3000]` SHALL resolve to `3000`

#### Scenario: Compose mode exposes ports with static ports
- **WHEN** `mode: compose`
- **AND** `compose.expose` contains `api:3000`
- **AND** `dynamic_ports` is set to `false`
- **THEN** the wos-owned Compose overlay SHALL publish service `api` port `3000` as `3000:3000`
- **AND** compose environment templates for `expose.api.hostPort[3000]` SHALL resolve to `3000`

#### Scenario: Shell mode uses static service port
- **WHEN** `mode: shell`
- **AND** `app.services.web.ports` lists port `3000`
- **AND** `dynamic_ports` is set to `false`
- **THEN** the shell service process SHALL receive `WOS_SERVICE_PORT=3000`
- **AND** shell environment templates for `app.services.web.hostPort[3000]` SHALL resolve to `3000`

#### Scenario: Service has no configured ports
- **WHEN** an app or dependency service omits `ports`
- **THEN** the generated compose file SHALL NOT add host port mappings for that service

#### Scenario: Previous assignment is valid
- **WHEN** `dynamic_ports` is omitted or set to `true`
- **AND** deployment state contains a host-port assignment for a configured service container port
- **AND** that host port is inside the configured range, not duplicated, and currently available
- **THEN** the system SHALL reuse that host-port assignment for the generated compose file

#### Scenario: Previous assignment is unavailable
- **WHEN** `dynamic_ports` is omitted or set to `true`
- **AND** deployment state contains a host-port assignment that is outside the configured range, duplicated, or currently unavailable
- **THEN** the system SHALL allocate a replacement host port before Docker Compose startup

#### Scenario: Candidate port is unavailable
- **WHEN** `dynamic_ports` is omitted or set to `true`
- **AND** wos evaluates a candidate host port during allocation
- **AND** the port is already bound on the host
- **THEN** the system SHALL skip that candidate and continue allocation within the configured range

#### Scenario: Static port is duplicated
- **WHEN** `dynamic_ports` is set to `false`
- **AND** the selected managed port bindings require the same host port for more than one mapping
- **THEN** the system SHALL fail before startup with an actionable error naming the duplicate static port

#### Scenario: Static port is unavailable
- **WHEN** `dynamic_ports` is set to `false`
- **AND** a selected declared port is already bound on the host
- **THEN** the system SHALL fail before startup with an actionable error naming the unavailable static port

### Requirement: Generated Container Names
The system SHALL generate unique deterministic container names for every wos-managed service.

#### Scenario: App service container name is generated
- **WHEN** `wos up` generates Compose output for app service `api`
- **THEN** the generated service SHALL include `container_name` equal to the worktree project name plus `-api`

#### Scenario: Dependency service container name is generated
- **WHEN** `wos up` generates Compose output for dependency service `db`
- **THEN** the generated service SHALL include `container_name` equal to the worktree project name plus `-db`

#### Scenario: Internal init service container name is generated
- **WHEN** `wos up` generates Compose output for the internal init service
- **THEN** the generated service SHALL include a container name based on the worktree project name and the internal init service name

### Requirement: Environment Template Resolution
The system SHALL resolve documented wos environment templates before writing generated Docker Compose output.

#### Scenario: Service container name template is configured
- **WHEN** a service environment value contains `${app.services.api.containerName}` or `${deps.db.containerName}`
- **THEN** the generated compose file SHALL contain the resolved deterministic container name in that environment value

#### Scenario: Host port template is configured
- **WHEN** a service environment value contains `${app.services.api.hostPort[3000]}` or `${deps.db.hostPort[5432]}`
- **THEN** the generated compose file SHALL contain the resolved wos-assigned host port in that environment value

#### Scenario: Environment template is embedded in a larger value
- **WHEN** a service environment value contains supported wos templates surrounded by other text
- **THEN** the system SHALL replace each supported template while preserving the surrounding text

#### Scenario: App service environment is configured
- **WHEN** `app.services.web.environment` contains string, number, or boolean values
- **THEN** the generated compose file SHALL include those environment variables after applying wos template resolution

#### Scenario: Template references unknown service
- **WHEN** an environment template references a service that is not configured
- **THEN** the system SHALL fail before Docker Compose startup with an actionable error

#### Scenario: Template references unknown port
- **WHEN** an environment template references a container port that is not configured for the referenced service
- **THEN** the system SHALL fail before Docker Compose startup with an actionable error

### Requirement: Port Conflict Recovery
The system SHALL retry Docker Compose startup with reassigned host ports when dynamic startup fails because a wos-assigned host port cannot be bound, and SHALL NOT reassign ports when static port mode is enabled.

#### Scenario: Compose startup reports dynamic port bind conflict
- **WHEN** `dynamic_ports` is omitted or set to `true`
- **AND** `docker compose up -d` fails with an error indicating that an assigned host port is unavailable
- **THEN** the system SHALL reassign the conflicting host port mapping
- **AND** the system SHALL rewrite the generated compose file or compose overlay
- **AND** the system SHALL retry Docker Compose startup

#### Scenario: Compose startup succeeds after retry
- **WHEN** Docker Compose startup succeeds after dynamic host-port reassignment
- **THEN** the system SHALL persist the final host-port assignments in deployment state
- **AND** the system SHALL show the deployed services and their accessible host addresses

#### Scenario: Compose startup keeps failing with port conflicts
- **WHEN** dynamic Docker Compose startup continues to fail with port bind conflicts after the retry limit is reached
- **THEN** the system SHALL fail with an actionable error that explains host-port allocation could not be completed

#### Scenario: Static compose startup reports port bind conflict
- **WHEN** `dynamic_ports` is set to `false`
- **AND** `docker compose up -d` fails with an error indicating that a static host port is unavailable
- **THEN** the system SHALL fail with an actionable error
- **AND** the system SHALL NOT reassign the static port mapping
- **AND** the system SHALL NOT retry startup with a different host port

#### Scenario: Compose startup fails for another reason
- **WHEN** `docker compose up -d` fails for a reason other than a port bind conflict
- **THEN** the system SHALL fail without reallocating ports or retrying startup

### Requirement: Port Assignment State
The system SHALL persist wos-assigned host ports in the current worktree's wos session state.

#### Scenario: Deployment starts successfully
- **WHEN** `wos up` successfully starts a deployment with configured service port mappings
- **THEN** the system SHALL store each service container port and assigned host port in the current worktree's wos session state

#### Scenario: Deployment has no configured ports
- **WHEN** `wos up` successfully starts a deployment with no configured service port mappings
- **THEN** the system SHALL store an empty assignment set or omit port assignments from the current worktree's wos session state

### Requirement: Cache Configuration
The system SHALL allow `wos.yaml` to configure init-time cache entries using a single top-level `cache` field.

#### Scenario: Cache entry uses key files
- **WHEN** `wos.yaml` contains a `cache` entry with `key.files` and `paths`
- **THEN** the system SHALL accept the entry and compute the cache key from the listed files

#### Scenario: Cache entry uses explicit key
- **WHEN** `wos.yaml` contains a `cache` entry with a string `key` and `paths`
- **THEN** the system SHALL accept the entry and use the string as the cache key input

#### Scenario: Cache entry uses wildcard paths
- **WHEN** `wos.yaml` contains a `cache` entry with `paths: ["packages/*/node_modules"]`
- **AND** the current worktree contains `packages/a/node_modules` and `packages/b/node_modules`
- **THEN** the system SHALL treat both `packages/a/node_modules` and `packages/b/node_modules` as cache paths for that entry

#### Scenario: Cache wildcard path has no matches
- **WHEN** `wos.yaml` contains a `cache` entry with a wildcard `paths` entry that matches no current worktree paths
- **THEN** the system SHALL continue without failing because of the unmatched wildcard path

#### Scenario: Cache entry path escapes worktree
- **WHEN** a configured cache `paths` entry, expanded cache `paths` match, or `key.files` entry resolves outside the current worktree
- **THEN** the system SHALL fail before restoring cache, running init scripts, saving cache, or starting Docker Compose

#### Scenario: Cache field has invalid shape
- **WHEN** `wos.yaml` contains `cache` in a shape other than a list of entries with `key` and non-empty `paths`
- **THEN** the system SHALL fail with an actionable configuration error

### Requirement: Global Cross-Worktree Init Cache
The system SHALL store configured cache paths globally under `<wos-home>/cache` and reuse them across Git worktrees.

#### Scenario: Cache hit before init script
- **WHEN** first-run setup runs and a configured cache entry already exists for the computed key
- **THEN** the system SHALL restore each configured cache path from `<wos-home>/cache` before running `app.init_script`

#### Scenario: Wildcard cache hit before init script
- **WHEN** first-run setup runs with `paths: ["packages/*/node_modules"]`
- **AND** the matching global cache entry contains previously saved paths `packages/a/node_modules` and `packages/b/node_modules`
- **THEN** the system SHALL restore both cached paths before running `app.init_script`

#### Scenario: Cache miss before init script
- **WHEN** first-run setup runs and no configured cache entry exists for the computed key
- **THEN** the system SHALL continue to `app.init_script` without restoring that cache entry

#### Scenario: Restore replaces existing path
- **WHEN** a configured cache destination path already exists in the current worktree and a matching cache entry exists
- **THEN** the system SHALL replace the existing destination path with the cached content before running `app.init_script`

#### Scenario: Successful init saves cache
- **WHEN** first-run setup restores configured caches and `app.init_script` completes successfully
- **THEN** the system SHALL save each existing configured cache path into the matching global cache entry under `<wos-home>/cache`

#### Scenario: Successful init saves expanded wildcard paths
- **WHEN** first-run setup completes successfully with `paths: ["packages/*/node_modules"]`
- **AND** the current worktree contains `packages/a/node_modules` and `packages/b/node_modules`
- **THEN** the system SHALL save both expanded paths into the matching global cache entry under `<wos-home>/cache`

#### Scenario: Failed init does not save cache
- **WHEN** `app.init_script` fails during first-run setup
- **THEN** the system SHALL NOT save configured cache paths for that failed setup attempt

#### Scenario: Force uses cache restore and save
- **WHEN** the user runs `wos up --force`
- **THEN** the system SHALL apply the same cache restore-before-init and save-after-successful-init behavior used by first-run setup

### Requirement: Down Command
The system SHALL provide `wos down` to remove the current worktree's wos-managed Docker Compose containers using the deployment state stored for that worktree.

#### Scenario: Worktree has deployment state
- **WHEN** the user runs `wos down` in a worktree with initialized wos state
- **THEN** the system SHALL execute Docker Compose `down --remove-orphans` with the stored worktree-specific project name and generated compose file
- **AND** the system SHALL leave wos deployment state, generated compose files, cloned volumes, and Docker named volumes intact

#### Scenario: Worktree has no deployment state
- **WHEN** the user runs `wos down` in a worktree without initialized wos state
- **THEN** the system SHALL report that no wos deployment has been initialized for the current worktree
- **AND** the system SHALL NOT execute Docker Compose

#### Scenario: Down command is run outside a worktree
- **WHEN** the user runs `wos down` outside a Git worktree
- **THEN** the system SHALL fail with the same non-worktree guard message used by other worktree-scoped wos commands
- **AND** the system SHALL NOT read deployment state or execute Docker Compose

#### Scenario: Docker Compose down fails
- **WHEN** Docker Compose `down --remove-orphans` returns a non-zero exit code
- **THEN** the system SHALL fail with an actionable `wos down failed` error
- **AND** the system SHALL preserve existing wos deployment state

### Requirement: WorktreeOS Home and Worktree Sessions
The system SHALL use a wos home directory for global managed data, resolved from `WOS_HOME` when set and from `~/.wos` otherwise. The system SHALL store per-worktree generated session files under `<wos-home>/sessions/<session-name>`.

#### Scenario: Default wos home is used
- **WHEN** `WOS_HOME` is not set
- **THEN** the system SHALL use `~/.wos` as the wos home directory

#### Scenario: Environment wos home is used
- **WHEN** `WOS_HOME` is set
- **THEN** the system SHALL use that value as the wos home directory

#### Scenario: Session name is derived from worktree path
- **WHEN** the current worktree root is `/var/www/repo-path`
- **THEN** the system SHALL use `var-www-repo-path` as the worktree session name

#### Scenario: Session files are stored under wos home
- **WHEN** `wos up` manages generated files for the current worktree
- **THEN** the system SHALL store those files under `<wos-home>/sessions/<session-name>`

### Requirement: CLI Uses Daemon API
The system SHALL route worktree-scoped CLI commands through the local wos daemon API while preserving daemon-backed text command behavior.

#### Scenario: Up uses daemon
- **WHEN** the user runs `wos up` inside a valid Git worktree
- **THEN** the CLI SHALL connect to the local daemon
- **AND** the CLI SHALL submit an `up` operation for the current worktree session
- **AND** the CLI SHALL render daemon-streamed operation events as non-interactive deployment progress
- **AND** the CLI SHALL print the current worktree web detail URL after successful completion when available

#### Scenario: Down uses daemon
- **WHEN** the user runs `wos down` inside a valid Git worktree
- **THEN** the CLI SHALL connect to the local daemon
- **AND** the CLI SHALL submit a `down` operation for the current worktree session
- **AND** the command SHALL preserve the existing successful and no-deployment output behavior

#### Scenario: Status uses daemon
- **WHEN** the user runs `wos status` inside a valid Git worktree
- **THEN** the CLI SHALL connect to the local daemon
- **AND** the CLI SHALL request status for the current worktree session
- **AND** the command SHALL print service status and published host ports in the existing status format

### Requirement: CLI Auto-Starts Daemon
The system SHALL automatically start the local wos daemon when a worktree-scoped CLI command requires it and no healthy daemon is available, using the same foreground daemon entrypoint as `wos start --foreground`.

#### Scenario: Daemon already running
- **WHEN** the user runs `wos up`, `wos down`, or `wos status`
- **AND** a daemon responds successfully and protocol-compatibly to `GET /ui/v1/health` at the metadata `webUrl`
- **THEN** the CLI SHALL use the existing daemon process
- **AND** the CLI SHALL NOT start another daemon

#### Scenario: Daemon not running
- **WHEN** the user runs `wos up`, `wos down`, or `wos status`
- **AND** no compatible daemon responds to the HTTP health check
- **THEN** the CLI SHALL start a local daemon process for the resolved wos home by spawning `wos start --foreground` in the background
- **AND** the CLI SHALL wait for daemon HTTP metadata and a successful health check before submitting the command operation

#### Scenario: Daemon startup fails
- **WHEN** the CLI attempts to auto-start the daemon
- **AND** the daemon does not become healthy before the startup timeout
- **THEN** the CLI SHALL fail the command with an actionable daemon startup error

### Requirement: CLI Output Compatibility
The system SHALL preserve script-friendly CLI output semantics while using daemon-streamed events and daemon responses internally.

#### Scenario: Foreground up output is text
- **WHEN** the user runs `wos up`
- **THEN** the CLI SHALL use non-interactive text output for deployment lifecycle output and final service status
- **AND** the CLI SHALL NOT require terminal UI capabilities regardless of TTY state

#### Scenario: Detached up output is accepted-only
- **WHEN** the user runs `wos up -d`
- **THEN** the CLI SHALL print only accepted-start output and the current worktree web detail URL when available
- **AND** the CLI SHALL NOT stream operation progress or final service status

#### Scenario: Worktree guard remains before daemon mutation
- **WHEN** the user runs `wos up`, `wos down`, or `wos status` outside a Git worktree
- **THEN** the command SHALL report that wos must be run from inside a Git worktree
- **AND** the command SHALL NOT submit a mutating daemon operation

### Requirement: CLI Handles Busy Sessions
The system SHALL report daemon per-session operation conflicts in a way that lets users understand which operation is already running.

#### Scenario: Up conflicts with active operation
- **WHEN** the user runs `wos up`
- **AND** the daemon reports that a mutating operation is already active for the current session
- **THEN** the CLI SHALL report that the session is busy
- **AND** the CLI SHALL include the active operation id in the diagnostic output

#### Scenario: Down conflicts with active operation
- **WHEN** the user runs `wos down`
- **AND** the daemon reports that a mutating operation is already active for the current session
- **THEN** the CLI SHALL report that the session is busy
- **AND** the CLI SHALL NOT run Docker Compose directly as a bypass

### Requirement: Daemon Restart Command
The system SHALL provide `wos restart` to restart the local daemon for the current `<wos-home>` without requiring a Git worktree.

#### Scenario: Restart running daemon
- **WHEN** the user runs `wos restart` and a daemon responds successfully to HTTP health
- **THEN** the system SHALL request daemon restart through the daemon HTTP lifecycle API
- **AND** the system SHALL wait until the new daemon HTTP health check succeeds before exiting successfully

#### Scenario: Restart absent or stale daemon
- **WHEN** the user runs `wos restart` and no compatible daemon responds to HTTP health
- **THEN** the system SHALL remove stale daemon metadata for the current `<wos-home>`
- **AND** the system SHALL start `wos start --foreground` in the background
- **AND** the system SHALL wait until daemon HTTP health check succeeds before exiting successfully

#### Scenario: Restart outside worktree
- **WHEN** the user runs `wos restart` from a directory that is not inside a Git worktree
- **THEN** the system SHALL perform the daemon restart behavior
- **AND** the system SHALL NOT report the worktree command guard error
- **AND** the system SHALL NOT read `wos.yaml`
- **AND** the system SHALL NOT read or write wos session state

#### Scenario: Restart preserves deployed services
- **WHEN** the user runs `wos restart`
- **THEN** the system SHALL NOT run Docker Compose shutdown commands for any worktree
- **AND** the system SHALL NOT remove wos session state files

### Requirement: Single Binary Distribution
The system SHALL provide a Bun-compiled `wos` executable that contains the CLI, daemon startup path, workspace runtime packages, and embedded web UI assets needed for normal local use. The build path SHALL support the default local executable output and explicit Bun compile target/output settings for release automation.

#### Scenario: Default binary build succeeds
- **WHEN** a developer runs the single-binary build command from the repository root without release-specific overrides
- **THEN** the system SHALL produce one executable CLI file named `wos` under the configured distribution directory
- **AND** the build SHALL use Bun's executable compiler
- **AND** the build SHALL NOT require Node.js, npm, pnpm, yarn, Vite, webpack, or a separate frontend production server

#### Scenario: Targeted binary build succeeds
- **WHEN** release automation runs the single-binary build command with an explicit Bun compile target and output file path
- **THEN** the system SHALL produce one executable CLI file at the configured output file path
- **AND** the build SHALL pass the configured Bun compile target to Bun's executable compiler
- **AND** the build SHALL NOT require Node.js, npm, pnpm, yarn, Vite, webpack, or a separate frontend production server

#### Scenario: Binary runs CLI help
- **WHEN** the user runs the built `wos` executable with `help`
- **THEN** the executable SHALL print the normal wos CLI help output
- **AND** it SHALL NOT require Bun or the source checkout to be present at runtime

#### Scenario: Binary auto-starts daemon from itself
- **WHEN** a command running from the built `wos` executable needs the local daemon
- **AND** no healthy daemon responds on the wos socket
- **THEN** the CLI SHALL start `start --foreground` by spawning the same built executable
- **AND** the CLI SHALL wait for the daemon health check before continuing
- **AND** the startup path SHALL NOT require `bun run`, `apps/cli/index.ts`, or the repository source tree

#### Scenario: Binary starts foreground daemon from itself
- **WHEN** the user runs `wos start --foreground` from the built executable
- **THEN** the executable SHALL run the foreground daemon server from the same binary
- **AND** it SHALL NOT require Bun or the source checkout to be present at runtime

#### Scenario: Binary restarts daemon from itself
- **WHEN** the user runs `wos restart` from the built executable
- **THEN** the system SHALL stop any healthy existing daemon for the current `<wos-home>`
- **AND** it SHALL start the replacement daemon by spawning the same built executable with `start --foreground`
- **AND** it SHALL wait until the replacement daemon health check succeeds before exiting successfully

### Requirement: Web Command
The system SHALL provide a `wos web` command that ensures the daemon is running, prints the web UI URL, and opens it in the user's default browser.

#### Scenario: Daemon running and web listener available
- **WHEN** the user runs `wos web` and the daemon metadata includes a `webUrl`
- **THEN** the system SHALL print the URL to stdout on a single line
- **AND** the system SHALL invoke the platform default browser launcher (`open` on macOS, `xdg-open` on Linux, `start` on Windows) with that URL
- **AND** the system SHALL exit with status `0` on success

#### Scenario: Daemon not running
- **WHEN** the user runs `wos web` and no daemon is currently running
- **THEN** the system SHALL start the daemon before reading metadata
- **AND** it SHALL proceed with the printing and browser-launch behavior once the daemon is available

#### Scenario: Web UI disabled
- **WHEN** the user runs `wos web` and the daemon metadata does not include a `webUrl`
- **THEN** the system SHALL emit an actionable error to stderr explaining that the web UI is disabled and suggesting the user free the configured port or change `web.port` in the global config
- **AND** the system SHALL exit with a non-zero status

#### Scenario: Print-only mode via --no-open
- **WHEN** the user runs `wos web --no-open` and a `webUrl` is available
- **THEN** the system SHALL print the URL to stdout
- **AND** the system SHALL NOT invoke any browser launcher
- **AND** the system SHALL exit with status `0`

#### Scenario: Browser launcher fails
- **WHEN** the user runs `wos web` and the browser launcher command is missing or exits non-zero
- **THEN** the system SHALL have already printed the URL to stdout
- **AND** the system SHALL emit a single-line warning to stderr describing the launcher failure
- **AND** the system SHALL exit with status `0`

#### Scenario: Web command outside a Git worktree
- **WHEN** the user runs `wos web` from a directory that is not inside a Git worktree
- **THEN** the system SHALL still execute the command
- **AND** the system SHALL NOT require worktree resolution

### Requirement: App Service Hostname Template
The system SHALL support `${app.services.<name>.hostname[<port>]}` templates for configured app service ports. When no active tunnel hostname exists, the template SHALL resolve to the configured `serviceBind` address when set, and to `localhost` otherwise.

#### Scenario: Hostname template resolves active tunnel hostname
- **WHEN** `wos.yaml` contains an app service environment value `${app.services.api.hostname[3000]}`
- **AND** `app.services.api.ports` configures port `3000`
- **AND** global tunneling is enabled
- **AND** the daemon registers an active tunnel route with hostname `feature-login-api.example.com`
- **THEN** generated Compose environment SHALL resolve the template to `feature-login-api.example.com`

#### Scenario: Hostname template resolves localhost when tunnel is disabled
- **WHEN** `wos.yaml` contains an app service environment value `${app.services.api.hostname[3000]}`
- **AND** `app.services.api.ports` configures port `3000`
- **AND** global tunneling is disabled
- **AND** `serviceBind` is not set
- **THEN** generated Compose environment SHALL resolve the template to `localhost`

#### Scenario: Hostname template resolves serviceBind when tunnel is absent
- **WHEN** `wos.yaml` contains an app service environment value `${app.services.api.hostname[3000]}`
- **AND** `app.services.api.ports` configures port `3000`
- **AND** no active tunnel hostname exists for `api:3000`
- **AND** the global config sets `serviceBind` to `192.168.1.18`
- **THEN** the resolved hostname SHALL be `192.168.1.18`

#### Scenario: Hostname template resolves localhost when tunnel fails
- **WHEN** `wos.yaml` contains an app service environment value `${app.services.api.hostname[3000]}`
- **AND** `app.services.api.ports` configures port `3000`
- **AND** global tunneling is enabled
- **AND** route registration for `api:3000` fails
- **AND** `serviceBind` is not set
- **THEN** generated Compose environment SHALL resolve the template to `localhost`
- **AND** `wos up` SHALL continue without failing solely because of the tunnel failure

#### Scenario: Hostname template references unknown app port
- **WHEN** `wos.yaml` contains a template `${app.services.api.hostname[9999]}`
- **AND** `app.services.api.ports` does not configure container port `9999`
- **THEN** template resolution SHALL fail with an actionable error naming the unconfigured app service port

#### Scenario: Hostname template does not support dependency services
- **WHEN** `wos.yaml` contains a template `${deps.db.hostname[5432]}`
- **THEN** template resolution SHALL fail with an unsupported template expression error

### Requirement: Up Command Opens App Port Tunnels
When global tunneling is enabled and not skipped, `wos up` SHALL register local HTTP tunnel routes for assigned host ports before generating Compose so hostname templates can be resolved.

#### Scenario: Up registers tunnel before Compose generation
- **WHEN** `wos up` allocates host port `20042` for configured app service port `api:3000`
- **AND** global tunneling is enabled
- **AND** `--no-tunnel` is not passed
- **THEN** the system SHALL register a local HTTP tunnel route for local port `20042` before writing the generated Compose file
- **AND** the generated Compose file SHALL use the resulting hostname for `${app.services.api.hostname[3000]}`

#### Scenario: Tunnel failure is non-fatal
- **WHEN** `wos up` allocates host port `20042` for configured app service port `api:3000`
- **AND** global tunneling is enabled
- **AND** route registration fails
- **THEN** `wos up` SHALL continue with Docker Compose startup and app-port healthchecks
- **AND** status output SHALL mark the tunnel for `api:3000` as failed

#### Scenario: Port conflict retry recreates tunnels
- **WHEN** `wos up` registers a tunnel for assigned host port `20042`
- **AND** Docker Compose reports a host-port conflict for that assignment
- **THEN** the system SHALL unregister the tunnel route for `20042`
- **AND** the system SHALL allocate a replacement host port
- **AND** the system SHALL register a new tunnel route for the replacement host port before rewriting the generated Compose file

### Requirement: Tunnel Status Output
After startup and during status checks, the system SHALL show local HTTP tunnel information alongside local published addresses when tunnel records are present.

#### Scenario: Status shows active tunnel URL
- **WHEN** a worktree deployment has service `api` with local address `http://localhost:20042 -> 3000/tcp`
- **AND** `api:3000` has an active tunnel URL `http://feature-login-api.example.com`
- **THEN** `wos status` SHALL show the local address
- **AND** `wos status` SHALL show the tunnel URL for `api:3000`

#### Scenario: Status shows failed tunnel
- **WHEN** a worktree deployment has service `api` with a failed tunnel record for `3000`
- **THEN** `wos status` SHALL show the local address
- **AND** `wos status` SHALL mark the tunnel for `api:3000` as failed with an actionable message

#### Scenario: Status omits tunnel when no record exists
- **WHEN** a worktree deployment has service `api` with local address `http://localhost:20042 -> 3000/tcp`
- **AND** no active or failed tunnel record exists for `api:3000`
- **THEN** `wos status` SHALL show the local address
- **AND** `wos status` SHALL NOT show a tunnel URL for `api:3000`

### Requirement: App Service Env File
The system SHALL accept an optional env file path for app services and include it in generated Docker Compose output together with inline environment overrides.

#### Scenario: App service configures env file
- **WHEN** `wos.yaml` contains `app.services.api.env_file: .env`
- **THEN** the system SHALL accept the app service env file during config validation
- **AND** the generated compose service for `api` SHALL include `env_file`

#### Scenario: App service relative env file path
- **WHEN** `wos.yaml` contains `app.services.api.env_file` with a relative path
- **THEN** the generated compose service SHALL resolve the env file path against the current worktree

#### Scenario: App service absolute env file path
- **WHEN** `wos.yaml` contains `app.services.api.env_file` with an absolute path
- **THEN** the generated compose service SHALL preserve that env file path unchanged

#### Scenario: Inline environment overrides env file values
- **WHEN** `wos.yaml` contains both `app.services.api.env_file` and `app.services.api.environment`
- **THEN** the generated compose service for `api` SHALL include both `env_file` and `environment`
- **AND** Docker Compose SHALL receive inline `environment` as the override layer for variables also defined in the env file

#### Scenario: Inline environment templates still resolve
- **WHEN** `app.services.api.environment` contains a supported wos template and `app.services.api.env_file` is also configured
- **THEN** the generated compose service SHALL include the resolved inline environment value
- **AND** the env file contents SHALL NOT be parsed for wos template resolution

#### Scenario: Invalid app service env file
- **WHEN** `wos.yaml` contains `app.services.api.env_file` as a non-string value or an empty string
- **THEN** the system SHALL fail config validation with an actionable error naming `app.services.api.env_file`

#### Scenario: App service omits env file
- **WHEN** `wos.yaml` contains an app service without `env_file`
- **THEN** the generated compose service SHALL omit `env_file`

### Requirement: App Service Volumes
The system SHALL accept optional Docker Compose volume strings for app services and include them in generated Compose output in addition to the automatic current-worktree mount.

#### Scenario: App service configures additional volumes
- **WHEN** `wos.yaml` contains `app.services.api.volumes` with one or more non-empty strings
- **THEN** the system SHALL accept the app service volume list during config validation
- **AND** the generated compose service for `api` SHALL include the automatic current-worktree mount at `/workspace`
- **AND** the generated compose service for `api` SHALL include each configured app service volume

#### Scenario: App service relative volume host path
- **WHEN** `wos.yaml` contains an app service volume `./.data/uploads:/workspace/uploads`
- **THEN** the generated compose service SHALL resolve the host side relative to the current worktree

#### Scenario: App service named and absolute volumes
- **WHEN** `wos.yaml` contains app service volumes using a Docker named volume or an absolute host path
- **THEN** the generated compose service SHALL preserve those volume strings unchanged

#### Scenario: Invalid app service volume list
- **WHEN** `wos.yaml` contains `app.services.api.volumes` as a non-list value or with an empty or non-string entry
- **THEN** the system SHALL fail config validation with an actionable error naming `app.services.api.volumes`

#### Scenario: App service omits volumes
- **WHEN** `wos.yaml` contains an app service without `volumes`
- **THEN** the generated compose service SHALL continue to include the automatic current-worktree mount at `/workspace`

### Requirement: Clone Volume Entry Syntax
The system SHALL accept `clone_volumes` entries as non-empty strings in single-path form, string `source:destination` form, or object `{ source, destination }` form.

#### Scenario: Single-path clone volume entry
- **WHEN** `wos.yaml` contains `clone_volumes` entry `.data`
- **THEN** the system SHALL treat `.data` as both the configured source path and the configured destination path

#### Scenario: Mapped clone volume entry
- **WHEN** `wos.yaml` contains `clone_volumes` entry `.env.local:.env`
- **THEN** the system SHALL treat `.env.local` as the configured source path
- **AND** the system SHALL treat `.env` as the configured destination path

#### Scenario: Object clone volume entry
- **WHEN** `wos.yaml` contains `clone_volumes` entry with `source: "C:\shared\.env"` and `destination: ".env"`
- **THEN** the system SHALL treat the object fields as the configured source and destination paths
- **AND** it SHALL NOT parse drive-letter colons inside those field values as mapping separators

#### Scenario: Windows single-path clone volume entry
- **WHEN** `wos.yaml` contains `clone_volumes` string entry `C:\shared\.env` on Windows
- **THEN** the system SHALL treat `C:\shared\.env` as both the configured source path and the configured destination path

#### Scenario: Windows mapped clone volume entry
- **WHEN** `wos.yaml` contains a Windows mapped clone volume string with drive letters on both sides
- **THEN** the system SHALL split the entry at the mapping separator
- **AND** it SHALL NOT split at either drive-letter colon

#### Scenario: Empty mapped clone volume source
- **WHEN** `wos.yaml` contains a `clone_volumes` entry whose mapped form has an empty source side
- **THEN** the system SHALL fail config validation with an actionable error naming `clone_volumes`

#### Scenario: Empty mapped clone volume destination
- **WHEN** `wos.yaml` contains a `clone_volumes` entry whose mapped form has an empty destination side
- **THEN** the system SHALL fail config validation with an actionable error naming `clone_volumes`

#### Scenario: Invalid object clone volume entry
- **WHEN** `wos.yaml` contains a `clone_volumes` object entry without a non-empty string `source` or `destination`
- **THEN** the system SHALL fail config validation with an actionable error naming `clone_volumes`

### Requirement: CLI Up Registers Project
The CLI SHALL register the primary/source worktree in the project registry after a successful `wos up`.

#### Scenario: Up succeeds
- **WHEN** the user runs `wos up` and the deployment operation succeeds
- **THEN** the CLI/daemon flow SHALL register the resolved primary/source worktree in the project registry
- **AND** the project SHALL appear in the web project sidebar and UI API project list

#### Scenario: Up fails
- **WHEN** the user runs `wos up` and the deployment operation fails
- **THEN** the CLI/daemon flow SHALL NOT create a new project registry entry solely because of that failed operation

### Requirement: Daemon-Mode CLI Unified Events
Daemon-mode CLI clients SHALL be able to consume unified or compatibility operation events for foreground operation progress and deployment state changes.

#### Scenario: CLI starts daemon-owned up
- **WHEN** daemon-mode `wos up` submits an `up` operation
- **THEN** the CLI SHALL observe operation progress through unified events or a compatibility bridge that preserves text renderer behavior
- **AND** operation progress SHALL include deployment steps, logs, retries, service discovery, completion, and failure

#### Scenario: CLI starts daemon-owned down
- **WHEN** daemon-mode `wos down` submits a `down` operation
- **THEN** the CLI SHALL observe operation completion and failure through unified events or a compatibility bridge
- **AND** it SHALL print user-visible failure output when the operation fails

#### Scenario: Detached up does not consume progress stream
- **WHEN** daemon-mode `wos up -d` submits an `up` operation
- **THEN** the CLI SHALL return after operation acceptance
- **AND** the CLI SHALL NOT remain attached to consume post-acceptance progress or session state changes

### Requirement: CLI Event Reconciliation
Daemon-mode CLI clients SHALL use snapshot APIs to recover from missed or insufficient event replay when they are attached to foreground operations.

#### Scenario: CLI reconnects to event stream
- **WHEN** a daemon-mode CLI client reconnects to unified events with a last seen event id
- **THEN** it SHALL use replayed events when available
- **AND** it SHALL fall back to status or UI snapshot APIs when replay is unavailable or insufficient

#### Scenario: Event stream is unavailable
- **WHEN** the unified event stream cannot be opened for an attached foreground command
- **THEN** daemon-mode commands SHALL fail with an actionable transport error or fall back to existing compatible operation stream behavior
- **AND** the command SHALL NOT silently report stale deployment state as current

### Requirement: CLI Event Schema Compatibility
The CLI SHALL share or validate the unified event schema used by daemon clients.

#### Scenario: CLI parses unified event
- **WHEN** the CLI receives a unified event from the daemon
- **THEN** it SHALL parse the envelope id, timestamp, event type, scope identifiers, and typed payload
- **AND** it SHALL ignore unknown future event types without crashing when those events are not required for the active command

### Requirement: Compose Mode Configuration
The system SHALL support `mode: compose` in `wos.yaml` to use a user-owned Docker Compose file with wos-managed exposed port publications.

#### Scenario: Compose mode config is present
- **WHEN** `wos.yaml` contains `mode: compose`
- **AND** `compose.config` names a non-empty Compose config path
- **AND** `compose.expose` contains one or more exposed port entries
- **THEN** the system SHALL accept the config as compose-backed deployment configuration
- **AND** the system SHALL resolve a relative `compose.config` path against the current worktree root

#### Scenario: Compose mode accepts string exposed port entries
- **WHEN** `wos.yaml` contains `mode: compose`
- **AND** `compose.expose` contains `api:3000`
- **THEN** the system SHALL accept the entry as service `api` container port `3000`

#### Scenario: Compose mode accepts object exposed port entries
- **WHEN** `wos.yaml` contains `mode: compose`
- **AND** `compose.expose` contains an object entry with `name: api` and `port: 3000`
- **THEN** the system SHALL accept the entry as service `api` container port `3000`

#### Scenario: Compose mode rejects generated service fields
- **WHEN** `wos.yaml` contains `mode: compose`
- **AND** it also contains `app` or `deps`
- **THEN** the system SHALL fail config validation with an actionable error explaining that those fields are only supported by generated-compose mode

#### Scenario: Compose mode accepts host port range
- **WHEN** `wos.yaml` contains `mode: compose`
- **AND** it also contains `host_ports`
- **THEN** the system SHALL validate `host_ports` and use it for compose expose host-port allocation

#### Scenario: Compose mode requires compose config
- **WHEN** `wos.yaml` contains `mode: compose`
- **AND** `compose.config` is missing, empty, or not a string
- **THEN** the system SHALL fail config validation with an actionable error naming `compose.config`

#### Scenario: Compose mode requires exposed ports
- **WHEN** `wos.yaml` contains `mode: compose`
- **AND** `compose.expose` is missing, empty, contains a plain service name, or contains an invalid exposed port entry
- **THEN** the system SHALL fail config validation with an actionable error naming `compose.expose`

#### Scenario: Misspelled clone volumes field
- **WHEN** `wos.yaml` contains `cloned_volumes`
- **THEN** the system SHALL fail config validation with an actionable error naming the supported `clone_volumes` field

#### Scenario: Compose-mode overlay includes Docker identity labels
- **WHEN** wos writes the wos-owned compose-mode overlay for services listed in `compose.expose`
- **THEN** each overlay service SHALL include wos Docker identity labels sufficient for daemon Docker API filtering and session/service mapping
- **AND** these labels SHALL be present even when no tunnel is configured for that exposed service

### Requirement: Compose Mode Command Environment
The system SHALL pass environment loaded from `compose.env_file` and resolved `compose.environment` to Docker Compose commands in compose mode.

#### Scenario: Compose env file values are loaded
- **WHEN** `wos.yaml` contains `mode: compose`
- **AND** `compose.env_file` contains `.env.compose`
- **AND** `.env.compose` contains `TEST=from-file`
- **THEN** Docker Compose lifecycle, status, log, and service action commands SHALL receive `TEST=from-file` in their process environment

#### Scenario: Multiple compose env files are loaded in order
- **WHEN** `compose.env_file` lists `.env.base` before `.env.local`
- **AND** both files define `TEST`
- **THEN** Docker Compose commands SHALL receive the `TEST` value from `.env.local`

#### Scenario: Inline environment overrides env file
- **WHEN** `compose.env_file` defines `TEST=from-file`
- **AND** `compose.environment` defines `TEST: from-inline`
- **THEN** Docker Compose commands SHALL receive `TEST=from-inline`

#### Scenario: Env file path resolution
- **WHEN** `compose.env_file` contains a relative path
- **THEN** the system SHALL resolve that path against the current worktree root
- **AND** absolute env file paths SHALL be used unchanged

#### Scenario: Invalid compose env file
- **WHEN** a configured `compose.env_file` path cannot be read or contains a malformed non-empty line
- **THEN** the system SHALL fail before running Docker Compose commands
- **AND** the error SHALL name the env file path

#### Scenario: Inline compose environment value coercion
- **WHEN** `compose.environment` contains string, number, or boolean values
- **THEN** the system SHALL coerce those values to strings before passing them to Docker Compose commands

#### Scenario: Inline compose environment resolves expose templates
- **WHEN** `compose.environment` contains `${expose.api.hostPort[3000]}`
- **AND** `compose.expose` configures `api:3000`
- **AND** wos assigns host port `21432`
- **THEN** Docker Compose commands SHALL receive the resolved inline environment value containing `21432`

### Requirement: Compose Mode Managed Services
The system SHALL treat only services named by `compose.expose` port entries as wos-managed services in compose mode.

#### Scenario: Compose status is filtered to exposed services
- **WHEN** `wos up` or `wos status` runs in compose mode
- **AND** Docker Compose reports services `api`, `worker`, and `db`
- **AND** `compose.expose` contains only ports for service `api`
- **THEN** wos SHALL show `api` as the user-facing service
- **AND** wos SHALL NOT show `worker` or `db` as user-facing services

#### Scenario: Compose service logs are opened for exposed services
- **WHEN** a client opens service logs for a compose mode deployment
- **THEN** wos SHALL allow on-demand service log streams only for services named by `compose.expose` port entries
- **AND** compose mode startup SHALL NOT start service log followers solely because services were discovered

#### Scenario: Compose service action targets unexposed service
- **WHEN** a service stop or restart action targets a service not named by `compose.expose` port entries
- **THEN** the system SHALL reject the action with an actionable error naming the service

#### Scenario: Compose mode has no app-port healthchecks
- **WHEN** wos runs `up` or `status` in compose mode
- **THEN** the system SHALL NOT run generated app-port healthchecks
- **AND** the system SHALL NOT require app service port metadata in `wos.yaml`

### Requirement: Global Working Directory Option
The CLI SHALL provide a global `--cwd <path>` option that selects the directory used to resolve the target Git worktree for worktree-scoped commands.

#### Scenario: Global cwd selects another worktree
- **WHEN** the user runs `wos --cwd /path/to/worktree status` from outside `/path/to/worktree`
- **THEN** the command SHALL resolve deployment state for the Git worktree containing `/path/to/worktree`
- **AND** the command SHALL use the same command-specific behavior as if it had been run from inside that worktree

#### Scenario: Global cwd is omitted
- **WHEN** the user runs a worktree-scoped command without `--cwd`
- **THEN** the command SHALL resolve the target Git worktree from the process current working directory
- **AND** existing command-specific behavior SHALL be preserved

#### Scenario: Global cwd points outside a Git worktree
- **WHEN** the user runs `wos --cwd /tmp status`
- **AND** `/tmp` is not inside a Git worktree
- **THEN** the command SHALL report that wos must be run from inside a Git worktree
- **AND** the command SHALL NOT submit a mutating daemon operation

#### Scenario: Global cwd argument is missing
- **WHEN** the user runs `wos --cwd status`
- **THEN** the CLI SHALL fail argument parsing with an actionable error for `--cwd`
- **AND** the CLI SHALL NOT run the `status` command

### Requirement: Wait Command
The CLI SHALL provide `wos wait` to wait until the selected worktree deployment is ready.

#### Scenario: Wait succeeds when deployment is ready
- **WHEN** the user runs `wos wait` for a worktree whose deployment status reaches `running`
- **THEN** the command SHALL print the latest service status output
- **AND** the command SHALL exit with status code `0`

#### Scenario: Wait keeps polling while deployment is in progress
- **WHEN** the user runs `wos wait`
- **AND** the selected worktree deployment status is `pending` or `checking`
- **THEN** the command SHALL continue polling until the deployment status reaches `running`, a terminal failure state is observed, or the timeout expires

#### Scenario: Wait treats partial deployment as not ready
- **WHEN** the user runs `wos wait`
- **AND** the selected worktree deployment status is `running_partial`, `unknown`, or otherwise not `running`
- **THEN** the command SHALL continue polling until the deployment status reaches `running`, a terminal failure state is observed, or the timeout expires

#### Scenario: Wait fails when deployment is not started
- **WHEN** the user runs `wos wait` for a worktree whose deployment status is `not_started`
- **THEN** the command SHALL report that no wos deployment has been initialized for the current worktree
- **AND** the command SHALL exit with a non-zero status code

#### Scenario: Wait fails on terminal failure state
- **WHEN** the user runs `wos wait`
- **AND** the selected worktree deployment status is `failed` or `stopped`
- **THEN** the command SHALL report the observed deployment status
- **AND** the command SHALL exit with a non-zero status code

### Requirement: Wait Timeout
The `wos wait` command SHALL support a `--timeout <duration>` option and SHALL default to a one-minute timeout when the option is omitted.

#### Scenario: Wait uses the default timeout
- **WHEN** the user runs `wos wait` without `--timeout`
- **AND** the selected worktree deployment does not reach `running` within one minute
- **THEN** the command SHALL report that waiting timed out
- **AND** the command SHALL exit with a non-zero status code

#### Scenario: Wait uses configured timeout
- **WHEN** the user runs `wos wait --timeout 30s`
- **AND** the selected worktree deployment does not reach `running` within thirty seconds
- **THEN** the command SHALL report that waiting timed out after the configured timeout
- **AND** the command SHALL exit with a non-zero status code

#### Scenario: Wait rejects invalid timeout
- **WHEN** the user runs `wos wait --timeout nope`
- **THEN** the CLI SHALL fail argument parsing with an actionable timeout error
- **AND** the CLI SHALL NOT start waiting on deployment status

#### Scenario: Wait timeout accepts millisecond values
- **WHEN** the user runs `wos wait --timeout 1500ms`
- **THEN** the command SHALL use a timeout of 1500 milliseconds

### Requirement: Wait Command Worktree Guard
The `wos wait` command SHALL require the selected working directory to be inside a Git worktree before reading deployment status.

#### Scenario: Wait outside a Git worktree
- **WHEN** the user runs `wos wait` from a directory that is not inside a Git worktree
- **THEN** the system SHALL report that wos must be run from inside a Git worktree
- **AND** the system SHALL NOT request deployment status from the daemon

#### Scenario: Wait with global cwd inside a Git worktree
- **WHEN** the user runs `wos --cwd /path/to/worktree wait`
- **THEN** the command SHALL wait for the deployment belonging to the Git worktree containing `/path/to/worktree`
- **AND** the process current working directory SHALL NOT determine the target worktree

### Requirement: Compose Mode Managed Port Overlay
In compose mode, the system SHALL remove unmanaged service port bindings from the effective Compose configuration and SHALL publish every `compose.expose` port through wos-generated Docker Compose files.

#### Scenario: Compose sanitized base removes user port bindings
- **WHEN** `wos.yaml` contains `mode: compose`
- **AND** the user-owned Compose file contains `services.api.ports` and `services.db.ports`
- **THEN** the system SHALL write a wos-owned sanitized Compose base file in the current worktree's session directory
- **AND** the sanitized base file SHALL omit all `services.*.ports` entries from the user-owned Compose file
- **AND** the system SHALL NOT rewrite the user-owned Compose file

#### Scenario: Compose overlay publishes exposed ports only
- **WHEN** `wos.yaml` contains `mode: compose`
- **AND** `compose.expose` contains `api:3000` and `api:4000`
- **AND** wos assigns host ports `21432` and `21888`
- **THEN** the system SHALL write a wos-owned Compose overlay file in the current worktree's session directory
- **AND** the overlay file SHALL publish service `api` port `3000` as `21432:3000`
- **AND** the overlay file SHALL publish service `api` port `4000` as `21888:4000`
- **AND** the overlay file SHALL NOT publish ports that are absent from `compose.expose`

#### Scenario: Unexposed base port does not remain published
- **WHEN** the user-owned Compose file contains service `db` port binding `5432:5432`
- **AND** `compose.expose` does not contain `db:5432`
- **THEN** the effective Compose file set used by wos SHALL NOT publish `db:5432`

#### Scenario: Compose startup uses sanitized base and overlay
- **WHEN** the user runs `wos up` with `mode: compose`
- **AND** wos writes a sanitized base file and overlay file
- **THEN** Docker Compose shutdown, startup, status, service action, and log commands SHALL use the wos-owned sanitized base file and the wos-owned overlay in that order

#### Scenario: Compose overlay is regenerated on retry
- **WHEN** Docker Compose startup reports a port conflict for a wos-assigned compose expose port
- **THEN** the system SHALL allocate a replacement host port using the same retry behavior as generated mode
- **AND** the system SHALL rewrite the wos-owned overlay file with the replacement host port before retrying Docker Compose startup

#### Scenario: Compose mode persists assigned ports
- **WHEN** `wos up` succeeds in compose mode
- **THEN** the system SHALL persist the assigned exposed host ports in the current worktree's wos session state
- **AND** subsequent compose-mode commands SHALL use the persisted assignments when resolving expose templates and building the overlay

### Requirement: Compose Expose Environment Templates
The system SHALL resolve expose-port templates in inline `compose.environment` values before passing the environment to Docker Compose commands. When no active tunnel value exists, hostname and URL templates SHALL fall back to the configured `serviceBind` address when set, and to `localhost` otherwise.

#### Scenario: Host port template resolves assigned port
- **WHEN** `compose.expose` contains `api:3000`
- **AND** wos assigns host port `21432` to `api:3000`
- **AND** `compose.environment` contains `API_HOST_PORT: ${expose.api.hostPort[3000]}`
- **THEN** Docker Compose commands SHALL receive `API_HOST_PORT=21432`

#### Scenario: Hostname template resolves active tunnel hostname
- **WHEN** `compose.expose` contains `api:3000`
- **AND** wos assigns host port `21432` to `api:3000`
- **AND** global tunneling is enabled
- **AND** the daemon registers an active tunnel route with hostname `feature-login-api.example.com`
- **AND** `compose.environment` contains `API_HOSTNAME: ${expose.api.hostname[3000]}`
- **THEN** Docker Compose commands SHALL receive `API_HOSTNAME=feature-login-api.example.com`

#### Scenario: Hostname template falls back to localhost
- **WHEN** `compose.expose` contains `api:3000`
- **AND** no active tunnel hostname exists for `api:3000`
- **AND** `serviceBind` is not set
- **AND** `compose.environment` contains `API_HOSTNAME: ${expose.api.hostname[3000]}`
- **THEN** Docker Compose commands SHALL receive `API_HOSTNAME=localhost`

#### Scenario: Hostname template falls back to serviceBind
- **WHEN** `compose.expose` contains `api:3000`
- **AND** no active tunnel hostname exists for `api:3000`
- **AND** the global config sets `serviceBind` to `192.168.1.18`
- **AND** `compose.environment` contains `API_HOSTNAME: ${expose.api.hostname[3000]}`
- **THEN** Docker Compose commands SHALL receive `API_HOSTNAME=192.168.1.18`

#### Scenario: Expose template references unknown port
- **WHEN** `compose.environment` contains `${expose.api.hostPort[9999]}`
- **AND** `compose.expose` does not configure `api:9999`
- **THEN** the system SHALL fail before running Docker Compose commands with an actionable template error

#### Scenario: Unsupported compose environment template
- **WHEN** `compose.environment` contains an unsupported wos template expression
- **THEN** the system SHALL fail before running Docker Compose commands with an actionable template error

### Requirement: Global Tunnel Usage
When the tunnel listener and service tunnel publication are both enabled, `wos up` SHALL register local HTTP tunnel routes for managed application service ports.

#### Scenario: Up creates service tunnels when service publication is enabled
- **WHEN** global config contains `tunnel.enabled: true`, a valid `tunnel.domain`, an effective tunnel port, and `tunnel.serviceTunnels.enabled: true`
- **AND** `wos up` allocates host port `20042` for app service port `api:3000`
- **THEN** the system SHALL register an HTTP tunnel route for `api:3000`
- **AND** the route SHALL point to local host port `20042`

#### Scenario: Up does not create service tunnels by default
- **WHEN** global config contains `tunnel.enabled: true` and omits `tunnel.serviceTunnels.enabled`
- **AND** `wos up` allocates host port `20042` for app service port `api:3000`
- **THEN** the system SHALL run deployment startup without registering service tunnel routes
- **AND** hostname templates SHALL resolve as if no tunnel is active for that service port

#### Scenario: Up skips tunnels via flag
- **WHEN** service tunnel publication is enabled
- **AND** the user runs `wos up --no-tunnel`
- **THEN** the system SHALL run deployment startup without registering tunnel routes
- **AND** hostname templates SHALL resolve as if no tunnel is active

#### Scenario: Detached up skips tunnels via flag
- **WHEN** service tunnel publication is enabled
- **AND** the user runs `wos up -d --no-tunnel`
- **THEN** the daemon operation submitted by the CLI SHALL skip tunnel route registration

#### Scenario: Global tunnel disabled
- **WHEN** global config omits `tunnel` or contains `tunnel.enabled: false`
- **AND** the user runs `wos up`
- **THEN** the system SHALL run deployment startup without registering tunnel routes

#### Scenario: Obsolete app port tunnel config is rejected
- **WHEN** `wos.yaml` contains `app.services.api.ports` with an object entry that includes `tunnel`
- **THEN** config validation SHALL fail with an actionable error explaining that tunnels are configured in global `config.json`
- **AND** the error SHALL mention `tunnel.serviceTunnels.enabled` for enabling service publication
- **AND** the error SHALL mention `--no-tunnel` as the per-run opt-out

#### Scenario: Obsolete compose expose tunnel config is rejected
- **WHEN** `wos.yaml` contains a `compose.expose` object entry that includes `tunnel`
- **THEN** config validation SHALL fail with an actionable error explaining that tunnels are configured in global `config.json`
- **AND** the error SHALL mention `tunnel.serviceTunnels.enabled` for enabling service publication
- **AND** the error SHALL mention `--no-tunnel` as the per-run opt-out

### Requirement: Tunnel Hostnames Require Service Tunnel Publication
Hostname template resolution SHALL use public service hostnames only for service ports with active service tunnel routes.

#### Scenario: tunnel listener enabled without service route
- **WHEN** `tunnel.enabled` is true
- **AND** `tunnel.serviceTunnels.enabled` is false
- **AND** a command template references the hostname for `api:3000`
- **THEN** the hostname template SHALL resolve to `localhost`

#### Scenario: service tunnel active
- **WHEN** `tunnel.serviceTunnels.enabled` is true
- **AND** the daemon registered an active tunnel route with hostname `feature-api.example.com`
- **AND** a command template references the hostname for `api:3000`
- **THEN** the hostname template SHALL resolve to `feature-api.example.com`

### Requirement: Tunnel Status Omits Disabled Service Publication
CLI status output SHALL show service tunnel URLs only when service tunnel records exist.

#### Scenario: service tunnel publication disabled
- **WHEN** a worktree deployment has local service port `api:3000`
- **AND** service tunnel publication is disabled
- **THEN** `wos status` SHALL show the local published address
- **AND** it SHALL NOT show a tunnel URL or failed tunnel state for `api:3000`

### Requirement: Tunnel Hostname Generation
The system SHALL generate tunnel hostnames from DNS-sanitized worktree and service names.

#### Scenario: Hostname uses worktree basename and service name
- **WHEN** the current worktree path basename is `feature-login`
- **AND** the service name is `api`
- **AND** the configured tunnel domain is `example.com`
- **THEN** the generated tunnel hostname SHALL be `feature-login-api.example.com`

#### Scenario: Hostname labels are DNS sanitized
- **WHEN** the current worktree path basename is `Feature/Login`
- **AND** the service name is `Web_App`
- **AND** the configured tunnel domain is `example.com`
- **THEN** the generated tunnel hostname SHALL use lowercase DNS-safe labels
- **AND** it SHALL replace unsupported label characters with dashes

#### Scenario: Hostname conflict increments worktree label
- **WHEN** generated hostname `feature-login-api.example.com` is already registered by another project
- **AND** the same base worktree name and service name need a tunnel
- **THEN** the next generated hostname SHALL be `feature-login2-api.example.com`
- **AND** further conflicts SHALL increment the numeric suffix until an unused hostname is found

### Requirement: Compose Tunnel Restore Metadata
The system SHALL write versioned wos tunnel restore metadata into generated Compose services and compose-mode overlays for managed service ports with active tunnel hostnames.

#### Scenario: Generated Compose includes restore labels for tunneled app ports
- **WHEN** generated-compose mode registers an active tunnel hostname `feature-api.example.com` for app service `api` container port `3000`
- **AND** the assigned host port is `21432`
- **THEN** the generated Compose service `api` SHALL include labels identifying the service as wos-managed
- **AND** the labels SHALL include schema version, wos home hash, session name, compose project name, deployment id, mode `generated`, service name `api`, tunnel port `3000`, hostname `feature-api.example.com`, and host port `21432`

#### Scenario: Compose-mode overlay includes restore labels for tunneled expose ports
- **WHEN** compose mode registers an active tunnel hostname `feature-api.example.com` for `compose.expose` entry `api:3000`
- **AND** the assigned host port is `21432`
- **THEN** the wos-owned compose overlay service `api` SHALL include labels identifying the service as wos-managed
- **AND** the labels SHALL include schema version, wos home hash, session name, compose project name, deployment id, mode `compose`, service name `api`, tunnel port `3000`, hostname `feature-api.example.com`, and host port `21432`

#### Scenario: Hostname environment is exposed for single-port service
- **WHEN** service `api` has exactly one active tunnel hostname for container port `3000`
- **THEN** the Compose service SHALL include `WOS_SERVICE_HOSTNAME=feature-api.example.com`
- **AND** it SHALL include `WOS_SERVICE_HOSTNAME_3000=feature-api.example.com`

#### Scenario: Hostname environment is port-specific for multi-port service
- **WHEN** service `web` has active tunnel hostnames for container ports `4200` and `4210`
- **THEN** the Compose service SHALL include `WOS_SERVICE_HOSTNAME_4200` and `WOS_SERVICE_HOSTNAME_4210`
- **AND** it SHALL NOT include ambiguous `WOS_SERVICE_HOSTNAME`

#### Scenario: Services without active tunnel hostnames omit tunnel restore metadata
- **WHEN** a service has no active tunnel hostname because tunneling is disabled, skipped, or failed
- **THEN** the Compose service SHALL NOT include `dev.wos.tunnel.*` hostname labels
- **AND** it SHALL NOT include `WOS_SERVICE_HOSTNAME` variables

### Requirement: Deployment Identity Persistence
The system SHALL persist a deployment id for each Compose artifact generation that can be matched against Docker labels during daemon restart restoration.

#### Scenario: Up persists deployment id before Compose startup
- **WHEN** `wos up` writes generated Compose or compose-mode overlay artifacts
- **THEN** session state SHALL include the deployment id used in the Compose service labels
- **AND** Docker Compose startup SHALL use artifacts containing the same deployment id

#### Scenario: Port-conflict retry refreshes deployment id metadata
- **WHEN** `wos up` rewrites Compose artifacts after a wos-owned port conflict retry
- **THEN** the rewritten service labels SHALL contain the deployment id persisted in the latest session state
- **AND** stale labels from the previous attempted artifact SHALL NOT be used for restoration

### Requirement: Worktree Remove Command
The CLI SHALL provide a worktree-scoped command that removes the current secondary Git worktree through the local daemon.

#### Scenario: Remove current secondary worktree
- **WHEN** the user runs `wos worktree remove` from inside a secondary Git worktree
- **THEN** the CLI SHALL submit a `worktree-remove` operation for the current worktree session
- **AND** it SHALL stream operation output until the operation reaches a terminal state
- **AND** it SHALL exit successfully only when the daemon reports the removal operation succeeded

#### Scenario: Remove dirty or untracked worktree with force
- **WHEN** the user runs `wos worktree remove --force` from inside a secondary Git worktree with dirty or untracked files
- **THEN** the CLI SHALL submit a `worktree-remove` operation with force enabled
- **AND** the daemon SHALL invoke Git removal with force semantics for the selected worktree

#### Scenario: Remove dirty or untracked worktree without force
- **WHEN** the user runs `wos worktree remove` from inside a secondary Git worktree with dirty or untracked files
- **THEN** the operation SHALL fail with Git's removal error
- **AND** the CLI SHALL exit with a non-zero status

#### Scenario: Remove outside a Git worktree
- **WHEN** the user runs `wos worktree remove` from a directory that is not inside a Git worktree
- **THEN** the CLI SHALL report that wos must be run from inside a Git worktree
- **AND** it SHALL NOT submit a daemon operation

#### Scenario: Remove primary source worktree
- **WHEN** the user runs `wos worktree remove` from the repository primary/source worktree
- **THEN** the operation SHALL be rejected
- **AND** the CLI SHALL report that the primary/source worktree cannot be removed by wos

#### Scenario: Remove preserves branch
- **WHEN** the user removes a worktree checked out on a branch
- **THEN** wos SHALL NOT delete the Git branch associated with that worktree

### Requirement: Generated Service Dependencies
In generated-compose mode, the system SHALL accept dependencies on app services so selecting or starting one app service also includes the app services and dependency services it requires.

#### Scenario: App service depends on another app service
- **WHEN** `wos.yaml` contains `app.services.app.dependencies` with entry `api`
- **AND** `api` is a configured app service
- **THEN** generated-compose config validation SHALL accept the dependency
- **AND** startup selection for `app` SHALL include `api`

#### Scenario: App service depends on dependency service
- **WHEN** `wos.yaml` contains `app.services.api.dependencies` with entry `db`
- **AND** `db` is a configured `deps` service
- **THEN** generated-compose config validation SHALL accept the dependency
- **AND** startup selection for `api` SHALL include `db`

#### Scenario: Dependency references unknown service
- **WHEN** `wos.yaml` contains an app service dependency that does not match an `app.services` entry or `deps` entry
- **THEN** config validation or startup selection SHALL fail with an actionable error naming the unknown dependency

#### Scenario: Dependency graph has a cycle
- **WHEN** generated-compose service dependencies contain a cycle
- **THEN** startup selection SHALL fail before Docker Compose startup
- **AND** the error SHALL name the dependency cycle

### Requirement: Generated Compose Targets
In generated-compose mode, the system SHALL accept top-level `targets` as named service selection aliases.

#### Scenario: Target references services
- **WHEN** `wos.yaml` contains `targets.app` with entries `app` and `api`
- **AND** both entries reference configured app services or `deps` services
- **THEN** generated-compose config validation SHALL accept the target

#### Scenario: Target references dependency closure
- **WHEN** `wos.yaml` contains `targets.app` with entry `app`
- **AND** `app.services.app.dependencies` includes `api`
- **THEN** `wos up --target app` SHALL resolve the target to include both `api` and `app`

#### Scenario: Target references unknown service
- **WHEN** `wos.yaml` contains a target entry that does not match an `app.services` entry or `deps` entry
- **THEN** config validation or startup selection SHALL fail with an actionable error naming the target and unknown service

#### Scenario: Invalid target shape
- **WHEN** `targets` is not a mapping of target name to non-empty string lists
- **THEN** config validation SHALL fail with an actionable error naming the invalid target field

### Requirement: Selective Up Command
In generated-compose mode, `wos up` SHALL support selecting services directly or through a configured target while preserving full deployment behavior when no selection is provided.

#### Scenario: Up without selection starts all services
- **WHEN** the user runs `wos up` without service names and without `--target`
- **THEN** the system SHALL use the existing full generated-compose deployment behavior
- **AND** it SHALL include every configured app service and `deps` service

#### Scenario: Up with explicit services starts resolved selection
- **WHEN** the user runs `wos up app,api`
- **THEN** the system SHALL start only `app`, `api`, and their transitive dependencies
- **AND** it SHALL NOT run init scripts or healthchecks for app services outside that resolved selection
- **AND** on-demand service log streams SHALL be available only for app services inside that resolved selection

#### Scenario: Up with target starts resolved target
- **WHEN** the user runs `wos up --target app`
- **AND** `targets.app` is configured
- **THEN** the system SHALL start services from that target plus their transitive dependencies

#### Scenario: Target and explicit services are mutually exclusive
- **WHEN** the user runs `wos up app --target api`
- **THEN** the command SHALL fail before starting deployment
- **AND** the error SHALL explain that direct service selection and `--target` cannot be combined

#### Scenario: Compose mode rejects service selection
- **WHEN** the user runs `wos up app` or `wos up --target app`
- **AND** the resolved config uses `mode: compose`
- **THEN** the system SHALL fail with an actionable error explaining that selective startup is supported only in generated-compose mode

### Requirement: Service-Level Init Scripts
In generated-compose mode, the system SHALL accept `app.services.<name>.init_script` and run it only when that app service is included in the resolved startup selection.

#### Scenario: Selected service init runs after global init
- **WHEN** `app.init_script` and `app.services.api.init_script` are both configured
- **AND** the resolved startup selection includes `api`
- **THEN** the system SHALL run `app.init_script` first in the worktree root
- **AND** it SHALL run `app.services.api.init_script` after global init

#### Scenario: Service init uses service cwd
- **WHEN** `app.services.api.cwd` is `packages/api`
- **AND** `app.services.api.init_script` is configured
- **AND** the resolved startup selection includes `api`
- **THEN** the service init commands SHALL run in `/workspace/packages/api` inside the init container

#### Scenario: Unselected service init is skipped
- **WHEN** `app.services.admin.init_script` is configured
- **AND** the resolved startup selection does not include `admin`
- **THEN** the system SHALL NOT run `admin` service init commands

#### Scenario: Service init requires app image
- **WHEN** any `app.services.<name>.init_script` is configured
- **AND** `app.image` is absent
- **THEN** config validation SHALL fail with an actionable error explaining that `app.image` is required for init scripts

#### Scenario: Service init failure stops startup
- **WHEN** a selected service init command exits unsuccessfully
- **THEN** the system SHALL stop setup, return a failure, and SHALL NOT mark the worktree initialized

### Requirement: Selective Generated Compose Output
In generated-compose mode, the generated Compose file for a selective `up` SHALL contain only services in the resolved startup selection, and subsequent status healthchecks SHALL remain scoped to services present in that generated deployment.

#### Scenario: Selective compose omits unselected services
- **WHEN** the config contains app services `api`, `app`, and `admin`
- **AND** the user runs `wos up app`
- **THEN** the generated Compose file SHALL include `app` and its resolved dependencies
- **AND** it SHALL omit `admin` when `admin` is not in that resolved selection

#### Scenario: Selected app service includes depends_on
- **WHEN** `app.services.app.dependencies` includes `api`
- **AND** the generated Compose file includes both services
- **THEN** the generated Compose service for `app` SHALL include a Compose dependency on `api`

#### Scenario: Port allocation follows selected services
- **WHEN** the user runs a selective `wos up`
- **THEN** host-port allocation SHALL include only port bindings for services in the resolved startup selection

#### Scenario: Healthchecks follow selected app services
- **WHEN** the user runs a selective `wos up`
- **THEN** app-port healthchecks SHALL run only for selected app services that configure enabled healthchecks

#### Scenario: Later status healthchecks follow selected generated deployment
- **WHEN** a selective generated-compose `up` has persisted a generated Compose file that omits an unselected app service
- **AND** the user later runs `wos status`
- **THEN** app-port healthchecks SHALL run only for app services present in the persisted generated Compose service snapshot
- **AND** absent configured app services SHALL NOT make the status output partial or failed

### Requirement: Runtime Argument Configuration
In generated-compose mode, the system SHALL accept top-level `arguments` as the list of runtime argument names that may be provided when starting a deployment.

#### Scenario: Runtime arguments are configured
- **WHEN** `wos.yaml` contains `arguments: [API_URL]`
- **THEN** config validation SHALL accept the file
- **AND** the parsed config SHALL expose `API_URL` as a declared runtime argument

#### Scenario: Runtime arguments default to empty
- **WHEN** `wos.yaml` omits `arguments`
- **THEN** the parsed config SHALL expose no declared runtime arguments

#### Scenario: Invalid runtime argument declaration
- **WHEN** `wos.yaml` contains `arguments` as a non-list, an empty string, a duplicate name, or a name that is not a shell environment-style identifier
- **THEN** config validation SHALL fail with an actionable error naming `arguments`

#### Scenario: Runtime arguments are generated-mode only
- **WHEN** `wos.yaml` contains `mode: compose`
- **AND** it contains top-level `arguments`
- **THEN** config validation SHALL fail with an actionable error explaining that `arguments` is only supported by generated-compose mode

### Requirement: Up Command Runtime Arguments
The CLI SHALL allow users to pass declared runtime argument values to `wos up`.

#### Scenario: Up accepts runtime argument flag
- **WHEN** the user runs `wos up --arg API_URL=https://empl-stage.test-wa.ru`
- **THEN** the CLI SHALL submit runtime argument `API_URL` with value `https://empl-stage.test-wa.ru` to the up operation

#### Scenario: Up accepts equals form runtime argument flag
- **WHEN** the user runs `wos up --arg=API_URL=https://empl-stage.test-wa.ru`
- **THEN** the CLI SHALL submit runtime argument `API_URL` with value `https://empl-stage.test-wa.ru` to the up operation

#### Scenario: Up combines runtime arguments with existing options
- **WHEN** the user runs `wos up -d --target lk-zup --force --arg API_URL=https://empl-stage.test-wa.ru`
- **THEN** the CLI SHALL preserve detached mode, target selection, force mode, and the runtime argument value in the daemon submission

#### Scenario: Up rejects malformed runtime argument flag
- **WHEN** the user passes `--arg` without `KEY=VALUE`, an empty key, or the same key more than once
- **THEN** the CLI SHALL fail before daemon submission with an actionable argument parsing error

### Requirement: Runtime Argument Environment Templates
In generated-compose mode, the system SHALL resolve declared runtime argument templates in inline service environment values before writing generated Docker Compose output.

#### Scenario: Runtime argument template resolves from submitted value
- **WHEN** `wos.yaml` declares runtime argument `API_URL`
- **AND** `app.services.lk-zup.environment` contains `EMPL_API_URL: ${API_URL}`
- **AND** the up operation receives runtime argument `API_URL=https://empl-stage.test-wa.ru`
- **THEN** the generated compose service SHALL contain `EMPL_API_URL=https://empl-stage.test-wa.ru`

#### Scenario: Runtime argument template uses default value
- **WHEN** `wos.yaml` declares runtime argument `API_URL`
- **AND** `app.services.lk-zup.environment` contains `EMPL_API_URL: ${API_URL:-https://empl-dev.test-wa.ru}`
- **AND** the up operation receives no non-empty value for `API_URL`
- **THEN** the generated compose service SHALL contain `EMPL_API_URL=https://empl-dev.test-wa.ru`

#### Scenario: Runtime argument template is embedded in larger value
- **WHEN** `wos.yaml` declares runtime argument `API_URL`
- **AND** an inline environment value contains `prefix-${API_URL:-default}-suffix`
- **THEN** generated Compose output SHALL replace only the runtime argument expression and preserve surrounding text

#### Scenario: Runtime argument templates coexist with wos templates
- **WHEN** an inline environment map contains `${API_URL:-https://empl-dev.test-wa.ru}` and `${deps.db.containerName}`
- **AND** `API_URL` is declared in `arguments`
- **THEN** the system SHALL resolve both the runtime argument template and the existing wos template before writing generated Compose output

#### Scenario: Required runtime argument is missing
- **WHEN** `wos.yaml` declares runtime argument `API_URL`
- **AND** an inline environment value contains `${API_URL}` without a default
- **AND** the up operation receives no non-empty value for `API_URL`
- **THEN** the system SHALL fail before Docker Compose startup with an actionable error naming `API_URL`

#### Scenario: Template references undeclared runtime argument
- **WHEN** an inline environment value contains `${API_URL:-https://empl-dev.test-wa.ru}`
- **AND** `API_URL` is not declared in `arguments`
- **THEN** the system SHALL fail before Docker Compose startup with an actionable error naming the undeclared runtime argument

#### Scenario: Submitted runtime argument is undeclared
- **WHEN** the up operation receives runtime argument `API_URL`
- **AND** `wos.yaml` does not declare `API_URL` in `arguments`
- **THEN** the system SHALL fail before Docker Compose startup with an actionable error naming `API_URL`

### Requirement: Daemon Start Command
The system SHALL provide `wos start` to start the local daemon for the current `<wos-home>` without requiring a Git worktree, and SHALL provide `wos start --foreground` as the foreground daemon process entrypoint.

#### Scenario: Start absent daemon
- **WHEN** the user runs `wos start` and no compatible daemon responds to HTTP health
- **THEN** the system SHALL remove stale daemon metadata for the current `<wos-home>`
- **AND** the system SHALL start `wos start --foreground` in the background
- **AND** the system SHALL wait until daemon HTTP health check succeeds before exiting successfully

#### Scenario: Start already running daemon
- **WHEN** the user runs `wos start` and a daemon responds successfully to HTTP health
- **THEN** the system SHALL report that the daemon is already running
- **AND** the system SHALL exit successfully
- **AND** the system SHALL NOT start another daemon

#### Scenario: Start outside worktree
- **WHEN** the user runs `wos start` from a directory that is not inside a Git worktree
- **THEN** the system SHALL perform the daemon start behavior
- **AND** the system SHALL NOT report the worktree command guard error
- **AND** the system SHALL NOT read `wos.yaml`
- **AND** the system SHALL NOT read or write wos session state

#### Scenario: Foreground start
- **WHEN** the user runs `wos start --foreground`
- **THEN** the system SHALL run the local daemon server in the foreground for the current `<wos-home>`
- **AND** the command SHALL keep running until the daemon exits or receives a termination signal
- **AND** the command SHALL NOT spawn another daemon process in the background

#### Scenario: Start startup failure
- **WHEN** the user runs `wos start` and the daemon does not become healthy before the startup timeout
- **THEN** the system SHALL exit unsuccessfully
- **AND** the system SHALL print an actionable error that includes the daemon startup failure

### Requirement: Daemon Stop Command
The system SHALL provide `wos stop` to stop the local daemon for the current `<wos-home>` without requiring a Git worktree and without stopping deployed Docker services.

#### Scenario: Stop running daemon
- **WHEN** the user runs `wos stop` and a daemon responds successfully to HTTP health
- **THEN** the system SHALL request daemon shutdown through the daemon HTTP lifecycle API
- **AND** the system SHALL remove stale daemon metadata for the current `<wos-home>` after the daemon no longer responds
- **AND** the system SHALL exit successfully after the daemon process is stopped or no longer responds

#### Scenario: Stop absent or stale daemon
- **WHEN** the user runs `wos stop` and no compatible daemon responds to HTTP health
- **THEN** the system SHALL remove stale daemon metadata for the current `<wos-home>`
- **AND** the system SHALL exit successfully

#### Scenario: Stop outside worktree
- **WHEN** the user runs `wos stop` from a directory that is not inside a Git worktree
- **THEN** the system SHALL perform the daemon stop behavior
- **AND** the system SHALL NOT report the worktree command guard error
- **AND** the system SHALL NOT read `wos.yaml`
- **AND** the system SHALL NOT read or write wos session state

#### Scenario: Stop preserves deployed services
- **WHEN** the user runs `wos stop`
- **THEN** the system SHALL NOT run Docker Compose shutdown commands for any worktree
- **AND** the system SHALL NOT remove wos session state files
- **AND** deployed Docker services SHALL remain running unless stopped by some other command or external process

### Requirement: CLI Web URL Scheme
The CLI SHALL surface the daemon Web UI URL with the effective HTTP or HTTPS scheme.

#### Scenario: wos web prints HTTPS URL
- **WHEN** the daemon metadata contains `webUrl` with an `https://` URL
- **AND** the user runs `wos web --no-open`
- **THEN** the CLI SHALL print that HTTPS URL

#### Scenario: wos web opens HTTPS URL
- **WHEN** the daemon metadata contains `webUrl` with an `https://` URL
- **AND** the user runs `wos web`
- **THEN** the CLI SHALL pass that HTTPS URL to the platform browser launcher

#### Scenario: wos web keeps HTTP default
- **WHEN** the daemon metadata contains `webUrl` with an `http://` URL
- **AND** the user runs `wos web`
- **THEN** the CLI SHALL preserve the existing HTTP behavior

### Requirement: CLI Tunnel URL Scheme
The CLI SHALL display active tunnel URLs using the effective tunnel listener scheme.

#### Scenario: Status shows HTTPS tunnel
- **WHEN** a worktree deployment has service `api` with an active tunnel URL `https://feature-api.example.com`
- **AND** the user runs `wos status`
- **THEN** the CLI SHALL show the HTTPS tunnel URL for `api`

#### Scenario: Status keeps HTTP tunnel by default
- **WHEN** a worktree deployment has service `api` with an active tunnel URL `http://feature-api.example.com`
- **AND** the user runs `wos status`
- **THEN** the CLI SHALL preserve the existing HTTP tunnel display

### Requirement: Docker Compose Lifecycle Execution
The system SHALL continue using Docker Compose lifecycle execution for deployment operations that rely on Compose semantics.

#### Scenario: Up remains Compose-backed
- **WHEN** the user runs `wos up`
- **THEN** wos SHALL continue using Docker Compose lifecycle execution for startup in this change
- **AND** Docker API state observation SHALL be used after lifecycle execution to report current managed service state

#### Scenario: Down remains Compose-backed
- **WHEN** the user runs `wos down`
- **THEN** wos SHALL continue using Docker Compose lifecycle execution for shutdown in this change
- **AND** Docker API state observation SHALL reconcile managed service state after shutdown

#### Scenario: Container init remains Compose-backed
- **WHEN** wos runs generated-mode container init commands
- **THEN** wos SHALL continue using Docker Compose run semantics for the init service in this change

### Requirement: Service Bind Address Port Publishing
When the global config sets `serviceBind`, generated-compose mode SHALL publish each managed host port on both a loopback address and the `serviceBind` address; when `serviceBind` is unset, it SHALL publish the prior single mapping. This keeps the loopback-bound tunnel proxy and healthchecks working while making the `serviceBind` address reachable.

#### Scenario: serviceBind unset publishes a single mapping
- **WHEN** `serviceBind` is not set
- **AND** wos assigns host port `21432` to a managed container port `3000`
- **THEN** the generated Compose port mapping SHALL be the prior single `21432:3000` form

#### Scenario: serviceBind set publishes loopback and bind mappings
- **WHEN** the global config sets `serviceBind` to `192.168.1.18`
- **AND** wos assigns host port `21432` to a managed container port `3000`
- **THEN** the generated Compose port mappings SHALL include `127.0.0.1:21432:3000`
- **AND** they SHALL include `192.168.1.18:21432:3000`

#### Scenario: Loopback mapping preserves tunnel and healthcheck reachability
- **WHEN** `serviceBind` is set and a managed port is published on both loopback and `serviceBind`
- **AND** a tunnel route or healthcheck targets the loopback host port
- **THEN** the loopback-bound target SHALL remain reachable

### Requirement: Service URL Template Bind Fallback
The system SHALL support `${app.services.<name>.url[<port>]}` and `${expose.<service>.url[<port>]}` templates. Resolution SHALL prefer an active tunnel URL; when none exists, it SHALL build a URL from the published host port using the configured `serviceBind` address when set, and `localhost` otherwise. IPv6 literal addresses SHALL be bracketed in the resulting URL.

#### Scenario: URL template prefers active tunnel URL
- **WHEN** a `url[<port>]` template references a managed port with an active tunnel URL
- **THEN** the template SHALL resolve to the tunnel URL regardless of `serviceBind`

#### Scenario: URL template falls back to localhost
- **WHEN** a `url[<port>]` template references a managed port with no active tunnel URL
- **AND** `serviceBind` is not set
- **AND** the assigned host port is `21432`
- **THEN** the template SHALL resolve to `http://localhost:21432`

#### Scenario: URL template falls back to serviceBind
- **WHEN** a `url[<port>]` template references a managed port with no active tunnel URL
- **AND** the global config sets `serviceBind` to `192.168.1.18`
- **AND** the assigned host port is `21432`
- **THEN** the template SHALL resolve to `http://192.168.1.18:21432`

#### Scenario: URL fallback brackets IPv6 serviceBind
- **WHEN** a `url[<port>]` template references a managed port with no active tunnel URL
- **AND** the global config sets `serviceBind` to an IPv6 literal such as `fd00::1`
- **AND** the assigned host port is `21432`
- **THEN** the template SHALL resolve to `http://[fd00::1]:21432`

### Requirement: Service Bind Address Shell Advisory
In shell mode the system cannot force a host process to bind a specific interface, so `serviceBind` SHALL only change injected values, not enforce a bind. When set and no active tunnel value exists, `WOS_SERVICE_HOSTNAME` and `${app.services.<name>.hostname[<port>]}` / `${app.services.<name>.url[<port>]}` fallbacks SHALL use `serviceBind` instead of `localhost`.

#### Scenario: Shell injects serviceBind as advertised hostname
- **WHEN** a shell service has a configured port with no active tunnel hostname
- **AND** the global config sets `serviceBind` to `192.168.1.18`
- **THEN** the injected `WOS_SERVICE_HOSTNAME` SHALL be `192.168.1.18`

#### Scenario: Shell serviceBind does not enforce the process bind
- **WHEN** `serviceBind` is set for a shell service
- **THEN** the system SHALL NOT modify how the host process itself binds its listening socket
- **AND** reachability on `serviceBind` SHALL depend on the process binding a compatible interface

### Requirement: CLI Exec Command
The CLI SHALL provide `wos exec <service> [--] <command...>` to run a command inside a running Docker-backed service for the current Git worktree.

#### Scenario: Exec command submits service command
- **WHEN** the user runs `wos exec api -- bun test` inside a Git worktree
- **THEN** the CLI SHALL resolve the current worktree using the same global `--cwd` semantics as other worktree-scoped commands
- **AND** it SHALL submit an exec session creation request for service `api`
- **AND** it SHALL preserve command argv as `["bun", "test"]`

#### Scenario: Exec command preserves command flags
- **WHEN** the user runs `wos exec api -- --version`
- **THEN** the CLI SHALL treat `--version` as the command argv entry
- **AND** it SHALL NOT parse `--version` as a wos exec option

#### Scenario: Exec command requires service
- **WHEN** the user runs `wos exec`
- **THEN** the CLI SHALL fail argument parsing
- **AND** it SHALL print usage that shows `wos exec <service> [--] <command...>`
- **AND** it SHALL NOT contact the daemon

#### Scenario: Exec command requires command
- **WHEN** the user runs `wos exec api`
- **THEN** the CLI SHALL fail argument parsing
- **AND** it SHALL report that a command is required
- **AND** it SHALL NOT contact the daemon

### Requirement: CLI Exec Uses Web API Attach
The CLI exec command SHALL use daemon `webUrl` and the daemon UI API for session creation and terminal WebSocket attach.

#### Scenario: Exec discovers daemon web URL
- **WHEN** the user runs `wos exec api -- sh`
- **AND** daemon metadata contains a compatible healthy `webUrl`
- **THEN** the CLI SHALL create the exec session through the daemon UI API at that `webUrl`
- **AND** it SHALL attach to the returned terminal session through the terminal WebSocket endpoint at that `webUrl`

#### Scenario: Exec requires daemon web URL
- **WHEN** the user runs `wos exec api -- sh`
- **AND** the daemon is running but daemon metadata does not contain a usable `webUrl`
- **THEN** the CLI SHALL fail with an actionable error that says exec requires the daemon web listener
- **AND** it SHALL NOT fall back to Unix-socket operation streaming

#### Scenario: Exec forwards terminal input and resize
- **WHEN** the CLI is attached to an exec terminal session from a TTY
- **THEN** it SHALL forward local stdin to terminal input frames
- **AND** it SHALL forward local terminal size changes to terminal resize frames
- **AND** it SHALL restore the local terminal mode when the session ends or attach fails

#### Scenario: Exec returns command exit code
- **WHEN** the exec terminal session exits with code `7`
- **THEN** the `wos exec` process SHALL exit with code `7`

#### Scenario: Exec attach transport fails before exit
- **WHEN** the terminal WebSocket attach fails before the CLI receives an exit status
- **THEN** the CLI SHALL print the attach error
- **AND** it SHALL exit with a wos-level nonzero failure code

### Requirement: Windows-Safe Session Storage
The CLI and daemon SHALL derive session storage paths from filesystem-safe session names on every supported host.

#### Scenario: Windows worktree path has drive letter
- **WHEN** the current worktree root is a Windows path such as `C:\Users\dev\repo`
- **THEN** the session name SHALL NOT contain the drive-letter colon
- **AND** the session directory SHALL be valid on Windows filesystems

#### Scenario: Worktree path contains invalid filename characters
- **WHEN** a worktree path contains characters that are invalid in Windows filenames
- **THEN** the session name SHALL replace or avoid those characters
- **AND** it SHALL include a stable path-derived hash to avoid collisions

#### Scenario: Existing POSIX session name remains readable
- **WHEN** a macOS or Linux worktree already has state under the legacy safe session directory name
- **THEN** the system SHALL continue reading that session state
- **AND** it SHALL NOT create a duplicate session solely because the new naming helper exists

### Requirement: CLI Uses Daemon HTTP API
The CLI SHALL use daemon HTTP metadata and HTTP API endpoints for daemon-backed commands.

#### Scenario: CLI discovers healthy daemon
- **WHEN** the CLI needs a running daemon
- **AND** `<wos-home>/daemon.json` contains a `webUrl`
- **THEN** the CLI SHALL call `GET /ui/v1/health` at that URL
- **AND** it SHALL treat the daemon as running only when the health response is successful and protocol-compatible

#### Scenario: CLI starts absent daemon
- **WHEN** the CLI needs a running daemon and no compatible HTTP daemon responds
- **THEN** it SHALL remove stale daemon metadata for the current `<wos-home>`
- **AND** it SHALL spawn `wos start --foreground` in the background
- **AND** it SHALL wait until daemon HTTP metadata and `GET /ui/v1/health` are available

#### Scenario: CLI avoids Unix socket fetch
- **WHEN** the CLI runs `wos start`, `wos stop`, `wos restart`, `wos web`, `wos up`, `wos down`, `wos status`, `wos wait`, or daemon-backed worktree commands
- **THEN** it SHALL NOT require `daemon.sock`
- **AND** it SHALL NOT use Bun `fetch` with the `unix` option

#### Scenario: CLI handles stale metadata
- **WHEN** daemon metadata exists but `webUrl` does not answer a compatible health check
- **THEN** the CLI SHALL treat the metadata as stale
- **AND** it SHALL not submit daemon operations to that stale URL

### Requirement: CLI HTTP Worktree Operations
The CLI SHALL map worktree-scoped commands to the daemon HTTP UI API.

#### Scenario: Up uses HTTP UI API
- **WHEN** the user runs `wos up`
- **THEN** the CLI SHALL submit the operation through the HTTP worktree up endpoint
- **AND** it SHALL stream operation progress through the HTTP operation event endpoint for foreground runs

#### Scenario: Down uses HTTP UI API
- **WHEN** the user runs `wos down`
- **THEN** the CLI SHALL submit the operation through the HTTP worktree down endpoint
- **AND** it SHALL stream operation progress through the HTTP operation event endpoint

#### Scenario: Status uses HTTP UI API
- **WHEN** the user runs `wos status`
- **THEN** the CLI SHALL read the current worktree detail through the HTTP UI API
- **AND** it SHALL format deployment status, services, healthchecks, and tunnels from that response

#### Scenario: Wait uses HTTP UI API
- **WHEN** the user runs `wos wait`
- **THEN** the CLI SHALL poll or observe readiness through HTTP UI API data
- **AND** it SHALL not call legacy socket status endpoints

### Requirement: Global Configuration Gate
The system SHALL require the global config file `~/.wos/config.json` (resolved under the current `<wos-home>`) to exist before running any command other than the setup wizard entrypoints (`wos` with no arguments, `wos init`) and help (`help`, `-h`, `--help`). When the global config file does not exist, any other command SHALL fail with `wos: no configuration found. Run \`wos init\` to set up.` and a non-zero exit code, before any worktree resolution, daemon contact, or daemon auto-start. This gate is independent of the per-repo deploy config (`.wos/deploy.yaml` / `.wos/deploy.worktree.yaml`).

#### Scenario: Command blocked when no global config exists
- **WHEN** the user runs a non-wizard, non-help command (for example `wos up`, `wos status`, `wos start`, `wos web`) and `~/.wos/config.json` does not exist
- **THEN** the system SHALL print `wos: no configuration found. Run \`wos init\` to set up.`
- **AND** the system SHALL exit with a non-zero code
- **AND** the system SHALL NOT resolve the worktree, contact the daemon, or auto-start the daemon

#### Scenario: Help is allowed without a config
- **WHEN** the user runs `wos help`, `wos -h`, or `wos --help` and no global config exists
- **THEN** the system SHALL print the usage text
- **AND** the system SHALL exit successfully

#### Scenario: Gate satisfied after the wizard writes a config
- **WHEN** the global config file exists (for example after `wos init` saved it)
- **THEN** the system SHALL allow non-wizard commands to run normally

### Requirement: Init Command and Default Invocation
The system SHALL register `init` as a known command and SHALL route both bare `wos` (no arguments) and `wos init` to the setup wizard. The top-level usage text SHALL document `init`. Bare `wos` SHALL launch the wizard rather than printing usage.

#### Scenario: init is a known command
- **WHEN** the CLI parses the command `init`
- **THEN** the system SHALL treat `init` as a known command and route it to the setup wizard

#### Scenario: Bare wos routes to the wizard
- **WHEN** the user runs `wos` with no command argument
- **THEN** the system SHALL launch the setup wizard
- **AND** the system SHALL NOT print the usage text as the default action

#### Scenario: Usage documents init
- **WHEN** the system prints the top-level usage text
- **THEN** the usage SHALL include an `init` entry describing the setup wizard

### Requirement: Default Backend Stability Warning
The system SHALL warn that terminal sessions may be unstable when the effective terminal backend is `default`. The wording SHALL be `Running outside tmux/psmux — terminal sessions may be unstable.` and SHALL be emitted on `wos start` when the configured backend is `default`.

#### Scenario: Warning on daemon start with default backend
- **WHEN** the user runs `wos start` and the configured `terminalBackend` is `default`
- **THEN** the system SHALL print `Running outside tmux/psmux — terminal sessions may be unstable.`
- **AND** the warning SHALL NOT prevent the daemon from starting

#### Scenario: No warning on daemon start with tmux backend
- **WHEN** the user runs `wos start` and the configured `terminalBackend` is `tmux`
- **THEN** the system SHALL NOT print the outside-tmux/psmux warning

