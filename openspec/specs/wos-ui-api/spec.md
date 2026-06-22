# wos-ui-api Specification

## Purpose
TBD - created by archiving change develop-web-main-functionality. Update Purpose after archive.
## Requirements
### Requirement: Unified UI API Contract
The system SHALL provide one daemon-owned UI API contract for web clients to inspect projects, worktrees, deployment status, operation state, logs, and diffs.

#### Scenario: Web client requests UI data
- **WHEN** the browser web app requests UI data through the daemon web listener
- **THEN** the daemon SHALL serve the request through the unified UI API contract
- **AND** the response SHALL use the web UI API schema

#### Scenario: Non-browser client requests UI data
- **WHEN** a non-browser local client requests project, worktree, status, operation, log, or diff data through the UI API
- **THEN** it SHALL use the unified UI API contract
- **AND** it SHALL NOT build its UI model by directly calling the legacy low-level `/v1/status`, `/v1/session/resolve`, or `/v1/operations/*` endpoints

### Requirement: Project List Endpoint
The UI API SHALL expose a project list response containing every registered project and each project's discovered worktree summaries.

#### Scenario: Projects are listed
- **WHEN** a UI client requests the project list
- **THEN** the response SHALL include all registered projects sorted in a stable order
- **AND** each project SHALL include id, display name, primary/source worktree path, stale/error state when applicable, and worktree summaries when discovery succeeds

#### Scenario: Worktree summary includes deployment status
- **WHEN** a project worktree has no initialized wos state
- **THEN** its worktree summary SHALL include deployment status `not_started`
- **AND** it SHALL include a service summary with `running` equal to `0` and `total` equal to `0`

#### Scenario: Worktree has active up operation
- **WHEN** a project worktree has an active daemon-owned `up` operation
- **THEN** its worktree summary SHALL include deployment status `pending` or `checking` according to the current deployment phase
- **AND** it SHALL identify the active operation

#### Scenario: Worktree is partially running
- **WHEN** a project worktree has initialized state and only part of its managed services are running
- **THEN** its worktree summary SHALL include deployment status `running_partial`
- **AND** its service summary SHALL include the current `running` and `total` counts when available

### Requirement: Project Add Endpoint
The UI API SHALL expose an endpoint that adds a project from a user-submitted path.

#### Scenario: Project add succeeds
- **WHEN** a UI client submits a valid Git worktree path
- **THEN** the daemon SHALL resolve and register the primary/source worktree
- **AND** it SHALL return the registered project record

#### Scenario: Project add fails validation
- **WHEN** a UI client submits a path that cannot be resolved as a Git worktree
- **THEN** the daemon SHALL return a validation error that can be displayed by UI clients
- **AND** it SHALL NOT mutate the project registry

### Requirement: Worktree Detail Endpoint
The UI API SHALL expose a worktree detail response for a selected project worktree.

#### Scenario: Worktree has initialized deployment state
- **WHEN** a UI client requests detail for an initialized worktree
- **THEN** the response SHALL include worktree identity, project identity, session identity, deployment status, service summary, service rows, app-port healthcheck results, local HTTP tunnel information, active operation metadata when present, and latest operation context when present

#### Scenario: Selective generated detail scopes healthchecks
- **WHEN** a UI client requests detail for an initialized generated-compose worktree whose current deployed service snapshot contains only a selected subset of configured app services
- **THEN** the response SHALL include app-port healthcheck results only for configured app services present in that deployed service snapshot
- **AND** the response SHALL NOT include app-port healthcheck results for configured app services absent from that deployed service snapshot

#### Scenario: Worktree has not been started
- **WHEN** a UI client requests detail for a worktree without initialized wos state
- **THEN** the response SHALL include deployment status `not_started`
- **AND** it SHALL include a service summary with `running` equal to `0` and `total` equal to `0`
- **AND** it SHALL include enough identity information for the client to present a launch action
- **AND** it SHALL include latest operation or failure context when present, such as a previous failed `up` attempt before initialization

#### Scenario: Worktree status is unknown
- **WHEN** a UI client requests detail for an initialized worktree whose current service state cannot be collected
- **THEN** the response SHALL include deployment status `unknown`
- **AND** it SHALL preserve worktree identity, project identity, session identity, persisted state, any latest operation context, and any status error message

### Requirement: Worktree Operation Submission
The UI API SHALL allow UI clients to start `up` for a selected worktree and observe the resulting operation using the shared operation stream schema.

#### Scenario: Start uninitialized worktree
- **WHEN** a UI client submits `up` for a worktree whose deployment status is `not_started`
- **THEN** the daemon SHALL start the same deployment behavior as `wos up`
- **AND** it SHALL return an operation id and session name

#### Scenario: Start worktree without tunnels
- **WHEN** a UI client submits `up` for a worktree with tunnel skipping enabled in the request
- **THEN** the daemon SHALL start the same deployment behavior as `wos up --no-tunnel`
- **AND** it SHALL return an operation id and session name

#### Scenario: Session is busy
- **WHEN** a UI client submits `up` for a worktree whose session already has an active mutating operation
- **THEN** the daemon SHALL reject the request with a conflict response that identifies the active operation

### Requirement: Deployment Status Contract
The UI API SHALL expose deployment status values from the shared daemon lifecycle model — derived from daemon-owned operation state, Docker cache state, and healthcheck state — deriving healthcheck availability from app services present in the current deployed Docker service snapshot.

#### Scenario: Status value is returned
- **WHEN** a UI API response includes deployment status
- **THEN** the value SHALL be one of `not_started`, `pending`, `checking`, `running`, `running_partial`, `failed`, `stopped`, `stopping`, or `unknown`

#### Scenario: Fully running deployment is returned
- **WHEN** all managed services are running and required healthchecks are healthy or disabled
- **THEN** the UI API SHALL return deployment status `running`
- **AND** the service summary SHALL report equal `running` and `total` counts

#### Scenario: Selective generated deployment is returned as running
- **WHEN** a UI API detail response is built for a generated-compose deployment that contains only a selected subset of configured app services
- **AND** all deployed managed services are running
- **AND** all returned app-port healthchecks are healthy, disabled, or allowed failures
- **THEN** the UI API SHALL return deployment status `running`
- **AND** unselected configured app services SHALL NOT cause deployment status `running_partial`

#### Scenario: Stopped deployment is returned
- **WHEN** initialized deployment state exists and no managed services are running
- **THEN** the UI API SHALL return deployment status `stopped`
- **AND** the service summary SHALL report `running` equal to `0`

#### Scenario: Stopping deployment is returned
- **WHEN** an initialized worktree has an active mutating operation of kind `down` or `service-stop`
- **THEN** the UI API SHALL return deployment status `stopping`
- **AND** the response SHALL continue to expose active operation metadata identifying the in-flight stop or service-stop operation

### Requirement: Service Summary Contract
The UI API SHALL expose aggregate managed service counts anywhere it exposes worktree deployment status.

#### Scenario: Summary appears in worktree summary
- **WHEN** a UI client requests the project list
- **THEN** each worktree summary SHALL include a service summary when current counts are known
- **AND** the summary SHALL include at least `running` and `total`

#### Scenario: Summary appears in worktree detail
- **WHEN** a UI client requests worktree detail
- **THEN** the response SHALL include a service summary
- **AND** the summary SHALL include at least `running` and `total`

#### Scenario: Worktree detail uses Docker cache
- **WHEN** a UI client requests detail for an initialized worktree
- **THEN** the UI API SHALL build the managed service list and aggregate service counts from the daemon Docker state cache

#### Scenario: Worktree summary uses Docker cache counts
- **WHEN** a UI client requests project or worktree summaries
- **THEN** the UI API SHALL compute deployment summary counts from Docker cache state for initialized sessions

### Requirement: Worktree Logs Endpoint
The UI API SHALL expose init logs from daemon-owned bounded init history and service logs from on-demand Docker log streams for a selected worktree.

#### Scenario: Client opens init logs
- **WHEN** a UI client opens logs for channel `init` on a worktree session that has buffered init output
- **THEN** the daemon SHALL deliver buffered init history before new init log chunks
- **AND** each log chunk SHALL identify session, channel, stream, timestamp, sequence, and chunk text

#### Scenario: Client opens service logs
- **WHEN** a UI client opens logs for channel `service:<service>` on an initialized worktree session
- **THEN** the daemon SHALL resolve the current managed container for that service from the Docker state cache
- **AND** it SHALL start or reuse a request-scoped Docker logs API stream for only that container using follow and tail options
- **AND** the daemon SHALL deliver initial tailed output before newly arriving chunks from that service
- **AND** each log chunk SHALL identify session, channel, service name, stream, timestamp, sequence, and chunk text

#### Scenario: Client switches service log channels
- **WHEN** a UI client switches from `service:api` to `service:web`
- **THEN** the client SHALL close or cancel the previous stream
- **AND** the daemon SHALL release the previous stream subscription
- **AND** the new stream SHALL deliver only `service:web` chunks with its own `--tail 1000` startup behavior

#### Scenario: Client opens quiet channel
- **WHEN** a UI client opens logs for a valid init or service channel that has no buffered, tailed, or live output yet
- **THEN** the daemon SHALL keep the stream open without returning log chunks from other channels

#### Scenario: Client omits log channel
- **WHEN** a UI client opens worktree logs without requesting a specific channel
- **THEN** the daemon SHALL preserve compatibility with the existing service log stream behavior as a request-scoped aggregate stream for the selected session
- **AND** it SHALL NOT mix init output into that compatibility stream
- **AND** all service log followers started for that compatibility stream SHALL stop when the stream has no subscribers

### Requirement: Worktree Diff Endpoint
The UI API SHALL expose staged and unstaged Git diffs for a selected worktree as both raw diff text and structured review data.

#### Scenario: Client requests staged raw diff
- **WHEN** a UI client requests the staged raw diff for a worktree
- **THEN** the daemon SHALL return the output equivalent to `git diff --cached --no-ext-diff --` run from that worktree root

#### Scenario: Client requests unstaged raw diff
- **WHEN** a UI client requests the unstaged raw diff for a worktree
- **THEN** the daemon SHALL return the output equivalent to `git diff --no-ext-diff --` run from that worktree root

#### Scenario: Client requests structured diff summary
- **WHEN** a UI client requests structured diff review data for a worktree
- **THEN** the response SHALL include staged and unstaged diff sets
- **AND** each diff set SHALL include raw patch text when available, aggregate additions, aggregate deletions, and changed file count
- **AND** the response SHALL include total additions, deletions, and changed file count across both staged and unstaged sets

#### Scenario: Structured diff file metadata
- **WHEN** structured diff review data includes a changed file
- **THEN** the file entry SHALL include a stable file id, status, old path when applicable, new path when applicable, additions, deletions, hunks, and enough metadata for clients to render file headers and collapse files

#### Scenario: Structured diff hunk and line metadata
- **WHEN** structured diff review data includes a text hunk
- **THEN** the hunk entry SHALL include a stable hunk id, old start line, old line count, new start line, new line count, and ordered line entries
- **AND** each line entry SHALL include kind, old line number when present, new line number when present, content, and a stable line id within the diff snapshot

#### Scenario: Worktree has no diff
- **WHEN** the requested staged, unstaged, or structured diff data is empty
- **THEN** the daemon SHALL return an empty diff payload with zero additions, zero deletions, and zero changed files
- **AND** the client SHALL be able to distinguish the clean state from an error

#### Scenario: Diff command fails
- **WHEN** Git cannot produce diff data for the selected worktree
- **THEN** the UI API SHALL return a structured API error that preserves the Git failure message

### Requirement: Unified UI Event Stream
The UI API SHALL expose unified daemon events to web clients through the same SSE contract.

#### Scenario: UI client opens event stream
- **WHEN** a UI client opens `GET /ui/v1/events`
- **THEN** the UI API SHALL stream unified event envelopes using SSE
- **AND** every event frame SHALL include a replay id, event type, and JSON data payload

