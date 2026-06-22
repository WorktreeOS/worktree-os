# wos-events Specification

## Purpose
TBD - created by archiving change add-unified-deployment-events. Update Purpose after archive.
## Requirements
### Requirement: Unified Event Envelope
The system SHALL wrap every unified daemon event in a typed envelope with a daemon-local monotonic sequence id, timestamp, event type, and optional project, worktree, session, and operation identifiers.

#### Scenario: Event envelope is emitted
- **WHEN** the daemon publishes a unified event
- **THEN** the envelope SHALL include a string or numeric `id` that increases monotonically for the daemon process
- **AND** the envelope SHALL include an ISO timestamp
- **AND** the envelope SHALL include the event type
- **AND** the envelope SHALL include the typed event payload

#### Scenario: Session-scoped event is emitted
- **WHEN** an event describes a worktree deployment, operation, service, healthcheck, tunnel, or log change
- **THEN** the envelope SHALL include the affected `sessionName`
- **AND** the envelope SHALL include `worktreePath` when the daemon can resolve it

#### Scenario: Operation-scoped event is emitted
- **WHEN** an event is caused by a daemon operation
- **THEN** the envelope SHALL include the `operationId`
- **AND** the event payload SHALL include the operation metadata or deployment lifecycle details relevant to that event

### Requirement: Unified Event Taxonomy
The system SHALL define typed unified events for daemon, project, worktree, operation, deployment, compose, service, healthcheck, and tunnel state changes.

#### Scenario: Project lifecycle event
- **WHEN** a project is added, updated, removed, marked stale, or recovered
- **THEN** the daemon SHALL emit a project lifecycle event containing enough project identity for clients to update or refetch project lists

#### Scenario: Worktree lifecycle event
- **WHEN** a worktree is added, removed, updated, or changes deployment status
- **THEN** the daemon SHALL emit a worktree lifecycle event containing the worktree path and session name

#### Scenario: Operation lifecycle event
- **WHEN** a daemon operation starts, finishes, fails, or is rejected because the session is busy
- **THEN** the daemon SHALL emit an operation lifecycle event containing the affected session and operation metadata

#### Scenario: Deployment progress event
- **WHEN** deployment setup, compose startup, retries, healthcheck readiness, completion, failure, or deployment diagnostic output occurs
- **THEN** the daemon SHALL emit deployment progress events equivalent to the existing operation progress information
- **AND** those events SHALL NOT include raw long-running service stdout or stderr chunks

#### Scenario: Compose status event
- **WHEN** the normalized compose status snapshot for a session changes
- **THEN** the daemon SHALL emit a compose status change event containing the current snapshot and previous snapshot when available

#### Scenario: Service lifecycle event
- **WHEN** a managed service is discovered, starts, stops, crashes, is removed, or changes compose state
- **THEN** the daemon SHALL emit a service lifecycle event naming the service and current service status

#### Scenario: Healthcheck status event
- **WHEN** an app-port healthcheck state changes for a service and container port
- **THEN** the daemon SHALL emit a healthcheck status change event containing service, container port, previous state when available, and current healthcheck result

#### Scenario: Tunnel lifecycle event
- **WHEN** a local HTTP tunnel route opens, fails, closes, resets, or is dropped
- **THEN** the daemon SHALL emit a tunnel lifecycle event containing service, container port, host port when available, hostname or failure details when available, and tunnel state details

#### Scenario: Service log output is streamed
- **WHEN** a request-scoped service log stream receives service stdout or stderr
- **THEN** the daemon SHALL NOT emit raw service log chunks as unified events
- **AND** log consumers SHALL use the worktree log stream endpoint for that output

### Requirement: Daemon Event Bus
The daemon SHALL own an in-memory event bus that records bounded event history and fans events out to live subscribers without blocking deployment operations.

#### Scenario: Event is published
- **WHEN** a subsystem publishes a unified event
- **THEN** the event bus SHALL assign the next monotonic sequence id
- **AND** the event bus SHALL append the envelope to bounded history
- **AND** the event bus SHALL deliver the envelope to matching live subscribers

