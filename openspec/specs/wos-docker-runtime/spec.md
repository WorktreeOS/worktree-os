# wos-docker-runtime Specification

## Purpose
TBD - created by archiving change add-docker-api-state-cache. Update Purpose after archive.
## Requirements
### Requirement: Docker Engine API Client
The system SHALL provide a Docker Engine API client for daemon-owned Docker container observation and service-level actions across supported local Docker Engine transports.

#### Scenario: List wos-managed containers
- **WHEN** the daemon requests current Docker container state
- **THEN** the Docker client SHALL list containers with `all=true`
- **AND** it SHALL use Docker label filters for wos-managed containers belonging to the current wos home

#### Scenario: Normalize Docker container snapshot
- **WHEN** Docker returns a managed container from list or inspect
- **THEN** the system SHALL normalize it into a wos container snapshot containing container id, name, labels, session name, project name, service name, deployment id, mode, state, status, and published port mappings

#### Scenario: Stream filtered container events
- **WHEN** the daemon starts Docker event observation
- **THEN** the Docker client SHALL subscribe to container events filtered to wos-managed containers for the current wos home
- **AND** it SHALL support aborting the event request so the daemon can reconnect after reconciliation

#### Scenario: Stream logs for a managed container
- **WHEN** a service log subscriber is attached to a managed service with a known current container id
- **THEN** the Docker client SHALL stream Docker logs for that container using follow and tail options

#### Scenario: Run service-level container action
- **WHEN** a service stop, start, or restart action targets a known managed service container
- **THEN** the Docker client SHALL invoke the corresponding Docker container API for that container

#### Scenario: Windows Docker Desktop named pipe
- **WHEN** the daemon runs on Windows and no explicit Docker host override is configured
- **THEN** the Docker client SHALL attempt to connect to Docker Desktop through the Windows named pipe `npipe:////./pipe/docker_engine`
- **AND** it SHALL NOT require `/var/run/docker.sock`

#### Scenario: Explicit Docker named pipe host
- **WHEN** `DOCKER_HOST` or the Docker client option identifies a Windows named pipe endpoint
- **THEN** the Docker client SHALL connect to that named pipe endpoint
- **AND** it SHALL use the same Docker Engine HTTP request semantics as other transports

#### Scenario: Explicit Docker TCP host
- **WHEN** `DOCKER_HOST` or the Docker client option identifies a plain `tcp://` or `http://` Docker Engine endpoint
- **THEN** the Docker client SHALL connect over TCP
- **AND** list, inspect, events, logs, stats, and service actions SHALL preserve the existing normalized Docker client behavior

#### Scenario: Docker transport unavailable
- **WHEN** the configured Docker Engine transport cannot be reached
- **THEN** the daemon SHALL surface a clear Docker connection diagnostic naming the selected transport kind
- **AND** the daemon SHALL continue serving non-Docker UI and daemon management APIs when otherwise healthy

### Requirement: WorktreeOS Docker Label Contract
The system SHALL label every wos-managed service container with identity metadata sufficient for Docker API filtering and session/service mapping.

#### Scenario: Generated service has identity labels
- **WHEN** wos writes generated-compose artifacts for a managed app or dependency service
- **THEN** the service definition SHALL include labels for managed marker, schema version, wos home hash, session name, project name, mode `generated`, service name, and deployment id

#### Scenario: Compose-mode exposed service has identity labels
- **WHEN** wos writes a compose-mode overlay for a service listed in `compose.expose`
- **THEN** the overlay service definition SHALL include labels for managed marker, schema version, wos home hash, session name, project name, mode `compose`, service name, and deployment id

#### Scenario: Tunnel labels are additive
- **WHEN** a managed service has no active tunnel hostname metadata
- **THEN** the service SHALL still include required wos identity labels
- **AND** it SHALL omit tunnel hostname labels

### Requirement: Docker Container State Cache
The daemon SHALL maintain an in-memory cache of wos-managed Docker container state.

#### Scenario: Initial full sync
- **WHEN** the daemon starts Docker state observation
- **THEN** it SHALL perform a full sync of wos-managed Docker containers before relying on Docker events
- **AND** the sync SHALL include stopped and exited containers

#### Scenario: Event updates cache
- **WHEN** Docker reports a managed container lifecycle event
- **THEN** the daemon SHALL update the cached container snapshot for the affected container
- **AND** it SHALL inspect the container when the event payload does not contain enough state to update the snapshot accurately

#### Scenario: Destroy event removes cached container
- **WHEN** Docker reports that a managed container was destroyed or removed
- **THEN** the daemon SHALL remove that container from the active cache snapshot or mark it removed so session readers no longer treat it as a current service container

#### Scenario: Periodic reconciliation repairs missed events
- **WHEN** the Docker event stream has been running for the configured reconciliation interval
- **THEN** the daemon SHALL interrupt the event request
- **AND** it SHALL perform a full sync
- **AND** it SHALL resume event observation after the sync

#### Scenario: Session snapshot excludes internal init service
- **WHEN** a daemon reader requests user-facing managed services for a session
- **THEN** the Docker state cache SHALL return managed service containers for that session
- **AND** it SHALL exclude wos internal init services from user-facing results

### Requirement: Docker Compose Exec Command Construction
The Docker runtime SHALL construct Docker Compose exec commands from persisted wos session Compose state.

#### Scenario: Generated-mode exec command uses persisted compose file
- **WHEN** exec targets an initialized generated-compose session with project name `wos-demo`
- **AND** the persisted compose file is `<session>/compose.yaml`
- **THEN** the Docker runtime SHALL build Docker arguments equivalent to `compose -p wos-demo -f <session>/compose.yaml exec <service> <command...>`

#### Scenario: Compose-mode exec command uses persisted compose file set
- **WHEN** exec targets an initialized compose-mode session with persisted Compose files `<session>/compose-base.yaml` and `<session>/compose-overlay.yaml`
- **THEN** the Docker runtime SHALL include both files in order with `-f`
- **AND** it SHALL run `exec <service> <command...>` after the Compose file flags

#### Scenario: Compose-mode exec receives compose environment
- **WHEN** exec targets a compose-mode session with configured Compose environment values
- **THEN** the Docker runtime SHALL pass the same resolved Compose command environment used by other Compose invocations

### Requirement: Docker Exec Service Validation
The Docker runtime SHALL validate exec targets against the initialized wos deployment before spawning Docker Compose exec.

#### Scenario: Exec rejects internal init service
- **WHEN** exec targets the internal wos init service
- **THEN** the Docker runtime SHALL reject the request
- **AND** it SHALL NOT spawn Docker Compose exec

#### Scenario: Exec rejects uninitialized deployment
- **WHEN** exec targets a session without initialized deployment state
- **THEN** the Docker runtime SHALL reject the request
- **AND** it SHALL NOT spawn Docker Compose exec

#### Scenario: Exec rejects compose-mode unexposed service
- **WHEN** exec targets a compose-mode service not listed in `compose.expose`
- **THEN** the Docker runtime SHALL reject the request
- **AND** it SHALL NOT spawn Docker Compose exec

#### Scenario: Exec rejects shell-mode deployment
- **WHEN** exec targets a shell-mode deployment
- **THEN** the Docker runtime SHALL reject the request as unsupported
- **AND** it SHALL NOT spawn a host shell command as a substitute