#### Scenario: UI client filters event stream by session
- **WHEN** a UI client opens `GET /ui/v1/events?session=<sessionName>`
- **THEN** the UI API SHALL stream events scoped to that session
- **AND** the UI API SHALL still allow the client to fetch project and worktree snapshots through existing endpoints

#### Scenario: UI client reconnects
- **WHEN** a UI client reconnects with `Last-Event-ID`
- **THEN** the UI API SHALL replay retained events after the last seen id when available
- **AND** the client SHALL be able to refetch snapshots if replay cannot fully recover its state

### Requirement: UI Event Types Mirror Domain Events
The UI API SHALL expose typed event payloads that mirror the daemon unified event taxonomy without requiring browser clients to import node-only packages.

#### Scenario: Browser receives event payload
- **WHEN** the browser UI receives a unified event
- **THEN** the payload SHALL be parseable by browser-local TypeScript types
- **AND** those types SHALL include project, worktree, operation, deployment, compose, service, healthcheck, local HTTP tunnel, and log event variants

#### Scenario: Operation progress event is received
- **WHEN** an operation progress event is streamed through the UI API
- **THEN** the payload SHALL contain enough information for web clients to update deployment steps and logs without reading the legacy operation stream

#### Scenario: Healthcheck status event is received
- **WHEN** a healthcheck status change event is streamed through the UI API
- **THEN** the payload SHALL identify service name, container port, previous state when available, and current healthcheck result

### Requirement: UI Snapshot Reconciliation
The UI API SHALL keep existing snapshot endpoints authoritative and compatible with event-driven clients.

#### Scenario: Event indicates project list changed
- **WHEN** a UI client receives a project or worktree lifecycle event
- **THEN** it SHALL be able to call the existing project list endpoint to retrieve an authoritative project and worktree snapshot

#### Scenario: Event indicates worktree detail changed
- **WHEN** a UI client receives a deployment status, compose, service, healthcheck, tunnel, operation, or log event for a selected session
- **THEN** it SHALL be able to call the existing worktree detail endpoint to retrieve authoritative detail state

#### Scenario: Event history is insufficient
- **WHEN** a UI client cannot replay all missed events after reconnect
- **THEN** the UI API SHALL still provide enough snapshot endpoints for the client to restore current visible state

### Requirement: Worktree Down Operation Submission
The UI API SHALL allow UI clients to stop the selected worktree deployment through a worktree-scoped `down` operation and observe the resulting operation using the shared operation stream schema.

#### Scenario: Stop initialized worktree
- **WHEN** a UI client submits `down` for a worktree whose deployment has initialized state
- **THEN** the daemon SHALL start the same shutdown behavior as `wos down`
- **AND** it SHALL return an operation id, session name, operation kind `down`, and start timestamp

#### Scenario: Stop worktree without initialized deployment
- **WHEN** a UI client submits `down` for a worktree without initialized wos deployment state
- **THEN** the daemon SHALL start a `down` operation that completes successfully with the existing no-deployment behavior
- **AND** it SHALL return an operation id and session name

#### Scenario: Down submission conflict
- **WHEN** a UI client submits `down` for a worktree whose session already has an active mutating operation
- **THEN** the daemon SHALL reject the request with a conflict response that identifies the active operation

### Requirement: Worktree Service Operation Submission
The UI API SHALL allow UI clients to stop and restart individual managed services for a selected worktree through worktree-scoped mutating operations.

#### Scenario: Stop service
- **WHEN** a UI client submits a service stop action with a worktree path and service name
- **AND** the worktree has initialized wos deployment state
- **THEN** the daemon SHALL resolve the current managed container for that service from the Docker state cache
- **AND** it SHALL stop that container through the Docker API
- **AND** it SHALL return an operation id, session name, operation kind `service-stop`, service name, and start timestamp

#### Scenario: Restart service
- **WHEN** a UI client submits a service restart action with a worktree path and service name
- **AND** the worktree has initialized wos deployment state
- **THEN** the daemon SHALL resolve the current managed container for that service from the Docker state cache
- **AND** it SHALL restart that container through the Docker API
- **AND** it SHALL return an operation id, session name, operation kind `service-restart`, service name, and start timestamp

#### Scenario: Service action target is missing
- **WHEN** a service action targets a managed service that has no current container in the Docker state cache
- **THEN** the UI API SHALL reject the action with a structured not-found or invalid-state error

#### Scenario: Service action requires service name
- **WHEN** a UI client submits a service action without a non-empty service name
- **THEN** the daemon SHALL reject the request with a validation error
- **AND** it SHALL NOT start an operation

#### Scenario: Service action rejects internal init service
- **WHEN** a UI client submits a service action for the internal wos init service
- **THEN** the daemon SHALL reject the request with a validation error
- **AND** it SHALL NOT perform a Docker container action for that service

#### Scenario: Service action requires initialized deployment
- **WHEN** a UI client submits a service action for a worktree without initialized wos deployment state
- **THEN** the daemon SHALL reject the request with a validation error
- **AND** it SHALL NOT start an operation

#### Scenario: Service action conflict
- **WHEN** a UI client submits a service action for a worktree whose session already has an active mutating operation
- **THEN** the daemon SHALL reject the request with a conflict response that identifies the active operation

### Requirement: Worktree Service List Includes Stopped Services
The UI API SHALL include managed services that are currently stopped (exited, created, dead) alongside running services in worktree detail responses so UI clients can present and act on them.

#### Scenario: Stopped service appears in worktree detail
- **WHEN** a UI client fetches worktree detail for an initialized deployment that has one running and one stopped managed service
- **THEN** the response services list SHALL include both services with their current Docker-derived states
- **AND** the internal wos init service SHALL still be excluded from the services list

#### Scenario: All services stopped
- **WHEN** a UI client fetches worktree detail for an initialized deployment where every managed service is stopped
- **THEN** the response services list SHALL include those stopped services rather than reporting an empty service list

#### Scenario: Stopped managed service remains visible
- **WHEN** the Docker state cache contains a managed service container whose state is exited, stopped, created, dead, or otherwise non-running
- **THEN** the UI API SHALL include that managed service in the worktree detail response
- **AND** it SHALL include the current Docker-derived state for the service

### Requirement: UI Operation Kinds
The UI API SHALL include whole-deployment and service-level operation kinds in operation metadata and operation submission responses.

#### Scenario: Service operation metadata is returned
- **WHEN** a UI client fetches metadata for a service stop or service restart operation
- **THEN** the response SHALL identify the operation kind as `service-stop` or `service-restart`
- **AND** the response SHALL include the same operation status fields used by other UI operations

#### Scenario: Active service operation appears in worktree snapshots
- **WHEN** a worktree has an active service stop or service restart operation
- **THEN** project list and worktree detail snapshots SHALL include that active operation metadata for the worktree session

### Requirement: Pre-Initialization Active Up Status
The UI API SHALL report an active daemon-owned `up` operation as an in-progress worktree deployment even when the worktree does not yet have initialized wos state.

#### Scenario: Worktree detail reports pending during first launch
- **WHEN** a UI client requests worktree detail for a worktree without initialized wos state
- **AND** that worktree session has an active running `up` operation
- **THEN** the response SHALL include deployment status `pending`
- **AND** the response SHALL include active operation metadata for the running `up` operation
- **AND** the response SHALL retain enough worktree identity information for the client to render deployment progress

#### Scenario: Project list reports pending during first launch
- **WHEN** a UI client requests the project list while a discovered worktree without initialized wos state has an active running `up` operation
- **THEN** that worktree summary SHALL include deployment status `pending`
- **AND** it SHALL include active operation metadata for the running `up` operation

#### Scenario: Fresh unlaunched worktree remains not started
- **WHEN** a UI client requests project or worktree snapshots for a worktree without initialized wos state
- **AND** the worktree session has no active running `up` operation
- **THEN** the response SHALL include deployment status `not_started`

#### Scenario: Active up fails before initialization
- **WHEN** an active `up` operation for an uninitialized worktree fails before wos state is initialized
- **THEN** subsequent authoritative UI API snapshots SHALL NOT continue reporting the worktree as `pending`
- **AND** the snapshot SHALL report deployment status `failed`
- **AND** the snapshot SHALL expose failure information through existing operation metadata or status error fields when available

### Requirement: UI API Exposes Restored Tunnel State
The UI API SHALL expose tunnel records restored after daemon restart through the same worktree detail and snapshot surfaces used for tunnels opened by `up`.

#### Scenario: Worktree detail includes restored active tunnel
- **WHEN** daemon startup restores an active tunnel for a worktree session with service `api`, container port `3000`, host port `21432`, and hostname `feature-api.example.com`
- **AND** a UI client requests worktree detail for that worktree
- **THEN** the response SHALL include tunnel information for `api:3000`
- **AND** the tunnel information SHALL include active state, host port `21432`, hostname `feature-api.example.com`, and URL `http://feature-api.example.com`

#### Scenario: Worktree detail remains authoritative after missed startup events
- **WHEN** a UI client connects after daemon startup tunnel restoration events have already been published
- **THEN** the client SHALL be able to call the worktree detail endpoint to retrieve the restored active tunnel state
- **AND** the client SHALL NOT need to run `wos up` to make restored tunnels visible

#### Scenario: Skipped restoration is omitted from worktree detail
- **WHEN** daemon startup skips a stale or invalid restore candidate for service `api` container port `3000`
- **AND** no active or failed tunnel record exists for that service port
- **THEN** worktree detail SHALL NOT include tunnel information for `api:3000`

### Requirement: Worktree Remove Operation Submission
The UI API SHALL allow clients to remove a selected secondary Git worktree through a worktree-scoped mutating operation, while requiring explicit discard confirmation before removing a worktree with local Git changes.

#### Scenario: Submit clean worktree removal
- **WHEN** a UI client submits removal for a secondary Git worktree path without discard confirmation
- **AND** the target worktree has no staged, unstaged, untracked, or unmerged changes
- **THEN** the daemon SHALL start a `worktree-remove` operation for the selected worktree session
- **AND** it SHALL return an operation id, session name, operation kind `worktree-remove`, and start timestamp
- **AND** it SHALL invoke Git worktree removal without force semantics

#### Scenario: Reject dirty worktree removal without confirmation
- **WHEN** a UI client submits removal for a secondary Git worktree path without discard confirmation
- **AND** the target worktree has staged, unstaged, untracked, or unmerged changes
- **THEN** the daemon SHALL reject the request with a structured `worktree-dirty` response
- **AND** it SHALL NOT start a `worktree-remove` operation
- **AND** it SHALL NOT drop tunnels, wos session records, monitors, session root files, or deployment resources for that worktree

#### Scenario: Submit confirmed dirty worktree removal
- **WHEN** a UI client submits removal for a secondary Git worktree path with discard confirmation
- **THEN** the daemon SHALL start a `worktree-remove` operation for the selected worktree session
- **AND** it SHALL return an operation id, session name, operation kind `worktree-remove`, and start timestamp
- **AND** it SHALL invoke Git worktree removal with force semantics for the selected worktree

#### Scenario: Remove cleans wos resources
- **WHEN** a `worktree-remove` operation runs for a worktree with initialized wos deployment state
- **THEN** the daemon SHALL perform the same runtime cleanup as a `down` operation
- **AND** it SHALL drop tunnel routes, stop session log followers, stop session monitoring, clear up-failure markers, and remove the persisted wos session root for that worktree

#### Scenario: Remove uninitialized worktree
- **WHEN** a UI client submits allowed removal for a secondary Git worktree without initialized wos deployment state
- **THEN** the daemon SHALL still remove wos session artifacts if present
- **AND** it SHALL remove the Git worktree

#### Scenario: Remove primary source worktree is rejected
- **WHEN** a UI client submits removal for the repository primary/source worktree
- **THEN** the daemon SHALL reject the request with a validation error
- **AND** it SHALL NOT start a removal operation

#### Scenario: Remove submission conflict
- **WHEN** a UI client submits removal for a worktree whose session already has an active mutating operation
- **THEN** the daemon SHALL reject the request with a conflict response that identifies the active operation

#### Scenario: Remove preserves branch
- **WHEN** a `worktree-remove` operation removes a Git worktree
- **THEN** the daemon SHALL NOT delete the branch associated with the removed worktree

