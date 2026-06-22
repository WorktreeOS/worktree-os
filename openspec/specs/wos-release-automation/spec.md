# wos-release-automation Specification

## Purpose
TBD - created by archiving change add-tagged-binary-release-workflow. Update Purpose after archive.
## Requirements
### Requirement: Version Tag Release Workflow
The system SHALL provide a GitHub Actions workflow that starts release automation when a version tag is pushed.

#### Scenario: Version tag pushed
- **WHEN** a tag matching the configured version tag pattern is pushed to GitHub
- **THEN** GitHub Actions SHALL run the wos release workflow for that tag
- **AND** the workflow SHALL check out the tagged source revision

#### Scenario: Non-release push ignored
- **WHEN** a branch push or non-version tag push occurs
- **THEN** the wos release workflow SHALL NOT run

### Requirement: Cross-Platform Release Binary Assets
The release workflow SHALL build standalone wos executable assets for macOS arm64, Linux amd64, and Windows amd64 through the repository `build:binary` script.

#### Scenario: macOS arm64 asset built
- **WHEN** the release workflow builds the macOS arm64 target
- **THEN** it SHALL run the repository binary build through Bun
- **AND** it SHALL produce a release asset named for macOS arm64 and the pushed tag

#### Scenario: Linux amd64 asset built
- **WHEN** the release workflow builds the Linux amd64 target
- **THEN** it SHALL run the repository binary build through Bun
- **AND** it SHALL produce a release asset named for Linux amd64 and the pushed tag

#### Scenario: Windows amd64 asset built
- **WHEN** the release workflow builds binary assets for a pushed version tag
- **THEN** it SHALL run a Windows amd64 binary build target
- **AND** it SHALL produce a Windows `.exe` release asset named for Windows amd64 and the pushed tag

#### Scenario: Binary terminal backend has no node-pty dependency
- **WHEN** the release workflow or binary smoke tests build a standalone wos executable
- **THEN** the resulting daemon terminal backend SHALL NOT require `node-pty`
- **AND** it SHALL NOT require `node-pty` `spawn-helper` files from a source checkout to initialize terminal sessions under a supported Bun runtime

### Requirement: GitHub Release Publication
The release workflow SHALL publish a GitHub Release for the pushed version tag and attach the generated binary assets.

#### Scenario: Release published with assets
- **WHEN** all configured release binary assets build successfully
- **THEN** the workflow SHALL create a GitHub Release for the pushed tag
- **AND** it SHALL upload the macOS arm64, Linux amd64, and Windows amd64 binary assets to that release

#### Scenario: Build failure prevents publication
- **WHEN** any configured release binary asset fails to build
- **THEN** the workflow SHALL fail
- **AND** it SHALL NOT publish a release that omits the failed platform asset

#### Scenario: Release permissions scoped
- **WHEN** the workflow creates the GitHub Release or uploads release assets
- **THEN** it SHALL use GitHub Actions permissions that allow repository contents writes
- **AND** it SHALL NOT require a custom personal access token for normal repository release publishing

### Requirement: Release Binary Terminal Runtime
Standalone wos binaries SHALL support the terminal layer without requiring native `node-pty` packages, `spawn-helper` files, or source-checkout terminal helper artifacts.

#### Scenario: Binary starts terminal runtime
- **WHEN** a standalone wos executable starts on a supported Bun terminal platform
- **THEN** the daemon SHALL initialize the terminal runtime using the Bun-native terminal backend
- **AND** it SHALL NOT require `node-pty` or `node-pty` helper files to create terminal sessions

#### Scenario: Binary runtime lacks terminal support
- **WHEN** a standalone wos executable runs on a platform or Bun runtime that cannot provide required terminal semantics
- **THEN** the daemon SHALL report terminal support as unavailable with a clear diagnostic
- **AND** non-terminal daemon and web functionality SHALL continue to start when otherwise valid

#### Scenario: Release smoke test covers terminal runtime
- **WHEN** release automation or binary smoke tests validate a standalone wos executable
- **THEN** the smoke test SHALL verify that the terminal runtime can initialize or returns the expected terminal-unavailable diagnostic
- **AND** the test SHALL fail if terminal startup depends on source-checkout `node-pty` helper artifacts

### Requirement: Windows Release Smoke Coverage
Release automation SHALL smoke-test native Windows executable behavior before publishing Windows assets.

#### Scenario: Windows binary starts
- **WHEN** release automation builds the Windows amd64 executable asset
- **THEN** the workflow SHALL run a smoke command against that executable on a Windows runner
- **AND** the smoke command SHALL fail the workflow if the executable cannot start

#### Scenario: Windows daemon health smoke succeeds
- **WHEN** the Windows release smoke starts the daemon in foreground mode
- **THEN** the daemon SHALL bind the configured HTTP listener
- **AND** `GET /ui/v1/health` SHALL return successful daemon metadata

#### Scenario: Windows daemon lifecycle smoke succeeds
- **WHEN** the Windows release smoke runs daemon lifecycle commands
- **THEN** `wos start`, `wos web --no-open`, and `wos stop` SHALL operate through HTTP metadata and health
- **AND** the smoke SHALL fail if a Unix socket is required
