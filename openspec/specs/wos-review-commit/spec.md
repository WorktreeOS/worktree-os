# wos-review-commit Specification

## Purpose
TBD - created by archiving change redesign-review-tab. Update Purpose after archive.
## Requirements
### Requirement: Git File Staging Operations
The system SHALL stage and unstage whole changed files in a selected worktree.

#### Scenario: Stage files
- **WHEN** the system is asked to stage one or more changed file paths in a worktree
- **THEN** it SHALL run the equivalent of `git add -- <paths>` from that worktree root
- **AND** each path SHALL be validated to resolve under the worktree root before running Git

#### Scenario: Unstage files
- **WHEN** the system is asked to unstage one or more staged file paths in a worktree
- **THEN** it SHALL run the equivalent of `git reset -q HEAD -- <paths>` from that worktree root

#### Scenario: Staging command fails
- **WHEN** Git fails to stage or unstage the requested paths
- **THEN** the system SHALL return a failure that preserves the Git error message
- **AND** it SHALL NOT report the staging change as applied

### Requirement: Git Commit Operation
The system SHALL create a commit in a selected worktree from the currently staged changes.

#### Scenario: Commit staged changes
- **WHEN** the system is asked to commit a worktree with a non-empty message and staged changes exist
- **THEN** it SHALL run the equivalent of `git commit -m <message>` from that worktree root
- **AND** it SHALL return the new commit identifier and a short summary

#### Scenario: Commit with nothing staged
- **WHEN** the system is asked to commit and there are no staged changes
- **THEN** it SHALL reject the request without creating a commit
- **AND** the rejection SHALL be distinguishable from a Git execution error

#### Scenario: Amend the latest commit
- **WHEN** the system is asked to commit with amend enabled
- **THEN** it SHALL run the equivalent of `git commit --amend` folding the staged changes into the latest commit

#### Scenario: Commit command fails
- **WHEN** Git fails to create the commit
- **THEN** the system SHALL return a failure that preserves the Git error message

### Requirement: Git Push Operation
The system SHALL push commits from a selected worktree to its remote.

#### Scenario: Push current branch
- **WHEN** the system is asked to push a worktree whose current branch has an upstream
- **THEN** it SHALL run the equivalent of `git push` from that worktree root
- **AND** it SHALL return the push summary

#### Scenario: Push a branch without upstream
- **WHEN** the system is asked to push a worktree whose current branch has no upstream
- **THEN** it SHALL set the upstream while pushing (equivalent to `git push -u origin <branch>`)

#### Scenario: Push command fails
- **WHEN** Git rejects the push
- **THEN** the system SHALL return a failure that preserves the Git error message

### Requirement: Worktree Head State Detection
The system SHALL report whether a worktree's `HEAD` is attached to a branch or detached.

#### Scenario: Attached head
- **WHEN** the system inspects a worktree checked out on a branch
- **THEN** it SHALL report the head as attached with the branch name

#### Scenario: Detached head
- **WHEN** the system inspects a worktree with a detached `HEAD`
- **THEN** it SHALL report the head as detached with the current commit identifier
- **AND** it SHALL NOT report a branch name

### Requirement: In-Place Branch Creation
The system SHALL create and switch to a new branch in a worktree without altering the source repository's checked-out refs.

#### Scenario: Create branch on a detached head
- **WHEN** the system is asked to create a branch with a valid name in a worktree
- **THEN** it SHALL run the equivalent of `git switch -c <name>` from that worktree root
- **AND** subsequent commits SHALL be recorded on the new branch

#### Scenario: Invalid or existing branch name
- **WHEN** the requested branch name is invalid or already exists
- **THEN** the system SHALL reject the request without creating or switching a branch
- **AND** it SHALL preserve the Git error message

### Requirement: Repository Config File
The system SHALL read an optional, committed repository config file at `<repo_root>/.wos/config.yaml`, independent of the deploy config, and SHALL treat it as extensible for future sections.

#### Scenario: Config file is absent
- **WHEN** a worktree has no `.wos/config.yaml`
- **THEN** the system SHALL resolve repository config to defaults without error

#### Scenario: Config file defines commit message rules
- **WHEN** `.wos/config.yaml` contains a valid `commit.message` section with any of `provider`, `model`, `language`, or `instructions`
- **THEN** the system SHALL include those values in the resolved repository config

#### Scenario: Config file has malformed values
- **WHEN** `.wos/config.yaml` contains malformed `commit.message` values
- **THEN** the system SHALL fall back to defaults for the affected fields
- **AND** it SHALL warn about the invalid values without failing the load

#### Scenario: Config file has unknown sections
- **WHEN** `.wos/config.yaml` contains top-level keys other than `commit`
- **THEN** the system SHALL ignore the unknown keys
- **AND** it SHALL still resolve the recognized sections

### Requirement: AI Commit Message Generation
The system SHALL generate a commit message from a worktree's staged diff using a configured AI provider, applying repository commit rules.

#### Scenario: Generate from staged diff
- **WHEN** the system is asked to generate a commit message for a worktree with staged changes and a resolvable AI provider
- **THEN** it SHALL build a prompt from the staged diff and the resolved repository `commit.message.instructions` and `language`
- **AND** it SHALL request a single completion from the resolved provider and model
- **AND** it SHALL return the generated message text

#### Scenario: Provider resolution order
- **WHEN** the system resolves which provider and model to use for generation
- **THEN** it SHALL prefer the repository config `commit.message.provider` / `model`
- **AND** it SHALL otherwise use the global default commit-message provider / model
- **AND** it SHALL otherwise use the first configured AI provider

#### Scenario: No provider configured
- **WHEN** generation is requested and no AI provider can be resolved
- **THEN** the system SHALL return a structured "no AI provider configured" result distinguishable from a provider request failure
- **AND** it SHALL NOT attempt a network request

#### Scenario: Large staged diff
- **WHEN** the staged diff exceeds the generation input budget
- **THEN** the system SHALL truncate the diff to the budget before sending the request

#### Scenario: Provider request fails
- **WHEN** the AI provider request fails or returns an empty completion
- **THEN** the system SHALL return a failure that preserves the provider error
- **AND** it SHALL NOT create a commit as a side effect of generation

### Requirement: Git Fetch Operation
The system SHALL fetch remote refs for a selected worktree so its upstream tracking information can be refreshed without modifying the working tree.

#### Scenario: Fetch a worktree with a remote
- **WHEN** the system is asked to fetch a worktree whose current branch has a configured remote
- **THEN** it SHALL run the equivalent of `git fetch` from that worktree root
- **AND** it SHALL NOT modify the working tree or the checked-out commit

#### Scenario: Fetch a worktree without a remote or upstream
- **WHEN** the system is asked to fetch a worktree that has no configured remote for its branch
- **THEN** it SHALL complete without error, leaving upstream tracking unchanged

#### Scenario: Fetch command fails
- **WHEN** Git rejects the fetch (for example, an unreachable remote or authentication failure)
- **THEN** the system SHALL return a failure that preserves the Git error message