### Requirement: Worktree Deployment Options
The UI API SHALL expose generated-compose deployment options in worktree detail responses so clients can present valid selective startup choices before or after a deployment exists.

#### Scenario: Generated worktree detail includes deployment options
- **WHEN** a UI client requests detail for a worktree whose source config uses generated-compose mode
- **THEN** the response SHALL include configured target names and their service entries
- **AND** it SHALL include configured app service names
- **AND** it SHALL include configured dependency service names

#### Scenario: Not-started worktree includes deployment options
- **WHEN** a UI client requests detail for a worktree with deployment status `not_started`
- **AND** the source config uses generated-compose mode
- **THEN** the response SHALL still include deployment options derived from the fresh source-worktree config

#### Scenario: Compose mode detail has no generated options
- **WHEN** a UI client requests detail for a worktree whose source config uses `mode: compose`
- **THEN** the response SHALL omit generated-compose deployment options or return them as empty

### Requirement: Worktree Selective Up Submission
The UI API SHALL allow UI clients to submit worktree `up` operations for all services, a configured target, or an explicit service selection.

#### Scenario: Submit worktree up with explicit services
- **WHEN** a UI client submits worktree `up` with services `app` and `api`
- **AND** the resolved config uses generated-compose mode
- **THEN** the daemon SHALL start the same deployment behavior as `wos up app,api`
- **AND** the response SHALL include operation id, session name, kind `up`, and start timestamp

#### Scenario: Submit worktree up with target
- **WHEN** a UI client submits worktree `up` with target `app`
- **AND** `targets.app` is configured
- **THEN** the daemon SHALL start the same deployment behavior as `wos up --target app`
- **AND** the response SHALL include operation id, session name, kind `up`, and start timestamp

#### Scenario: Submit worktree up without selection
- **WHEN** a UI client submits worktree `up` without services and without target
- **THEN** the daemon SHALL preserve the existing full-deployment worktree `up` behavior

#### Scenario: Reject invalid worktree up selection
- **WHEN** a UI client submits worktree `up` with both services and target, an empty service list, an empty target, an unknown service, an unknown target, or a dependency cycle
- **THEN** the UI API SHALL return an actionable validation error
- **AND** it SHALL NOT run Docker Compose startup

#### Scenario: Selective worktree up respects busy session
- **WHEN** a UI client submits selective worktree `up`
- **AND** the worktree session already has an active mutating operation
- **THEN** the UI API SHALL return the existing session-busy response
- **AND** it SHALL NOT start another operation

### Requirement: Worktree Latest Operation Context
The UI API SHALL expose latest operation and failure context in worktree detail responses when the daemon has enough information to describe the latest relevant worktree operation.

#### Scenario: Latest operation is available
- **WHEN** a UI client requests detail for a worktree whose session has a latest known operation
- **THEN** the response SHALL include latest operation metadata including operation id, kind, status, session name, start timestamp, finish timestamp when present, and failure message when present
- **AND** the response SHALL still include active operation metadata separately when a mutating operation is currently running

#### Scenario: Failed operation context is available
- **WHEN** a UI client requests detail for a worktree whose latest known operation failed
- **THEN** the response SHALL include failure context sufficient for UI clients to render a failed-state summary
- **AND** the failure context SHALL include the failure message when known

#### Scenario: Failure context identifies diagnostic channel when known
- **WHEN** the daemon can associate a failed deployment step with a diagnostic log channel
- **THEN** the failure context SHALL identify that channel as `init` or `service:<name>`
- **AND** clients SHALL be able to use that channel with the existing worktree logs endpoint

#### Scenario: Latest operation is unavailable
- **WHEN** a UI client requests detail for a worktree whose latest operation metadata is unavailable, such as after daemon restart
- **THEN** the response SHALL remain valid without latest operation context
- **AND** existing deployment status, status error, persisted state, services, healthchecks, tunnels, and log endpoints SHALL remain usable

### Requirement: Worktree Runtime Argument Options
The UI API SHALL expose declared generated-compose runtime arguments in worktree detail deployment options.

#### Scenario: Worktree detail includes runtime arguments
- **WHEN** a UI client requests detail for a worktree whose source config contains `arguments: [API_URL]`
- **AND** the source config uses generated-compose mode
- **THEN** the response deployment options SHALL include runtime argument `API_URL`

#### Scenario: Not-started worktree includes runtime arguments
- **WHEN** a UI client requests detail for a not-started worktree whose source config declares runtime arguments
- **THEN** the response SHALL still include those runtime arguments derived from the fresh source-worktree config

#### Scenario: Worktree detail omits runtime arguments for compose mode
- **WHEN** a UI client requests detail for a worktree whose source config uses `mode: compose`
- **THEN** the response SHALL omit generated-compose deployment options or expose no runtime arguments

### Requirement: Worktree Up Runtime Argument Submission
The UI API SHALL allow clients to submit runtime argument values with worktree `up` requests.

#### Scenario: Submit worktree up with runtime arguments
- **WHEN** a UI client submits worktree `up` with runtime argument `API_URL=https://empl-stage.test-wa.ru`
- **AND** the resolved generated-compose config declares `API_URL`
- **THEN** the daemon SHALL start the `up` operation with that runtime argument value
- **AND** the response SHALL include operation id, session name, kind `up`, and start timestamp

#### Scenario: Submit worktree up with runtime arguments and selection
- **WHEN** a UI client submits worktree `up` with target `lk-zup`
- **AND** it includes runtime argument `API_URL=https://empl-stage.test-wa.ru`
- **THEN** the daemon SHALL preserve both the target selection and runtime argument value for the operation

#### Scenario: Reject undeclared worktree up runtime argument
- **WHEN** a UI client submits worktree `up` with runtime argument `API_URL`
- **AND** the resolved generated-compose config does not declare `API_URL`
- **THEN** the UI API SHALL return an actionable validation error
- **AND** it SHALL NOT run Docker Compose startup

#### Scenario: Reject invalid runtime argument payload
- **WHEN** a UI client submits worktree `up` with `arguments` that is not a string-to-string object
- **THEN** the UI API SHALL return an actionable validation error
- **AND** it SHALL NOT start an operation

### Requirement: Public Auth Endpoints
The UI API SHALL provide public authentication endpoints for browser clients using the configured public web secret.

#### Scenario: login succeeds with valid secret
- **WHEN** public web access is enabled
- **AND** a public client submits `POST /ui/v1/auth/login` with the configured secret
- **THEN** the daemon SHALL return success
- **AND** it SHALL set an `HttpOnly` authentication cookie that authorizes later public UI API requests

#### Scenario: login fails with invalid secret
- **WHEN** public web access is enabled
- **AND** a public client submits `POST /ui/v1/auth/login` with a missing or invalid secret
- **THEN** the daemon SHALL return `401`
- **AND** it SHALL NOT set an authentication cookie

#### Scenario: session endpoint reports authenticated state
- **WHEN** public web access is enabled
- **AND** a public client calls `GET /ui/v1/auth/session` with a valid authentication cookie
- **THEN** the daemon SHALL return an authenticated session response

#### Scenario: logout clears session
- **WHEN** public web access is enabled
- **AND** a public client calls `POST /ui/v1/auth/logout`
- **THEN** the daemon SHALL clear the authentication cookie

### Requirement: Public UI API Session Authentication
The UI API SHALL require a valid public authentication cookie for every public-host UI API request except the auth endpoints.

#### Scenario: authenticated public request succeeds
- **WHEN** public web access is enabled
- **AND** a public client calls an existing UI API endpoint with a valid authentication cookie
- **THEN** the daemon SHALL handle the request according to the existing UI API contract

#### Scenario: unauthenticated public request is rejected
- **WHEN** public web access is enabled
- **AND** a public client calls an existing UI API endpoint without a valid authentication cookie
- **THEN** the daemon SHALL return `401`
- **AND** it SHALL NOT mutate daemon, project, worktree, deployment, terminal, or tunnel state

#### Scenario: public SSE stream requires session
- **WHEN** public web access is enabled
- **AND** a public client opens a UI API SSE or NDJSON stream without a valid authentication cookie
- **THEN** the daemon SHALL return `401`
- **AND** it SHALL NOT create a stream subscription

#### Scenario: local UI API auth endpoints are harmless
- **WHEN** a local loopback client calls the public auth endpoints
- **THEN** the daemon SHALL return a valid response
- **AND** existing local UI API endpoints SHALL remain usable without a public auth cookie

### Requirement: Public Terminal WebSocket Authentication
The UI API SHALL require both a valid public authentication cookie and explicit public terminal enablement before accepting terminal WebSocket attachment on the public daemon hostname.

#### Scenario: authenticated public terminal attach succeeds when terminal access is enabled
- **WHEN** public web access is enabled
- **AND** `web.public.terminalEnabled` is `true`
- **AND** a public client opens a terminal WebSocket attachment with a valid authentication cookie
- **THEN** the daemon SHALL allow the WebSocket upgrade
- **AND** the existing terminal WebSocket protocol SHALL apply after attachment

#### Scenario: unauthenticated public terminal attach is rejected
- **WHEN** public web access is enabled
- **AND** a public client opens a terminal WebSocket attachment without a valid authentication cookie
- **THEN** the daemon SHALL reject the request with `401`
- **AND** it SHALL NOT attach the client to the terminal session

#### Scenario: authenticated public terminal attach is forbidden when terminal access is disabled
- **WHEN** public web access is enabled
- **AND** `web.public.terminalEnabled` is omitted or `false`
- **AND** a public client opens a terminal WebSocket attachment with a valid authentication cookie
- **THEN** the daemon SHALL reject the request with a clear forbidden response
- **AND** it SHALL NOT attach the client to the terminal session

### Requirement: Managed Worktree Create Endpoint
The UI API SHALL expose a daemon-owned endpoint for creating managed Git worktrees under `$WOS_HOME/worktrees`.

#### Scenario: Create detached managed worktree
- **WHEN** a UI client submits a worktree create request with a project id and worktree name but no branch
- **THEN** the daemon SHALL start a managed worktree creation operation
- **AND** the accepted operation SHALL identify the operation id, operation kind, project id, target path, and started timestamp
- **AND** when creation succeeds, subsequent project list and worktree detail responses for the created worktree SHALL expose the submitted worktree name as its initial `displayName`

#### Scenario: Create branch-attached managed worktree
- **WHEN** a UI client submits a worktree create request with a project id, worktree name, and branch
- **THEN** the daemon SHALL start a managed worktree creation operation for the requested branch
- **AND** the accepted operation SHALL identify the operation id, operation kind, project id, target path, branch, and started timestamp
- **AND** when creation succeeds, subsequent project list and worktree detail responses for the created worktree SHALL expose the submitted worktree name as its initial `displayName`

#### Scenario: Create request is invalid
- **WHEN** a UI client submits a worktree create request with a missing project, unsafe name, colliding target path, or invalid branch
- **THEN** the UI API SHALL return a validation error
- **AND** it SHALL NOT create a Git worktree
- **AND** it SHALL NOT persist worktree display-name metadata

### Requirement: Managed Worktree Create Operation Status
The UI API SHALL expose managed worktree creation as an observable daemon operation.

#### Scenario: Create operation succeeds
- **WHEN** a managed worktree creation operation succeeds
- **THEN** clients SHALL be able to fetch the operation metadata
- **AND** clients SHALL be able to fetch the project list endpoint and see the newly-created worktree

#### Scenario: Create operation fails
- **WHEN** a managed worktree creation operation fails
- **THEN** the operation metadata SHALL include a failure message
- **AND** clients SHALL be able to display the failure without assuming the worktree exists

### Requirement: Terminal Session API
The UI API SHALL expose HTTP endpoints for listing, creating, inspecting, and terminating terminal sessions scoped to worktrees.

#### Scenario: List terminal sessions for worktree
- **WHEN** a UI client requests terminal sessions for a selected worktree
- **THEN** the response SHALL include all daemon-known terminal sessions for that worktree
- **AND** each session SHALL include id, worktree path, status, created timestamp, last attachment timestamp when available, dimensions when available, and exit status when exited

