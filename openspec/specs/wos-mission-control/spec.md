# wos-mission-control Specification

## Purpose
TBD - created by archiving change add-mission-control. Update Purpose after archive.
## Requirements
### Requirement: Mission Control Wall
The web frontend SHALL render Mission Control on the root route `/` as a single wall (grid) of live terminal-screen snapshots drawn from terminal sessions across every registered project and worktree. The wall SHALL stay within the `quiet-workspace v3` visual language, treating "everything is fine" as the default state and reserving amber for the single awaiting-input accent.

#### Scenario: Wall renders across projects
- **WHEN** the user opens the root route and at least one live terminal session exists
- **THEN** Mission Control SHALL render one pane per live session pulled from all projects/worktrees
- **AND** each pane SHALL show the agent/shell glyph and label, the project and branch, and the session's current screen snapshot

#### Scenario: Wall reflects sessions appearing and disappearing
- **WHEN** a terminal session starts, exits, or is removed (per unified daemon events)
- **THEN** the wall SHALL add or remove the corresponding pane without a full page reload

### Requirement: Live Screen Snapshot Rendering
Mission Control SHALL render each pane from a terminal **screen snapshot** (the current visible grid as flat SGR-colored rows) using a lightweight ANSI→DOM renderer. The wall SHALL NOT mount a terminal emulator (xterm) per pane and SHALL NOT run terminal emulation in the browser for wall panes.

#### Scenario: Snapshot is rendered as styled text
- **WHEN** a pane receives a screen snapshot containing SGR color/attribute sequences
- **THEN** the renderer SHALL convert SGR runs (foreground/background, bold, dim, italic, underline, reverse, 256-color, truecolor) into styled DOM
- **AND** it SHALL NOT interpret cursor-addressing or alternate-screen control sequences (the snapshot is already a flat grid)

#### Scenario: TUI applications render correctly
- **WHEN** a session is running a full-screen TUI (for example Claude Code, Codex, or lazygit)
- **THEN** the pane SHALL display that TUI's current screen, including box-drawing and colored regions

### Requirement: Awaiting-Input Accent
Mission Control SHALL highlight, with the single amber accent, exactly the sessions whose agent is awaiting user input, using real daemon data (`agentActivity.state === "awaiting-input"`) and SHALL surface the captured question summary when present.

#### Scenario: Agent awaiting input is accented
- **WHEN** a session's `agentActivity.state` is `awaiting-input`
- **THEN** its pane SHALL carry the amber awaiting-input accent
- **AND** it SHALL display the `agentActivity.question.summary` text when present

#### Scenario: Working and idle sessions stay calm
- **WHEN** a session is working, running, idle, or exited
- **THEN** its pane SHALL NOT use the amber awaiting-input accent
- **AND** session state SHALL be expressed as a leading status dot plus word, never a bordered chip

### Requirement: Pane Geometry Modes
Mission Control SHALL provide selectable pane geometry modes that normalize the differing native geometries of captured screens (for example 221×56 versus 80×24): at minimum `hybrid`, `proportional`, `fit`, `top`, `bottom`, and `native`. The selected mode SHALL be a UI setting persisted in `localStorage` and restored on load.

#### Scenario: Hybrid mode adapts per pane
- **WHEN** the geometry mode is `hybrid`
- **THEN** panes wider than a column threshold SHALL render as a fit-to-width thumbnail
- **AND** narrower panes SHALL render with a readable font anchored to the latest rows

#### Scenario: Proportional mode preserves aspect
- **WHEN** the geometry mode is `proportional`
- **THEN** all panes SHALL share a fixed height and each pane's width SHALL follow its terminal's true `cols×rows` aspect ratio without clipping content

#### Scenario: Mode selection persists
- **WHEN** the user changes the geometry mode and later reloads Mission Control
- **THEN** the previously selected mode SHALL be restored from `localStorage`

### Requirement: Snapshot Cadence Setting
Mission Control SHALL expose a snapshot refresh cadence as a UI setting persisted in `localStorage`. The cadence SHALL drive how often the wall updates and SHALL act as the artificial render delay for the live snapshot stream.

#### Scenario: Cadence is configurable and persisted
- **WHEN** the user selects a refresh cadence
- **THEN** the wall SHALL update at approximately that cadence
- **AND** the chosen cadence SHALL be restored from `localStorage` on the next load

### Requirement: Quick Filters
Mission Control SHALL provide quick filters that narrow the wall to a subset of the live sessions, at minimum All, Waiting (awaiting-input), Agents (sessions with a detected agent), and by project.

#### Scenario: Waiting filter shows only blocked agents
- **WHEN** the user activates the Waiting filter
- **THEN** the wall SHALL show only sessions whose agent is awaiting input

#### Scenario: Project filter scopes the wall
- **WHEN** the user activates a project filter
- **THEN** the wall SHALL show only sessions belonging to that project's worktrees

### Requirement: Focus Overlay Full Attach
Mission Control SHALL let the user focus a single pane, opening an overlay that performs a full interactive terminal attach using the existing `XtermViewport`. Focusing SHALL be the only place the wall mounts a terminal emulator.

#### Scenario: Focusing a pane attaches the terminal
- **WHEN** the user focuses a pane
- **THEN** the overlay SHALL attach to that session via the existing terminal WebSocket and render it with `XtermViewport`

#### Scenario: Focusing an unread session marks it read
- **WHEN** the user focuses a session that has an `unreadSince` marker
- **THEN** attaching SHALL clear the unread marker per existing terminal-layer behavior

### Requirement: Agent Identity Source
Mission Control SHALL determine a pane's agent identity (Claude Code, Codex, OpenCode, or plain shell) from daemon agent detection (`activeCommand.agent` via the existing `terminal-agents` mapping) and SHALL NOT derive agent identity from the tmux `pane_current_command` value.

#### Scenario: Agent label comes from daemon detection
- **WHEN** a session has `activeCommand.agent` set
- **THEN** the pane SHALL show that agent's brand glyph and label
- **AND** the pane SHALL NOT label the session from a raw process/command string such as a version number

### Requirement: Mission Control Empty State
When no live terminal sessions exist, Mission Control SHALL present a project/worktree overview and onboarding instead of an empty wall, preserving the cross-project read-overview that previously lived on the home route.

#### Scenario: No live terminals shows project overview
- **WHEN** the root route loads and there are no live terminal sessions
- **THEN** Mission Control SHALL render a cross-project overview (registered projects and their worktrees) and onboarding guidance
- **AND** the left rail SHALL remain the project/worktree navigator

### Requirement: Default-Backend Pane Fallback
For sessions whose terminal backend cannot produce a screen snapshot (a backend without a screen grid), Mission Control SHALL render a non-live fallback pane rather than a broken or empty terminal view.

#### Scenario: Session without snapshot capability
- **WHEN** a session's backend returns no screen snapshot
- **THEN** the pane SHALL show session metadata (agent/shell, project, branch, status) and a notice that a live preview is unavailable
- **AND** the user SHALL still be able to focus the pane to attach interactively

