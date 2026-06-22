# wos-daemon-api Specification

## Purpose
TBD - created by archiving change introduce-wos-daemon-api. Update Purpose after archive.
## Requirements
### Requirement: Session Resolution API
The system SHALL expose an API that resolves a client-provided working directory to the corresponding wos worktree session and loads the effective project deploy configuration from the resolved repository primary/source worktree.

#### Scenario: Resolve inside the source Git worktree
- **WHEN** a client asks the daemon to resolve a directory inside the selected primary/source Git worktree
- **THEN** the daemon SHALL return the worktree root, session name, session root, and current session state when present
- **AND** any loaded deploy configuration SHALL come from `.wos/deploy.yaml` in the repository primary/source worktree

#### Scenario: Resolve inside a secondary Git worktree
- **WHEN** a client asks the daemon to resolve a directory inside a secondary Git worktree
- **AND** the repository primary/source worktree contains `.wos/deploy.worktree.yaml`
- **THEN** the daemon SHALL resolve the secondary worktree session successfully
- **AND** the daemon SHALL load project deploy configuration from `.wos/deploy.worktree.yaml` in the primary/source worktree
- **AND** the daemon SHALL NOT require a deploy config file inside the secondary worktree checkout

#### Scenario: Resolve outside a Git worktree
- **WHEN** a client asks the daemon to resolve a directory that is not inside a Git worktree
- **THEN** the daemon SHALL return a failure that preserves the existing worktree command guard semantics
- **AND** the daemon SHALL NOT read project deploy configuration
- **AND** the daemon SHALL NOT read or write wos session state

### Requirement: Operation Submission API
The system SHALL expose local API endpoints that submit worktree-scoped `up`, `down`, and `status` operations for a resolved wos session using the effective deploy configuration selected for the current worktree.

#### Scenario: Submit source up operation
- **WHEN** a client submits an `up` operation for a resolved session whose current worktree is the selected primary/source worktree
- **THEN** the daemon SHALL start an operation that performs the same setup, selected startup, app-port healthcheck readiness when configured, status collection, and state persistence behavior as `wos up`
- **AND** the daemon SHALL use `.wos/deploy.yaml` from the primary/source worktree for the selected current worktree session
- **AND** the daemon SHALL return an operation id

#### Scenario: Submit secondary worktree up operation
- **WHEN** a client submits an `up` operation for a resolved session whose current worktree is not the selected primary/source worktree
- **THEN** the daemon SHALL start an operation that performs the same setup, selected startup, app-port healthcheck readiness when configured, status collection, and state persistence behavior as `wos up`
- **AND** the daemon SHALL use `.wos/deploy.worktree.yaml` from the primary/source worktree for the selected current worktree session
- **AND** the daemon SHALL return an operation id

#### Scenario: Submit compose-mode up operation
- **WHEN** a client submits an `up` operation for a resolved session whose effective deploy config contains `mode: compose`
- **THEN** the daemon SHALL use the resolved `compose.config` file and compose command environment for Docker Compose startup
- **AND** the daemon SHALL persist state for the compose-backed session
- **AND** the daemon SHALL return an operation id

#### Scenario: Submit forced up operation
- **WHEN** a client submits an `up` operation with `force` enabled
- **THEN** the daemon SHALL perform the same forced refresh behavior as `wos up --force`
- **AND** the daemon SHALL include the same app-port healthcheck readiness behavior as `wos up --force` when the selected deployment mode has app-port healthchecks
- **AND** the daemon SHALL return an operation id

#### Scenario: Submit down operation
- **WHEN** a client submits a `down` operation for a resolved session
- **THEN** the daemon SHALL perform the same Docker Compose or shell shutdown behavior as `wos down`
- **AND** the daemon SHALL return an operation id

#### Scenario: Submit status operation
- **WHEN** a client submits a `status` operation for a resolved session
- **THEN** the daemon SHALL collect and return current deployment status for that session from the daemon Docker state cache when the session has Docker-labeled managed containers
- **AND** the daemon SHALL collect and return current deployment status from persisted shell state when the session uses shell mode
- **AND** the daemon SHALL return an operation id

### Requirement: Daemon Status Healthchecks
The daemon status API SHALL include current app-port healthcheck results for resolved sessions with deployment state, scoped to app services present in the current deployed Compose service snapshot.

#### Scenario: Status includes healthy app port
- **WHEN** a client requests status for a resolved session with an app service port whose healthcheck succeeds
- **THEN** the daemon SHALL return that service and port with healthcheck status marked healthy
- **AND** the response SHALL include the checked URL, expected status, observed status, timeout, and `allow_failure` value

#### Scenario: Status includes failed app port
- **WHEN** a client requests status for a resolved session with an app service port whose healthcheck fails
- **THEN** the daemon SHALL return that service and port with healthcheck status marked failed
- **AND** the response SHALL include an actionable failure message
- **AND** the daemon SHALL still return a successful status API response

#### Scenario: Status includes disabled app port
- **WHEN** a client requests status for a resolved session with an app service port that has `healthcheck: false`
- **THEN** the daemon SHALL return that service and port with healthcheck status marked disabled
- **AND** the daemon SHALL NOT perform an HTTP request for that port

#### Scenario: Dependency ports are not checked
- **WHEN** a client requests status for a resolved session with dependency service ports
- **THEN** the daemon SHALL NOT return healthcheck results for dependency ports

#### Scenario: Selective generated deployment excludes absent app healthchecks
- **WHEN** a client requests status for a resolved generated-compose session whose current stored Compose service snapshot contains app services `api` and `web`
- **AND** the primary/source config also defines app service `admin`
- **AND** `admin` is absent from the stored Compose service snapshot
- **THEN** the daemon SHALL return app-port healthcheck results only for `api` and `web`
- **AND** it SHALL NOT return failed, waiting, or disabled healthcheck rows for `admin`

### Requirement: Operation Event Streams
The system SHALL provide a stream of ordered operation events for daemon-owned operations.

#### Scenario: Client subscribes to operation events
- **WHEN** a client subscribes to the event stream for an active operation
- **THEN** the daemon SHALL stream deployment events with operation id, monotonically increasing sequence, timestamp, and event payload

#### Scenario: Up operation emits deployment events
- **WHEN** an `up` operation runs setup, Docker Compose lifecycle commands, retries, service discovery, completion, or failure
- **THEN** the daemon SHALL emit event payloads equivalent to the existing deployment event model for those lifecycle changes

#### Scenario: Client disconnects from event stream
- **WHEN** a client disconnects from an operation event stream
- **THEN** the daemon SHALL keep the operation running
- **AND** the daemon SHALL keep bounded operation events or logs available for later clients

### Requirement: Per-Session Operation Coordination
The daemon SHALL coordinate operations per wos session so mutating operations cannot run concurrently for the same session.

#### Scenario: Mutating operation already running
- **WHEN** an `up` or `down` operation is already running for a session
- **AND** a client submits another `up` or `down` operation for the same session
- **THEN** the daemon SHALL reject the new mutating operation with a conflict response
- **AND** the conflict response SHALL identify the active operation

#### Scenario: Operations for different sessions
- **WHEN** clients submit mutating operations for different sessions
- **THEN** the daemon MAY run those operations concurrently
- **AND** each operation SHALL write only its own session state and selected compose-file metadata

### Requirement: On-Demand Service Log Streams
The daemon SHALL provide service logs as request-scoped Docker Compose streams rather than background daemon-owned collectors.

#### Scenario: Daemon starts with initialized sessions
- **WHEN** the daemon starts and restores initialized sessions, monitors, or tunnels
- **THEN** it SHALL NOT start service log followers solely because initialized session state exists
- **AND** it SHALL still restore session monitoring and tunnel behavior according to their own lifecycle requirements

#### Scenario: Up discovers services without log viewers
- **WHEN** a daemon-owned `up` operation discovers managed services after Docker Compose startup
- **THEN** the daemon SHALL NOT start service log followers solely because services were discovered
- **AND** service stdout and stderr SHALL NOT be appended to daemon-owned service log buffers unless a client has opened a service log stream

#### Scenario: Client opens one service log stream
- **WHEN** a client opens logs for `service:<name>` on an initialized session
- **THEN** the daemon SHALL start or reuse a request-scoped Docker Compose log stream only for that service
- **AND** the Docker Compose log command SHALL use `logs --follow --no-color --tail 1000 <name>`
- **AND** the stream SHALL deliver the requested service's chunks without delivering chunks from other services

#### Scenario: Multiple clients open the same service log stream
- **WHEN** multiple clients concurrently subscribe to logs for the same session and service
- **THEN** the daemon SHALL avoid duplicate Docker Compose log followers for that session/service while a shared active stream can serve them
- **AND** each subscriber SHALL receive the active stream's bounded tail before newly arriving chunks

#### Scenario: Last service log subscriber disconnects
- **WHEN** the last subscriber for an active session/service log stream disconnects
- **THEN** the daemon SHALL stop the associated Docker Compose log follower
- **AND** it SHALL discard request-scoped service log history for that stream
- **AND** it SHALL NOT stop Docker services because of the log stream disconnect

### Requirement: Session Log Stream API
The system SHALL expose APIs that stream service logs for a wos session as request-scoped Docker Compose log streams, so clients can observe current container output without the daemon continuously collecting service logs in the background.