#### Scenario: Subscriber fails
- **WHEN** a subscriber callback throws or its stream is closed
- **THEN** the event bus SHALL remove or ignore that subscriber
- **AND** event publication SHALL continue for other subscribers
- **AND** the deployment operation that published the event SHALL NOT fail solely because of the subscriber failure

#### Scenario: History capacity is exceeded
- **WHEN** publishing an event would exceed the configured history capacity
- **THEN** the event bus SHALL discard the oldest retained events
- **AND** it SHALL retain the newest events for later replay

### Requirement: Session Deployment Monitoring
The daemon SHALL monitor initialized deployment sessions and emit unified events when observed Docker service state, app-port healthcheck, tunnel, aggregate deployment status, or service summary state changes. App-port healthcheck monitoring SHALL be scoped to app services present in the current deployed Docker service snapshot.

#### Scenario: Monitor starts after service discovery
- **WHEN** an `up` operation discovers managed services for a session
- **THEN** the daemon SHALL start or refresh a monitor for that session
- **AND** the monitor SHALL use Docker cache snapshots for future managed service state collection

#### Scenario: Docker event changes service state
- **WHEN** Docker events update cached state for a monitored managed service
- **THEN** the daemon SHALL emit the corresponding service lifecycle and aggregate deployment events on the next monitor observation

#### Scenario: Periodic Docker reconciliation changes service state
- **WHEN** periodic Docker cache reconciliation discovers a service state change that was not delivered through events
- **THEN** the daemon SHALL emit the same unified events as it would for an event-delivered state change

#### Scenario: Monitor starts after daemon restart
- **WHEN** the daemon restarts and finds initialized deployment sessions
- **THEN** the daemon SHALL start or refresh monitors for resolvable initialized sessions
- **AND** it SHALL publish future deployment state events without requiring a new `up` operation

#### Scenario: Service crashes after deployment completion
- **WHEN** a monitored service transitions from a running state to an exited, dead, failed, or otherwise failure-like state after `up` completed
- **THEN** the daemon SHALL emit a service crashed event for that service
- **AND** the daemon SHALL emit a worktree deployment status change event when the aggregate deployment status changes

#### Scenario: Service stops after down
- **WHEN** a `down` operation stops services for a session
- **THEN** the daemon SHALL emit service stopped or removed events for affected managed services
- **AND** the daemon SHALL stop monitoring that session after the down operation completes

#### Scenario: Healthcheck changes after startup
- **WHEN** a monitored app-port healthcheck changes from healthy to failed, failed to healthy, waiting to healthy, or any other supported healthcheck state transition
- **THEN** the daemon SHALL emit one healthcheck status change event for the affected service and container port

#### Scenario: Selective deployment monitor ignores absent app services
- **WHEN** a monitored generated-compose deployment contains only a selected subset of configured app services
- **AND** an unselected configured app service is absent from the current deployed Docker service snapshot
- **THEN** the daemon SHALL NOT emit app-port healthcheck events for the absent app service
- **AND** absent app-service healthchecks SHALL NOT cause an aggregate deployment status change to `running_partial`

#### Scenario: Aggregate deployment state changes
- **WHEN** a monitor observes a change to aggregate deployment status or service summary counts
- **THEN** the daemon SHALL emit a worktree deployment status change event for the affected session
- **AND** the event SHALL include the current deployment status and service summary

#### Scenario: Snapshot collection fails
- **WHEN** the monitor cannot collect Docker cache, healthcheck, or tunnel status for a session
- **THEN** the daemon SHALL keep the monitor alive for future attempts
- **AND** it SHALL NOT terminate the daemon or the managed deployment solely because of the monitor error

### Requirement: Deployment Status Event Payload
The unified worktree deployment status event SHALL use the daemon deployment lifecycle model and include enough aggregate data for clients to update visible status without guessing.

#### Scenario: Deployment status event is emitted
- **WHEN** a worktree deployment status change event is published
- **THEN** its status SHALL be one of `not_started`, `pending`, `checking`, `running`, `running_partial`, `failed`, `stopped`, or `unknown`
- **AND** it SHALL include the affected `sessionName`
- **AND** it SHALL include the previous status when known

