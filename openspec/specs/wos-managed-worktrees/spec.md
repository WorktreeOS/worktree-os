# wos-managed-worktrees Specification

## Purpose
TBD - created by archiving change add-managed-worktrees-and-terminals.

## Requirements

### Requirement: Managed Worktree Storage Root
The system SHALL store wos-created Git worktrees strictly under `$WOS_HOME/worktrees/{project}/{worktree-name}`.

#### Scenario: Default wos home is used
- **WHEN** `WOS_HOME` is not set
- **AND** the daemon creates managed worktree `feature-a` for project `app`
- **THEN** the target path SHALL be under the default wos home at `.wos/worktrees/app/feature-a`
- **AND** the worktree SHALL NOT be created under `~/worktrees`

#### Scenario: Custom wos home is used
- **WHEN** `WOS_HOME` is set to `/tmp/wos-home`
- **AND** the daemon creates managed worktree `feature-a` for project `app`
- **THEN** the target path SHALL be `/tmp/wos-home/worktrees/app/feature-a`

#### Scenario: Project segment is path safe
- **WHEN** a project display name contains whitespace, path separators, or characters unsafe for a directory name
- **THEN** the daemon SHALL derive a safe project directory segment
- **AND** it SHALL keep the segment stable for subsequent managed worktree creation for the same project

### Requirement: Managed Worktree Name Validation
The system SHALL accept only safe single-segment managed worktree names.

#### Scenario: Valid worktree name
- **WHEN** a user requests a managed worktree name containing only safe filename characters
- **THEN** the daemon SHALL use that name as the `{worktree-name}` target path segment

#### Scenario: Empty worktree name
- **WHEN** a user requests an empty managed worktree name
- **THEN** the daemon SHALL reject the request with a validation error
- **AND** it SHALL NOT create a Git worktree

#### Scenario: Path escape is requested
- **WHEN** a user requests a managed worktree name containing a path separator, `.` segment, `..` segment, or any value that would resolve outside the project worktrees directory
- **THEN** the daemon SHALL reject the request with a validation error
- **AND** it SHALL NOT create or mutate files outside `$WOS_HOME/worktrees/{project}`

#### Scenario: Target path already exists
- **WHEN** the resolved target path for a managed worktree already exists
- **THEN** the daemon SHALL reject the request with a validation error
- **AND** it SHALL NOT overwrite the existing path

### Requirement: Detached Managed Worktree Creation
The system SHALL create managed worktrees in detached checkout mode by default.

#### Scenario: Create worktree without branch
- **WHEN** a user creates a managed worktree without specifying a branch
- **THEN** the daemon SHALL create a Git worktree at `$WOS_HOME/worktrees/{project}/{worktree-name}`
- **AND** the created worktree SHALL be detached at the source worktree's current `HEAD`
- **AND** the daemon SHALL refresh the project worktree list after creation succeeds

#### Scenario: Detached create fails
- **WHEN** Git fails to create the detached worktree
- **THEN** the daemon SHALL return a failure that includes the Git error message
- **AND** it SHALL NOT publish a successful worktree creation event

### Requirement: Branch-Attached Managed Worktree Creation
The system SHALL allow users to create a managed worktree attached to an explicitly requested existing branch.

#### Scenario: Create worktree for existing branch
- **WHEN** a user creates a managed worktree and specifies branch `feature/login`
- **THEN** the daemon SHALL create a Git worktree at `$WOS_HOME/worktrees/{project}/{worktree-name}` attached to `feature/login`
- **AND** the daemon SHALL refresh the project worktree list after creation succeeds

#### Scenario: Branch does not exist
- **WHEN** a user creates a managed worktree and specifies a branch that cannot be resolved by Git
- **THEN** the daemon SHALL reject the request with a validation or Git error
- **AND** it SHALL NOT create a new branch implicitly

#### Scenario: Branch is already checked out elsewhere
- **WHEN** a user creates a managed worktree for a branch that Git refuses because it is already checked out in another worktree
- **THEN** the daemon SHALL return the Git failure message to the client
- **AND** it SHALL NOT retry with force or detach automatically

### Requirement: Managed Worktree Branch Preservation
The system SHALL NOT delete Git branches as part of managed worktree lifecycle operations.

#### Scenario: Managed worktree is removed
- **WHEN** a managed worktree is removed through wos
- **THEN** the Git worktree SHALL be removed according to existing worktree removal semantics
- **AND** wos SHALL NOT delete the branch associated with that worktree

#### Scenario: Detached managed worktree is removed
- **WHEN** a detached managed worktree is removed through wos
- **THEN** wos SHALL remove the Git worktree
- **AND** it SHALL NOT delete or alter refs in the source repository
