# wos-agent-plugin-install Specification

## Purpose
Detect missing or outdated wos agent plugins for known agents running in terminal sessions, suggest installation or update in the web UI, install through the headless Claude Code plugin CLI, and optionally auto-inject plugins when enabled.
## Requirements
### Requirement: Plugin install detection
When process detection identifies a known agent (claude, opencode, or codex) running in a wos terminal session, the daemon SHALL check whether the corresponding wos plugin is installed and SHALL expose the result as a `pluginInstalled` indicator on the session's agent detection metadata. Detection SHALL reflect the current registry/manifest state at the time of each detection and MUST NOT serve a stale result from a prior detection (no time-based status cache). For claude, installation SHALL be determined from the Claude Code plugin registry (`~/.claude/plugins/installed_plugins.json` containing an enabled `wos` plugin entry); legacy injected hook entries in `~/.claude/settings.json` MUST NOT count as installed. For opencode, installation is the plugin entry present in the opencode configuration. For codex, installation SHALL be determined from the headless `codex plugin list --json` output (an installed `wos` plugin entry). For claude, the daemon SHALL additionally compare the installed plugin version against the bundled `packages/plugin-claude/.claude-plugin/plugin.json` version and expose a `pluginOutdated` indicator when the installed version is older; for codex, the daemon SHALL likewise expose `pluginOutdated` against the bundled `packages/plugin-codex/.codex-plugin/plugin.json` version only when `codex plugin list --json` surfaces an installed semver (when it reports only a local/non-semver version, `pluginOutdated` SHALL be omitted). When the registry/listing is missing or unparseable, detection SHALL degrade to reporting the plugin as not installed.

#### Scenario: Missing plugin is flagged
- **WHEN** a claude process is detected in a session and the plugin registry has no wos entry
- **THEN** the session metadata indicates the plugin is missing

#### Scenario: Missing codex plugin is flagged
- **WHEN** a codex process is detected in a session and `codex plugin list --json` has no installed wos entry
- **THEN** the session metadata indicates the plugin is missing

#### Scenario: Legacy injection does not count as installed
- **WHEN** `~/.claude/settings.json` contains legacy wos hook entries but the plugin registry has no wos entry
- **THEN** the session metadata indicates the plugin is missing

#### Scenario: Outdated plugin is flagged
- **WHEN** the registry records wos plugin version 0.1.0 and the bundled plugin manifest declares 0.2.0
- **THEN** the session metadata indicates `pluginOutdated`

#### Scenario: Installed and current plugin is not flagged
- **WHEN** a detected agent has the wos plugin installed at the bundled version
- **THEN** neither a missing-plugin nor an outdated-plugin indication is shown

#### Scenario: Detection is not served from a stale cache
- **WHEN** the plugin registry changes (e.g. the plugin is installed or removed) between two detections of the same agent
- **THEN** the second detection reflects the new registry state without waiting for a cache expiry

### Requirement: Install prompt in the web UI
The web UI SHALL surface a quiet, dismissible suggestion near the session row only when the **focused** terminal session reports a detected agent (claude, opencode, or codex) whose wos plugin is missing (offering to install) or outdated (offering to update for claude or codex when a version is known). When the focused session reports no running agent, or a running agent whose plugin is installed and current, no install/update prompt SHALL be shown. The prompt MUST follow quiet-workspace styling (local accent, no global banner) and the update variant SHALL state that the update applies to new agent sessions. Triggering the action SHALL call the daemon's install/update endpoint and surface its result (including an agent-CLI-not-found failure naming the relevant CLI, e.g. "claude CLI not found" or "codex CLI not found") inline. Dismissal SHALL be scoped to the currently detected state (agent plus missing/outdated/current state): a dismissed prompt MUST NOT reappear while that state holds, but SHALL reappear when the detected state changes.

#### Scenario: Prompt appears only when a focused-session agent needs it
- **WHEN** the focused terminal session reports a running agent whose wos plugin is missing
- **THEN** an install suggestion is rendered near the session row