#### Scenario: Client subscribes to session logs
- **WHEN** a client subscribes to the session log stream for an existing initialized session
- **THEN** the daemon SHALL stream service log chunks with session name, monotonically increasing sequence, timestamp, service name, stream (stdout or stderr), and chunk payload
- **AND** the daemon SHALL obtain initial service history from Docker Compose using `--tail 1000` for each requested service stream
- **AND** the daemon SHALL keep the stream open until the client disconnects

#### Scenario: Up completes before the client opens a log stream
- **WHEN** an `up` operation reaches its terminal state for a session with no service log subscribers
- **THEN** the daemon SHALL NOT keep service log followers running for that session
- **AND** a later log stream subscription SHALL start request-scoped Docker Compose log streaming with `--tail 1000`

#### Scenario: Session has no active service log stream yet
- **WHEN** a client subscribes to logs before any request-scoped service log stream is active for that session
- **THEN** the daemon SHALL accept the subscription when the session can be resolved
- **AND** the daemon SHALL start the required request-scoped service log stream without requiring the client to resubscribe

#### Scenario: Client cancels the session log stream
- **WHEN** a subscribed client cancels its session log stream
- **THEN** the daemon SHALL release that client's subscription
- **AND** the daemon SHALL stop any request-scoped service log follower that no longer has subscribers
- **AND** the daemon SHALL NOT stop Docker services because of that cancellation

### Requirement: Local Daemon Web Listener
The daemon SHALL provide a required HTTP or HTTPS listener that serves the built wos Web UI and the local daemon management API. The listener SHALL bind to default host `127.0.0.1` and default port `4949`, with both values overridable via global user config (`web.host`, `web.port`).

#### Scenario: Daemon starts web listener on default host and port
- **WHEN** the daemon starts successfully and the global config does not override `web.host` or `web.port`
- **THEN** it SHALL bind the listener to `127.0.0.1` on port `4949`
- **AND** it SHALL NOT bind to a public network interface by default
- **AND** it SHALL serve Web UI and daemon management API routes on that listener

#### Scenario: Daemon starts web listener on configured host
- **WHEN** the daemon starts successfully and the global config sets `web.host` to a valid value
- **THEN** it SHALL bind the listener to the configured host
- **AND** it SHALL NOT reject broad bind values such as `0.0.0.0`

#### Scenario: Daemon starts web listener on configured port
- **WHEN** the daemon starts successfully and the global config sets `web.port` to a valid value
- **THEN** it SHALL bind the listener to the configured port

#### Scenario: Configured web listener cannot bind
- **WHEN** the daemon starts and the effective web host or port cannot be bound
- **THEN** daemon startup SHALL fail with a clear diagnostic naming the host, port, and underlying error
- **AND** the daemon SHALL NOT report healthy metadata for that failed startup

#### Scenario: Web listener carries daemon API
- **WHEN** CLI clients call daemon management or worktree operation APIs
- **THEN** the daemon SHALL serve those requests through the HTTP listener
- **AND** the daemon SHALL NOT require a Unix domain socket for CLI control

#### Scenario: Daemon reports web location
- **WHEN** daemon metadata is written after startup
- **THEN** the metadata SHALL include the web UI URL so local clients can discover it
- **AND** the metadata SHALL include protocol and listener information required by HTTP daemon clients

### Requirement: Web And API Route Separation
The daemon SHALL keep browser web routes separate from daemon API routes while serving both on the daemon HTTP listener.

#### Scenario: Web request targets API namespace
- **WHEN** a browser or CLI sends a request to the web listener under a supported API namespace
- **THEN** the daemon SHALL handle that route according to the supported HTTP API contract
- **AND** it SHALL NOT fall through to static Web UI asset fallback

#### Scenario: Static route does not shadow daemon API
- **WHEN** a request targets a supported daemon HTTP API route
- **THEN** static web asset fallback behavior SHALL NOT change that API response

#### Scenario: Removed legacy API route is requested
- **WHEN** a request targets a removed legacy Unix-socket-only `/v1/*` route on the web listener
- **THEN** the daemon SHALL return a structured not-found response
- **AND** clients SHALL use the supported `/ui/v1/*` HTTP API instead

### Requirement: Daemon-Owned App Port Tunnels
The daemon SHALL own local HTTP tunnel route lifecycles for app ports when global tunneling is enabled and not skipped.

#### Scenario: Up operation registers active tunnel
- **WHEN** a daemon-owned `up` operation registers a local HTTP tunnel route for app service port `api:3000`
- **AND** the assigned host port is `20042`
- **AND** the generated hostname is `feature-login-api.example.com`
- **THEN** the daemon SHALL store an in-memory tunnel record for the resolved session
- **AND** the tunnel record SHALL include service name `api`, container port `3000`, assigned host port `20042`, public URL `http://feature-login-api.example.com`, hostname `feature-login-api.example.com`, and active state

#### Scenario: Up operation records tunnel failure
- **WHEN** a daemon-owned `up` operation attempts to register a local HTTP tunnel route for app service port `api:3000`
- **AND** route registration fails
- **THEN** the daemon SHALL store an in-memory failed tunnel record for the resolved session
- **AND** the daemon SHALL NOT fail the `up` operation solely because of that tunnel failure

#### Scenario: Up operation skips tunnels
- **WHEN** a daemon-owned `up` operation is submitted with tunnel skipping enabled
- **THEN** the daemon SHALL NOT register local HTTP tunnel routes for that operation
- **AND** the daemon SHALL clear stale tunnel records for the session before startup

#### Scenario: Repeated up resets previous tunnels
- **WHEN** a daemon session already has active or failed tunnel records
- **AND** a new `up` operation starts for the same session
- **THEN** the daemon SHALL unregister all active tunnel routes for that session before registering routes for the new deployment attempt
- **AND** the daemon SHALL replace stale tunnel records with records from the new deployment attempt

#### Scenario: Down closes tunnels
- **WHEN** a daemon-owned `down` operation runs for a session with active tunnels
- **THEN** the daemon SHALL unregister all active tunnel routes for that session
- **AND** the daemon SHALL clear tunnel records for that session

#### Scenario: Daemon shutdown closes tunnels
- **WHEN** the daemon shuts down
- **THEN** the daemon SHALL unregister every active local HTTP tunnel route it owns
- **AND** the daemon SHALL stop the local tunnel HTTP server
- **AND** the daemon SHALL clear all in-memory tunnel records

### Requirement: Daemon Status Tunnel Information
The daemon status API SHALL include app port tunnel information for resolved sessions with deployment state.

#### Scenario: Status includes active tunnel
- **WHEN** a client requests status for a resolved session with an active tunnel for `api:3000`
- **THEN** the daemon SHALL return the existing service status and app-port healthcheck information
- **AND** the response SHALL include tunnel information for `api:3000` with active state, public HTTP URL, hostname, container port, and assigned host port

#### Scenario: Status includes failed tunnel
- **WHEN** a client requests status for a resolved session with a failed tunnel for `api:3000`
- **THEN** the daemon SHALL return the existing service status and app-port healthcheck information
- **AND** the response SHALL include tunnel information for `api:3000` with failed state and an actionable failure message
- **AND** the daemon SHALL still return a successful status API response

#### Scenario: Status omits tunnel when no route exists
- **WHEN** a client requests status for a resolved session with app service port `api:3000`
- **AND** no active or failed tunnel record exists for that port
- **THEN** the daemon SHALL return no tunnel record for `api:3000`

#### Scenario: Status after daemon restart does not reopen tunnel
- **WHEN** a daemon starts after previous in-memory tunnel routes were lost
- **AND** a client requests status for a session with persisted deployment state
- **THEN** the daemon SHALL NOT register a new local HTTP tunnel route as a side effect of the status request
- **AND** the daemon SHALL report no active public tunnel until the user runs `wos up` again

### Requirement: Unified UI API Routes
The daemon SHALL expose unified UI API routes for local UI clients while preserving the existing low-level Unix-socket `/v1/*` daemon API.

#### Scenario: Browser calls UI API route
- **WHEN** a browser sends a request to a supported `/ui/v1/*` route on the daemon web listener
- **THEN** the daemon SHALL handle the request with the unified UI API handler
- **AND** it SHALL return a browser-readable HTTP response

#### Scenario: Local UI client calls UI API route through daemon transport
- **WHEN** a local non-browser UI client sends a request to a supported `/ui/v1/*` route through daemon transport
- **THEN** the daemon SHALL handle the request with the same unified UI API handler and response schema used by the web listener

#### Scenario: Existing daemon API remains available
- **WHEN** CLI command internals call existing `/v1/*` daemon routes
- **THEN** the daemon SHALL preserve their existing behavior and response semantics
- **AND** the unified UI API implementation SHALL NOT require removing those routes

### Requirement: UI API And Static Asset Separation
The daemon web listener SHALL route UI API requests before static asset fallback and SHALL NOT serve `index.html` for supported or malformed `/ui/v1/*` API requests.

#### Scenario: UI API route is supported
- **WHEN** a browser requests a supported `/ui/v1/*` route
- **THEN** the daemon SHALL return the UI API response
- **AND** it SHALL NOT attempt to serve a static asset for that route

#### Scenario: UI API route is unsupported
- **WHEN** a browser requests an unsupported `/ui/v1/*` route
- **THEN** the daemon SHALL return a structured API not-found response
- **AND** it SHALL NOT return the single-page app fallback HTML