#### Scenario: Create terminal session for worktree
- **WHEN** a UI client requests a new terminal session for a valid worktree
- **THEN** the daemon SHALL create the PTY-backed terminal session
- **AND** the response SHALL include the terminal session metadata

#### Scenario: Terminate terminal session
- **WHEN** a UI client requests termination of a running terminal session
- **THEN** the daemon SHALL terminate the PTY-backed process
- **AND** subsequent session metadata SHALL report the exited state after termination completes

### Requirement: Terminal Session WebSocket Transport
The UI API SHALL expose a WebSocket transport for attaching to a terminal session.

#### Scenario: Attach websocket to terminal
- **WHEN** a browser opens the terminal WebSocket endpoint for a running terminal session
- **THEN** the daemon SHALL attach the WebSocket to the PTY process
- **AND** it SHALL stream terminal output messages to the browser
- **AND** it SHALL accept input and resize messages from the browser

#### Scenario: Attach websocket to missing terminal
- **WHEN** a browser opens the terminal WebSocket endpoint for an unknown terminal session id
- **THEN** the daemon SHALL reject or close the connection with an error that identifies the terminal session as missing

#### Scenario: WebSocket disconnects
- **WHEN** a browser WebSocket disconnects from a running terminal session
- **THEN** the daemon SHALL detach only that client
- **AND** it SHALL keep the terminal session running when no kill request was sent

### Requirement: UI API Terminal Restart Recovery
The UI API SHALL report only terminal sessions owned by the current daemon process.

#### Scenario: Client reconnects after daemon restart
- **WHEN** a UI client reconnects after daemon restart and requests terminal sessions for a worktree
- **THEN** the response SHALL omit terminal sessions from the previous daemon process
- **AND** it SHALL NOT return stale terminal session ids that cannot be attached

### Requirement: Terminal Snapshot API
The UI API SHALL expose authoritative terminal session snapshots for worktree-scoped terminal sessions.

#### Scenario: Client lists terminal sessions
- **WHEN** a UI client requests terminal sessions for a selected worktree
- **THEN** the UI API SHALL return the current daemon-owned terminal sessions for that worktree
- **AND** each terminal session SHALL include id, worktree identity, status, current dimensions, created timestamp, attachment summary, control ownership summary, and exit information when available
- **AND** each terminal session SHALL include root process id and active command metadata when available

#### Scenario: Client fetches terminal detail
- **WHEN** a UI client requests a specific terminal session detail
- **THEN** the UI API SHALL return the authoritative current session state
- **AND** it SHALL include replay sequence boundaries when available
- **AND** it SHALL include active command metadata when the terminal layer can determine it

#### Scenario: Daemon restarted
- **WHEN** the daemon restarts after previously running terminal sessions
- **THEN** the terminal snapshot API SHALL omit terminal sessions from the previous daemon process
- **AND** clients SHALL recover by reconciling against the returned snapshot

#### Scenario: Active command metadata unavailable
- **WHEN** active command metadata cannot be determined for a running terminal session
- **THEN** the UI API SHALL still return the terminal session snapshot
- **AND** clients SHALL treat the missing active command fields as an unknown or idle terminal state

### Requirement: Terminal Control API
The UI API SHALL expose terminal session create, terminate, and control ownership operations without carrying PTY output through HTTP responses.

#### Scenario: Client creates terminal session
- **WHEN** a UI client requests a terminal session for a valid worktree
- **THEN** the UI API SHALL create a daemon-owned terminal session
- **AND** it SHALL return the created terminal session metadata without terminal output history

#### Scenario: Client terminates terminal session
- **WHEN** a UI client requests termination of a running terminal session
- **THEN** the UI API SHALL ask the terminal layer to terminate the PTY process tree
- **AND** it SHALL return current terminal session metadata or an accepted termination response

#### Scenario: Client requests terminal control
- **WHEN** an attached client requests controller ownership for a terminal session
- **THEN** the UI API or terminal attachment protocol SHALL route the request through the terminal layer
- **AND** the terminal layer SHALL grant, deny, or transfer control according to current attachment state

### Requirement: Terminal Attachment WebSocket API
The UI API SHALL expose a terminal attachment WebSocket that implements the terminal data-plane protocol for a single terminal session.

#### Scenario: Client attaches to running terminal
- **WHEN** a UI client opens the terminal attachment WebSocket for a running terminal session
- **THEN** the UI API SHALL complete the terminal hello handshake
- **AND** it SHALL stream replay output before live output when replay is requested and available

#### Scenario: Attachment disconnects
- **WHEN** a browser terminal WebSocket disconnects
- **THEN** the UI API SHALL detach only that client attachment
- **AND** it SHALL keep the terminal session running unless a separate termination request or daemon shutdown occurs

#### Scenario: Slow attachment exceeds backpressure limits
- **WHEN** an attached client cannot keep up with terminal output beyond configured queue limits
- **THEN** the UI API SHALL close or degrade that attachment with a typed terminal error
- **AND** it SHALL NOT terminate the underlying terminal session solely because that attachment is slow

### Requirement: Terminal API Access Boundary
The UI API SHALL deny terminal creation and attachment on non-trusted exposure paths by default, and SHALL allow them on the public daemon hostname only when public terminal access is explicitly enabled and authenticated.

#### Scenario: Trusted local request
- **WHEN** a trusted local UI request creates or attaches to a terminal session
- **THEN** the UI API SHALL process the request when worktree validation and terminal runtime availability checks pass

#### Scenario: Public exposure request with terminal access disabled
- **WHEN** a terminal create or attach request arrives through a public tunnel or remote API exposure path
- **AND** `web.public.terminalEnabled` is omitted or `false`
- **THEN** the UI API SHALL reject the request with a clear forbidden or unavailable response
- **AND** it SHALL NOT start or attach to a terminal session

#### Scenario: Public exposure request without authentication
- **WHEN** a terminal create or attach request arrives through a public tunnel or remote API exposure path
- **AND** the request does not include a valid public authentication cookie
- **THEN** the UI API SHALL reject the request with `401`
- **AND** it SHALL NOT start or attach to a terminal session

#### Scenario: Public exposure request with terminal access enabled
- **WHEN** a terminal create or attach request arrives through a public tunnel or remote API exposure path
- **AND** `web.public.terminalEnabled` is `true`
- **AND** the request includes a valid public authentication cookie
- **THEN** the UI API SHALL process the request when worktree validation and terminal runtime availability checks pass

### Requirement: Local Settings Config UI API
The UI API SHALL expose local-only endpoints for reading and writing supported global settings from `<wos-home>/config.json`. On a successful save, the UI API SHALL set `restartRequired` in the response by comparing the submitted config against the previously persisted config: `restartRequired` SHALL be `true` if and only if at least one **restart-sensitive** field changed value. The restart-sensitive fields are `web.port`, `web.host`, `web.ssl`, `tunnel.enabled`, `tunnel.port`, `tunnel.ssl`, `tunnel.webUi`, `tunnel.serviceTunnels.enabled`, `terminalBackend`, `autoInjectAgentPlugins`, and `logging`. All other supported settings are applied to the live daemon without a restart and SHALL NOT, on their own, mark a save as restart-required.

#### Scenario: Local client reads settings config
- **WHEN** a local UI client requests `GET /ui/v1/settings/config`
- **THEN** the UI API SHALL return the config file path
- **AND** it SHALL return whether the config file exists
- **AND** it SHALL return raw supported setting values when present
- **AND** it SHALL return the effective parsed global config

#### Scenario: Local client saves settings config
- **WHEN** a local UI client submits valid supported settings to `PUT /ui/v1/settings/config`
- **THEN** the UI API SHALL validate and write `<wos-home>/config.json`
- **AND** it SHALL return the updated settings config snapshot
- **AND** it SHALL set `restartRequired` based on whether a restart-sensitive field changed relative to the previously persisted config

#### Scenario: Save changing a restart-sensitive field requires restart
- **WHEN** a local UI client submits a valid save that changes the value of a restart-sensitive field such as `web.port`, `web.host`, `tunnel.enabled`, `tunnel.port`, `terminalBackend`, `autoInjectAgentPlugins`, `logging`, `web.ssl`, `tunnel.ssl`, `tunnel.webUi`, or `tunnel.serviceTunnels.enabled`
- **THEN** the response SHALL include `restartRequired` equal to `true`

#### Scenario: Save changing only live-applicable fields does not require restart
- **WHEN** a local UI client submits a valid save whose only changes are to live-applicable fields such as `aiProviders`, `commitMessages`, `editorCommand`, `healthcheck`, or `tunnel.serviceTunnels.whitelistIps`
- **THEN** the response SHALL NOT include `restartRequired` equal to `true`

#### Scenario: Save with no effective change does not require restart
- **WHEN** a local UI client submits a valid save whose values match the previously persisted config
- **THEN** the response SHALL NOT include `restartRequired` equal to `true`

#### Scenario: Local client submits invalid settings config
- **WHEN** a local UI client submits invalid supported settings to `PUT /ui/v1/settings/config`
- **THEN** the UI API SHALL return a validation error with enough field context for the web UI to display it
- **AND** it SHALL NOT overwrite `<wos-home>/config.json`

### Requirement: Settings Config API Access Boundary
The UI API SHALL deny settings config management on public/remote daemon web exposure paths.

#### Scenario: Unauthenticated public client reads settings config
- **WHEN** a request for `GET /ui/v1/settings/config` arrives through the public daemon hostname
- **AND** the request does not include a valid public authentication cookie
- **THEN** the UI API SHALL reject the request
- **AND** it SHALL NOT return raw or effective global config values

#### Scenario: Authenticated public client reads settings config
- **WHEN** a request for `GET /ui/v1/settings/config` arrives through the public daemon hostname
- **AND** the request includes a valid public authentication cookie
- **THEN** the UI API SHALL reject the request with a forbidden response
- **AND** it SHALL NOT return raw or effective global config values

#### Scenario: Authenticated public client saves settings config
- **WHEN** a request for `PUT /ui/v1/settings/config` arrives through the public daemon hostname
- **AND** the request includes a valid public authentication cookie
- **THEN** the UI API SHALL reject the request with a forbidden response
- **AND** it SHALL NOT modify `<wos-home>/config.json`

#### Scenario: Public terminal access is enabled
- **WHEN** a settings config request arrives through the public daemon hostname
- **AND** `web.public.terminalEnabled` is `true`
- **THEN** the UI API SHALL still reject the settings config request
- **AND** public terminal access SHALL NOT grant settings config access

### Requirement: Tunnel Web UI Public Authentication
The UI API SHALL use the effective `tunnel.webUi` settings as the public Web UI authentication policy.

#### Scenario: public tunnel request without session is rejected
- **WHEN** `tunnel.webUi.enabled` is true
- **AND** a request reaches `/ui/v1/*` through the tunnel route for the effective `tunnel.webUi` hostname
- **AND** the request does not target a public auth endpoint
- **AND** the request does not include a valid public authentication cookie signed with `tunnel.webUi.secret`
- **THEN** the UI API SHALL return `401`
- **AND** it SHALL NOT run the requested UI API handler

#### Scenario: public tunnel request with session succeeds
- **WHEN** `tunnel.webUi.enabled` is true
- **AND** a request reaches an existing `/ui/v1/*` endpoint through the tunnel route for the effective `tunnel.webUi` hostname
- **AND** the request includes a valid public authentication cookie signed with `tunnel.webUi.secret`
- **THEN** the UI API SHALL handle the request according to the existing endpoint contract

#### Scenario: auth login uses tunnel web ui secret
- **WHEN** `tunnel.webUi.enabled` is true
- **AND** a public client submits `POST /ui/v1/auth/login` with the configured `tunnel.webUi.secret`
- **THEN** the UI API SHALL return `200`
- **AND** it SHALL set an `HttpOnly` authentication cookie that authorizes later public UI API requests

#### Scenario: local loopback request remains local
- **WHEN** a loopback client calls an existing `/ui/v1/*` endpoint on `web.port`
- **THEN** the UI API SHALL preserve the existing local UI API behavior without requiring the public authentication cookie

