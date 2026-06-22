# wos-test-isolation Specification

## Purpose
TBD - created by archiving change isolate-daemon-tests-wos-home. Update Purpose after archive.
## Requirements
### Requirement: Repository tests isolate wos home state
The repository test command SHALL run tests with an isolated temporary `WOS_HOME` by default and SHALL remove that home when the test run completes.

#### Scenario: Default repository test command
- **WHEN** a developer runs the root test command
- **THEN** the test runner SHALL execute with `WOS_HOME` set to a temporary directory created for that run
- **AND** tests SHALL NOT use the developer's default wos home unless an individual test explicitly overrides the environment for a path-resolution scenario

#### Scenario: Test run teardown
- **WHEN** the test command exits successfully or unsuccessfully
- **THEN** the temporary test `WOS_HOME` SHALL be removed before the wrapper exits
- **AND** the wrapper SHALL preserve the test process exit status

### Requirement: Daemon tests isolate wos home state
Daemon tests SHALL run with an isolated wos home and SHALL NOT read, restore, or subscribe to sessions from the developer's default wos home unless the test explicitly opts into that behavior.

#### Scenario: Default daemon test startup
- **WHEN** a daemon test starts a daemon through the shared daemon test harness
- **THEN** the daemon SHALL use a temporary wos home controlled by the test
- **AND** the daemon SHALL NOT scan the user's default wos home for persisted sessions

#### Scenario: Restoration test opt-in
- **WHEN** a test verifies persisted tunnel, monitor, project, or session restoration
- **THEN** the test SHALL explicitly enable restoration
- **AND** the daemon SHALL restore only from the temporary wos home populated by that test

### Requirement: Test daemon teardown stops service log followers
Daemon test teardown SHALL stop all active service log followers owned by the test daemon before the test completes.

#### Scenario: Active log stream during teardown
- **WHEN** a daemon test has an active `service:<name>` log stream subscription
- **AND** the test daemon is stopped during teardown
- **THEN** the service log follower for that stream SHALL be stopped before teardown resolves

#### Scenario: Client disconnect during test
- **WHEN** a daemon test client cancels or aborts a service log stream response
- **THEN** the daemon SHALL unsubscribe the stream
- **AND** the associated follower SHALL be stopped when no remaining test subscriber uses that service stream

### Requirement: Daemon tests avoid live Docker log followers by default
Daemon tests SHALL NOT spawn real `docker compose logs --follow` processes by default.

#### Scenario: Test uses default daemon harness
- **WHEN** a test starts a daemon with the default daemon test harness
- **THEN** service log follower creation SHALL use injected fake followers or no-op followers unless the test explicitly requests live Docker behavior

#### Scenario: Regression guard after daemon tests
- **WHEN** a daemon test that opens service log streams completes
- **THEN** the test suite SHALL be able to assert that no `docker compose logs --follow` process referencing the test wos home remains

### Requirement: Test cleanup terminates only test-owned Docker Compose processes
Test cleanup SHALL terminate lingering Docker Compose processes only when they are owned by the current test run's isolated `WOS_HOME`.

#### Scenario: Lingering test-owned Compose process
- **WHEN** the test wrapper teardown finds a `docker compose` or `docker-compose` process whose command line references the temporary test `WOS_HOME`
- **THEN** the wrapper SHALL attempt to terminate that process before removing the temporary home
- **AND** it SHALL escalate if the process does not exit after a bounded wait

#### Scenario: Unrelated Docker process
- **WHEN** the process table contains Docker Desktop, Docker backend, or Compose processes that do not reference the temporary test `WOS_HOME`
- **THEN** test cleanup SHALL NOT terminate those processes