#### Scenario: Codex install prompt appears when missing
- **WHEN** the focused terminal session reports a running codex agent whose wos plugin is missing
- **THEN** an install suggestion is rendered near the session row and triggering it invokes the daemon install action for codex

#### Scenario: No prompt without a detected agent
- **WHEN** the focused terminal session reports no running agent
- **THEN** no install, update, or reinstall suggestion is rendered

#### Scenario: Update affordance for outdated plugin
- **WHEN** the focused session reports a claude agent with `pluginOutdated`
- **THEN** an update suggestion is rendered near the session row and triggering it invokes the daemon update action

#### Scenario: Dismissal is scoped to state and re-shown on change
- **WHEN** the user dismisses the suggestion for a detected state and the focused session's detected state later changes (for example missing to outdated, or a restarted agent in a different state)
- **THEN** the suggestion reappears for the new state, while it stays hidden as long as the dismissed state holds

### Requirement: Reinstall affordance for an installed claude plugin
The web UI SHALL offer a reinstall action near the session row when the focused terminal session reports a running **claude** agent whose wos plugin is installed and current. The reinstall action SHALL call the daemon reinstall endpoint, surface its result inline (including a "claude CLI not found" failure), and on success state that running agent sessions must reload the plugin or restart for the reinstall to take effect. The reinstall affordance SHALL NOT be offered for opencode.

#### Scenario: Reinstall offered for installed, current claude plugin
- **WHEN** the focused session reports a claude agent with the wos plugin installed at the bundled version
- **THEN** a reinstall affordance is rendered near the session row

#### Scenario: Reinstall not offered for opencode
- **WHEN** the focused session reports a running opencode agent
- **THEN** no reinstall affordance is rendered

#### Scenario: Reinstall reports reload requirement
- **WHEN** the user triggers reinstall and it succeeds
- **THEN** the UI states that running agent sessions must reload the plugin or restart for the change to take effect

### Requirement: Auto-inject setting
The system SHALL provide a global "auto-inject agent plugins" setting, default off. When enabled, wos SHALL ensure the Claude Code wos plugin is installed and current via the headless `claude plugin` CLI, ensure the Codex wos plugin is installed and current via the headless `codex plugin` CLI (registering the marketplace and installing/updating as needed for both), and ensure the OpenCode plugin entry exists in the opencode configuration via an idempotent write. Auto-inject failures (including an absent `claude` or `codex` CLI) MUST NOT break daemon startup or session spawning.

#### Scenario: Auto-inject installs the claude plugin
- **WHEN** auto-inject is enabled and the wos Claude Code plugin is not installed
- **THEN** the daemon registers the marketplace and installs the plugin so Claude Code started in new sessions loads the wos hooks without manual installation

#### Scenario: Auto-inject installs the codex plugin
- **WHEN** auto-inject is enabled and the wos Codex plugin is not installed
- **THEN** the daemon registers the codex marketplace and installs the plugin so Codex started in new sessions loads the wos hooks without manual installation

#### Scenario: Opencode config write is idempotent
- **WHEN** auto-inject is enabled and the opencode configuration already contains the plugin entry
- **THEN** the configuration file is left unchanged

#### Scenario: Default off
- **WHEN** the setting has never been changed
- **THEN** no configuration files are modified and no plugins are installed

### Requirement: Headless plugin install and update
The daemon SHALL install and update the wos Claude Code plugin exclusively through the headless `claude plugin` CLI (`marketplace add`, `install wos@<marketplace> --scope user`, `update wos`), never by writing the plugin registry or cache directly. The marketplace source SHALL be resolved through a single configurable resolver that defaults to the local repository root and supports a remote source (GitHub repo or URL) for distribution outside the source checkout. Marketplace registration MUST be idempotent. When the `claude` CLI is not available, install/update actions SHALL fail with a typed, user-visible error.

#### Scenario: Install action wires marketplace and plugin
- **WHEN** the install action runs on a machine without the wos marketplace registered
- **THEN** the daemon registers the marketplace from the resolved source and installs the plugin, and detection subsequently reports it installed

