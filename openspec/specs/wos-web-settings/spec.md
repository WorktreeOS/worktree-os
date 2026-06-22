# wos-web-settings Specification

## Purpose
Web UI Settings page for local management of global wos configuration in `<wos-home>/config.json`.
## Requirements
### Requirement: Local Settings Page
The web UI SHALL provide a Settings page for local management of all supported global `<wos-home>/config.json` settings, organized as a set of per-section pages under a shared `/settings` layout that loads configuration once and owns saving.

#### Scenario: Local user opens settings
- **WHEN** a local browser opens `/settings`
- **THEN** the web UI SHALL request the local settings config UI API
- **AND** it SHALL land the user on a default section page rather than a single scrolling document
- **AND** the supported controls for `terminalBackend`, `web.port`, `web.ssl.enabled`, `web.ssl.cert`, `web.ssl.key`, `web.public.enabled`, `web.public.hostname`, `web.public.secret`, `web.public.terminalEnabled`, `tunnel.enabled`, `tunnel.port`, `tunnel.domain`, `tunnel.ssl.enabled`, `tunnel.ssl.cert`, `tunnel.ssl.key`, `healthcheck.timeout`, `healthcheck.start_period`, `healthcheck.interval`, `healthcheck.request_timeout`, and `healthcheck.retries` SHALL be reachable across the section pages

#### Scenario: Config file is absent
- **WHEN** a local browser opens the Settings page and `<wos-home>/config.json` does not exist
- **THEN** the page SHALL render built-in effective defaults
- **AND** it SHALL make clear that saving will create the config file

#### Scenario: User saves valid settings requiring restart
- **WHEN** a local user edits supported settings and saves valid values
- **AND** the settings config UI API response includes `restartRequired` equal to `true`
- **THEN** the web UI SHALL submit the complete settings draft to the local settings config UI API
- **AND** it SHALL refresh the rendered raw and effective settings from the API response
- **AND** it SHALL display that a daemon restart is required for saved settings to take effect

#### Scenario: User saves valid settings not requiring restart
- **WHEN** a local user edits supported settings and saves valid values
- **AND** the settings config UI API response does not include `restartRequired` equal to `true`
- **THEN** the web UI SHALL submit the complete settings draft to the local settings config UI API
- **AND** it SHALL refresh the rendered raw and effective settings from the API response
- **AND** it SHALL NOT display that a daemon restart is required for the saved settings to take effect

#### Scenario: User saves invalid settings
- **WHEN** a local user submits invalid settings
- **THEN** the web UI SHALL display the validation message returned by the UI API near the relevant setting or form section
- **AND** it SHALL preserve the user's draft for correction

### Requirement: Public Settings Page Unavailable
The Settings page SHALL NOT be usable through public/remote daemon web access.

#### Scenario: Public user has authenticated session
- **WHEN** a browser reaches the web UI through the public daemon hostname
- **AND** the public authentication session is valid
- **THEN** the Settings navigation affordance SHALL be hidden or disabled
- **AND** the Settings page SHALL NOT render editable settings controls

#### Scenario: Public user opens settings route directly
- **WHEN** a browser reaches `/settings` through the public daemon hostname
- **THEN** the web UI SHALL render a not-found or forbidden-style unavailable state
- **AND** it SHALL NOT call the settings config UI API

### Requirement: Settings Form Behavior
The Settings page SHALL use typed controls that match each supported global setting.

#### Scenario: Boolean setting is edited
- **WHEN** the user edits `web.public.enabled`, `web.public.terminalEnabled`, or `tunnel.enabled`
- **THEN** the page SHALL present the value as a binary toggle or checkbox

#### Scenario: Numeric setting is edited
- **WHEN** the user edits `web.port`, `tunnel.port`, or `healthcheck.retries`
- **THEN** the page SHALL present the value as a numeric input with validation feedback

#### Scenario: Duration setting is edited
- **WHEN** the user edits a healthcheck duration setting
- **THEN** the page SHALL accept the same duration formats supported by global config parsing
- **AND** it SHALL preserve the draft value until the API accepts or rejects it

#### Scenario: Dependent setting is disabled
- **WHEN** `web.public.enabled` is false
- **THEN** the page SHALL NOT require `web.public.hostname`, `web.public.secret`, or `web.public.terminalEnabled` to save