#### Scenario: Service summary is included
- **WHEN** the daemon can compute managed service counts for a deployment status event
- **THEN** the event SHALL include a service summary with `total` and `running` counts
- **AND** the summary SHALL exclude internal init services

#### Scenario: Client receives unknown future status data
- **WHEN** a client receives a deployment status event whose optional summary fields are not recognized
- **THEN** the client SHALL be able to ignore unknown fields without rejecting the event envelope

### Requirement: Operation Start Deployment Status Event
The daemon SHALL surface a worktree deployment status transition to `pending` when a daemon-owned `up` operation starts, including before the deployment has initialized persisted worktree state or started session monitoring.

#### Scenario: Up operation starts before initialization
- **WHEN** the daemon accepts an `up` operation for a worktree session without initialized wos state
- **THEN** it SHALL publish an operation lifecycle event for the started operation
- **AND** it SHALL publish a worktree deployment status change event with status `pending` for that session
- **AND** the event envelope SHALL include `sessionName`, `operationId`, and `worktreePath` when available

#### Scenario: Status event precedes monitor startup
- **WHEN** first-run setup or init script execution is running before managed services are discovered
- **THEN** clients SHALL be able to observe the pending deployment status from unified events without waiting for the session monitor to start

#### Scenario: Operation start status is reconciled later
- **WHEN** the active `up` operation later emits deployment progress, completes, fails, or starts monitoring services
- **THEN** subsequent unified events and UI snapshots SHALL remain authoritative for the current worktree deployment state
- **AND** clients SHALL be able to reconcile any optimistic pending state through existing snapshot endpoints

### Requirement: Event Replay And Reconciliation
The system SHALL support bounded replay for reconnecting clients and SHALL keep snapshot APIs authoritative for recovery.

#### Scenario: Client reconnects with a retained last event id
- **WHEN** a client subscribes with `Last-Event-ID` matching an event still retained in history
- **THEN** the daemon SHALL replay events after that id before streaming new events

#### Scenario: Client reconnects after history eviction
- **WHEN** a client subscribes with `Last-Event-ID` older than the retained history
- **THEN** the daemon SHALL allow the client to connect
- **AND** the client SHALL be able to recover by refetching authoritative snapshot endpoints

#### Scenario: Daemon restarts
- **WHEN** the daemon restarts
- **THEN** event sequence ids and in-memory history MAY reset
- **AND** clients SHALL recover state by refetching snapshot endpoints after reconnect

### Requirement: Restored Tunnel Lifecycle Events
The daemon SHALL publish unified tunnel lifecycle events for tunnel routes restored during daemon startup.

#### Scenario: Restored route emits tunnel opened event
- **WHEN** daemon startup restores a tunnel route for session `s`, service `api`, container port `3000`, host port `21432`, and hostname `feature-api.example.com`
- **THEN** the daemon SHALL publish a tunnel lifecycle event for session `s`
- **AND** the event SHALL include service `api`, container port `3000`, host port `21432`, hostname `feature-api.example.com`, URL `http://feature-api.example.com`, and active state

#### Scenario: Skipped restore candidate does not emit active tunnel event
- **WHEN** daemon startup skips a restore candidate because its metadata is stale, invalid, from another wos home, or not confirmed by Docker published ports
- **THEN** the daemon SHALL NOT publish an active tunnel lifecycle event for that skipped candidate
- **AND** it SHALL continue publishing events for other successfully restored routes

#### Scenario: Restored events are available through event history
- **WHEN** tunnel restoration publishes lifecycle events during daemon startup
- **THEN** the unified event bus SHALL append those events to bounded history
- **AND** later subscribers SHALL be able to replay the retained restored tunnel events according to normal event history behavior

### Requirement: Worktree Removal Events
The daemon SHALL publish unified events that allow clients to observe worktree removal operations and refresh authoritative project/worktree snapshots.

