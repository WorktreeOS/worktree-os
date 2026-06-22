# wos-worktree-board Specification

## Purpose
Track where each worktree sits in a human workflow as a separate axis from the derived `DeploymentStatus`. This capability owns the global, freeform workflow status catalog (a single ordered list of statuses persisted at `$WOS_HOME/statuses.json`, seeded once with presets), the per-worktree status assignment with fractional within-column ordering (persisted globally at `$WOS_HOME/board.json`, keyed by absolute worktree path), and the per-worktree manual comments stored alongside the existing worktree note. It defines the default-unassigned rule, status deletion with worktree reassignment to unassigned, stale-path tolerance, and reuses the existing worktree note as the description. The workflow status is set by a person and never overwrites — and is never overwritten by — the runtime-derived deployment status.

## Requirements

### Requirement: Global Workflow Status Catalog
The system SHALL maintain a single global, ordered catalog of freeform workflow statuses, persisted at `$WOS_HOME/statuses.json`, where each status has a stable id, a display name, a color, and an order. The catalog SHALL be shared across all projects and SHALL impose no transition rules between statuses.

#### Scenario: Catalog is seeded with presets on first use
- **WHEN** the status catalog is read and no `statuses.json` exists
- **THEN** the system SHALL seed the catalog with the preset statuses `to dev`, `develop`, `review`, `to merge`, and `merged` in that order
- **AND** each preset SHALL be assigned a stable id and a default color
- **AND** the seeded catalog SHALL be persisted to `$WOS_HOME/statuses.json`

#### Scenario: Create a status
- **WHEN** a caller creates a status with a name and a color
- **THEN** the system SHALL append a new status with a stable id at the end of the catalog order
- **AND** it SHALL persist the updated catalog

#### Scenario: Rename or recolor a status
- **WHEN** a caller updates an existing status name or color
- **THEN** the system SHALL update only that status while preserving its id and any existing worktree assignments to it
- **AND** it SHALL persist the updated catalog

#### Scenario: Reorder statuses
- **WHEN** a caller changes the order of a status in the catalog
- **THEN** the system SHALL persist the new catalog order
- **AND** it SHALL NOT change any worktree status assignment

### Requirement: Workflow Status Is Independent Of Deployment Status
The system SHALL keep the human-controlled workflow status separate from the derived `DeploymentStatus`, and changing one SHALL NOT change the other.

#### Scenario: Changing workflow status does not affect the runtime
- **WHEN** a worktree's workflow status is changed
- **THEN** the system SHALL NOT start, stop, or otherwise alter the worktree's runtime or its derived `DeploymentStatus`

#### Scenario: Deployment status changes do not affect workflow status
- **WHEN** a worktree's derived `DeploymentStatus` changes
- **THEN** the system SHALL NOT change that worktree's workflow status assignment

### Requirement: Worktree Workflow Status Assignment And Ordering
The system SHALL persist, per worktree, its assigned workflow status and its order within that status, in a single global store at `$WOS_HOME/board.json`, keyed by the absolute worktree path. The order SHALL be represented as a fractional index so that inserting a worktree between two others does not require rewriting other entries.

#### Scenario: Assign a worktree to a status
- **WHEN** a caller assigns a worktree to a status with an order
- **THEN** the system SHALL persist `{ statusId, order }` for that worktree's absolute path in `board.json`
- **AND** the assignment SHALL be readable across all projects for board rendering

#### Scenario: Reorder within a status using a fractional index
- **WHEN** a caller moves a worktree between two neighbors in the same status
- **THEN** the system SHALL assign an order strictly between the two neighbors' orders
- **AND** it SHALL NOT rewrite the orders of the unaffected worktrees in that status

#### Scenario: Unassigned worktree
- **WHEN** a worktree has no entry in `board.json`
- **THEN** the system SHALL treat it as unassigned (no workflow status)

#### Scenario: Stale path entries are ignored
- **WHEN** `board.json` contains an assignment whose worktree path no longer exists
- **THEN** the system SHALL ignore that entry when producing board data
- **AND** it SHALL NOT fail the board read because of the stale entry

### Requirement: Default Unassigned Workflow Status
The system SHALL leave newly created or newly discovered worktrees unassigned, and SHALL NOT auto-assign a workflow status as a side effect of worktree creation or discovery.

#### Scenario: New worktree is unassigned
- **WHEN** a worktree is created or first discovered
- **THEN** the system SHALL NOT write a workflow status assignment for it
- **AND** the worktree SHALL be reported as unassigned until a caller assigns it

### Requirement: Status Deletion Reassigns Worktrees
The system SHALL allow deleting any status, and SHALL move every worktree assigned to a deleted status back to unassigned rather than deleting those worktrees or blocking the deletion.

#### Scenario: Delete a status that has assigned worktrees
- **WHEN** a caller deletes a status that has worktrees assigned to it
- **THEN** the system SHALL remove the status from the catalog
- **AND** it SHALL set every affected worktree to unassigned
- **AND** it SHALL NOT delete the affected worktrees or their other metadata

### Requirement: Worktree Comments
The system SHALL persist, per worktree, an ordered list of manual, timestamped comments, stored alongside the existing worktree note keyed by the worktree path. Each comment SHALL have a stable id, text bounded to a maximum length, and a creation timestamp. The system SHALL support appending and deleting comments.

#### Scenario: Append a comment
- **WHEN** a caller adds a comment with text to a worktree
- **THEN** the system SHALL append a comment with a stable id, the text, and a creation timestamp to that worktree's comment list
- **AND** it SHALL persist the updated list

#### Scenario: Delete a comment
- **WHEN** a caller deletes a comment by id from a worktree
- **THEN** the system SHALL remove only that comment from the list
- **AND** it SHALL persist the updated list

#### Scenario: Comment text exceeds the maximum length
- **WHEN** a caller adds a comment whose text exceeds the maximum length
- **THEN** the system SHALL reject the comment with a validation error
- **AND** it SHALL NOT persist a partial or truncated comment

### Requirement: Worktree Description Reuses The Existing Note
The system SHALL treat the existing per-worktree note as the worktree description and SHALL NOT introduce a separate description field.

#### Scenario: Description maps to the note
- **WHEN** a caller reads or edits a worktree's description
- **THEN** the system SHALL read or write the existing worktree note
- **AND** it SHALL NOT create a second persisted description field