#### Scenario: Frontend route is not API route
- **WHEN** a browser requests a non-file frontend route outside `/ui/v1/*`
- **THEN** the daemon SHALL continue returning the built `index.html` as the single-page app fallback

### Requirement: UI API Project And Worktree Aggregation
The daemon SHALL aggregate project registry data, Git worktree discovery, wos session state, active operation metadata, service status, healthchecks, tunnel data, deployment status, and service summary data into unified UI API responses.

#### Scenario: Project list aggregation succeeds
- **WHEN** a UI client requests the project list
- **THEN** the daemon SHALL read the project registry
- **AND** it SHALL discover worktrees for each valid registered primary/source worktree
- **AND** it SHALL include deployment status for each discovered worktree
- **AND** it SHALL include a service summary for initialized worktrees when service state can be collected

#### Scenario: Worktree detail aggregation succeeds
- **WHEN** a UI client requests worktree detail
- **THEN** the daemon SHALL resolve the worktree session
- **AND** it SHALL include current state, service status when initialized, app-port healthchecks, tunnel snapshots, active operation metadata when present, deployment status, and service summary

#### Scenario: Worktree is not initialized
- **WHEN** a UI client requests worktree detail for a worktree without initialized wos state
- **THEN** the daemon SHALL return a successful response with deployment status `not_started`
- **AND** it SHALL return a service summary with `running` equal to `0` and `total` equal to `0`
- **AND** it SHALL NOT treat the absence of deployment state as an API failure

### Requirement: UI API Git Diff Access
The daemon SHALL provide read-only staged and unstaged Git diff access for selected worktrees through the unified UI API, including structured review metadata for web clients.

#### Scenario: Staged diff requested
- **WHEN** a UI client requests staged diff for a selected worktree
- **THEN** the daemon SHALL run Git diff scoped to that worktree's root and return the staged diff text

#### Scenario: Unstaged diff requested
- **WHEN** a UI client requests unstaged diff for a selected worktree
- **THEN** the daemon SHALL run Git diff scoped to that worktree's root and return the unstaged diff text

#### Scenario: Structured review diff requested
- **WHEN** a UI client requests structured review diff data for a selected worktree
- **THEN** the daemon SHALL collect staged and unstaged Git diff data scoped to that worktree's root
- **AND** it SHALL return aggregate additions, deletions, changed file counts, per-file status and path metadata, hunks, line entries, and raw patch text when available

#### Scenario: Diff includes non-text file changes
- **WHEN** Git reports a changed file that cannot be represented as normal text hunks
- **THEN** the daemon SHALL still include the changed file in structured review data with file status and totals when available
- **AND** it SHALL mark the file so UI clients can render a non-text diff state instead of failing the whole response

#### Scenario: Diff command fails
- **WHEN** Git cannot produce the requested diff for the selected worktree
- **THEN** the daemon SHALL return a structured API error that preserves the Git failure message

### Requirement: Unified Event SSE API
The daemon API SHALL expose a local SSE stream for unified daemon events.

#### Scenario: Client subscribes to unified events
- **WHEN** a client sends `GET /ui/v1/events`
- **THEN** the daemon SHALL return an SSE response with content type `text/event-stream`
- **AND** each event frame SHALL include `id`, `event`, and `data` fields
- **AND** the `data` field SHALL contain the unified event envelope as JSON
- **AND** the stream SHALL remain open until the client disconnects or the daemon stops

#### Scenario: Client subscribes with session filter
- **WHEN** a client sends `GET /ui/v1/events?session=<sessionName>`
- **THEN** the daemon SHALL stream retained and live events for the requested session
- **AND** it SHALL omit events for other sessions unless the event is global and required for client reconciliation

#### Scenario: Client reconnects with Last-Event-ID
- **WHEN** a client subscribes to the SSE stream with a `Last-Event-ID` header
- **THEN** the daemon SHALL replay retained events after that id before streaming new events

#### Scenario: Client disconnects from unified stream
- **WHEN** a client disconnects from the unified event SSE stream
- **THEN** the daemon SHALL release that subscription
- **AND** the daemon SHALL keep operations, tunnels, and session monitors running according to their own lifecycle rules
- **AND** the unified event subscription SHALL NOT keep any service log follower alive

### Requirement: Daemon Event Publication
The daemon SHALL publish unified events from operation, project, tunnel, and session monitoring paths.

#### Scenario: Up operation publishes unified events
- **WHEN** a daemon-owned `up` operation starts, emits deployment progress, discovers services, completes, or fails
- **THEN** the daemon SHALL publish corresponding unified operation and deployment events
- **AND** the existing operation event stream SHALL continue to receive its existing envelopes

#### Scenario: Down operation publishes unified events
- **WHEN** a daemon-owned `down` operation starts, stops deployment resources, closes tunnels, completes, or fails
- **THEN** the daemon SHALL publish corresponding unified operation, service, tunnel, and deployment status events

#### Scenario: Project registration publishes unified events
- **WHEN** the daemon registers a new project or updates an existing project as part of project add or successful `up`
- **THEN** the daemon SHALL publish a project added or project updated event

#### Scenario: Service log stream receives output
- **WHEN** a request-scoped service log stream receives stdout or stderr from Docker Compose
- **THEN** the daemon SHALL deliver that output only to subscribers of the log stream
- **AND** it SHALL NOT publish raw service log chunks as unified events

#### Scenario: Tunnel lifecycle publishes unified events
- **WHEN** a tunnel opens successfully, fails to open, is reset, or is dropped
- **THEN** the daemon SHALL publish a tunnel lifecycle event for each affected app service port

### Requirement: Session Monitor API Behavior
The daemon SHALL own monitor lifecycles for initialized sessions and use monitors to publish post-operation deployment state events.

#### Scenario: Monitor is registered for initialized session
- **WHEN** a session reaches service discovery during `up`
- **THEN** the daemon SHALL register or refresh a monitor for that session using the current compose context

#### Scenario: Monitors are restored on daemon start
- **WHEN** the daemon starts and discovers initialized wos session state
- **THEN** it SHALL register or refresh monitors for initialized deployments that can be resolved
- **AND** a daemon restart SHALL NOT require a new `up` operation before service, healthcheck, tunnel, or aggregate deployment status changes can be observed

#### Scenario: Monitor is removed on down
- **WHEN** a `down` operation completes for a session
- **THEN** the daemon SHALL stop the monitor for that session
- **AND** future service or healthcheck changes for that stopped deployment SHALL NOT be emitted until another `up` registers a monitor

#### Scenario: Daemon shuts down
- **WHEN** the daemon is stopping
- **THEN** it SHALL stop all event subscriptions and session monitors
- **AND** it SHALL close active request-scoped service log streams and tunnels according to their lifecycle behavior

### Requirement: Deployment Status Classification
The daemon SHALL classify initialized deployment status from managed Docker container state, operation state, and app-port healthcheck results, using a single lifecycle model shared by session monitors and UI snapshot endpoints. Required healthchecks SHALL mean healthchecks for app services present in the current deployed Docker service snapshot.

#### Scenario: Deployment has no initialized state
- **WHEN** a worktree has no initialized wos deployment state
- **THEN** the daemon SHALL classify the deployment status as `not_started`

#### Scenario: Deployment has active up or service-restart operation
- **WHEN** a worktree has an active mutating operation of kind `up` or `service-restart` before healthcheck readiness is being evaluated
- **THEN** the daemon SHALL classify the deployment status as `pending`

#### Scenario: Deployment has active down or service-stop operation
- **WHEN** a worktree has an active mutating operation of kind `down` or `service-stop`
- **THEN** the daemon SHALL classify the deployment status as `stopping`

#### Scenario: Deployment is checking readiness
- **WHEN** managed services are being checked for app-port readiness
- **THEN** the daemon SHALL classify the deployment status as `checking`

#### Scenario: Deployment is fully running
- **WHEN** the Docker state cache reports all deployed managed services for an initialized session as running
- **AND** all required app-port healthchecks are healthy or disabled
- **THEN** the daemon SHALL classify the deployment status as `running`

#### Scenario: Selective deployment is fully running
- **WHEN** a generated-compose deployment contains only a selected subset of configured app services
- **AND** the Docker state cache reports all deployed managed services as running
- **AND** all required app-port healthchecks for deployed app services are healthy or disabled
- **AND** an unselected configured app service is absent from the deployed Docker service snapshot
- **THEN** the daemon SHALL classify the deployment status as `running`

#### Scenario: Deployment is partially running
- **WHEN** at least one managed service is running
- **AND** at least one managed service or required healthcheck is not fully available
- **THEN** the daemon SHALL classify the deployment status as `running_partial`

#### Scenario: Deployment has failed
- **WHEN** the latest relevant operation failed or the Docker state cache reports a managed service in a failure-like state
- **THEN** the daemon SHALL classify the deployment status as `failed`

#### Scenario: Deployment is stopped
- **WHEN** initialized deployment state exists
- **AND** the Docker state cache reports no managed services running
- **AND** no managed services are in a failure-like state
- **THEN** the daemon SHALL classify the deployment status as `stopped`

#### Scenario: No current managed service containers
- **WHEN** an initialized session has no current managed service containers in the Docker state cache
- **THEN** the daemon SHALL classify the deployment as `stopped` unless a relevant operation state implies another status

#### Scenario: Deployment status cannot be determined
- **WHEN** the daemon cannot collect enough current service state to classify an initialized deployment
- **THEN** it SHALL classify the deployment status as `unknown`
- **AND** it SHALL preserve available identity and state information in snapshot responses