#### Scenario: Tunnel setting is disabled
- **WHEN** `tunnel.enabled` is false
- **THEN** the page SHALL NOT require `tunnel.domain` to save

### Requirement: Settings SSL Form Behavior
The Settings page SHALL use typed controls for supported Web UI and tunnel SSL settings.

#### Scenario: SSL enabled setting is edited
- **WHEN** the user edits `web.ssl.enabled` or `tunnel.ssl.enabled`
- **THEN** the page SHALL present the value as a binary toggle or checkbox

#### Scenario: SSL certificate paths are edited
- **WHEN** the user edits `web.ssl.cert`, `web.ssl.key`, `tunnel.ssl.cert`, or `tunnel.ssl.key`
- **THEN** the page SHALL present the value as a path text input
- **AND** it SHALL preserve the draft value until the API accepts or rejects it

#### Scenario: SSL enabled without paths is allowed
- **WHEN** `web.ssl.enabled` or `tunnel.ssl.enabled` is true
- **AND** the matching certificate and key path fields are blank
- **THEN** the page SHALL allow save submission
- **AND** it SHALL present this as using generated self-signed certificates

#### Scenario: SSL disabled does not require paths
- **WHEN** `web.ssl.enabled` or `tunnel.ssl.enabled` is false
- **THEN** the page SHALL NOT require matching certificate or key paths to save

### Requirement: Settings Form Supports Cloudflare Lets Encrypt Provider
The Settings page SHALL let local users configure Cloudflare as the DNS-01 provider for Let's Encrypt SSL.

#### Scenario: Lets Encrypt provider selector is shown
- **WHEN** the user selects `letsencrypt` as the certificate source for Web UI or tunnel SSL
- **THEN** the Settings page SHALL provide a DNS challenge provider control with `cloudflare` and `hook` options

#### Scenario: Cloudflare provider fields are shown
- **WHEN** the user selects `cloudflare` as the DNS challenge provider
- **THEN** the Settings page SHALL render controls for Cloudflare token environment variable, optional zone id, and propagation wait
- **AND** it SHALL NOT require DNS hook create or delete commands

#### Scenario: Hook provider fields are still shown
- **WHEN** the user selects `hook` as the DNS challenge provider
- **THEN** the Settings page SHALL render the existing DNS create hook, DNS delete hook, and propagation wait controls
- **AND** it SHALL NOT require Cloudflare token fields

#### Scenario: Cloudflare settings are saved
- **WHEN** a local user submits valid Cloudflare Let's Encrypt settings
- **THEN** the Settings page SHALL submit `challenge.provider: "cloudflare"` and the configured Cloudflare fields to the local settings API
- **AND** it SHALL refresh the rendered raw and effective settings from the API response

#### Scenario: Invalid Cloudflare field error is shown
- **WHEN** the UI API rejects a save because a Cloudflare challenge field is missing or invalid
- **THEN** the Settings page SHALL display the validation message near the relevant Cloudflare control
- **AND** it SHALL preserve the user's draft for correction

#### Scenario: Public settings still unavailable
- **WHEN** a browser reaches the web UI through public daemon access
- **THEN** the Settings page SHALL NOT render editable Cloudflare certificate controls

### Requirement: Settings Let's Encrypt Form Behavior
The Settings page SHALL provide typed controls for supported Let's Encrypt SSL settings.

#### Scenario: User selects SSL certificate source
- **WHEN** a local user edits Web UI or tunnel SSL settings
- **THEN** the Settings page SHALL provide a certificate source control with `files`, `self-signed`, and `letsencrypt` options
- **AND** it SHALL preserve omitted-source compatibility for existing configs by rendering the effective source selected

#### Scenario: Let's Encrypt fields are shown
- **WHEN** the user selects `letsencrypt` as the certificate source for Web UI or tunnel SSL
- **THEN** the Settings page SHALL render controls for email, terms acceptance, ACME directory, DNS-01 hook create command, DNS-01 hook delete command, and propagation wait

#### Scenario: File path fields are hidden for Let's Encrypt source
- **WHEN** the user selects `letsencrypt` as the certificate source
- **THEN** the Settings page SHALL NOT require certificate path or key path fields for that listener

