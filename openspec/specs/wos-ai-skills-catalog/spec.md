# wos-ai-skills-catalog Specification

## Purpose
Catalog of repository-shipped AI skills for teaching agents wos CLI workflows and operational safety. The catalog gives AI agents focused, repository-local playbooks for starting, stopping, checking, and troubleshooting wos-managed services without rediscovering CLI workflows from source code or stale context.

## Requirements
### Requirement: Skills Package
The system SHALL provide a repository-local `packages/skills` workspace package for wos AI skills.

#### Scenario: Skills package exists
- **WHEN** the repository is inspected after the change
- **THEN** `packages/skills/package.json` SHALL exist
- **AND** the package metadata SHALL identify the package as a wos AI skills catalog
- **AND** the package SHALL NOT require runtime dependencies to read the shipped skill files

### Requirement: Catalog Index
The system SHALL provide a machine-readable catalog index for all shipped wos AI skills.

#### Scenario: Catalog index lists shipped skills
- **WHEN** an agent reads `packages/skills/index.json`
- **THEN** the index SHALL list every shipped skill by stable name
- **AND** each listed skill SHALL include a description
- **AND** each listed skill SHALL include the relative path to its `SKILL.md` entry file

#### Scenario: Catalog index paths resolve
- **WHEN** an agent resolves each entry path from `packages/skills/index.json` relative to `packages/skills`
- **THEN** every referenced `SKILL.md` file SHALL exist

### Requirement: WorktreeOS CLI Skill Coverage
The system SHALL ship AI skills that teach agents core wos CLI workflows.

#### Scenario: Core CLI workflow skills are present
- **WHEN** the skills catalog is inspected
- **THEN** it SHALL include skills for general wos CLI orientation, service lifecycle, service status and readiness, daemon management, web UI access, worktree operations, troubleshooting, and wos configuration

#### Scenario: Service lifecycle skill teaches start and stop operations
- **WHEN** an agent reads the service lifecycle skill
- **THEN** the skill SHALL explain how to start services with `wos up`
- **AND** the skill SHALL explain detached startup with `wos up -d`
- **AND** the skill SHALL explain selective startup with explicit service names or `--target`
- **AND** the skill SHALL explain stopping services with `wos down`

#### Scenario: Service status skill teaches readiness checks
- **WHEN** an agent reads the service status skill
- **THEN** the skill SHALL explain how to inspect a worktree deployment with `wos status`
- **AND** the skill SHALL explain how to wait for readiness with `wos wait --timeout <duration>`
- **AND** the skill SHALL explain that status and wait operate on the selected Git worktree

#### Scenario: Daemon skill teaches daemon operations
- **WHEN** an agent reads the daemon skill
- **THEN** the skill SHALL explain when to use `wos daemon --foreground`
- **AND** the skill SHALL explain when to use `wos daemon restart`
- **AND** the skill SHALL explain that regular CLI operations can start or contact the local daemon

#### Scenario: Worktree skill teaches scoped execution
- **WHEN** an agent reads the worktree skill
- **THEN** the skill SHALL explain the global `--cwd <path>` option for worktree-scoped commands
- **AND** the skill SHALL explain safe use of `wos worktree remove [--force]`
- **AND** the skill SHALL state that the primary/source worktree must not be removed through wos

### Requirement: Skill Command Accuracy
The system SHALL keep shipped skill instructions aligned with documented wos CLI commands.

#### Scenario: Skills reference supported commands
- **WHEN** a shipped `SKILL.md` recommends a wos command
- **THEN** the command SHALL correspond to an existing documented wos CLI command or option
- **AND** the skill SHALL NOT instruct agents to use unsupported package managers or non-wos service orchestration commands for wos-managed services

#### Scenario: Skills include safety guidance for destructive operations
- **WHEN** a shipped `SKILL.md` describes `wos up --force`, `wos down`, or `wos worktree remove`
- **THEN** the skill SHALL describe the operational effect before instructing the agent to run the command
- **AND** the skill SHALL prefer checking current state with `wos status` when that context is useful

### Requirement: English Skill Content
The system SHALL write all shipped wos AI skill content in English.

#### Scenario: Skill files are written in English
- **WHEN** a developer opens any shipped `packages/skills/**/SKILL.md` file
- **THEN** the instructional prose SHALL be written in English
- **AND** examples, headings, descriptions, and safety guidance SHALL be written in English except for literal command output, file names, command names, or quoted user-provided content

### Requirement: Human Catalog Documentation
The system SHALL provide human-readable documentation for the skills catalog.

#### Scenario: README describes catalog usage
- **WHEN** a developer opens `packages/skills/README.md`
- **THEN** the README SHALL describe the purpose of the catalog
- **AND** the README SHALL list the shipped skills
- **AND** the README SHALL explain that the catalog teaches wos CLI workflows for AI agents