### Requirement: Service Summary Counts
The daemon SHALL compute aggregate service summary counts for initialized deployments from managed Docker service containers, excluding internal init services.

#### Scenario: Service summary is computed
- **WHEN** the daemon computes managed service counts for an initialized session
- **THEN** it SHALL include `total`, `running`, `stopped`, `failed`, and `checking` service counts in the summary
- **AND** it SHALL count services from the Docker state cache for that session
- **AND** `running` SHALL count managed services whose Docker state is running
- **AND** `total` SHALL include current managed service containers even when stopped or exited

#### Scenario: Service summary is unavailable
- **WHEN** current managed service state cannot be collected for an initialized deployment
- **THEN** the daemon SHALL still return deployment identity information
- **AND** it SHALL either omit the service summary or return a summary that clearly represents unknown current counts

### Requirement: Unified Events Preserve Existing Operation Streams
The daemon SHALL preserve the existing operation event stream contract while unified events are introduced.

#### Scenario: Existing operation stream subscriber
- **WHEN** a client subscribes to `/v1/operations/:operationId/events`
- **THEN** the daemon SHALL return the existing newline-delimited operation envelope stream
- **AND** the stream SHALL include the same event payloads and terminal envelope semantics as before this change

#### Scenario: Unified and operation stream subscribers coexist
- **WHEN** one client subscribes to unified SSE events and another subscribes to a specific operation event stream
- **THEN** both clients SHALL receive their respective event streams without duplicate operation execution
- **AND** disconnecting either client SHALL NOT close the other client's stream

### Requirement: Daemon Compose Mode Service Scope
The daemon SHALL use the unique service names in `compose.expose` port entries as the managed service list for compose-backed sessions.

#### Scenario: Compose mode up discovers exposed services
- **WHEN** a daemon-owned `up` operation for a compose-mode session starts Docker Compose successfully
- **AND** Docker Compose reports services `api` and `db`
- **AND** `compose.expose` contains only port entries for service `api`
- **THEN** the daemon SHALL emit service discovery for `api`
- **AND** the daemon SHALL NOT register `db` as a managed service for service logs or UI service actions

#### Scenario: Compose mode status returns exposed services
- **WHEN** a client requests status for a compose-mode session
- **THEN** the daemon SHALL return service status information only for services named by `compose.expose` port entries
- **AND** the daemon SHALL return no generated app-port healthcheck results for that session

#### Scenario: Compose mode service action rejects unexposed service
- **WHEN** a client requests a service stop or restart action for a compose-mode service not named by `compose.expose` port entries
- **THEN** the daemon SHALL reject the request with an actionable error naming the service

#### Scenario: Compose mode Docker cache ignores unexposed services
- **WHEN** the Docker state cache contains containers from a compose-backed session
- **THEN** daemon session readers SHALL expose only services listed in `compose.expose` as wos-managed services
- **AND** unexposed user Compose services SHALL NOT appear in UI snapshots, service actions, service logs, or managed service counts

### Requirement: Daemon Compose Mode Command Environment
The daemon SHALL pass resolved compose-mode command environment to every Docker Compose command it owns for a compose-backed session.

#### Scenario: Daemon up uses compose command environment
- **WHEN** a daemon-owned `up` operation runs for a compose-mode session with `compose.env_file` and `compose.environment`
- **THEN** the daemon SHALL pass the merged and template-resolved compose command environment to Docker Compose shutdown, startup, status collection, and service log follower commands
- **AND** inline `compose.environment` values SHALL override values loaded from `compose.env_file`

#### Scenario: Daemon service action uses compose command environment
- **WHEN** a daemon-owned service stop or restart action runs for a compose-mode session
- **THEN** the daemon SHALL pass the merged and template-resolved compose command environment to the Docker Compose command

### Requirement: Daemon Compose Mode Managed Ports
The daemon SHALL use compose expose port entries to allocate host ports, generate sanitized compose files and overlays, and own tunnel records for compose-backed sessions.

#### Scenario: Daemon compose up allocates exposed ports
- **WHEN** a daemon-owned `up` operation runs for a compose-mode session
- **AND** `compose.expose` contains `api:3000`
- **THEN** the daemon SHALL allocate a wos-managed host port for `api:3000`
- **AND** the daemon SHALL persist that assignment in the session state when startup succeeds

#### Scenario: Daemon compose up writes sanitized base and overlay
- **WHEN** a daemon-owned `up` operation allocates host port `21432` for `api:3000`
- **THEN** the daemon SHALL write a wos-owned sanitized Compose base file for the resolved session with service port bindings removed
- **AND** the daemon SHALL write a wos-owned Compose overlay for the resolved session
- **AND** Docker Compose startup SHALL use both the sanitized base file and that overlay

#### Scenario: Daemon compose up removes unexposed base port
- **WHEN** a daemon-owned `up` operation runs for a compose-mode session
- **AND** the user-owned Compose file contains service `db` port binding `5432:5432`
- **AND** `compose.expose` does not contain `db:5432`
- **THEN** the daemon SHALL run Docker Compose with an effective Compose file set that does not publish `db:5432`

#### Scenario: Daemon compose up retries port conflict
- **WHEN** Docker Compose startup fails because a wos-assigned compose expose host port is unavailable
- **THEN** the daemon SHALL retry with a replacement host-port assignment using the same retry behavior as `wos up`
- **AND** the daemon SHALL rewrite the overlay before retrying startup

#### Scenario: Daemon compose up registers exposed port tunnel
- **WHEN** global tunneling is enabled
- **AND** a daemon-owned `up` operation runs for a compose-mode session with exposed port `api:3000`
- **AND** the daemon assigns host port `21432`
- **THEN** the daemon SHALL register a local HTTP tunnel route for local port `21432`
- **AND** the daemon SHALL include the tunnel record for `api:3000` in status responses

#### Scenario: Daemon compose tunnel failure is non-fatal
- **WHEN** global tunneling is enabled for a compose-mode session
- **AND** the daemon fails to register a tunnel route for an exposed port
- **THEN** the daemon SHALL record a failed tunnel entry for that exposed port
- **AND** the daemon SHALL NOT fail the `up` operation solely because the tunnel failed

### Requirement: Daemon Compose Expose Template Environment
The daemon SHALL resolve compose expose templates in inline `compose.environment` before running Docker Compose commands for compose-backed sessions.

#### Scenario: Daemon up resolves host port template
- **WHEN** a daemon-owned `up` operation assigns host port `21432` for `api:3000`
- **AND** `compose.environment` contains `API_HOST_PORT: ${expose.api.hostPort[3000]}`
- **THEN** Docker Compose startup, status collection, and service log follower commands SHALL receive `API_HOST_PORT=21432`

#### Scenario: Daemon up resolves hostname template
- **WHEN** a daemon-owned `up` operation registers a local HTTP tunnel route with hostname `feature-login-api.example.com` for `api:3000`
- **AND** `compose.environment` contains `API_HOSTNAME: ${expose.api.hostname[3000]}`
- **THEN** Docker Compose startup, status collection, and service log follower commands SHALL receive `API_HOSTNAME=feature-login-api.example.com`

#### Scenario: Daemon status uses persisted expose assignments
- **WHEN** a client requests status for a compose-mode session with persisted exposed port assignments
- **THEN** the daemon SHALL resolve compose expose environment templates from the persisted assignments before running Docker Compose status

#### Scenario: Daemon rejects unresolved expose template
- **WHEN** a daemon-owned compose-mode operation encounters an expose template that references an unconfigured exposed port
- **THEN** the daemon SHALL fail that operation with an actionable template error before running Docker Compose commands

### Requirement: Local Tunnel HTTP Server
The daemon SHALL own a local tunnel server when global tunneling is enabled. The tunnel server SHALL use HTTP by default and SHALL use HTTPS when effective `tunnel.ssl.enabled` is true.

#### Scenario: Tunnel server binds configured port
- **WHEN** global config enables tunneling with port `80`
- **THEN** the daemon SHALL attempt to start the tunnel server on `0.0.0.0:80`

#### Scenario: Tunnel server uses configured custom port
- **WHEN** global config enables tunneling with port `8080`
- **THEN** the daemon SHALL attempt to start the tunnel server on `0.0.0.0:8080`

#### Scenario: Tunnel server bind failure
- **WHEN** global config enables tunneling
- **AND** the daemon cannot bind the configured tunnel server port
- **THEN** daemon startup SHALL continue
- **AND** tunnel route registration attempts SHALL produce failed tunnel records with an actionable bind failure message

#### Scenario: Tunnel server proxies matching host
- **WHEN** the tunnel server receives a request whose `Host` header matches an active tunnel hostname
- **THEN** the daemon SHALL proxy the request to `127.0.0.1:<hostPort>` for that tunnel route using the route backend protocol
- **AND** it SHALL return the proxied response to the caller

#### Scenario: Tunnel server rejects unknown host
- **WHEN** the tunnel server receives a request whose `Host` header does not match an active tunnel hostname
- **THEN** the daemon SHALL return a not-found response

#### Scenario: Tunnel server is HTTP by default
- **WHEN** the daemon registers an active tunnel route while effective `tunnel.ssl.enabled` is `false`
- **THEN** the route URL SHALL use the `http://` scheme
- **AND** the daemon SHALL NOT perform TLS termination for the tunnel listener