#### Scenario: Self-signed source preserves generated hint
- **WHEN** the user selects `self-signed` as the certificate source
- **THEN** the Settings page SHALL present this as using generated self-signed certificates
- **AND** it SHALL NOT require Let's Encrypt fields to save

#### Scenario: Files source requires path fields
- **WHEN** the user selects `files` as the certificate source
- **THEN** the Settings page SHALL present certificate path and key path fields
- **AND** it SHALL preserve the existing validation feedback for incomplete path pairs

### Requirement: Settings Certificate Status Display
The Settings page SHALL display read-only certificate status returned by the UI API.

#### Scenario: Valid certificate status is displayed
- **WHEN** the settings snapshot includes a valid ACME-managed certificate status
- **THEN** the Settings page SHALL show the covered hostnames, active state, expiration time, and last successful renewal time

#### Scenario: Renewal failure status is displayed
- **WHEN** the settings snapshot includes a certificate failure status
- **THEN** the Settings page SHALL show the failure message near the relevant Web UI or tunnel SSL settings
- **AND** it SHALL preserve the user's editable config draft

#### Scenario: Pending certificate status is displayed
- **WHEN** the settings snapshot indicates that issuance or renewal is pending
- **THEN** the Settings page SHALL render the relevant certificate status as pending
- **AND** it SHALL keep save controls available for local users

### Requirement: Settings Let's Encrypt Validation Feedback
The Settings page SHALL map Let's Encrypt validation errors to the relevant controls.

#### Scenario: Missing terms error is shown
- **WHEN** the UI API rejects a save because Let's Encrypt terms were not accepted
- **THEN** the Settings page SHALL display the validation message near the terms acceptance control

#### Scenario: Invalid DNS hook error is shown
- **WHEN** the UI API rejects a save because a DNS hook command is missing or invalid
- **THEN** the Settings page SHALL display the validation message near the relevant DNS hook control

#### Scenario: Missing public hostname error is shown
- **WHEN** the UI API rejects Web UI Let's Encrypt settings because no public hostname is available
- **THEN** the Settings page SHALL display the validation message near the Web UI public hostname or Web UI SSL section

### Requirement: Settings Page Supports Tunnel Publication Controls
The Settings page SHALL expose controls for tunnel-scoped Web UI publication and service tunnel publication.

#### Scenario: tunnel publication controls are rendered
- **WHEN** a local user opens Settings
- **THEN** the page SHALL render controls for `tunnel.enabled`, `tunnel.port`, `tunnel.publicPort`, `tunnel.domain`, `tunnel.webUi.enabled`, `tunnel.webUi.subdomain`, `tunnel.webUi.secret`, `tunnel.webUi.terminalEnabled`, `tunnel.webUi.whitelistIps`, `tunnel.serviceTunnels.enabled`, and `tunnel.serviceTunnels.whitelistIps`

#### Scenario: tunnel public port input is optional
- **WHEN** a local user opens Settings
- **AND** the user leaves the `tunnel.publicPort` input blank
- **THEN** the page SHALL persist a draft without a `tunnel.publicPort` value
- **AND** the daemon SHALL fall back to `tunnel.port` for tunnel URL ports

#### Scenario: tunnel public port input rejects out-of-range integers
- **WHEN** a local user submits Settings with `tunnel.publicPort` not in `[1, 65535]`
- **THEN** the page SHALL surface a field error for `tunnel.publicPort`
- **AND** the daemon SHALL reject the save with a validation error naming `tunnel.publicPort`

#### Scenario: service tunnel publication disabled
- **WHEN** `tunnel.serviceTunnels.enabled` is false
- **THEN** the page SHALL NOT require `tunnel.serviceTunnels.whitelistIps` to save

#### Scenario: tunnel web ui disabled
- **WHEN** `tunnel.webUi.enabled` is false
- **THEN** the page SHALL NOT require `tunnel.webUi.subdomain`, `tunnel.webUi.secret`, `tunnel.webUi.terminalEnabled`, or `tunnel.webUi.whitelistIps` to save

#### Scenario: tunnel web ui enabled
- **WHEN** `tunnel.webUi.enabled` is true
- **THEN** the page SHALL require a valid `tunnel.webUi.subdomain`
- **AND** it SHALL require a non-empty `tunnel.webUi.secret`