### Requirement: Tunnel Web UI Terminal Access Policy
The UI API SHALL use `tunnel.webUi.terminalEnabled` to decide whether authenticated public Web UI users may use terminal endpoints.

#### Scenario: public terminal disabled
- **WHEN** a terminal create or attach request arrives through the public Web UI tunnel route
- **AND** `tunnel.webUi.terminalEnabled` is omitted or `false`
- **AND** the request includes a valid public authentication cookie
- **THEN** the UI API SHALL reject the terminal request with `403`

#### Scenario: public terminal enabled
- **WHEN** a terminal create or attach request arrives through the public Web UI tunnel route
- **AND** `tunnel.webUi.terminalEnabled` is `true`
- **AND** the request includes a valid public authentication cookie
- **THEN** the UI API SHALL allow the request when the selected worktree and terminal policy are valid

### Requirement: Local First-Run Setup Status
The UI API SHALL expose a local-only setup status snapshot that lets the web client decide whether to render the first-run setup flow.

#### Scenario: Fresh local daemon requires setup
- **WHEN** a local UI client requests setup status
- **AND** `<wos-home>/config.json` does not exist
- **AND** the project registry contains no projects
- **THEN** the response SHALL include `setupRequired` equal to `true`
- **AND** it SHALL include the global config management snapshot with built-in effective defaults
- **AND** it SHALL include a registered project count of `0`

#### Scenario: Existing config completes setup
- **WHEN** a local UI client requests setup status
- **AND** `<wos-home>/config.json` exists
- **THEN** the response SHALL include `setupRequired` equal to `false`
- **AND** it SHALL include the global config management snapshot

#### Scenario: Existing project completes setup
- **WHEN** a local UI client requests setup status
- **AND** the project registry contains one or more projects
- **THEN** the response SHALL include `setupRequired` equal to `false`
- **AND** it SHALL include the registered project count

#### Scenario: Public setup status is forbidden
- **WHEN** a browser reaches the UI API through public/remote daemon web access
- **AND** it requests setup status
- **THEN** the UI API SHALL return `403 forbidden`
- **AND** it SHALL NOT include local config file contents or project registry details

### Requirement: Worktree Project Config Status
The UI API SHALL include the selected worktree's effective project deploy config status in worktree detail responses.

#### Scenario: Source worktree deploy config is valid
- **WHEN** a UI client requests detail for the selected primary/source worktree
- **AND** the resolved source worktree contains a valid `.wos/deploy.yaml`
- **THEN** the response SHALL include project config status `valid`
- **AND** it SHALL include the absolute config file path
- **AND** it SHALL include the resolved deployment mode

#### Scenario: Secondary worktree deploy config is valid
- **WHEN** a UI client requests detail for a secondary worktree
- **AND** the resolved source worktree contains a valid `.wos/deploy.worktree.yaml`
- **THEN** the response SHALL include project config status `valid`
- **AND** it SHALL include the absolute config file path
- **AND** it SHALL include the resolved deployment mode

#### Scenario: Source worktree deploy config is missing
- **WHEN** a UI client requests detail for the selected primary/source worktree
- **AND** the resolved source worktree does not contain `.wos/deploy.yaml`
- **THEN** the response SHALL include project config status `missing`
- **AND** it SHALL include the expected absolute config file path
- **AND** it SHALL include a user-displayable message explaining that service startup is unavailable until `.wos/deploy.yaml` is added

#### Scenario: Secondary worktree deploy config is missing
- **WHEN** a UI client requests detail for a secondary worktree
- **AND** the resolved source worktree does not contain `.wos/deploy.worktree.yaml`
- **THEN** the response SHALL include project config status `missing`
- **AND** it SHALL include the expected absolute config file path
- **AND** it SHALL include a user-displayable message explaining that service startup is unavailable until `.wos/deploy.worktree.yaml` is added

#### Scenario: Effective deploy config is invalid
- **WHEN** a UI client requests detail for a worktree whose effective deploy config file is invalid
- **THEN** the response SHALL include project config status `invalid`
- **AND** it SHALL include the absolute config file path
- **AND** it SHALL include a user-displayable validation message

#### Scenario: Worktree source cannot be resolved
- **WHEN** a UI client requests detail for a worktree whose source worktree cannot be resolved
- **THEN** the response SHALL include project config status `unknown`
- **AND** it SHALL preserve the existing worktree detail response shape for identity and status data

### Requirement: Worktree Start Requires Project Config
The UI API SHALL reject worktree `up` submissions when the effective project deploy config file for the selected worktree is missing or invalid.

#### Scenario: Start rejected when source config is missing
- **WHEN** a UI client submits `up` for the selected primary/source worktree
- **AND** the resolved source worktree does not contain `.wos/deploy.yaml`
- **THEN** the UI API SHALL reject the request with a structured validation error
- **AND** the error SHALL identify the condition as missing project config
- **AND** the daemon SHALL NOT create an operation

#### Scenario: Start rejected when worktree config is missing
- **WHEN** a UI client submits `up` for a secondary worktree
- **AND** the resolved source worktree does not contain `.wos/deploy.worktree.yaml`
- **THEN** the UI API SHALL reject the request with a structured validation error
- **AND** the error SHALL identify the condition as missing project config
- **AND** the daemon SHALL NOT create an operation

#### Scenario: Start rejected when effective config is invalid
- **WHEN** a UI client submits `up` for a worktree whose effective deploy config file is invalid
- **THEN** the UI API SHALL reject the request with a structured validation error
- **AND** the error SHALL include the config validation message
- **AND** the daemon SHALL NOT create an operation

#### Scenario: Start accepted when effective config is valid
- **WHEN** a UI client submits `up` for a worktree whose effective deploy config file is valid
- **THEN** the UI API SHALL preserve the existing worktree operation submission behavior
- **AND** it SHALL return an operation id and session name when submission succeeds

### Requirement: Filesystem Directory Autocomplete Endpoint
The UI API SHALL expose a non-mutating endpoint that returns directory suggestions for add-project path autocomplete.

When the requested path resolves to an existing directory, the daemon SHALL list that directory's immediate child directories. When the requested path does not resolve to an existing directory but its parent does, the daemon SHALL list the parent directory's immediate child directories so a partial trailing segment can still be autocompleted.

The daemon SHALL identify a suggested directory as a Git worktree by detecting a `.git` entry directly within that directory (a worktree or repository root). The daemon SHALL NOT spawn a Git subprocess while building autocomplete suggestions, and suggestions SHALL NOT report whether a `wos.yaml` configuration exists.

#### Scenario: Local client lists root directories
- **WHEN** a local UI client requests directory suggestions for `/`
- **THEN** the daemon SHALL return immediate child directories under the filesystem root
- **AND** the response SHALL NOT include non-directory files

#### Scenario: Local client lists nested directories
- **WHEN** a local UI client requests directory suggestions for an absolute directory path
- **THEN** the daemon SHALL return immediate child directories for that path
- **AND** each suggestion SHALL include an absolute path and display name

#### Scenario: Exact existing directory lists its contents
- **WHEN** a local UI client requests directory suggestions for an absolute path with no trailing slash that names an existing directory
- **THEN** the daemon SHALL return that directory's immediate child directories
- **AND** the response path SHALL be the requested directory

#### Scenario: Partial segment lists the parent directory
- **WHEN** a local UI client requests directory suggestions for an absolute path whose final segment does not name an existing entry but whose parent is an existing directory
- **THEN** the daemon SHALL return the parent directory's immediate child directories
- **AND** the response path SHALL be the parent directory

#### Scenario: Suggestions mark Git worktrees
- **WHEN** a returned directory contains a `.git` entry
- **THEN** the suggestion SHALL indicate that it is a Git worktree
- **AND** the daemon SHALL NOT spawn a Git subprocess to produce that suggestion

#### Scenario: Non-worktree directories are not marked
- **WHEN** a returned directory does not contain a `.git` entry
- **THEN** the suggestion SHALL indicate that it is not a Git worktree

#### Scenario: Autocomplete handles inaccessible directories
- **WHEN** the daemon cannot read a requested directory because it does not exist, is not a directory, or is inaccessible, and no listable parent applies
- **THEN** the daemon SHALL return a validation error that can be displayed by UI clients
- **AND** it SHALL NOT mutate daemon, project, worktree, deployment, terminal, or tunnel state

#### Scenario: Public client without terminal access is denied
- **WHEN** a public-host UI client requests directory suggestions
- **AND** public terminal access is not enabled
- **THEN** the daemon SHALL return `403`

#### Scenario: Public client with terminal access is allowed
- **WHEN** a public-host UI client requests directory suggestions
- **AND** public terminal access is enabled
- **THEN** the daemon SHALL process the request using the same behavior as a local UI client

### Requirement: Project Path Validation Endpoint
The UI API SHALL expose a non-mutating endpoint that validates whether a submitted path can be added as a project.

#### Scenario: Valid Git worktree path
- **WHEN** a UI client validates a path that resolves as a Git worktree
- **THEN** the daemon SHALL return a valid result
- **AND** it SHALL include the normalized input path and resolved primary/source worktree path
- **AND** it SHALL NOT mutate the project registry

#### Scenario: Invalid Git worktree path
- **WHEN** a UI client validates a path that cannot be resolved as a Git worktree
- **THEN** the daemon SHALL return an invalid result with a validation message
- **AND** it SHALL NOT mutate the project registry

#### Scenario: Missing root deploy config warning
- **WHEN** a UI client validates a Git worktree whose resolved primary/source worktree does not contain `.wos/deploy.yaml`
- **THEN** the daemon SHALL return a valid result with a warning that root worktree service startup will not be available until `.wos/deploy.yaml` exists
- **AND** project registration SHALL remain allowed

#### Scenario: Missing worktree deploy config warning
- **WHEN** a UI client validates a Git worktree whose resolved primary/source worktree does not contain `.wos/deploy.worktree.yaml`
- **THEN** the daemon SHALL return a valid result with a warning that secondary worktree service startup will not be available until `.wos/deploy.worktree.yaml` exists
- **AND** project registration SHALL remain allowed

#### Scenario: WorktreeOS deploy configs present
- **WHEN** a UI client validates a Git worktree whose resolved primary/source worktree contains `.wos/deploy.yaml` and `.wos/deploy.worktree.yaml`
- **THEN** the daemon SHALL return a valid result without a missing-config warning

#### Scenario: Public validation follows terminal access policy
- **WHEN** a public-host UI client validates a project path
- **AND** public terminal access is not enabled
- **THEN** the daemon SHALL return `403`

### Requirement: Settings API Includes SSL Settings
The UI API settings management endpoint SHALL expose and persist supported Web UI and tunnel SSL settings.

#### Scenario: Settings snapshot includes effective SSL defaults
- **WHEN** a local UI client requests `GET /ui/v1/settings/config`
- **AND** `<wos-home>/config.json` omits SSL settings
- **THEN** the response SHALL include effective `web.ssl.enabled` equal to `false`
- **AND** it SHALL include effective `tunnel.ssl.enabled` equal to `false`

#### Scenario: Settings snapshot includes raw SSL settings
- **WHEN** a local UI client requests `GET /ui/v1/settings/config`
- **AND** `<wos-home>/config.json` contains supported `web.ssl` or `tunnel.ssl` settings
- **THEN** the response SHALL include those raw supported SSL settings in the management snapshot

#### Scenario: Settings API saves valid SSL settings
- **WHEN** a local UI client submits `PUT /ui/v1/settings/config` with valid `web.ssl` or `tunnel.ssl` settings
- **THEN** the daemon SHALL persist the submitted SSL settings
- **AND** it SHALL return a refreshed settings snapshot
- **AND** it SHALL mark the response as restart-required

#### Scenario: Settings API rejects invalid SSL settings
- **WHEN** a local UI client submits `PUT /ui/v1/settings/config` with invalid SSL settings
- **THEN** the daemon SHALL return a validation response with field-specific SSL errors
- **AND** it SHALL NOT overwrite the existing global config file