#### Scenario: Tunnel server terminates TLS when SSL enabled
- **WHEN** the daemon registers an active tunnel route while effective `tunnel.ssl.enabled` is `true`
- **THEN** the route URL SHALL use the `https://` scheme
- **AND** the daemon SHALL perform TLS termination for the tunnel listener

#### Scenario: Tunnel SSL uses configured certificate paths
- **WHEN** the daemon starts with global tunneling enabled
- **AND** effective `tunnel.ssl.enabled` is `true`
- **AND** effective `tunnel.ssl.cert` and `tunnel.ssl.key` paths are configured
- **THEN** the daemon SHALL start the tunnel listener with TLS using those certificate files

#### Scenario: Tunnel SSL generates self-signed certificate
- **WHEN** the daemon starts with global tunneling enabled
- **AND** effective `tunnel.ssl.enabled` is `true`
- **AND** no tunnel certificate paths are configured
- **THEN** the daemon SHALL generate or reuse a persistent self-signed tunnel certificate and key under `<wos-home>/certs`
- **AND** the generated certificate SHALL include the effective tunnel domain and wildcard hostname for that domain

### Requirement: Daemon Startup Tunnel Restoration
When global tunneling is enabled and the local tunnel server starts successfully, the daemon SHALL restore active local HTTP tunnel routes for initialized sessions whose running Docker services contain valid wos tunnel restore metadata.

#### Scenario: Daemon restores active tunnel route after restart
- **WHEN** the daemon starts after a previous daemon process registered a tunnel for session `s`, service `api`, container port `3000`, host port `21432`, and hostname `feature-api.example.com`
- **AND** session state for `s` is initialized and contains the deployment id shown in the running Docker service labels
- **AND** Docker reports that service `api` is running and publishes container port `3000` on host port `21432`
- **THEN** the daemon SHALL register a local HTTP tunnel route from `feature-api.example.com` to local host port `21432`
- **AND** the daemon SHALL store an active tunnel record for session `s` with service `api`, container port `3000`, host port `21432`, URL `http://feature-api.example.com`, hostname `feature-api.example.com`, and active state

#### Scenario: Daemon restores multiple ports for one service
- **WHEN** a running service contains valid wos tunnel labels for container ports `4200` and `4210`
- **AND** Docker reports both container ports published on their expected host ports
- **THEN** the daemon SHALL restore one active tunnel record per labeled container port
- **AND** each restored route SHALL use the hostname associated with its container port label

#### Scenario: Daemon skips restoration when tunnel server is unavailable
- **WHEN** global tunneling is enabled but the daemon cannot start the local tunnel server
- **THEN** the daemon SHALL skip tunnel restoration
- **AND** daemon startup SHALL continue without failing solely because tunnel restoration could not run

#### Scenario: Daemon skips stale deployment metadata
- **WHEN** a running Docker service contains wos tunnel labels whose deployment id does not match the current initialized session state
- **THEN** the daemon SHALL NOT restore tunnel routes from that service
- **AND** it SHALL continue scanning other sessions and services

#### Scenario: Daemon skips metadata from another wos home
- **WHEN** a running Docker service contains wos tunnel labels whose wos home hash does not match the daemon's current wos home
- **THEN** the daemon SHALL NOT restore tunnel routes from that service
- **AND** it SHALL continue scanning other sessions and services

#### Scenario: Daemon validates published host port before restoration
- **WHEN** a running Docker service contains a tunnel hostname label for container port `3000`
- **AND** Docker does not report container port `3000` published on the labeled host port
- **THEN** the daemon SHALL NOT restore that tunnel route
- **AND** it SHALL continue scanning other tunnel ports for that service

#### Scenario: Daemon handles hostname conflicts during restoration
- **WHEN** two restore candidates claim the same tunnel hostname for different session/service/port identities
- **THEN** the daemon SHALL restore at most one route for that hostname
- **AND** it SHALL skip the conflicting candidate without failing daemon startup

#### Scenario: Daemon does not restore failed tunnel records
- **WHEN** a previous deployment had a failed tunnel record but no active tunnel hostname labels for that service port
- **THEN** daemon startup SHALL NOT recreate the failed tunnel record
- **AND** status SHALL omit tunnel information for that service port until a later operation records active or failed tunnel state

#### Scenario: Tunnel restoration validates Docker cache state
- **WHEN** daemon startup evaluates a tunnel restore candidate
- **THEN** it SHALL validate that the Docker state cache or Docker API reports the labeled service container as running
- **AND** it SHALL validate that Docker reports the labeled container port published on the labeled host port before restoring the route

### Requirement: Daemon Selective Up Operation
The daemon API SHALL accept generated-compose selective startup options for daemon-owned `up` operations and execute the same behavior as the corresponding CLI invocation.

#### Scenario: Submit up with explicit services
- **WHEN** a daemon client submits an `up` operation with services `app` and `api`
- **AND** the resolved session config uses generated-compose mode
- **THEN** the daemon SHALL start an `up` operation for only those services plus their transitive dependencies
- **AND** it SHALL emit deployment progress, service discovery, service logs, healthchecks, and completion events for the resolved startup selection

#### Scenario: Submit up with target
- **WHEN** a daemon client submits an `up` operation with target `app`
- **AND** `targets.app` is configured in the resolved generated-compose config
- **THEN** the daemon SHALL start an `up` operation for that target plus transitive dependencies

#### Scenario: Submit up without selection
- **WHEN** a daemon client submits an `up` operation without services and without target
- **THEN** the daemon SHALL preserve the existing full-deployment `up` behavior

#### Scenario: Submit up with invalid selection
- **WHEN** a daemon client submits an `up` operation with both services and target, an empty service list, an empty target, an unknown service, an unknown target, or a dependency cycle
- **THEN** the operation SHALL fail with an actionable validation error
- **AND** the daemon SHALL NOT run Docker Compose startup

#### Scenario: Submit selective up for compose mode
- **WHEN** a daemon client submits an `up` operation with services or target
- **AND** the resolved session config uses `mode: compose`
- **THEN** the operation SHALL fail with an actionable error explaining that selective startup is supported only in generated-compose mode
- **AND** the daemon SHALL NOT run Docker Compose startup

### Requirement: Daemon Up Runtime Arguments
The daemon API SHALL accept runtime argument values on daemon-owned `up` operation requests and apply the same validation and generated-compose behavior as the CLI.

#### Scenario: Daemon up accepts runtime arguments
- **WHEN** a daemon-owned `up` operation request includes runtime argument `API_URL=https://empl-stage.test-wa.ru`
- **AND** the resolved generated-compose config declares `API_URL`
- **THEN** the daemon SHALL pass the runtime argument value to the up operation
- **AND** generated Compose environment templates SHALL resolve using that value

#### Scenario: Daemon up rejects undeclared runtime arguments
- **WHEN** a daemon-owned `up` operation request includes runtime argument `API_URL`
- **AND** the resolved config does not declare `API_URL`
- **THEN** the daemon SHALL fail the operation with an actionable validation error before Docker Compose startup

#### Scenario: Daemon up preserves runtime arguments with selection
- **WHEN** a daemon-owned `up` operation request includes target `lk-zup`
- **AND** it includes runtime argument `API_URL=https://empl-stage.test-wa.ru`
- **THEN** the daemon SHALL preserve both the startup selection and the runtime argument values when running the deployment

### Requirement: Public Daemon Web Tunnel Route
The daemon SHALL publish the daemon web listener through the daemon-owned tunnel server only when global tunneling and public web access are both enabled.

#### Scenario: daemon registers public web route
- **WHEN** the daemon starts with effective `tunnel.enabled` equal to `true`
- **AND** effective `web.public.enabled` equal to `true`
- **AND** the daemon web listener successfully binds to the effective web port
- **THEN** the daemon SHALL register a tunnel route for the effective public web hostname
- **AND** that route SHALL proxy to the daemon web listener host port
- **AND** that route SHALL NOT appear in per-worktree tunnel snapshots

#### Scenario: public web route is not registered by default
- **WHEN** the daemon starts with default global config
- **THEN** the daemon SHALL NOT register a public daemon web tunnel route
- **AND** the daemon web listener SHALL remain reachable through loopback when it binds successfully

#### Scenario: public web route fails soft
- **WHEN** public web access is enabled
- **AND** the daemon cannot register the public web tunnel route because the tunnel server is unavailable, the web listener is unavailable, or the hostname conflicts
- **THEN** the daemon SHALL continue running
- **AND** the daemon SHALL emit a single-line warning to stderr naming the public web hostname and failure reason
- **AND** local loopback web access SHALL continue when the web listener is bound

#### Scenario: deployment operations do not reset public web route
- **WHEN** the daemon has registered a public daemon web tunnel route
- **AND** a daemon-owned `up` or `down` operation resets session-scoped app tunnel routes
- **THEN** the public daemon web tunnel route SHALL remain registered

### Requirement: Public Daemon Web Auth Boundary
The daemon web listener SHALL require authentication for public-host control-plane requests and SHALL preserve existing unauthenticated loopback behavior.

#### Scenario: public UI API request without session is rejected
- **WHEN** a request reaches the daemon web listener with the public daemon hostname
- **AND** the request targets `/ui/v1/*` other than public auth endpoints
- **AND** the request does not include a valid public auth cookie
- **THEN** the daemon SHALL return `401`
- **AND** it SHALL NOT run the requested UI API handler