#### Scenario: Removal operation lifecycle
- **WHEN** a `worktree-remove` operation starts, finishes, fails, or conflicts
- **THEN** the daemon SHALL publish the corresponding operation lifecycle event
- **AND** the event envelope SHALL include the operation id, session name, and worktree path when available

#### Scenario: Worktree removed lifecycle event
- **WHEN** a `worktree-remove` operation successfully removes a Git worktree
- **THEN** the daemon SHALL publish a `worktree.removed` event for the removed session
- **AND** clients SHALL be able to fetch the project list endpoint to retrieve an authoritative snapshot without the removed worktree

### Requirement: Managed Worktree Creation Events
The daemon SHALL publish unified events for managed worktree creation operations and successful worktree creation.

#### Scenario: Worktree create operation lifecycle
- **WHEN** a managed worktree creation operation starts, finishes, fails, or conflicts
- **THEN** the daemon SHALL publish the corresponding operation lifecycle event
- **AND** the event envelope SHALL include the operation id, project id when available, and target worktree path when available

#### Scenario: Worktree created lifecycle event
- **WHEN** a managed worktree creation operation successfully creates a Git worktree
- **THEN** the daemon SHALL publish a `worktree.created` event
- **AND** the event SHALL include project id, source worktree path, created worktree path, worktree name, checkout mode, and branch when applicable
- **AND** clients SHALL be able to fetch the project list endpoint to retrieve an authoritative snapshot with the created worktree

#### Scenario: Worktree creation fails
- **WHEN** managed worktree creation fails before a Git worktree is created
- **THEN** the daemon SHALL publish a failed operation lifecycle event
- **AND** it SHALL NOT publish `worktree.created`

### Requirement: Terminal Session Lifecycle Events
The daemon SHALL publish unified events for terminal session lifecycle changes.

#### Scenario: Terminal session started
- **WHEN** the daemon starts a terminal session for a worktree
- **THEN** it SHALL publish a terminal session lifecycle event
- **AND** the event SHALL include terminal session id, worktree path, session status, and created timestamp

#### Scenario: Terminal session attached
- **WHEN** a client attaches to a running terminal session
- **THEN** the daemon SHALL publish a terminal session attachment event
- **AND** the event SHALL identify the terminal session id and worktree path

#### Scenario: Terminal session exited
- **WHEN** a terminal session process exits
- **THEN** the daemon SHALL publish a terminal session exited event
- **AND** the event SHALL include terminal session id, worktree path, exit code or signal when available, and exit timestamp

### Requirement: Terminal Events Are Snapshot-Reconcilable
Terminal session events SHALL be hints for UI refresh and SHALL NOT be the only source of terminal session state.

#### Scenario: Client receives terminal event
- **WHEN** a UI client receives a terminal session lifecycle event
- **THEN** it SHALL be able to fetch the terminal session list endpoint for the affected worktree
- **AND** the endpoint response SHALL be authoritative for current daemon-owned terminal sessions

#### Scenario: Client misses terminal events
- **WHEN** a UI client reconnects after missing terminal session events
- **THEN** it SHALL recover visible terminal state by fetching the terminal session list endpoint
- **AND** it SHALL NOT need replay of previous-daemon terminal events after daemon restart

### Requirement: Terminal Lifecycle Event Taxonomy
The daemon SHALL publish unified terminal lifecycle events that help clients reconcile terminal snapshots without carrying PTY output.

#### Scenario: Terminal session created
- **WHEN** the daemon creates a terminal session
- **THEN** it SHALL publish a terminal lifecycle event identifying the terminal session id, worktree path, session status, created timestamp, and current dimensions when available

#### Scenario: Terminal attachment changes
- **WHEN** a terminal attachment connects, disconnects, or changes control ownership
- **THEN** the daemon SHALL publish a terminal lifecycle event identifying the terminal session id and enough attachment summary data for clients to know that snapshots should be refreshed

#### Scenario: Terminal session exits
- **WHEN** a terminal session process exits
- **THEN** the daemon SHALL publish a terminal lifecycle event identifying the terminal session id, worktree path, exited status, exit timestamp, and exit code or signal when available

