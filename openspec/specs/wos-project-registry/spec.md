# wos-project-registry Specification

## Purpose
TBD - created by archiving change develop-web-main-functionality. Update Purpose after archive.

## Requirements
### Requirement: Project Registry Storage
The system SHALL maintain a wos project registry under the resolved wos home directory, keyed by primary/source worktree path.

#### Scenario: Registry file absent
- **WHEN** the system loads the project registry and `<wos-home>/projects.json` does not exist
- **THEN** it SHALL return an empty registry without error
- **AND** it SHALL NOT create the file

#### Scenario: Project is registered
- **WHEN** the system registers a project for a primary/source worktree path
- **THEN** it SHALL persist the normalized primary/source path, stable project id, display name, creation timestamp, and last-seen timestamp
- **AND** the registry SHALL be written under `<wos-home>/projects.json`

#### Scenario: Project is registered again
- **WHEN** the system registers a project whose normalized primary/source path already exists in the registry
- **THEN** it SHALL update that project's last-seen timestamp
- **AND** it SHALL preserve the existing stable project id

### Requirement: Automatic Project Registration
The system SHALL register a project's primary/source worktree after a successful `wos up` for any worktree in that Git worktree set.

#### Scenario: Up succeeds in feature worktree
- **WHEN** `wos up` succeeds from a non-source worktree
- **THEN** the system SHALL resolve the Git primary/source worktree using the same source-worktree selection semantics used for clone volumes
- **AND** it SHALL register that primary/source worktree in the project registry

#### Scenario: Up fails
- **WHEN** `wos up` fails before completing the deployment operation
- **THEN** the system SHALL NOT register a new project solely because of that failed run

### Requirement: Manual Project Registration
The system SHALL allow a user to add a project by entering a filesystem path and SHALL store the resolved primary/source worktree for that repository.

#### Scenario: User enters primary source path
- **WHEN** the user submits an existing Git worktree path that is the selected primary/source worktree
- **THEN** the system SHALL add that path to the project registry
- **AND** the project SHALL appear in subsequent project list responses

#### Scenario: User enters non-source worktree path
- **WHEN** the user submits an existing Git worktree path that belongs to a worktree set whose selected primary/source worktree is a different path
- **THEN** the system SHALL register the selected primary/source worktree path
- **AND** it SHALL NOT create a separate project keyed by the submitted non-source worktree path

#### Scenario: User enters invalid path
- **WHEN** the user submits a path that does not resolve to a Git worktree
- **THEN** the system SHALL reject the add request with an actionable validation error
- **AND** it SHALL NOT write a project registry entry for that path

### Requirement: Project Worktree Discovery
The system SHALL discover worktrees for each registered project by running Git worktree discovery from the registered primary/source worktree.

#### Scenario: Registered project has multiple worktrees
- **WHEN** a registered project's repository reports multiple worktrees
- **THEN** the system SHALL return each non-bare worktree with its path, branch when available, HEAD when available, detached flag, source-worktree flag, session name, and deployment status

#### Scenario: Registered project path is stale
- **WHEN** a registered primary/source worktree path no longer exists or no longer resolves as a Git worktree
- **THEN** the system SHALL keep the registry entry
- **AND** it SHALL report the project as stale or errored in project list responses