#### Scenario: public web shell can load before login
- **WHEN** a request reaches the daemon web listener with the public daemon hostname
- **AND** the request targets the web app shell or static web assets
- **THEN** the daemon SHALL serve the web app shell or asset according to normal web routing
- **AND** protected UI API calls from that page SHALL still require authentication

#### Scenario: local UI API request remains unauthenticated
- **WHEN** a request reaches the daemon web listener through loopback or a non-public host
- **AND** the request targets `/ui/v1/*`
- **THEN** the daemon SHALL preserve the existing UI API behavior without requiring the public auth cookie

#### Scenario: legacy daemon API remains unavailable on public web route
- **WHEN** a request reaches the daemon web listener with the public daemon hostname
- **AND** the request targets a legacy `/v1/*` daemon API route
- **THEN** the daemon SHALL NOT expose the Unix-socket daemon API through the public web route

### Requirement: Public Main-Port Dashboard Exposure
The daemon SHALL expose the public dashboard on the effective daemon web port when public web access is enabled, while preserving the existing tunnel route and local-only default behavior.

#### Scenario: Public web enables direct main-port dashboard access
- **WHEN** the daemon starts with effective `web.public.enabled` equal to `true`
- **AND** the daemon web listener successfully binds to the effective `web.port`
- **THEN** the daemon SHALL accept dashboard web requests on the effective `web.port` from non-loopback clients
- **AND** the daemon SHALL serve the same web app shell and static assets as the local dashboard listener

#### Scenario: Public web keeps tunnel route
- **WHEN** the daemon starts with effective `tunnel.enabled` equal to `true`
- **AND** effective `web.public.enabled` equal to `true`
- **AND** the daemon web listener successfully binds to the effective `web.port`
- **THEN** the daemon SHALL still register the public daemon web tunnel route for the effective public web hostname
- **AND** direct main-port exposure SHALL NOT add the public daemon web route to per-worktree tunnel snapshots

#### Scenario: Default web listener remains local-only
- **WHEN** the daemon starts with effective `web.public.enabled` equal to `false`
- **THEN** the daemon SHALL NOT expose the daemon web listener on a public network interface
- **AND** the daemon web listener SHALL remain reachable through loopback when it binds successfully

#### Scenario: Public main-port exposure fails soft
- **WHEN** public web access is enabled
- **AND** the daemon cannot expose the dashboard on the effective `web.port`
- **THEN** the daemon SHALL continue running with the Unix domain socket API intact
- **AND** the daemon SHALL emit a single-line warning to stderr naming the effective `web.port` and failure reason
- **AND** local loopback web access SHALL continue when the daemon can still bind a loopback web listener

#### Scenario: Legacy daemon API remains unavailable on main port
- **WHEN** a request reaches the daemon web listener on the effective `web.port`
- **AND** the request targets a legacy `/v1/*` daemon API route
- **THEN** the daemon SHALL NOT expose the Unix-socket daemon API through the web listener

### Requirement: Daemon Web HTTPS Listener
The daemon SHALL serve the Web UI and daemon management listener over HTTPS when effective `web.ssl.enabled` is true.

#### Scenario: Web SSL uses configured certificate paths
- **WHEN** the daemon starts with effective `web.ssl.enabled` equal to `true`
- **AND** effective `web.ssl.cert` and `web.ssl.key` paths are configured
- **THEN** the daemon SHALL start the listener with TLS using those certificate files
- **AND** the daemon metadata `webUrl` SHALL use the `https://` scheme

#### Scenario: Web SSL generates self-signed certificate
- **WHEN** the daemon starts with effective `web.ssl.enabled` equal to `true`
- **AND** no Web UI certificate paths are configured
- **THEN** the daemon SHALL generate or reuse a persistent self-signed Web UI certificate and key under `<wos-home>/certs`
- **AND** it SHALL start the listener with TLS using that generated certificate and key
- **AND** the generated certificate SHALL include loopback hostnames and the configured daemon web host when applicable

#### Scenario: Web SSL certificate resolution fails
- **WHEN** the daemon starts with effective `web.ssl.enabled` equal to `true`
- **AND** the Web UI certificate/key cannot be read or generated
- **THEN** daemon startup SHALL fail with a clear diagnostic naming the Web UI SSL failure
- **AND** the daemon SHALL NOT report healthy metadata for that failed startup

#### Scenario: Web SSL disabled preserves HTTP
- **WHEN** the daemon starts with effective `web.ssl.enabled` equal to `false`
- **THEN** the daemon SHALL start the listener over HTTP
- **AND** the daemon metadata `webUrl` SHALL use the `http://` scheme

### Requirement: Tunnel Route URL Scheme
The daemon SHALL build active tunnel URLs from the effective tunnel listener scheme.

#### Scenario: HTTP tunnel route uses HTTP URL
- **WHEN** global tunneling is enabled
- **AND** effective `tunnel.ssl.enabled` is `false`
- **AND** the daemon registers an active app tunnel route for hostname `feature-api.example.com`
- **THEN** the tunnel record URL SHALL be `http://feature-api.example.com`

#### Scenario: HTTPS tunnel route uses HTTPS URL
- **WHEN** global tunneling is enabled
- **AND** effective `tunnel.ssl.enabled` is `true`
- **AND** the daemon registers an active app tunnel route for hostname `feature-api.example.com`
- **THEN** the tunnel record URL SHALL be `https://feature-api.example.com`

#### Scenario: Restored tunnel keeps effective scheme
- **WHEN** daemon startup restores an active tunnel route
- **THEN** the restored tunnel record URL SHALL use the current effective tunnel listener scheme
- **AND** the restored route SHALL NOT preserve a stale scheme from a previous daemon process

### Requirement: Tunnel Route Backend Protocol
The daemon-owned tunnel server SHALL route each hostname to a local backend using the backend protocol registered for that route.

#### Scenario: App service route proxies to HTTP backend
- **WHEN** a daemon-owned `up` operation registers an app service tunnel route
- **THEN** the route backend protocol SHALL be `http`
- **AND** the tunnel server SHALL proxy matching HTTP requests to `http://127.0.0.1:<hostPort>`

#### Scenario: Public web route proxies to HTTPS backend
- **WHEN** public web access is enabled
- **AND** the Web UI listener is using HTTPS
- **AND** the daemon registers the public daemon web tunnel route
- **THEN** the public web route backend protocol SHALL be `https`
- **AND** the tunnel server SHALL proxy matching requests to `https://127.0.0.1:<webPort>`

#### Scenario: Public web route proxies to HTTP backend
- **WHEN** public web access is enabled
- **AND** the Web UI listener is using HTTP
- **AND** the daemon registers the public daemon web tunnel route
- **THEN** the public web route backend protocol SHALL be `http`
- **AND** the tunnel server SHALL proxy matching requests to `http://127.0.0.1:<webPort>`

#### Scenario: Tunnel forwards external protocol
- **WHEN** the tunnel server proxies a matching request
- **THEN** it SHALL set `X-Forwarded-Host` to the original tunnel hostname
- **AND** it SHALL set `X-Forwarded-Proto` to `https` when the tunnel listener uses HTTPS
- **AND** it SHALL set `X-Forwarded-Proto` to `http` when the tunnel listener uses HTTP

### Requirement: Public Auth Secure Cookie On HTTPS
The daemon SHALL mark public authentication cookies secure when the public request is effectively HTTPS.

#### Scenario: HTTPS public login sets Secure cookie
- **WHEN** a public auth login request reaches the daemon through an HTTPS Web UI listener or an HTTPS tunnel listener
- **AND** the submitted secret is valid
- **THEN** the daemon SHALL return a public auth cookie with the `Secure` attribute

#### Scenario: HTTP public login keeps non-secure cookie
- **WHEN** a public auth login request reaches the daemon through an HTTP Web UI listener or an HTTP tunnel listener
- **AND** the submitted secret is valid
- **THEN** the daemon SHALL preserve the existing public auth cookie behavior without requiring the `Secure` attribute

### Requirement: Cloudflare DNS Challenge Resolution
The daemon SHALL resolve Let's Encrypt DNS-01 challenges through Cloudflare when a listener uses a Cloudflare challenge provider.

#### Scenario: Cloudflare create challenge publishes TXT record
- **WHEN** the daemon starts certificate issuance or renewal for a listener whose effective SSL config uses `source: "letsencrypt"`
- **AND** the challenge provider is `cloudflare`
- **THEN** the daemon SHALL create the required `_acme-challenge` TXT record through the Cloudflare DNS Records API
- **AND** the record content SHALL equal the ACME DNS-01 challenge value

#### Scenario: Cloudflare challenge uses token from environment
- **WHEN** a Cloudflare challenge config contains `apiTokenEnv`
- **AND** the named environment variable contains a non-empty value
- **THEN** the daemon SHALL authenticate Cloudflare API requests with that value as a bearer token

#### Scenario: Cloudflare challenge uses direct token
- **WHEN** a Cloudflare challenge config omits `apiTokenEnv`
- **AND** it contains `apiToken`
- **THEN** the daemon SHALL authenticate Cloudflare API requests with the configured token as a bearer token

#### Scenario: Cloudflare token is unavailable
- **WHEN** a Cloudflare challenge config contains `apiTokenEnv`
- **AND** the named environment variable is missing or empty
- **THEN** certificate issuance or renewal SHALL fail soft
- **AND** the daemon SHALL record certificate failure status naming the missing token environment variable