### Requirement: UI API Tunnel URL Scheme
The UI API SHALL expose active tunnel URLs with the effective tunnel listener scheme.

#### Scenario: Worktree detail includes HTTPS tunnel URL
- **WHEN** a UI client requests detail for an initialized worktree
- **AND** that worktree has an active tunnel whose URL is `https://feature-api.example.com`
- **THEN** the response SHALL include that HTTPS URL in the tunnel information

#### Scenario: Events endpoint streams HTTPS tunnel URL
- **WHEN** a UI client receives a tunnel lifecycle event for an active tunnel whose URL is `https://feature-api.example.com`
- **THEN** the event payload exposed through the UI API SHALL include that HTTPS URL

#### Scenario: HTTP tunnel URLs remain unchanged
- **WHEN** a UI client requests or receives tunnel information for an HTTP tunnel
- **THEN** the UI API SHALL preserve the existing `http://` tunnel URL behavior

### Requirement: Settings API Supports Cloudflare Lets Encrypt Challenge
The local settings UI API SHALL accept, persist, and return Cloudflare Let's Encrypt challenge settings for Web UI and tunnel SSL configuration.

#### Scenario: Local settings response includes Cloudflare challenge config
- **WHEN** `<wos-home>/config.json` contains supported Cloudflare Let's Encrypt challenge settings
- **AND** a local client requests the settings config snapshot
- **THEN** the response SHALL include those Cloudflare challenge settings in the raw config
- **AND** the response SHALL include an effective SSL config whose challenge provider is `cloudflare`

#### Scenario: Local settings save accepts Cloudflare challenge config
- **WHEN** a local UI client submits valid `web.ssl` or `tunnel.ssl` values using `source: "letsencrypt"` and `challenge.provider: "cloudflare"`
- **THEN** the API SHALL persist the supported Cloudflare challenge fields to `<wos-home>/config.json`
- **AND** it SHALL return the refreshed raw and effective settings snapshot

#### Scenario: Local settings save rejects invalid Cloudflare challenge config
- **WHEN** a local UI client submits invalid Cloudflare challenge settings
- **THEN** the API SHALL reject the save with validation errors
- **AND** each error SHALL identify the relevant Cloudflare challenge field

#### Scenario: Public access cannot read Cloudflare challenge config
- **WHEN** a browser reaches the web UI through public daemon access
- **THEN** it SHALL NOT be able to read Cloudflare token values or mutate Cloudflare challenge settings through settings APIs

### Requirement: Certificate Status Identifies Cloudflare Source
The local settings UI API SHALL identify Cloudflare-managed Let's Encrypt certificate status without exposing Cloudflare credentials.

#### Scenario: Certificate status for Cloudflare listener
- **WHEN** a listener uses `source: "letsencrypt"` with `challenge.provider: "cloudflare"`
- **AND** a local client requests the settings config snapshot
- **THEN** the certificate status for that listener SHALL identify the certificate source as `letsencrypt`
- **AND** it SHALL identify the DNS challenge provider as `cloudflare`
- **AND** it SHALL NOT include Cloudflare token values

### Requirement: Settings API Includes Let's Encrypt Settings
The UI API settings management endpoint SHALL expose and persist supported Let's Encrypt SSL settings for local clients.

#### Scenario: Settings snapshot includes raw Let's Encrypt settings
- **WHEN** a local UI client requests `GET /ui/v1/settings/config`
- **AND** `<wos-home>/config.json` contains supported `web.ssl` or `tunnel.ssl` Let's Encrypt settings
- **THEN** the response SHALL include those raw supported settings in the management snapshot

#### Scenario: Settings snapshot includes effective certificate source
- **WHEN** a local UI client requests `GET /ui/v1/settings/config`
- **THEN** the response SHALL include the effective SSL certificate source for Web UI and tunnel SSL settings

#### Scenario: Settings API saves valid Let's Encrypt settings
- **WHEN** a local UI client submits `PUT /ui/v1/settings/config` with valid Let's Encrypt settings under `web.ssl` or `tunnel.ssl`
- **THEN** the daemon SHALL persist the submitted settings
- **AND** it SHALL return a refreshed settings snapshot
- **AND** it SHALL mark the response as restart-required

#### Scenario: Settings API rejects invalid Let's Encrypt settings
- **WHEN** a local UI client submits invalid Let's Encrypt settings
- **THEN** the daemon SHALL return a validation response with field-specific errors
- **AND** it SHALL NOT overwrite the existing global config file

### Requirement: UI API Exposes Certificate Status
The UI API SHALL expose read-only certificate status for Web UI and tunnel SSL listeners.

#### Scenario: Certificate status is returned
- **WHEN** a local UI client requests `GET /ui/v1/settings/config`
- **THEN** the response SHALL include certificate status for `web` and `tunnel`
- **AND** each status SHALL include listener kind, source, state, required hostnames, and whether the active certificate is currently usable when known

#### Scenario: Valid certificate status includes expiration
- **WHEN** an ACME-managed certificate exists for a listener
- **THEN** the certificate status SHALL include its `notBefore`, `notAfter`, last successful issuance or renewal time, and renewal eligibility when known

#### Scenario: Failed certificate status includes error
- **WHEN** the daemon has recorded a certificate issuance, renewal, or activation failure
- **THEN** the certificate status SHALL include the last failure time and an actionable failure message

#### Scenario: Public clients cannot mutate certificate settings
- **WHEN** a public-host UI client submits certificate or SSL settings through the settings API
- **THEN** the daemon SHALL reject the request using the existing public settings access boundary
- **AND** it SHALL NOT persist certificate settings

### Requirement: UI API Streams Certificate Lifecycle Events
The UI API SHALL expose certificate lifecycle events through the existing unified events stream.

#### Scenario: Certificate renewal event is streamed
- **WHEN** the daemon publishes a certificate lifecycle event for a renewed certificate
- **THEN** a subscribed local UI client SHALL receive an event containing listener kind, certificate source, hostnames, and lifecycle state

#### Scenario: Certificate failure event is streamed
- **WHEN** the daemon publishes a certificate lifecycle event for an issuance, renewal, or activation failure
- **THEN** a subscribed local UI client SHALL receive an event containing listener kind, failure phase, and failure message

### Requirement: Worktree Display Names
The UI API SHALL expose wos-managed worktree display names as presentation metadata on worktree summaries without changing worktree identity fields.

#### Scenario: Project list includes persisted worktree display name
- **WHEN** a UI client requests the project list
- **AND** a discovered worktree has a persisted display name
- **THEN** that worktree summary SHALL include `displayName` with the persisted value
- **AND** the summary SHALL still include the absolute `path`, derived `sessionName`, branch metadata, source-worktree flag, and deployment status

#### Scenario: Worktree detail includes persisted worktree display name
- **WHEN** a UI client requests detail for a worktree with a persisted display name
- **THEN** the response worktree summary SHALL include `displayName` with the persisted value
- **AND** the response SHALL continue to use the worktree path and session name as operational identifiers

#### Scenario: Worktree has no persisted display name
- **WHEN** a UI client requests a project list or worktree detail for a worktree without persisted display-name metadata
- **THEN** the UI API SHALL still return the worktree summary
- **AND** it SHALL preserve branch, head, path, and session identity fields so clients can render existing fallback labels

### Requirement: Worktree Display Name Rename Endpoint
The UI API SHALL expose an endpoint that updates a worktree display name without renaming the Git worktree path or wos session.

#### Scenario: Rename worktree display name
- **WHEN** a UI client submits a valid worktree path and non-empty display name to the rename endpoint
- **THEN** the UI API SHALL persist the trimmed display name for that worktree
- **AND** subsequent project list and worktree detail responses SHALL include the new display name
- **AND** the worktree path and session name SHALL remain unchanged

#### Scenario: Rename display name is invalid
- **WHEN** a UI client submits an empty, non-string, too-long, or control-character-containing display name
- **THEN** the UI API SHALL return a validation error
- **AND** it SHALL NOT update the persisted display name

#### Scenario: Rename target is not registered
- **WHEN** a UI client submits a path that is not a discovered worktree of any registered project
- **THEN** the UI API SHALL return a not-found or validation error
- **AND** it SHALL NOT create orphaned worktree display-name metadata

### Requirement: Settings API Includes Terminal Backend
The UI API settings management endpoint SHALL expose and persist the supported `terminalBackend` global setting.

#### Scenario: Settings snapshot includes effective terminal backend default
- **WHEN** a local UI client requests `GET /ui/v1/settings/config`
- **AND** `<wos-home>/config.json` omits `terminalBackend`
- **THEN** the response SHALL include effective `terminalBackend` equal to `"default"`

#### Scenario: Settings snapshot includes raw terminal backend
- **WHEN** a local UI client requests `GET /ui/v1/settings/config`
- **AND** `<wos-home>/config.json` contains supported `terminalBackend` equal to `"default"` or `"tmux"`
- **THEN** the response SHALL include that raw `terminalBackend` value in the management snapshot
- **AND** it SHALL include the same value as the effective terminal backend

#### Scenario: Settings API saves valid terminal backend
- **WHEN** a local UI client submits `PUT /ui/v1/settings/config` with `terminalBackend` equal to `"default"` or `"tmux"`
- **THEN** the daemon SHALL persist the submitted terminal backend setting
- **AND** it SHALL return a refreshed settings snapshot
- **AND** the response SHALL indicate that daemon restart is required for the saved backend selection to take effect

#### Scenario: Settings API rejects invalid terminal backend
- **WHEN** a local UI client submits `PUT /ui/v1/settings/config` with invalid `terminalBackend`
- **THEN** the UI API SHALL reject the request with a field-specific validation error for `terminalBackend`
- **AND** it SHALL NOT overwrite the existing global config file

#### Scenario: Public client cannot read terminal backend setting
- **WHEN** a settings config request arrives through the public daemon hostname
- **THEN** the UI API SHALL reject the settings config request according to the settings config access boundary
- **AND** it SHALL NOT return raw or effective `terminalBackend` values

### Requirement: Worktree Files Endpoint
The UI API SHALL expose worktree-scoped file explorer endpoints that allow clients to list directories, read editable text files, and save existing text files without escaping the selected worktree root.

#### Scenario: Client lists the worktree root directory
- **WHEN** a UI client requests a file tree listing for a selected worktree with an empty directory path
- **THEN** the daemon SHALL return direct child entries for the selected worktree root
- **AND** each entry SHALL include a relative path, display name, kind (`file` or `directory`), and metadata sufficient for the web client to render and sort the tree
- **AND** the response SHALL NOT include `.git` entries

#### Scenario: Client lists a nested directory
- **WHEN** a UI client requests a file tree listing for a relative directory inside the selected worktree
- **THEN** the daemon SHALL return only that directory's direct child entries
- **AND** the daemon SHALL NOT recursively return the full worktree tree

#### Scenario: Directory path is outside worktree
- **WHEN** a UI client requests a file tree listing with an absolute directory path, parent traversal, or a path that resolves outside the selected worktree
- **THEN** the daemon SHALL reject the request with a structured validation error
- **AND** it SHALL NOT read filesystem entries outside the selected worktree

#### Scenario: Client reads editable text file
- **WHEN** a UI client requests content for an existing text file inside the selected worktree
- **THEN** the daemon SHALL return UTF-8 text content
- **AND** the response SHALL include file metadata including size and modification time
- **AND** the response SHALL identify the file as editable

#### Scenario: Client reads unsupported file
- **WHEN** a UI client requests content for a binary file, a file above the editable size limit, a directory, or a missing file
- **THEN** the daemon SHALL reject the request with a structured error that identifies why content is unavailable
- **AND** it SHALL NOT return raw binary content as text

#### Scenario: Client saves existing text file
- **WHEN** a UI client submits new UTF-8 content for an existing editable text file inside the selected worktree
- **AND** the submitted modification-time guard matches the file's current modification time when provided
- **THEN** the daemon SHALL write the submitted content to that file
- **AND** it SHALL return updated file metadata including size and modification time