### Requirement: Settings Page Removes Web Public Controls
The Settings page SHALL stop presenting `web.public` as an editable or persisted public exposure model.

#### Scenario: web public controls are absent
- **WHEN** a local user opens Settings
- **THEN** the page SHALL NOT render controls for `web.public.enabled`, `web.public.hostname`, `web.public.secret`, or `web.public.terminalEnabled`

#### Scenario: local web settings remain local
- **WHEN** a local user edits Web UI listener settings
- **THEN** the page SHALL treat `web.port` as a local HTTP management port
- **AND** it SHALL NOT offer direct public bind or public main-port settings

### Requirement: Settings Page Keeps Tunnel SSL Controls
The Settings page SHALL keep tunnel SSL and certificate controls attached to the tunnel listener.

#### Scenario: tunnel ssl controls remain available
- **WHEN** a local user opens Settings
- **THEN** the page SHALL render supported `tunnel.ssl` certificate source controls
- **AND** those controls SHALL apply to the public tunnel listener

#### Scenario: web ssl no longer configures public access
- **WHEN** the page displays local Web UI listener settings
- **THEN** it SHALL NOT present `web.ssl` as a way to configure remote Web UI HTTPS
- **AND** it SHALL direct remote HTTPS configuration to `tunnel.ssl`

### Requirement: Settings Terminal Backend Form Behavior
The Settings page SHALL provide a finite option control for the supported `terminalBackend` values.

#### Scenario: Terminal backend setting is edited
- **WHEN** the user edits `terminalBackend`
- **THEN** the page SHALL present the value as a finite option control with choices for `"default"` and `"tmux"`
- **AND** it SHALL preserve the draft value until the settings API accepts or rejects it

#### Scenario: Terminal backend save requires restart
- **WHEN** the user saves a valid changed `terminalBackend` value
- **THEN** the page SHALL display that a daemon restart is required for the saved terminal backend to take effect

#### Scenario: Terminal backend validation fails
- **WHEN** the settings API rejects the submitted `terminalBackend` value
- **THEN** the page SHALL display the validation message near the terminal backend control or form section
- **AND** it SHALL preserve the user's draft for correction

### Requirement: Settings Daemon Restart Action
The Settings page SHALL provide a local daemon restart action protected by a confirmation dialog.

#### Scenario: Local user opens daemon restart dialog
- **WHEN** a local user opens `/settings`
- **THEN** the Settings page SHALL render a `Restart daemon` action
- **AND** activating the action SHALL open a confirmation dialog before any restart request is submitted

#### Scenario: Restart dialog warns about consequences
- **WHEN** the daemon restart confirmation dialog is shown
- **THEN** the dialog SHALL warn that the Web UI can briefly disconnect during restart
- **AND** it SHALL warn that active daemon-owned operations, streams, or terminal sessions can be interrupted
- **AND** it SHALL explain that saved settings take effect only after the daemon comes back

#### Scenario: User confirms daemon restart
- **WHEN** the user confirms the daemon restart dialog
- **THEN** the Settings page SHALL submit a daemon restart request through the local UI API
- **AND** it SHALL show a restart-submitted or reconnecting state before the daemon disconnects

#### Scenario: User cancels daemon restart
- **WHEN** the user cancels the daemon restart dialog
- **THEN** the Settings page SHALL close the dialog
- **AND** it SHALL NOT submit a daemon restart request

### Requirement: Settings Save Offers Restart After Success
The Settings page SHALL offer daemon restart after a successful save that requires restart.

#### Scenario: Valid save requires daemon restart
- **WHEN** a local user saves valid settings
- **AND** the settings config UI API response includes `restartRequired` equal to `true`
- **THEN** the Settings page SHALL refresh the rendered raw and effective settings from the API response
- **AND** it SHALL display the restart-required saved state
- **AND** it SHALL open the daemon restart confirmation dialog after the save completes

#### Scenario: Valid save does not require daemon restart
- **WHEN** a local user saves valid settings
- **AND** the settings config UI API response does not include `restartRequired` equal to `true`
- **THEN** the Settings page SHALL NOT open the daemon restart confirmation dialog automatically