#### Scenario: Cloudflare explicit zone id is used
- **WHEN** a Cloudflare challenge config contains `zoneId`
- **THEN** the daemon SHALL use that zone id for Cloudflare DNS record create, list, and delete requests
- **AND** it SHALL NOT require Cloudflare zone discovery before publishing the challenge record

#### Scenario: Cloudflare zone id is discovered
- **WHEN** a Cloudflare challenge config omits `zoneId`
- **THEN** the daemon SHALL discover the Cloudflare zone id for the challenge record name before creating the TXT record
- **AND** discovery failure SHALL fail certificate issuance or renewal softly with an actionable certificate failure status

#### Scenario: Cloudflare propagation wait is honored
- **WHEN** a Cloudflare challenge config includes `propagationSeconds`
- **AND** the TXT record create request succeeds
- **THEN** the daemon SHALL wait at least that many seconds before asking the ACME server to validate the challenge

#### Scenario: Cloudflare delete challenge removes TXT record
- **WHEN** the daemon has attempted a Cloudflare DNS-01 challenge
- **THEN** it SHALL attempt to remove the matching Cloudflare TXT record after validation succeeds or fails
- **AND** delete failure SHALL NOT invalidate an already issued certificate

#### Scenario: Cloudflare API failure is recorded
- **WHEN** a Cloudflare API request required for DNS challenge creation fails
- **THEN** certificate issuance or renewal SHALL fail soft
- **AND** the daemon SHALL record certificate failure status including the listener kind, Cloudflare phase, and provider error message

#### Scenario: Hook challenge remains supported
- **WHEN** a listener uses `source: "letsencrypt"` with `challenge.provider: "hook"`
- **THEN** the daemon SHALL continue to execute the configured DNS hook commands for that listener

### Requirement: Let's Encrypt Certificate Resolution
The daemon SHALL resolve Let's Encrypt-managed TLS material when a Web UI or tunnel SSL config uses the Let's Encrypt certificate source.

#### Scenario: Tunnel listener obtains wildcard certificate
- **WHEN** the daemon starts with global tunneling enabled
- **AND** effective `tunnel.ssl.enabled` is `true`
- **AND** effective `tunnel.ssl.source` is `letsencrypt`
- **AND** no valid stored tunnel Let's Encrypt certificate exists
- **THEN** the daemon SHALL request a certificate covering `tunnel.domain` and `*.${tunnel.domain}`
- **AND** it SHALL use DNS-01 validation for the requested names
- **AND** it SHALL start the tunnel listener with the issued certificate when issuance succeeds

#### Scenario: Web listener obtains public hostname certificate
- **WHEN** the daemon starts with effective `web.ssl.enabled` equal to `true`
- **AND** effective `web.ssl.source` is `letsencrypt`
- **AND** no valid stored Web UI Let's Encrypt certificate exists
- **THEN** the daemon SHALL request a certificate covering the effective public Web UI hostname
- **AND** it SHALL use DNS-01 validation for the requested hostname
- **AND** it SHALL start the Web UI listener with the issued certificate when issuance succeeds

#### Scenario: Existing valid certificate is reused
- **WHEN** a listener uses `source: "letsencrypt"`
- **AND** a stored certificate exists for the required hostnames
- **AND** the stored certificate is not inside the configured renewal window
- **THEN** the daemon SHALL start the listener using the stored certificate without creating a new ACME order

#### Scenario: Stored certificate does not cover required names
- **WHEN** a listener uses `source: "letsencrypt"`
- **AND** a stored certificate exists
- **AND** the stored certificate does not cover all required hostnames for that listener
- **THEN** the daemon SHALL request a replacement certificate before starting that listener

#### Scenario: First issuance failure fails soft
- **WHEN** a listener uses `source: "letsencrypt"`
- **AND** no valid stored certificate exists
- **AND** ACME issuance fails
- **THEN** daemon startup SHALL continue
- **AND** the affected HTTPS listener SHALL follow the existing SSL resolution failure behavior
- **AND** the daemon SHALL record certificate failure status for that listener

### Requirement: DNS-01 Hook Challenge Execution
The daemon SHALL execute configured DNS-01 hook commands while completing Let's Encrypt challenges.

#### Scenario: DNS create hook receives challenge environment
- **WHEN** the daemon starts a DNS-01 challenge for a Let's Encrypt order
- **THEN** it SHALL execute the configured create hook command
- **AND** it SHALL pass the challenge record name, record value, base domain, listener kind, and certificate names through environment variables

#### Scenario: DNS propagation wait is honored
- **WHEN** a DNS-01 hook challenge config includes `propagationSeconds`
- **AND** the create hook command succeeds
- **THEN** the daemon SHALL wait at least that many seconds before asking the ACME server to validate the challenge

#### Scenario: DNS delete hook runs after challenge attempt
- **WHEN** the daemon has executed a DNS create hook for a challenge
- **THEN** it SHALL attempt to execute the configured delete hook after validation succeeds or fails
- **AND** delete hook failure SHALL NOT invalidate an already issued certificate

#### Scenario: DNS create hook failure aborts issuance
- **WHEN** the configured DNS create hook exits unsuccessfully
- **THEN** the daemon SHALL abort the certificate order
- **AND** it SHALL record certificate failure status including the listener kind and hook phase

### Requirement: Let's Encrypt Renewal Scheduler
The daemon SHALL renew Let's Encrypt-managed certificates before expiration.

#### Scenario: Scheduler starts for ACME-managed listeners
- **WHEN** the daemon starts with Web UI or tunnel SSL using `source: "letsencrypt"`
- **THEN** it SHALL start a background renewal scheduler for each ACME-managed listener kind

#### Scenario: Renewal window triggers order
- **WHEN** an ACME-managed certificate has 30 days or fewer before expiration
- **THEN** the daemon SHALL attempt renewal for that listener kind
- **AND** it SHALL acquire a listener-kind renewal lock before creating an ACME order

#### Scenario: Renewal outside window does not create order
- **WHEN** an ACME-managed certificate has more than 30 days before expiration
- **THEN** the daemon SHALL NOT create a renewal order for that scheduler tick

#### Scenario: Concurrent renewal is skipped
- **WHEN** a renewal lock already exists for the same listener kind
- **THEN** the daemon SHALL skip that renewal attempt
- **AND** it SHALL preserve the currently active certificate

#### Scenario: Renewal failure preserves active certificate
- **WHEN** a renewal attempt fails
- **AND** the currently active certificate is still present on disk
- **THEN** the daemon SHALL keep serving with the active certificate
- **AND** it SHALL record the renewal failure status for that listener kind

### Requirement: ACME Certificate Storage
The daemon SHALL store ACME account data, certificate material, and renewal metadata under `<wos-home>/certs/acme`.

#### Scenario: Issued certificate is written atomically
- **WHEN** a Let's Encrypt order succeeds
- **THEN** the daemon SHALL write the new certificate, key, and metadata to temporary files
- **AND** it SHALL validate that the certificate covers the required hostnames
- **AND** it SHALL atomically replace the active files only after validation succeeds

#### Scenario: Invalid issued material is not activated
- **WHEN** a Let's Encrypt order returns certificate material that cannot be parsed or does not cover required hostnames
- **THEN** the daemon SHALL NOT replace the active certificate files
- **AND** it SHALL record certificate failure status for that listener kind

#### Scenario: ACME account is reused
- **WHEN** the daemon has an existing ACME account for the configured directory and email
- **THEN** it SHALL reuse that account for subsequent issuance and renewal attempts

### Requirement: Certificate Listener Rotation
The daemon SHALL activate renewed Let's Encrypt certificates without restarting the daemon process.

#### Scenario: Web listener rotates after renewal
- **WHEN** a Web UI Let's Encrypt certificate renewal succeeds
- **THEN** the daemon SHALL restart the Web UI listener on the same configured host and port using the renewed certificate
- **AND** the daemon Unix socket API SHALL remain running during the rotation

#### Scenario: Tunnel listener rotates after renewal
- **WHEN** a tunnel Let's Encrypt certificate renewal succeeds
- **THEN** the daemon SHALL replace the tunnel listener with a listener using the renewed certificate
- **AND** it SHALL replay active app tunnel routes and daemon-scoped routes onto the replacement listener
- **AND** the daemon Unix socket API SHALL remain running during the rotation

#### Scenario: Rotation failure keeps previous listener when possible
- **WHEN** certificate renewal succeeds
- **AND** listener rotation fails before the previous listener is stopped
- **THEN** the daemon SHALL keep the previous listener active
- **AND** it SHALL record certificate activation failure status

#### Scenario: Rotation may interrupt long-lived clients
- **WHEN** listener rotation requires stopping the old listener before binding the replacement listener
- **THEN** the daemon SHALL preserve route state for replay
- **AND** WebSocket or SSE clients SHALL be allowed to reconnect after the listener is available again

### Requirement: Tunnel Route Replay After Listener Replacement
The daemon SHALL retain canonical tunnel route state outside the tunnel listener implementation so routes can be replayed after listener replacement.

#### Scenario: Active app routes are replayed
- **WHEN** the daemon replaces the tunnel listener during certificate activation
- **AND** an active app tunnel route existed before replacement
- **THEN** the daemon SHALL register the same hostname, host port, and backend protocol on the replacement listener
- **AND** the active tunnel snapshot URL SHALL remain stable except for the effective listener scheme and port formatting rules