#### Scenario: Save detects external modification
- **WHEN** a UI client submits new content with an expected modification time
- **AND** the current file modification time no longer matches that expected value
- **THEN** the daemon SHALL reject the save with a conflict response
- **AND** it SHALL NOT overwrite the file

#### Scenario: Save target is outside worktree
- **WHEN** a UI client submits content for an absolute file path, parent traversal path, symlink escape, missing file, directory, binary file, or file above the editable size limit
- **THEN** the daemon SHALL reject the save with a structured error
- **AND** it SHALL NOT write outside the selected worktree root

### Requirement: Daemon Restart UI API Endpoint
The UI API SHALL expose a local-only endpoint for requesting a daemon restart from web clients.

#### Scenario: Local client requests daemon restart
- **WHEN** a local UI client submits `POST /ui/v1/daemon/restart`
- **THEN** the UI API SHALL accept the request before stopping the current daemon process
- **AND** it SHALL return a response indicating that daemon restart has been scheduled

#### Scenario: Restart request schedules lifecycle restart asynchronously
- **WHEN** the UI API accepts a daemon restart request
- **THEN** the daemon SHALL schedule restart work so the HTTP response can be delivered before the current daemon exits
- **AND** the restart work SHALL use the same daemon lifecycle semantics as `wos restart`

#### Scenario: Public client cannot restart daemon
- **WHEN** a daemon restart request arrives through the public daemon hostname
- **THEN** the UI API SHALL reject the request as forbidden
- **AND** it SHALL NOT schedule daemon restart work

#### Scenario: Unsupported method is rejected
- **WHEN** a UI client requests `/ui/v1/daemon/restart` with a method other than `POST`
- **THEN** the UI API SHALL reject the request with a method-not-allowed response
- **AND** it SHALL NOT schedule daemon restart work

#### Scenario: Restart scheduling fails
- **WHEN** the UI API cannot schedule daemon restart work
- **THEN** it SHALL return a structured API error
- **AND** it SHALL leave the current daemon process running

### Requirement: Terminal Session Rename API
The UI API SHALL expose a local terminal control-plane endpoint that lets trusted UI clients set or clear the optional title of an existing terminal session.

#### Scenario: UI client renames terminal session
- **WHEN** a trusted UI client submits a valid title for an existing terminal session
- **THEN** the UI API SHALL update the terminal session title
- **AND** the response SHALL include the authoritative updated terminal session metadata

#### Scenario: UI client clears terminal session title
- **WHEN** a trusted UI client submits `null` or an empty-after-trim title for an existing terminal session
- **THEN** the UI API SHALL clear the terminal session title
- **AND** the response SHALL include terminal session metadata without a title

#### Scenario: UI client renames missing terminal session
- **WHEN** a trusted UI client submits a title update for an unknown terminal session id
- **THEN** the UI API SHALL return a not-found error
- **AND** it SHALL NOT create a terminal session

#### Scenario: UI client submits invalid terminal session title
- **WHEN** a trusted UI client submits a terminal session title containing control characters or exceeding the supported length
- **THEN** the UI API SHALL return a validation error
- **AND** it SHALL NOT change the terminal session title

#### Scenario: Public terminal rename follows terminal policy
- **WHEN** a request reaches the daemon through a public tunnel or remote API exposure path
- **AND** public terminal access is not explicitly enabled and authenticated
- **THEN** the UI API SHALL deny terminal session title updates
- **AND** it SHALL preserve the current terminal session metadata

### Requirement: Terminal Snapshot Includes Title
The UI API SHALL include the optional terminal session title in terminal session snapshots whenever a title is set.

#### Scenario: List includes named terminal sessions
- **WHEN** a UI client lists terminal sessions for a worktree that has a named terminal session
- **THEN** the matching session metadata SHALL include its title
- **AND** unnamed terminal sessions SHALL remain valid without a title field

#### Scenario: Detail includes named terminal session
- **WHEN** a UI client fetches detail for a named terminal session
- **THEN** the response SHALL include the title alongside the existing terminal session metadata
- **AND** replay boundaries, attachment summaries, and control ownership SHALL remain available as before

### Requirement: Worktree Exec Session Endpoint
The UI API SHALL expose a trusted-local-only endpoint that creates daemon-owned terminal sessions for Docker Compose exec commands in a selected worktree.

#### Scenario: Create exec session
- **WHEN** a trusted local UI API client submits `POST /ui/v1/worktrees/exec` with a valid `path`, `service`, and non-empty `command` argv
- **AND** the resolved worktree has an initialized Docker-backed deployment
- **THEN** the daemon SHALL create a terminal-layer session that runs the requested command inside the requested service container
- **AND** the response SHALL include the terminal session metadata and session id
- **AND** the response SHALL include or imply the terminal attach endpoint for that session

#### Scenario: Exec endpoint rejects public access
- **WHEN** a public or tunnel client submits a worktree exec request
- **THEN** the UI API SHALL reject the request as forbidden
- **AND** it SHALL NOT create a terminal session
- **AND** it SHALL NOT spawn any command

#### Scenario: Exec endpoint rejects missing path
- **WHEN** a trusted local client submits a worktree exec request without a valid `path`
- **THEN** the UI API SHALL return a validation error
- **AND** it SHALL NOT create a terminal session

#### Scenario: Exec endpoint rejects missing service
- **WHEN** a trusted local client submits a worktree exec request without a non-empty `service`
- **THEN** the UI API SHALL return a validation error
- **AND** it SHALL NOT create a terminal session

#### Scenario: Exec endpoint rejects missing command
- **WHEN** a trusted local client submits a worktree exec request without a non-empty command argv
- **THEN** the UI API SHALL return a validation error
- **AND** it SHALL NOT create a terminal session

#### Scenario: Exec endpoint rejects uninitialized worktree
- **WHEN** a trusted local client submits a worktree exec request for a worktree without initialized deployment state
- **THEN** the UI API SHALL return a validation error explaining that no deployment has been initialized
- **AND** it SHALL NOT create a terminal session

#### Scenario: Exec endpoint rejects shell mode
- **WHEN** a trusted local client submits a worktree exec request for a shell-mode worktree
- **THEN** the UI API SHALL return an unsupported-mode error
- **AND** it SHALL NOT create a terminal session

#### Scenario: Exec endpoint rejects invalid service
- **WHEN** a trusted local client submits a worktree exec request for an unknown, unmanaged, unexposed, or internal service
- **THEN** the UI API SHALL return a validation error naming the service problem
- **AND** it SHALL NOT create a terminal session

### Requirement: Daemon HTTP Health Endpoint
The UI API SHALL expose daemon readiness and discovery metadata through `GET /ui/v1/health`.

#### Scenario: Health returns daemon metadata
- **WHEN** a local HTTP client requests `GET /ui/v1/health`
- **THEN** the API SHALL return a successful response with `ok`, UI API version, daemon protocol version, daemon pid, daemon id, started timestamp, web host, web port, and web scheme

#### Scenario: CLI verifies protocol
- **WHEN** the CLI checks daemon readiness through `GET /ui/v1/health`
- **THEN** it SHALL be able to compare the returned protocol or version against the CLI-supported protocol
- **AND** it SHALL be able to reject stale or incompatible daemon metadata

#### Scenario: Public tunnel health keeps public boundary
- **WHEN** a request reaches `/ui/v1/health` through public tunnel Web UI access
- **THEN** the API MAY return minimal readiness information
- **AND** it SHALL NOT expose additional local management details beyond the configured public access policy

### Requirement: Daemon Lifecycle Management API
The UI API SHALL expose daemon lifecycle management endpoints needed by CLI lifecycle commands.

#### Scenario: Local client requests daemon stop
- **WHEN** a trusted local HTTP client submits `POST /ui/v1/daemon/stop`
- **THEN** the daemon SHALL return an accepted response before stopping
- **AND** it SHALL schedule daemon shutdown after the response is committed
- **AND** it SHALL NOT stop deployed worktree services solely because the daemon stops

#### Scenario: Local client requests daemon restart
- **WHEN** a trusted local HTTP client submits `POST /ui/v1/daemon/restart`
- **THEN** the daemon SHALL return an accepted response before scheduling restart
- **AND** the restarted daemon SHALL become discoverable through daemon HTTP metadata and health

#### Scenario: Public client requests daemon lifecycle endpoint
- **WHEN** a public tunnel request submits `POST /ui/v1/daemon/stop` or `POST /ui/v1/daemon/restart`
- **THEN** the UI API SHALL return a forbidden response
- **AND** it SHALL NOT schedule stop or restart work

### Requirement: CLI HTTP Worktree API Coverage
The UI API SHALL provide enough HTTP endpoints for CLI worktree commands to avoid legacy Unix socket APIs.

#### Scenario: CLI submits up operation
- **WHEN** the CLI submits `wos up` through HTTP
- **THEN** the UI API SHALL accept the request through the existing worktree up endpoint
- **AND** it SHALL return operation id, session name, operation kind, and start timestamp

#### Scenario: CLI submits down operation
- **WHEN** the CLI submits `wos down` through HTTP
- **THEN** the UI API SHALL accept the request through the worktree down endpoint
- **AND** it SHALL return operation id, session name, operation kind, and start timestamp

#### Scenario: CLI reads status snapshot
- **WHEN** the CLI runs `wos status`
- **THEN** the UI API SHALL provide a worktree detail snapshot with deployment status, service rows, app-port healthchecks, tunnels, active operation metadata, and relevant error context

#### Scenario: CLI observes operation progress
- **WHEN** the CLI runs a foreground mutating operation
- **THEN** the UI API SHALL provide an operation event stream for the returned operation id
- **AND** the stream SHALL preserve ordered deployment progress events until the operation reaches a terminal state

#### Scenario: CLI handles busy session
- **WHEN** the UI API rejects an operation because the session already has an active mutating operation
- **THEN** it SHALL return a conflict response that identifies the active operation
- **AND** the CLI SHALL not need to call any legacy socket API to render the conflict

### Requirement: HTTP API Broad Bind Behavior
The UI API SHALL treat the daemon web listener as the configured local management surface and SHALL NOT add automatic loopback enforcement.

#### Scenario: User binds to wildcard host
- **WHEN** the effective daemon config sets `web.host` to `0.0.0.0`
- **THEN** the UI API SHALL serve the same local management routes on that listener
- **AND** it SHALL NOT reject the request solely because the listener is not loopback-bound

#### Scenario: Public tunnel access remains distinct
- **WHEN** a request is identified as public tunnel Web UI access
- **THEN** the UI API SHALL keep applying existing public access restrictions
- **AND** the local listener bind host SHALL NOT disable those public tunnel restrictions

### Requirement: Terminal Backend Availability Endpoint
The UI API SHALL expose a local-only endpoint that probes the terminal backend multiplexer on demand and reports its availability.

#### Scenario: Local client probes an available multiplexer
- **WHEN** a local UI client requests `GET /ui/v1/settings/terminal-backend/availability`
- **AND** the tmux backend multiplexer can be resolved and answers its version probe
- **THEN** the response SHALL report the tmux backend as available
- **AND** it SHALL include the resolved multiplexer binary and the host platform

#### Scenario: Local client probes an unavailable multiplexer
- **WHEN** a local UI client requests `GET /ui/v1/settings/terminal-backend/availability`
- **AND** the tmux backend multiplexer cannot be resolved or fails its version probe
- **THEN** the response SHALL report the tmux backend as unavailable
- **AND** it SHALL include a human-readable reason naming the missing prerequisite and the host platform

#### Scenario: Probe runs fresh on each request
- **WHEN** a local UI client requests `GET /ui/v1/settings/terminal-backend/availability` more than once
- **THEN** each request SHALL probe the multiplexer freshly rather than returning a cached backend-adapter result
- **AND** a multiplexer installed between requests SHALL be reflected as available on the later request

#### Scenario: Public access is forbidden
- **WHEN** a request for `GET /ui/v1/settings/terminal-backend/availability` arrives through the public daemon hostname
- **THEN** the UI API SHALL respond with a forbidden error
- **AND** it SHALL NOT probe the multiplexer or return availability details