#### Scenario: Invalid save does not offer restart
- **WHEN** a local user submits invalid settings
- **THEN** the Settings page SHALL display validation feedback returned by the UI API
- **AND** it SHALL preserve the user's draft for correction
- **AND** it SHALL NOT open the daemon restart confirmation dialog

#### Scenario: User cancels post-save restart
- **WHEN** a settings save succeeds with `restartRequired` equal to `true`
- **AND** the user cancels the daemon restart confirmation dialog
- **THEN** the Settings page SHALL keep the saved restart-required state visible
- **AND** the user SHALL still be able to open the restart dialog with the `Restart daemon` action

### Requirement: Public Settings Cannot Restart Daemon
The Settings page SHALL NOT expose daemon restart controls through public or remote daemon web access.

#### Scenario: Public user opens settings route
- **WHEN** a browser reaches `/settings` through the public daemon hostname
- **THEN** the Settings page SHALL render the existing unavailable state
- **AND** it SHALL NOT render the `Restart daemon` action
- **AND** it SHALL NOT submit daemon restart requests

### Requirement: Settings Page Manages Web Host And Service Bind
The local Settings page SHALL expose the `web.host` and `serviceBind` global settings as text controls, hydrate them from the settings snapshot, submit them through the local settings API, and surface field-aware validation errors. Saving unrelated settings SHALL NOT drop a configured `web.host` or `serviceBind`.

#### Scenario: Web host control is shown and hydrated
- **WHEN** the Settings page renders
- **THEN** it SHALL present `web.host` as a text input
- **AND** it SHALL hydrate the input from the raw configured value when present, falling back to the effective value (`127.0.0.1`)

#### Scenario: Service bind control is shown and hydrated
- **WHEN** the Settings page renders
- **THEN** it SHALL present `serviceBind` as a text input
- **AND** it SHALL hydrate the input from the raw configured value when present, falling back to the effective value (empty when unset)

#### Scenario: Web host and service bind are saved
- **WHEN** a local user submits a non-empty `web.host` and `serviceBind`
- **THEN** the Settings page SHALL submit both values to the local settings API
- **AND** it SHALL refresh the rendered raw and effective settings from the API response

#### Scenario: Clearing the controls removes the overrides
- **WHEN** a local user clears the `web.host` or `serviceBind` input and saves
- **THEN** the settings API SHALL omit the cleared key from the persisted file
- **AND** the effective `web.host` SHALL fall back to `127.0.0.1` and `serviceBind` SHALL be unset

#### Scenario: Invalid web host is rejected with field feedback
- **WHEN** a submitted `web.host` is not a non-empty string
- **THEN** the settings API SHALL return a field-aware error keyed to `web.host`
- **AND** the Settings page SHALL associate the error with the web host control

#### Scenario: Saving other settings preserves the bind keys
- **WHEN** `web.host` and `serviceBind` are already configured
- **AND** a local user saves a change to an unrelated setting through the Settings page
- **THEN** the persisted `config.json` SHALL retain the configured `web.host` and `serviceBind`

### Requirement: Settings Page Multi-Page Navigation
The Settings page SHALL present each settings section as a distinct page under the `/settings` layout. Server-config sections SHALL share a single unsaved-draft lifecycle (one load, one Save) across pages; client-side sections (such as Notifications and Appearance) SHALL persist their own preferences independently and SHALL NOT participate in that shared draft.

#### Scenario: Section pages have distinct routes
- **WHEN** a local user navigates the Settings sections
- **THEN** each section (Web, Services, Tunnel, Terminal, Healthchecks, AI providers, Notifications, Appearance) SHALL be a distinct child route of `/settings`
- **AND** the section navigation SHALL mark the active section
- **AND** opening `/settings` with no section SHALL redirect to a default section page

#### Scenario: Save controls are shared across pages
- **WHEN** a local user is on any settings section page
- **THEN** the Save, Reset, and Restart daemon controls and their status banners SHALL remain visible
- **AND** the unsaved-changes indicator SHALL reflect edits made on any section page

#### Scenario: Edits survive cross-page navigation
- **WHEN** a local user edits a control on one section page and navigates to another section page without saving
- **THEN** the page SHALL retain the unsaved edit
- **AND** saving SHALL submit the edits made across all pages in one request