#### Scenario: Public Web route is replayed
- **WHEN** the daemon replaces the tunnel listener during certificate activation
- **AND** a daemon-scoped public Web UI tunnel route existed before replacement
- **THEN** the daemon SHALL register the same public Web UI hostname, host port, and backend protocol on the replacement listener
- **AND** the route SHALL NOT appear in per-worktree tunnel snapshots

#### Scenario: Replay failure records route failure
- **WHEN** the daemon cannot replay an app tunnel route onto the replacement listener
- **THEN** the daemon SHALL record a failed tunnel snapshot for that route
- **AND** it SHALL emit the normal tunnel failure event for that route

### Requirement: Local Web UI Listener Is Loopback HTTP Only
The daemon SHALL serve the management Web UI and UI API over an HTTP listener that binds a loopback address by default, and SHALL bind the configured `web.host` address only when the operator explicitly sets it. Enabling public Web UI access SHALL NOT by itself widen the bind beyond loopback.

#### Scenario: daemon starts web listener
- **WHEN** the daemon starts with Web UI serving enabled
- **AND** the global config does not set `web.host`
- **THEN** it SHALL bind the Web UI listener to a loopback address
- **AND** it SHALL serve the listener over HTTP
- **AND** it SHALL NOT bind the Web UI listener to `0.0.0.0` because public Web UI access is enabled

#### Scenario: daemon binds configured web host
- **WHEN** the daemon starts with Web UI serving enabled
- **AND** the global config sets `web.host` to a non-loopback address
- **THEN** it SHALL bind the Web UI listener to that address over HTTP
- **AND** the wider bind SHALL be the result of explicit operator configuration, not of enabling public Web UI access

#### Scenario: web ssl does not change local listener scheme
- **WHEN** config contains `web.ssl.enabled` equal to `true`
- **THEN** the daemon Web UI listener SHALL still use HTTP on the configured bind address
- **AND** HTTPS for remote access SHALL be provided only by the tunnel listener when `tunnel.ssl` is enabled

### Requirement: Tunnel Web UI Route Publication
The daemon SHALL publish the management Web UI through a daemon-scoped tunnel route only when `tunnel.webUi.enabled` is true.

#### Scenario: tunnel web ui route registered
- **WHEN** the effective config has `tunnel.enabled` equal to `true`
- **AND** `tunnel.webUi.enabled` equal to `true`
- **AND** the Web UI listener is available
- **THEN** the daemon SHALL register a daemon-scoped tunnel route for the effective `tunnel.webUi` hostname
- **AND** the route SHALL proxy to the local Web UI listener port

#### Scenario: tunnel web ui disabled
- **WHEN** `tunnel.webUi.enabled` is false or omitted
- **THEN** the daemon SHALL NOT register a public Web UI tunnel route

#### Scenario: tunnel server unavailable
- **WHEN** `tunnel.webUi.enabled` is true
- **AND** the tunnel listener is unavailable
- **THEN** the daemon SHALL continue running
- **AND** it SHALL emit a warning explaining that the public Web UI tunnel route was not registered

### Requirement: Service Tunnel Publication Gate
The daemon SHALL publish service tunnel routes only when service tunnel publication is enabled for the tunnel listener.

#### Scenario: tunnel listener enabled but service tunnels disabled
- **WHEN** `tunnel.enabled` is true
- **AND** `tunnel.serviceTunnels.enabled` is false or omitted
- **AND** a deployment starts service `api` on host port `20042`
- **THEN** the daemon SHALL NOT register a service tunnel route for `api`
- **AND** the deployment SHALL continue using local host port publication

#### Scenario: service tunnels enabled
- **WHEN** `tunnel.enabled` is true
- **AND** `tunnel.serviceTunnels.enabled` is true
- **AND** a deployment starts service `api` on host port `20042`
- **THEN** the daemon SHALL register a service tunnel route for `api`
- **AND** the route SHALL point to local host port `20042`

#### Scenario: service tunnel restoration disabled
- **WHEN** the daemon starts with `tunnel.serviceTunnels.enabled` false
- **AND** persisted deployment metadata contains previous service tunnel routes
- **THEN** the daemon SHALL NOT restore those service tunnel routes
- **AND** it SHALL NOT emit active tunnel events for skipped service routes

### Requirement: Tunnel Route IP Whitelist Enforcement
The tunnel listener SHALL enforce route-specific IP whitelists before proxying requests upstream.

#### Scenario: web ui whitelist allows client
- **WHEN** a request targets the public Web UI tunnel hostname
- **AND** `tunnel.webUi.whitelistIps` contains the request client IP
- **THEN** the tunnel listener SHALL proxy the request to the local Web UI listener

#### Scenario: web ui whitelist rejects client
- **WHEN** a request targets the public Web UI tunnel hostname
- **AND** `tunnel.webUi.whitelistIps` is non-empty
- **AND** it does not contain the request client IP
- **THEN** the tunnel listener SHALL return `403`
- **AND** it SHALL NOT proxy the request to the local Web UI listener

#### Scenario: service whitelist rejects client
- **WHEN** a request targets a service tunnel hostname
- **AND** `tunnel.serviceTunnels.whitelistIps` is non-empty
- **AND** it does not contain the request client IP
- **THEN** the tunnel listener SHALL return `403`
- **AND** it SHALL NOT proxy the request to the service host port

#### Scenario: empty whitelist allows all
- **WHEN** a request targets a tunnel route whose whitelist is empty
- **THEN** the tunnel listener SHALL allow the request to proceed to normal route proxying

### Requirement: Tunnel Route Replay Preserves Route Policy
The daemon SHALL preserve tunnel route type and whitelist policy when replaying routes onto a replacement tunnel listener.

#### Scenario: public web route replay preserves whitelist
- **WHEN** the daemon replaces the tunnel listener during certificate activation
- **AND** a daemon-scoped public Web UI route existed before replacement
- **THEN** the daemon SHALL replay the route with the same effective Web UI whitelist policy

#### Scenario: service route replay preserves whitelist
- **WHEN** the daemon replaces the tunnel listener during certificate activation
- **AND** an active service tunnel route existed before replacement
- **THEN** the daemon SHALL replay the route with the same effective service tunnel whitelist policy

### Requirement: Daemon Startup Restoration
The daemon SHALL restore initialized session monitoring and tunnel state during startup without requiring users to run `wos up` again.

#### Scenario: Docker state cache starts during daemon startup
- **WHEN** the daemon starts
- **THEN** it SHALL start the Docker state cache and perform initial Docker container synchronization for current-home wos-managed containers
- **AND** restored monitors and UI snapshots SHALL be able to read synchronized Docker state

### Requirement: HTTP Daemon Metadata
The daemon SHALL write HTTP-oriented metadata under `<wos-home>/daemon.json` after the management listener is bound.

#### Scenario: Metadata is written for HTTP listener
- **WHEN** the daemon starts successfully
- **THEN** the daemon metadata SHALL include `pid`, `startedAt`, `protocol`, `daemonId`, `webUrl`, `webHost`, `webPort`, and `webScheme`
- **AND** `webUrl` SHALL be the client-facing URL used by local CLI clients

#### Scenario: Wildcard bind reports local web URL
- **WHEN** the daemon binds the listener to `0.0.0.0`
- **THEN** daemon metadata SHALL preserve `webHost` as `0.0.0.0`
- **AND** daemon metadata `webUrl` SHALL use a same-host client address such as `127.0.0.1`

#### Scenario: WOS_HOME is overridden
- **WHEN** `WOS_HOME` is set before daemon startup
- **THEN** daemon metadata SHALL be written under the overridden `<wos-home>`
- **AND** daemon HTTP discovery SHALL use that metadata location

### Requirement: Live Application of Reloadable Settings
The daemon SHALL apply selected global settings to live operations without restarting the daemon process, so that a saved change takes effect on the next relevant operation. This SHALL cover the `healthcheck` defaults and the service-tunnel IP whitelist (`tunnel.serviceTunnels.whitelistIps`). Applying these settings live SHALL NOT rebind the Web UI or tunnel listener sockets and SHALL NOT interrupt active sessions, deployments, or tunnels.

#### Scenario: Updated healthcheck defaults apply to the next up operation
- **WHEN** the global `healthcheck` defaults are changed and persisted while the daemon is running
- **AND** a subsequent `up`/deploy operation evaluates app-port healthchecks
- **THEN** the daemon SHALL resolve healthcheck timing from the updated defaults without a daemon restart

#### Scenario: In-flight operations keep their resolved healthcheck timing
- **WHEN** the global `healthcheck` defaults are changed while an `up`/deploy operation is already evaluating healthchecks
- **THEN** the daemon SHALL NOT retroactively alter the timing already resolved for that in-flight operation

#### Scenario: Updated service-tunnel whitelist applies to newly opened tunnels
- **WHEN** `tunnel.serviceTunnels.whitelistIps` is changed and persisted while the daemon is running
- **AND** a service tunnel is subsequently opened or restored
- **THEN** the daemon SHALL apply the updated whitelist to that tunnel's route policy without a daemon restart

#### Scenario: Existing service tunnels retain their prior whitelist
- **WHEN** `tunnel.serviceTunnels.whitelistIps` is changed while service tunnels are already active
- **THEN** the daemon SHALL leave already-active tunnel routes on the policy they were registered with
- **AND** the updated whitelist SHALL apply only to routes opened or restored after the change