### Requirement: Terminal Events Are Reconciliation Hints
Terminal unified events SHALL be hints for snapshot reconciliation and SHALL NOT be the authoritative carrier for terminal output, replay, or full attachment state.

#### Scenario: Client receives terminal event
- **WHEN** a UI client receives a terminal lifecycle event
- **THEN** it SHALL be able to fetch terminal snapshot APIs for authoritative current terminal state
- **AND** the event payload SHALL NOT be required to contain all terminal session details

#### Scenario: Client misses terminal events
- **WHEN** a UI client reconnects after missing terminal lifecycle events
- **THEN** it SHALL recover visible terminal state from terminal snapshot APIs
- **AND** it SHALL NOT need replay of previous-daemon terminal lifecycle events after daemon restart

#### Scenario: Terminal emits PTY output
- **WHEN** a terminal session emits raw PTY output or terminal control sequences
- **THEN** the daemon SHALL NOT publish that output through the unified event bus
- **AND** the event bus SHALL NOT retain terminal replay payloads

### Requirement: Tunnel Events Use Effective URL Scheme
Unified tunnel lifecycle events SHALL include active tunnel URLs with the effective tunnel listener scheme.

#### Scenario: HTTPS active tunnel event
- **WHEN** the daemon publishes a tunnel lifecycle event for an active tunnel
- **AND** effective `tunnel.ssl.enabled` is `true`
- **THEN** the event SHALL include the active tunnel URL with the `https://` scheme

#### Scenario: HTTP active tunnel event
- **WHEN** the daemon publishes a tunnel lifecycle event for an active tunnel
- **AND** effective `tunnel.ssl.enabled` is `false`
- **THEN** the event SHALL preserve the existing active tunnel URL with the `http://` scheme

#### Scenario: Restored tunnel event uses current scheme
- **WHEN** daemon startup restores an active tunnel route
- **THEN** the restored tunnel lifecycle event SHALL include a URL using the current effective tunnel listener scheme

### Requirement: Certificate Lifecycle Events
The system SHALL define typed unified events for certificate issuance, renewal, activation, and failure.

#### Scenario: Certificate issued event
- **WHEN** the daemon successfully obtains a Let's Encrypt certificate for a listener
- **THEN** it SHALL publish a certificate lifecycle event with state `issued`
- **AND** the event SHALL include listener kind, certificate source, covered hostnames, and expiration time when known

#### Scenario: Certificate renewed event
- **WHEN** the daemon successfully renews a Let's Encrypt certificate for a listener
- **THEN** it SHALL publish a certificate lifecycle event with state `renewed`
- **AND** the event SHALL include listener kind, certificate source, covered hostnames, and expiration time when known

#### Scenario: Certificate activated event
- **WHEN** the daemon activates certificate material on a Web UI or tunnel listener
- **THEN** it SHALL publish a certificate lifecycle event with state `activated`
- **AND** the event SHALL include listener kind and activation time

#### Scenario: Certificate failed event
- **WHEN** certificate issuance, renewal, DNS challenge handling, storage, or listener activation fails
- **THEN** the daemon SHALL publish a certificate lifecycle event with state `failed`
- **AND** the event SHALL include listener kind, failure phase, and an actionable failure message

### Requirement: Certificate Event Replay
The system SHALL retain recent certificate lifecycle events in unified event history according to existing event replay behavior.

#### Scenario: Later subscriber receives retained failure
- **WHEN** the daemon publishes a certificate failure event
- **AND** a UI client subscribes to unified events after the failure
- **THEN** the retained event history SHALL be able to replay that certificate failure according to normal event history behavior

#### Scenario: Later subscriber receives retained activation
- **WHEN** the daemon publishes a certificate activation event
- **AND** a UI client subscribes to unified events after activation
- **THEN** the retained event history SHALL be able to replay that certificate activation according to normal event history behavior

### Requirement: Terminal Metadata Update Events
The daemon SHALL publish a unified terminal metadata update event when terminal session user-visible metadata changes.