#### Scenario: Update action refreshes an outdated plugin
- **WHEN** the update action runs while the installed version is older than the bundled version
- **THEN** the daemon invokes the plugin update command and detection subsequently reports the plugin as current

#### Scenario: Missing claude CLI is a soft failure
- **WHEN** an install or update action runs and the `claude` binary is not on PATH
- **THEN** the action returns a typed error and the daemon remains healthy

### Requirement: Headless plugin reinstall
The daemon SHALL provide a reinstall operation for the wos Claude Code plugin that, exclusively through the headless `claude plugin` CLI, removes the installed plugin and installs it again: it SHALL first migrate legacy injected hooks away (best-effort, not aborting on failure), then run `uninstall wos@<marketplace>`, then `marketplace update <marketplace>`, then `install wos@<marketplace> --scope user`. The operation MUST NOT write the plugin registry or cache directly. The first failing CLI step SHALL surface as a typed, user-visible error, and an absent `claude` CLI SHALL produce the typed "claude CLI not found" error. The daemon SHALL expose this operation through a dedicated reinstall endpoint whose response mirrors the install endpoint.

#### Scenario: Reinstall removes then reinstalls the plugin
- **WHEN** the reinstall operation runs while the wos plugin is installed
- **THEN** the daemon uninstalls the plugin, refreshes the marketplace, installs it again, and detection subsequently reports it installed at the bundled version

#### Scenario: Reinstall surfaces a failing step
- **WHEN** a CLI step during reinstall fails
- **THEN** the operation returns a typed error identifying the failure and does not silently report success

#### Scenario: Missing claude CLI is a soft failure
- **WHEN** the reinstall action runs and the `claude` binary is not on PATH
- **THEN** the action returns a typed "claude CLI not found" error and the daemon remains healthy

### Requirement: Legacy hook migration
Before installing or updating the Claude Code plugin, and whenever auto-inject runs, the daemon SHALL remove legacy injected wos hook entries (commands matching the `plugin-claude/scripts` marker) from `~/.claude/settings.json`, preserving all unrelated hooks and settings. The cleanup MUST be idempotent and a failure to clean MUST NOT abort the plugin installation.

#### Scenario: Legacy entries are removed on install
- **WHEN** the install action runs against a settings.json containing legacy wos hook entries alongside unrelated hooks
- **THEN** the wos entries are removed, unrelated hooks are preserved byte-for-byte in structure, and the plugin is installed

#### Scenario: Cleanup is idempotent
- **WHEN** the cleanup runs against a settings.json without legacy entries
- **THEN** the file is left unchanged

### Requirement: Headless Codex plugin install and update
The daemon SHALL install and update the wos Codex plugin exclusively through the headless `codex plugin` CLI (`marketplace add`, `add wos@<marketplace>`, and a re-`add` against a refreshed marketplace as the update path), never by writing the Codex plugin cache directly. (The install/remove verbs are `add`/`remove`, verified against codex-cli 0.141.0.) The marketplace source SHALL be resolved through a single configurable resolver that defaults to the local repository root (which carries the committed `.agents/plugins/marketplace.json`) and supports a remote source (GitHub repo or URL) via an environment override for distribution outside the source checkout. Marketplace registration MUST be idempotent. When the `codex` CLI is not available, install/update actions SHALL fail with a typed, user-visible "codex CLI not found" error and the daemon SHALL remain healthy.

#### Scenario: Codex install wires marketplace and plugin
- **WHEN** the install action runs on a machine without the wos codex marketplace registered
- **THEN** the daemon registers the marketplace from the resolved source and installs the plugin via the `codex plugin` CLI, and detection subsequently reports it installed

#### Scenario: Codex marketplace registration is idempotent
- **WHEN** the install action runs while the wos codex marketplace is already registered
- **THEN** re-registration succeeds without error and the plugin install proceeds

#### Scenario: Missing codex CLI is a soft failure
- **WHEN** an install or update action runs and the `codex` binary is not on PATH
- **THEN** the action returns a typed "codex CLI not found" error and the daemon remains healthy