### Requirement: Worktree Git Staging Endpoints
The UI API SHALL expose endpoints to stage and unstage whole changed files for a selected worktree.

#### Scenario: Client stages files
- **WHEN** a UI client sends `POST /ui/v1/worktrees/git/stage` with a worktree path and a list of changed file paths
- **THEN** the daemon SHALL stage those files in that worktree
- **AND** it SHALL return a success result the client can use to refresh the diff

#### Scenario: Client unstages files
- **WHEN** a UI client sends `POST /ui/v1/worktrees/git/unstage` with a worktree path and a list of staged file paths
- **THEN** the daemon SHALL unstage those files in that worktree

#### Scenario: Staging fails
- **WHEN** Git cannot stage or unstage the requested paths
- **THEN** the UI API SHALL return a structured API error that preserves the Git failure message

### Requirement: Worktree Git Commit Endpoint
The UI API SHALL expose a commit endpoint for a selected worktree supporting optional push and amend.

#### Scenario: Client commits staged changes
- **WHEN** a UI client sends `POST /ui/v1/worktrees/git/commit` with a worktree path and a non-empty message
- **THEN** the daemon SHALL create the commit from the staged changes
- **AND** the response SHALL include the new commit identifier and a short summary

#### Scenario: Client commits and pushes
- **WHEN** the commit request sets push
- **THEN** the daemon SHALL push after a successful commit
- **AND** the response SHALL include the push result

#### Scenario: Client amends the latest commit
- **WHEN** the commit request sets amend
- **THEN** the daemon SHALL fold the staged changes into the latest commit

#### Scenario: Commit fails
- **WHEN** the commit (or push) fails, or nothing is staged
- **THEN** the UI API SHALL return a structured API error that distinguishes "nothing staged" from a Git execution failure and preserves the Git message

### Requirement: Worktree Git Branch Endpoint
The UI API SHALL expose a branch-creation endpoint so a client can attach a detached worktree to a new branch before committing.

#### Scenario: Client creates a branch
- **WHEN** a UI client sends `POST /ui/v1/worktrees/git/branch` with a worktree path and a valid branch name
- **THEN** the daemon SHALL create and switch to that branch in the worktree
- **AND** the response SHALL include the resulting head state

#### Scenario: Branch creation fails
- **WHEN** the branch name is invalid or already exists
- **THEN** the UI API SHALL return a structured API error that preserves the Git failure message

### Requirement: Worktree Commit Message Generation Endpoint
The UI API SHALL expose an endpoint that generates a commit message from a worktree's staged diff using a configured AI provider.

#### Scenario: Client requests a generated message
- **WHEN** a UI client sends `POST /ui/v1/worktrees/git/commit-message` with a worktree path and an AI provider is resolvable
- **THEN** the daemon SHALL generate a message from the staged diff and resolved repository commit rules
- **AND** the response SHALL include the generated message text

#### Scenario: No provider configured
- **WHEN** the client requests generation and no AI provider can be resolved
- **THEN** the UI API SHALL return a structured result indicating no AI provider is configured, distinguishable from a provider request failure

#### Scenario: Generation fails
- **WHEN** the AI provider request fails or returns an empty completion
- **THEN** the UI API SHALL return a structured API error that preserves the provider failure message
- **AND** the daemon SHALL NOT create a commit as a side effect

### Requirement: Workflow Status Catalog Endpoints
The unified UI API SHALL expose endpoints to read and manage the global workflow status catalog.

#### Scenario: List the status catalog
- **WHEN** a client requests `GET /ui/v1/statuses`
- **THEN** the daemon SHALL return the global catalog as an ordered list of statuses, each with id, name, color, and order
- **AND** if no catalog exists yet it SHALL return the seeded preset statuses

#### Scenario: Create a status
- **WHEN** a client requests `POST /ui/v1/statuses` with a name and a color
- **THEN** the daemon SHALL append a new status to the catalog and return it with its assigned id and order

#### Scenario: Update a status
- **WHEN** a client requests `PATCH /ui/v1/statuses/:id` with a new name, color, and/or order
- **THEN** the daemon SHALL update only that status and return the updated catalog or status
- **AND** it SHALL preserve existing worktree assignments to that status

#### Scenario: Delete a status
- **WHEN** a client requests `DELETE /ui/v1/statuses/:id`
- **THEN** the daemon SHALL remove the status from the catalog and set every worktree assigned to it to unassigned
- **AND** it SHALL NOT remove the affected worktrees or their other metadata

#### Scenario: Invalid status payload
- **WHEN** a client submits a status create or update with a missing name or an invalid color
- **THEN** the daemon SHALL reject the request with a validation error and SHALL NOT mutate the catalog

### Requirement: Worktree Workflow Status Assignment Endpoint
The unified UI API SHALL expose an endpoint to assign a worktree's workflow status and within-status order, serving as the Kanban drag target.

#### Scenario: Assign a worktree to a status with an order
- **WHEN** a client requests `PATCH /ui/v1/worktrees/status` with a worktree path, a status id, and an order
- **THEN** the daemon SHALL persist that assignment in the board store
- **AND** it SHALL emit a worktree board change event

#### Scenario: Move a worktree to no status
- **WHEN** a client requests `PATCH /ui/v1/worktrees/status` with a worktree path and a null status id
- **THEN** the daemon SHALL mark the worktree unassigned and emit a worktree board change event

#### Scenario: Assignment references an unknown status
- **WHEN** a client requests `PATCH /ui/v1/worktrees/status` with a status id that is not in the catalog
- **THEN** the daemon SHALL reject the request with a validation error and SHALL NOT change the assignment

#### Scenario: Assignment does not affect deployment status
- **WHEN** a worktree's workflow status assignment changes
- **THEN** the daemon SHALL NOT change the worktree's derived `DeploymentStatus` or its runtime

### Requirement: Worktree Comment Endpoints
The unified UI API SHALL expose endpoints to read, append, and delete manual worktree comments.

#### Scenario: List comments for a worktree
- **WHEN** a client requests `GET /ui/v1/worktrees/comments` for a worktree path
- **THEN** the daemon SHALL return that worktree's comments as an ordered list, each with id, text, and creation timestamp

#### Scenario: Add a comment
- **WHEN** a client requests `POST /ui/v1/worktrees/comments` with a worktree path and text
- **THEN** the daemon SHALL append the comment with a generated id and creation timestamp and emit a worktree comment change event

#### Scenario: Delete a comment
- **WHEN** a client requests `DELETE /ui/v1/worktrees/comments` with a worktree path and a comment id
- **THEN** the daemon SHALL remove that comment and emit a worktree comment change event

#### Scenario: Comment exceeds the maximum length
- **WHEN** a client adds a comment whose text exceeds the maximum length
- **THEN** the daemon SHALL reject the request with a validation error and SHALL NOT persist the comment

### Requirement: Terminal Snapshot Stream Endpoint
The unified UI API SHALL provide a single Server-Sent Events endpoint that multiplexes terminal-screen snapshots for a set of sessions at a server-driven cadence. The cadence SHALL be controllable by the client (request parameter) and SHALL act as the artificial render delay. The endpoint SHALL be subject to the same access control as other terminal endpoints (forbidden for public/tunnel requests unless terminal access is explicitly enabled).

#### Scenario: One connection multiplexes many sessions
- **WHEN** a client subscribes to the snapshot stream
- **THEN** the daemon SHALL push, over that single connection, screen snapshots for the requested live sessions
- **AND** it SHALL repeat at approximately the requested cadence

#### Scenario: Cadence is bounded
- **WHEN** a client requests a snapshot cadence
- **THEN** the daemon SHALL clamp it to a safe minimum and maximum interval

#### Scenario: Access is gated for public requests
- **WHEN** a public or tunnel request reaches the snapshot stream endpoint and terminal access is not enabled
- **THEN** the daemon SHALL refuse the request with a forbidden response

#### Scenario: Passive subscription does not register terminal presence
- **WHEN** a client is subscribed only to the snapshot stream (no interactive terminal attachment)
- **THEN** the notification engine SHALL NOT treat that subscription as an active terminal presence
- **AND** agent notifications (done / question) SHALL NOT be suppressed solely because the snapshot stream is open

### Requirement: Terminal Snapshot One-Shot Endpoint
The unified UI API SHALL provide an endpoint that returns the current screen snapshot for a single session on demand, for initial pane seeding and fallback when the stream is not connected.

#### Scenario: Fetch a single snapshot
- **WHEN** a client requests the current snapshot for a session that supports capture
- **THEN** the daemon SHALL return that session's current screen snapshot and its geometry

#### Scenario: Session without snapshot capability
- **WHEN** a client requests a snapshot for a session whose backend cannot capture a screen
- **THEN** the daemon SHALL respond indicating no snapshot is available rather than returning corrupted output

### Requirement: Client Presence Endpoint
The UI API SHALL expose an authenticated endpoint for a web client to report its window focus state to the daemon, so the notification engine can gate delivery on real user presence. The endpoint SHALL accept a client id and a focus state (`focused` or `away`), record it in the daemon presence registry, and tolerate malformed bodies without error. Focused presence SHALL be kept live by repeated reports and SHALL expire after a bounded TTL when reports lapse.

#### Scenario: Client reports focused presence
- **WHEN** an authenticated client `POST`s `/ui/v1/presence` with `{ clientId, state: "focused" }`
- **THEN** the daemon SHALL record that client as focused and the notification engine SHALL treat the user as present

#### Scenario: Client reports away
- **WHEN** an authenticated client `POST`s `/ui/v1/presence` with `{ clientId, state: "away" }`
- **THEN** the daemon SHALL clear that client's focused presence

#### Scenario: Malformed presence body is tolerated
- **WHEN** a presence request has a missing client id or an invalid state (e.g. a dropped `sendBeacon` payload)
- **THEN** the endpoint SHALL reject it without throwing and SHALL NOT alter recorded presence

#### Scenario: Lapsed presence expires
- **WHEN** a client previously reported `focused` and stops reporting beyond the presence TTL
- **THEN** the daemon SHALL stop counting that client as focused

### Requirement: Worktree Git Fetch Endpoint
The UI API SHALL expose a fetch endpoint that refreshes a selected worktree's upstream tracking and returns the recomputed ahead/behind posture so a client can update its sync state without waiting for the next snapshot poll.

#### Scenario: Client fetches a worktree
- **WHEN** a UI client sends `POST /ui/v1/worktrees/git/fetch` with a worktree path
- **THEN** the daemon SHALL run the fetch operation from that worktree root
- **AND** the response SHALL include the recomputed `aheadCount` and `behindCount` for the branch against its upstream

#### Scenario: Fetched worktree has no upstream
- **WHEN** the fetched worktree's branch has no upstream or is detached
- **THEN** the daemon SHALL still return a success result
- **AND** it SHALL omit `aheadCount` and `behindCount` from the response

#### Scenario: Fetch fails
- **WHEN** Git rejects the fetch
- **THEN** the UI API SHALL return a structured API error that preserves the Git failure message

### Requirement: Worktree Git Push Endpoint
The UI API SHALL expose a standalone push endpoint that pushes a selected worktree's branch and returns the recomputed ahead/behind posture, so a client can push already-committed work without creating a new commit.

#### Scenario: Client pushes a worktree
- **WHEN** a UI client sends `POST /ui/v1/worktrees/git/push` with a worktree path whose branch has an upstream
- **THEN** the daemon SHALL push that branch to its remote
- **AND** the response SHALL include the push summary and the recomputed `aheadCount` and `behindCount`

#### Scenario: Client pushes a branch without upstream
- **WHEN** the pushed worktree's branch has no upstream
- **THEN** the daemon SHALL set the upstream while pushing (equivalent to `git push -u origin <branch>`)

#### Scenario: Push is rejected
- **WHEN** Git rejects the push because the branch is not a fast-forward of its upstream
- **THEN** the UI API SHALL return a structured API error that preserves the Git rejection message so the client can prompt the user to fetch first

#### Scenario: Push fails
- **WHEN** the push fails for any other reason
- **THEN** the UI API SHALL return a structured API error that preserves the Git failure message