#### Scenario: Validation errors route to their section
- **WHEN** a save is rejected with field validation errors for controls on non-active section pages
- **THEN** the Settings page SHALL indicate which section pages contain errors in the section navigation
- **AND** it SHALL navigate the user to the section page containing the first error

#### Scenario: Client-side sections do not affect the shared draft
- **WHEN** a local user changes a preference on a client-side section page (such as Appearance)
- **THEN** the change SHALL NOT mark the shared settings draft as dirty
- **AND** the change SHALL take effect without using the Save control

### Requirement: Settings Terminal Backend Availability Control
The Settings Terminal page SHALL present the terminal backend as a checkbox gated by live detection of the required multiplexer.

#### Scenario: Backend control is a checkbox
- **WHEN** a local user opens the Terminal settings page
- **THEN** the page SHALL present `terminalBackend` as a checkbox where checked maps to `"tmux"` and unchecked maps to `"default"`
- **AND** it SHALL request terminal backend availability from the UI API

#### Scenario: Multiplexer is available
- **WHEN** the availability response reports the multiplexer is available
- **THEN** the checkbox SHALL be enabled
- **AND** the page SHALL indicate the detected multiplexer binary

#### Scenario: Multiplexer is unavailable
- **WHEN** the availability response reports the multiplexer is unavailable
- **THEN** the checkbox SHALL be disabled
- **AND** the page SHALL show platform-aware guidance naming psmux on Windows or tmux on POSIX
- **AND** it SHALL present the install commands and an external install reference
- **AND** it SHALL provide a re-check control that requests availability again without restarting the daemon

#### Scenario: Re-check after install
- **WHEN** a local user activates the re-check control after installing the multiplexer
- **THEN** the page SHALL request availability again
- **AND** it SHALL enable the checkbox when the new response reports the multiplexer is available

### Requirement: Settings Default Commit Message Provider Control
The Settings AI providers page SHALL let the user choose a default AI provider and optional model for commit-message generation from the configured providers.

#### Scenario: AI page exposes the default commit-message provider
- **WHEN** the user opens the Settings AI providers page with at least one configured provider
- **THEN** the page SHALL show a control to select the default commit-message provider from the configured providers, plus an optional model

#### Scenario: Saving the default commit-message provider
- **WHEN** the user selects a default commit-message provider and saves settings
- **THEN** the settings flow SHALL persist the selection to the global config `commitMessages` section

#### Scenario: No providers configured
- **WHEN** the user opens the Settings AI providers page with no configured providers
- **THEN** the page SHALL indicate that a provider must be added before a default commit-message provider can be selected

### Requirement: Settings Appearance Section
The Settings page SHALL provide an **Appearance** section for cosmetic, per-browser preferences that are not part of the daemon `config.json`. The section SHALL persist its choices client-side (localStorage), independently of the shared settings-save lifecycle. The Appearance section SHALL let the user choose the rail mode — **Sessions** or **Worktrees** (see the `wos-web-ui` **Project Sidebar** requirement) — and the chosen mode SHALL be applied to the rail live, without a reload.

The rail-mode chooser SHALL be presented as two **preview cards**, one per mode, each rendering a static illustration of that mode (a token-styled sketch, not a live render of the rail with real session data). The currently active mode SHALL be indicated as selected.

#### Scenario: Appearance section selects the rail mode with previews
- **WHEN** a local user opens the Appearance settings section
- **THEN** the page SHALL render a rail-mode control as two preview cards, `Sessions` and `Worktrees`, each showing a static illustration of that mode
- **AND** the card matching the persisted rail mode SHALL be marked as selected (defaulting to `Sessions` when none has been persisted)

#### Scenario: Selecting a mode persists it and updates the rail live
- **WHEN** a local user selects a rail-mode preview card
- **THEN** the web app SHALL persist the choice per browser
- **AND** the rail SHALL re-render to the selected mode immediately, without a reload
- **AND** the choice SHALL still be in effect after a reload

#### Scenario: Appearance preferences are client-side only
- **WHEN** a local user changes an Appearance preference
- **THEN** the web app SHALL persist it to browser storage
- **AND** it SHALL NOT submit the change to the settings config UI API
- **AND** it SHALL NOT mark the shared settings draft as having unsaved changes or require a daemon restart