#### Scenario: Terminal session title changes
- **WHEN** a terminal session title is set, changed, or cleared
- **THEN** the daemon SHALL publish a terminal metadata update event
- **AND** the event SHALL identify the terminal session id, worktree path, and changed timestamp

#### Scenario: Terminal metadata event omits PTY output
- **WHEN** the daemon publishes a terminal metadata update event
- **THEN** the event SHALL NOT include terminal PTY output, replay buffers, or attachment output data
- **AND** clients SHALL fetch terminal snapshot APIs for authoritative current terminal state

#### Scenario: Client receives terminal metadata update
- **WHEN** a UI client receives a terminal metadata update event
- **THEN** it SHALL be able to fetch terminal snapshots and observe the latest terminal session title
- **AND** missing the event SHALL NOT prevent recovery through terminal snapshot APIs


### Requirement: agent.activity.changed unified event
The unified event vocabulary SHALL include `agent.activity.changed`, scoped to the worktree like `terminal.*` events, carrying the terminal session id (when bound), the worktree, the full derived `agentActivity` block, and the originating `AgentActivityEvent` (`eventId`, `agent`, `event`, `severity`, `summary`). The event MUST be self-contained so subscribers (including the future notification engine) can render it without additional lookups, and MUST be emitted at most once per ingested `eventId`.

#### Scenario: State transition publishes unified event
- **WHEN** an ingested agent event changes a session's derived activity state
- **THEN** an `agent.activity.changed` event is published on the event bus and delivered over SSE to subscribed clients

#### Scenario: Deduplicated ingest emits no duplicate event
- **WHEN** a duplicate `eventId` is ingested
- **THEN** no additional `agent.activity.changed` event is published

### Requirement: Notification raised event
The unified event taxonomy SHALL include a `notification.raised` event published by the notification engine when it renders a notification for a matching, non-suppressed, non-duplicate source event. The payload SHALL carry the rendered, channel-agnostic notification (at least `kind`, `title`, `body`, `severity`, click-through `link`, and `dedupeKey`, plus optional `worktreePath` and `terminalSessionId`) so subscribers — delivery channels, the open web client, and any future notification inbox — can render it without additional lookups.

#### Scenario: Notification raised event is emitted
- **WHEN** the notification engine raises a notification for a source event
- **THEN** the daemon SHALL publish a `notification.raised` unified event whose payload contains the rendered notification

#### Scenario: Notification raised event is self-contained
- **WHEN** a subscriber receives a `notification.raised` event
- **THEN** the payload SHALL contain the title, body, severity, link, and dedupeKey needed to render or deliver the notification without further queries

#### Scenario: Suppressed event raises no notification event
- **WHEN** a source event is suppressed or de-duplicated by the engine
- **THEN** no `notification.raised` event SHALL be published for it

### Requirement: Workflow Status And Comment Events
The system SHALL emit unified events when the workflow status catalog, a worktree's board assignment, or a worktree's comments change, so that clients can keep the Kanban board and worktree dossier current without polling. These events SHALL be snapshot-reconcilable: their payloads carry enough identity for a client to refetch the affected snapshot rather than embedding full state.

#### Scenario: Status catalog change event
- **WHEN** the global workflow status catalog is created, updated, reordered, or has a status deleted
- **THEN** the daemon SHALL emit a status catalog change event sufficient for clients to refetch the catalog

#### Scenario: Worktree board change event
- **WHEN** a worktree's workflow status assignment or within-status order changes
- **THEN** the daemon SHALL emit a worktree board change event containing the worktree path, the new status id (or null when unassigned), and the order

#### Scenario: Worktree comment change event
- **WHEN** a worktree comment is added or removed
- **THEN** the daemon SHALL emit a worktree comment change event containing the worktree path
- **AND** clients SHALL treat it as a hint to refetch that worktree's comments

#### Scenario: Status deletion reassignment is observable
- **WHEN** deleting a status reassigns worktrees to unassigned
- **THEN** the daemon SHALL emit events sufficient for clients to reflect both the catalog change and the affected worktrees' new unassigned state
