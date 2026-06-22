# wos-global-config Specification

## Purpose
TBD - created by archiving change add-web-command-and-global-config. Update Purpose after archive.
## Requirements
### Requirement: Global User Config File
The system SHALL read an optional global user configuration file at `<wos-home>/config.json` (default `~/.wos/config.json`, overridable via `WOS_HOME`).

#### Scenario: Config file absent
- **WHEN** the system loads the global config and `<wos-home>/config.json` does not exist
- **THEN** it SHALL return built-in defaults without error
- **AND** it SHALL NOT create the file

#### Scenario: Config file present and valid
- **WHEN** the system loads the global config and the file contains valid JSON whose values match the schema
- **THEN** it SHALL merge the parsed values over the built-in defaults
- **AND** it SHALL preserve defaults for any key the file omits

#### Scenario: Config file is invalid JSON
- **WHEN** the system loads the global config and the file cannot be parsed as JSON
- **THEN** it SHALL fall back to built-in defaults
- **AND** it SHALL emit a single-line warning to stderr that names the file path and the parse error

#### Scenario: WOS_HOME override
- **WHEN** `WOS_HOME` is set
- **THEN** the system SHALL read `config.json` from that directory instead of `~/.wos`

### Requirement: Web Port Setting
The global config SHALL expose an optional `web.port` integer that overrides the default web UI port (`4949`).

#### Scenario: web.port omitted
- **WHEN** the config file omits `web` or `web.port`
- **THEN** the effective web port SHALL be `4949`

#### Scenario: web.port set to a valid integer
- **WHEN** the config file contains `web.port` as an integer in the range `[1, 65535]`
- **THEN** the effective web port SHALL equal that integer

#### Scenario: web.port has an invalid value
- **WHEN** the config file contains `web.port` whose value is not an integer or is outside `[1, 65535]`
- **THEN** the effective web port SHALL fall back to `4949`
- **AND** the system SHALL emit a single-line warning to stderr naming the file path and the invalid value

### Requirement: Tunnel Server Setting
The global config SHALL expose optional `tunnel` settings for the daemon-owned public tunnel server.

#### Scenario: tunnel omitted
- **WHEN** the config file omits `tunnel`
- **THEN** the effective tunnel config SHALL have `enabled` equal to `false`
- **AND** the effective tunnel port SHALL be `5858`

#### Scenario: tunnel disabled
- **WHEN** the config file contains `tunnel.enabled` equal to `false`
- **THEN** the effective tunnel config SHALL have `enabled` equal to `false`
- **AND** `tunnel.domain` SHALL NOT be required

#### Scenario: tunnel enabled with valid domain
- **WHEN** the config file contains `tunnel.enabled` equal to `true`
- **AND** `tunnel.domain` is a non-empty string
- **THEN** the effective tunnel config SHALL have `enabled` equal to `true`
- **AND** the effective tunnel domain SHALL equal the configured domain

#### Scenario: tunnel port omitted
- **WHEN** the config file contains `tunnel.enabled` equal to `true`
- **AND** it omits `tunnel.port`
- **AND** `tunnel.domain` is valid
- **THEN** the effective tunnel port SHALL be `5858`

#### Scenario: tunnel port set to a valid integer
- **WHEN** the config file contains `tunnel.port` as an integer in the range `[1, 65535]`
- **THEN** the effective tunnel port SHALL equal that integer

#### Scenario: tunnel enabled without domain
- **WHEN** the config file contains `tunnel.enabled` equal to `true`
- **AND** `tunnel.domain` is missing, empty, or not a string
- **THEN** the effective tunnel config SHALL fall back to disabled tunneling
- **AND** the system SHALL emit a single-line warning to stderr naming `tunnel.domain`

#### Scenario: tunnel has invalid enabled value
- **WHEN** the config file contains `tunnel.enabled` whose value is not boolean
- **THEN** the effective tunnel config SHALL fall back to disabled tunneling
- **AND** the system SHALL emit a single-line warning to stderr naming `tunnel.enabled`

#### Scenario: tunnel port has invalid value
- **WHEN** the config file contains `tunnel.port` whose value is not an integer or is outside `[1, 65535]`
- **THEN** the effective tunnel port SHALL fall back to `5858`
- **AND** the system SHALL emit a single-line warning to stderr naming `tunnel.port`

#### Scenario: tunnel public port omitted
- **WHEN** the config file omits `tunnel.publicPort`
- **THEN** the effective `tunnel.publicPort` SHALL be undefined
- **AND** tunnel URL builders SHALL use `tunnel.port` as the URL port

#### Scenario: tunnel public port set to a valid integer
- **WHEN** the config file contains `tunnel.publicPort` as an integer in the range `[1, 65535]`
- **THEN** the effective `tunnel.publicPort` SHALL equal that integer
- **AND** tunnel URL builders SHALL use `tunnel.publicPort` as the URL port

#### Scenario: tunnel public port has invalid value
- **WHEN** the config file contains `tunnel.publicPort` whose value is not an integer or is outside `[1, 65535]`
- **THEN** the effective `tunnel.publicPort` SHALL fall back to undefined
- **AND** tunnel URL builders SHALL use `tunnel.port` as the URL port
- **AND** the system SHALL emit a single-line warning to stderr naming `tunnel.publicPort`

### Requirement: Tunnel Web UI Access Settings
The global config SHALL expose optional `tunnel.webUi` settings for publishing the daemon Web UI through the tunnel listener.

#### Scenario: tunnel web ui omitted
- **WHEN** the config file omits `tunnel.webUi`
- **THEN** the effective tunnel Web UI config SHALL have `enabled` equal to `false`
- **AND** the daemon SHALL NOT register a public Web UI tunnel route

#### Scenario: tunnel web ui enabled with label subdomain
- **WHEN** the config file contains `tunnel.enabled` equal to `true`
- **AND** `tunnel.domain` is `example.com`
- **AND** `tunnel.webUi.enabled` is `true`
- **AND** `tunnel.webUi.subdomain` is `sample`
- **AND** `tunnel.webUi.secret` is a non-empty string
- **THEN** the effective public Web UI hostname SHALL be `sample.example.com`
- **AND** the effective public Web UI secret SHALL equal the configured secret

#### Scenario: tunnel web ui enabled with full hostname
- **WHEN** the config file contains `tunnel.domain` equal to `example.com`
- **AND** `tunnel.webUi.enabled` is `true`
- **AND** `tunnel.webUi.subdomain` is `sample.example.com`
- **AND** `tunnel.webUi.secret` is a non-empty string
- **THEN** the effective public Web UI hostname SHALL be `sample.example.com`

#### Scenario: tunnel web ui rejects hostname outside tunnel domain
- **WHEN** the config file contains `tunnel.domain` equal to `example.com`
- **AND** `tunnel.webUi.enabled` is `true`
- **AND** `tunnel.webUi.subdomain` is `sample.other.test`
- **THEN** the effective tunnel Web UI config SHALL fall back to disabled
- **AND** the system SHALL emit a single-line warning naming `tunnel.webUi.subdomain`

#### Scenario: tunnel web ui enabled without secret
- **WHEN** the config file contains `tunnel.webUi.enabled` equal to `true`
- **AND** `tunnel.webUi.secret` is missing, empty, or not a string
- **THEN** the effective tunnel Web UI config SHALL fall back to disabled
- **AND** the system SHALL emit a single-line warning naming `tunnel.webUi.secret`

#### Scenario: tunnel web ui terminal access flag
- **WHEN** the config file contains `tunnel.webUi.enabled` equal to `true`
- **AND** `tunnel.webUi.terminalEnabled` is `true`
- **THEN** the effective public terminal access flag SHALL be enabled

### Requirement: Tunnel Web UI IP Whitelist Settings
The global config SHALL parse `tunnel.webUi.whitelistIps` as an optional list of exact client IP addresses.

#### Scenario: tunnel web ui whitelist omitted
- **WHEN** the config file omits `tunnel.webUi.whitelistIps`
- **THEN** the effective Web UI whitelist SHALL be an empty list
- **AND** an empty list SHALL mean all client IPs are allowed

#### Scenario: tunnel web ui whitelist valid
- **WHEN** the config file contains `tunnel.webUi.whitelistIps` with IPv4 or IPv6 address strings
- **THEN** the effective Web UI whitelist SHALL preserve those addresses

#### Scenario: tunnel web ui whitelist invalid
- **WHEN** the config file contains `tunnel.webUi.whitelistIps` with a non-array value or an invalid entry
- **THEN** the effective tunnel Web UI config SHALL fall back to a safe disabled public Web UI config
- **AND** the system SHALL emit a single-line warning naming `tunnel.webUi.whitelistIps`

### Requirement: Service Tunnel Publication Settings
The global config SHALL expose optional `tunnel.serviceTunnels` settings for publishing service ports through the tunnel listener.

#### Scenario: service tunnels omitted
- **WHEN** the config file omits `tunnel.serviceTunnels`
- **THEN** the effective service tunnel config SHALL have `enabled` equal to `false`
- **AND** no service ports SHALL be published solely because `tunnel.enabled` is true

#### Scenario: service tunnels enabled
- **WHEN** the config file contains `tunnel.enabled` equal to `true`
- **AND** `tunnel.serviceTunnels.enabled` is `true`
- **THEN** service tunnel publication SHALL be enabled for started service ports

#### Scenario: service tunnel whitelist omitted
- **WHEN** the config file omits `tunnel.serviceTunnels.whitelistIps`
- **THEN** the effective service tunnel whitelist SHALL be an empty list
- **AND** an empty list SHALL mean all client IPs are allowed

#### Scenario: service tunnel whitelist valid
- **WHEN** the config file contains `tunnel.serviceTunnels.whitelistIps` with IPv4 or IPv6 address strings
- **THEN** the effective service tunnel whitelist SHALL preserve those addresses

#### Scenario: service tunnel whitelist invalid
- **WHEN** the config file contains `tunnel.serviceTunnels.whitelistIps` with a non-array value or an invalid entry
- **THEN** service tunnel publication SHALL be disabled
- **AND** the system SHALL emit a single-line warning naming `tunnel.serviceTunnels.whitelistIps`

### Requirement: Global Config Management Snapshot
The system SHALL expose a reusable local management representation of the supported global config settings without changing the persisted `config.json` schema.

#### Scenario: Management snapshot is built for existing config
- **WHEN** the system builds a management snapshot and `<wos-home>/config.json` exists
- **THEN** the snapshot SHALL include the config file path
- **AND** it SHALL include whether the file exists
- **AND** it SHALL include raw supported setting values from the file when present
- **AND** it SHALL include the effective parsed global config after defaults and validation fallback are applied

#### Scenario: Management snapshot is built without config file
- **WHEN** the system builds a management snapshot and `<wos-home>/config.json` does not exist
- **THEN** the snapshot SHALL include the config file path
- **AND** it SHALL report that the file does not exist
- **AND** it SHALL include built-in effective defaults

### Requirement: Global Config Management Save
The system SHALL validate and persist supported global config settings submitted by the local settings management flow.

#### Scenario: Valid settings are saved
- **WHEN** the settings management flow submits valid values for supported global config settings
- **THEN** the system SHALL create `<wos-home>` when needed
- **AND** it SHALL write `<wos-home>/config.json` as formatted JSON using the existing global config schema
- **AND** a subsequent global config load SHALL resolve the saved values as effective config

#### Scenario: Invalid settings are rejected
- **WHEN** the settings management flow submits an invalid value for a supported global config setting
- **THEN** the system SHALL reject the update with a field-specific validation error
- **AND** it SHALL NOT overwrite the existing `config.json`

#### Scenario: Disabled public web is saved
- **WHEN** the settings management flow submits `web.public.enabled` equal to `false`
- **THEN** the system SHALL NOT require `web.public.hostname` or `web.public.secret`
- **AND** the persisted config SHALL load with public web disabled

#### Scenario: Enabled public web is saved
- **WHEN** the settings management flow submits `web.public.enabled` equal to `true`
- **AND** the submitted settings include a usable hostname or an enabled tunnel domain
- **AND** the submitted settings include a non-empty secret
- **THEN** the persisted config SHALL load with public web enabled
- **AND** the persisted public terminal access flag SHALL reflect `web.public.terminalEnabled`

#### Scenario: Disabled tunnel is saved
- **WHEN** the settings management flow submits `tunnel.enabled` equal to `false`
- **THEN** the system SHALL NOT require `tunnel.domain`
- **AND** the persisted config SHALL load with tunneling disabled

#### Scenario: Enabled tunnel is saved
- **WHEN** the settings management flow submits `tunnel.enabled` equal to `true`
- **AND** the submitted settings include a non-empty tunnel domain
- **THEN** the persisted config SHALL load with tunneling enabled for that domain

### Requirement: First-Run Global Config Reuse
The system SHALL use the supported global config management model for first-run setup without introducing a separate persisted schema.

#### Scenario: First-run setup saves global settings
- **WHEN** the first-run setup flow submits valid supported global settings
- **THEN** the system SHALL validate and persist them using the same behavior as global config management save
- **AND** the resulting `<wos-home>/config.json` SHALL load as effective global config

#### Scenario: First-run setup rejects invalid global settings
- **WHEN** the first-run setup flow submits an invalid supported global config value
- **THEN** the system SHALL reject the update with field-specific validation errors
- **AND** it SHALL NOT overwrite the existing `config.json`

#### Scenario: First-run setup can keep defaults
- **WHEN** the first-run setup flow submits an empty or default global settings draft that is valid
- **THEN** the system SHALL be able to create `<wos-home>/config.json`
- **AND** a subsequent setup status snapshot SHALL be able to treat global config setup as complete because the config file exists

### Requirement: First-Run Setup Completion Semantics
The system SHALL define first-run setup as incomplete only while both global config and project registration are absent.

#### Scenario: No config and no projects
- **WHEN** `<wos-home>/config.json` does not exist
- **AND** the project registry contains no projects
- **THEN** first-run setup SHALL be considered required

#### Scenario: Config exists and no projects
- **WHEN** `<wos-home>/config.json` exists
- **AND** the project registry contains no projects
- **THEN** first-run setup SHALL NOT be considered required

#### Scenario: Project exists and config absent
- **WHEN** `<wos-home>/config.json` does not exist
- **AND** the project registry contains one or more projects
- **THEN** first-run setup SHALL NOT be considered required
- **AND** global config loading SHALL continue to use built-in defaults

### Requirement: Web SSL Settings
The global config SHALL expose optional `web.ssl` settings for enabling HTTPS on the daemon Web UI listener.

#### Scenario: web.ssl omitted
- **WHEN** the config file omits `web.ssl`
- **THEN** the effective Web UI SSL config SHALL have `enabled` equal to `false`
- **AND** the daemon Web UI listener SHALL use HTTP by default

#### Scenario: web.ssl disabled
- **WHEN** the config file contains `web.ssl.enabled` equal to `false`
- **THEN** the effective Web UI SSL config SHALL have `enabled` equal to `false`
- **AND** `web.ssl.cert` and `web.ssl.key` SHALL NOT be required

#### Scenario: web.ssl enabled without certificate paths
- **WHEN** the config file contains `web.ssl.enabled` equal to `true`
- **AND** it omits `web.ssl.cert` and `web.ssl.key`
- **THEN** the effective Web UI SSL config SHALL have `enabled` equal to `true`
- **AND** it SHALL indicate that a generated self-signed certificate is required

#### Scenario: web.ssl enabled with certificate paths
- **WHEN** the config file contains `web.ssl.enabled` equal to `true`
- **AND** `web.ssl.cert` and `web.ssl.key` are non-empty strings
- **THEN** the effective Web UI SSL config SHALL include those certificate and key paths

#### Scenario: web.ssl has incomplete certificate paths
- **WHEN** the config file contains `web.ssl.enabled` equal to `true`
- **AND** exactly one of `web.ssl.cert` or `web.ssl.key` is provided
- **THEN** the effective Web UI SSL config SHALL fall back to disabled SSL
- **AND** the system SHALL emit a single-line warning to stderr naming the incomplete Web UI SSL setting

#### Scenario: web.ssl has invalid values
- **WHEN** the config file contains `web.ssl.enabled`, `web.ssl.cert`, or `web.ssl.key` with an invalid type
- **THEN** the effective Web UI SSL config SHALL fall back to disabled SSL
- **AND** the system SHALL emit a single-line warning to stderr naming the invalid Web UI SSL setting

### Requirement: Tunnel SSL Settings
The global config SHALL expose optional `tunnel.ssl` settings for enabling HTTPS on the daemon-owned tunnel listener.

#### Scenario: tunnel.ssl omitted
- **WHEN** the config file omits `tunnel.ssl`
- **THEN** the effective tunnel SSL config SHALL have `enabled` equal to `false`
- **AND** the daemon-owned tunnel listener SHALL use HTTP by default

#### Scenario: tunnel.ssl disabled
- **WHEN** the config file contains `tunnel.ssl.enabled` equal to `false`
- **THEN** the effective tunnel SSL config SHALL have `enabled` equal to `false`
- **AND** `tunnel.ssl.cert` and `tunnel.ssl.key` SHALL NOT be required

#### Scenario: tunnel.ssl enabled without certificate paths
- **WHEN** the config file contains `tunnel.enabled` equal to `true`
- **AND** `tunnel.ssl.enabled` equal to `true`
- **AND** it omits `tunnel.ssl.cert` and `tunnel.ssl.key`
- **THEN** the effective tunnel SSL config SHALL have `enabled` equal to `true`
- **AND** it SHALL indicate that a generated self-signed certificate is required

#### Scenario: tunnel.ssl enabled with certificate paths
- **WHEN** the config file contains `tunnel.ssl.enabled` equal to `true`
- **AND** `tunnel.ssl.cert` and `tunnel.ssl.key` are non-empty strings
- **THEN** the effective tunnel SSL config SHALL include those certificate and key paths

#### Scenario: tunnel.ssl has incomplete certificate paths
- **WHEN** the config file contains `tunnel.ssl.enabled` equal to `true`
- **AND** exactly one of `tunnel.ssl.cert` or `tunnel.ssl.key` is provided
- **THEN** the effective tunnel SSL config SHALL fall back to disabled SSL
- **AND** the system SHALL emit a single-line warning to stderr naming the incomplete tunnel SSL setting

#### Scenario: tunnel.ssl has invalid values
- **WHEN** the config file contains `tunnel.ssl.enabled`, `tunnel.ssl.cert`, or `tunnel.ssl.key` with an invalid type
- **THEN** the effective tunnel SSL config SHALL fall back to disabled SSL
- **AND** the system SHALL emit a single-line warning to stderr naming the invalid tunnel SSL setting

### Requirement: SSL Settings Management Save
The system SHALL validate and persist supported SSL settings submitted by the local settings management flow.

#### Scenario: Web SSL settings are saved
- **WHEN** the settings management flow submits valid `web.ssl` values
- **THEN** the persisted config SHALL include the submitted Web UI SSL settings
- **AND** a subsequent global config load SHALL resolve the Web UI SSL settings as effective config

#### Scenario: Tunnel SSL settings are saved
- **WHEN** the settings management flow submits valid `tunnel.ssl` values
- **THEN** the persisted config SHALL include the submitted tunnel SSL settings
- **AND** a subsequent global config load SHALL resolve the tunnel SSL settings as effective config

#### Scenario: Invalid SSL settings are rejected
- **WHEN** the settings management flow submits invalid SSL values
- **THEN** the system SHALL reject the update with field-specific validation errors
- **AND** it SHALL NOT overwrite the existing `config.json`

### Requirement: Cloudflare Lets Encrypt DNS Challenge Config
The global config SHALL support Cloudflare as a DNS-01 challenge provider for Let's Encrypt SSL settings.

#### Scenario: Cloudflare challenge uses token environment variable
- **WHEN** an SSL config uses `source: "letsencrypt"`
- **AND** `letsencrypt.challenge.type` equals `dns-01`
- **AND** `letsencrypt.challenge.provider` equals `cloudflare`
- **AND** `letsencrypt.challenge.apiTokenEnv` is a non-empty string
- **THEN** the effective SSL config SHALL include the Cloudflare challenge settings
- **AND** it SHALL preserve the configured environment variable name

#### Scenario: Cloudflare challenge uses direct token
- **WHEN** an SSL config uses `source: "letsencrypt"`
- **AND** `letsencrypt.challenge.provider` equals `cloudflare`
- **AND** `letsencrypt.challenge.apiToken` is a non-empty string
- **THEN** the effective SSL config SHALL include the Cloudflare challenge settings
- **AND** it SHALL preserve the configured token value for local daemon use

#### Scenario: Cloudflare token environment wins over direct token
- **WHEN** an SSL config uses `source: "letsencrypt"`
- **AND** `letsencrypt.challenge.provider` equals `cloudflare`
- **AND** both `letsencrypt.challenge.apiTokenEnv` and `letsencrypt.challenge.apiToken` are non-empty strings
- **THEN** the effective SSL config SHALL prefer the environment-variable credential source

#### Scenario: Cloudflare challenge can configure explicit zone id
- **WHEN** an SSL config uses a Cloudflare DNS-01 challenge
- **AND** `letsencrypt.challenge.zoneId` is a non-empty string
- **THEN** the effective SSL config SHALL include the explicit Cloudflare zone id

#### Scenario: Cloudflare challenge can configure propagation wait
- **WHEN** an SSL config uses a Cloudflare DNS-01 challenge
- **AND** `letsencrypt.challenge.propagationSeconds` is an integer greater than or equal to zero
- **THEN** the effective SSL config SHALL include that propagation wait

#### Scenario: Cloudflare challenge without token source is rejected
- **WHEN** an SSL config uses `source: "letsencrypt"`
- **AND** `letsencrypt.challenge.provider` equals `cloudflare`
- **AND** neither `letsencrypt.challenge.apiTokenEnv` nor `letsencrypt.challenge.apiToken` is a non-empty string
- **THEN** the effective SSL config SHALL disable SSL
- **AND** the system SHALL emit a single-line warning naming the missing Cloudflare token field

#### Scenario: Invalid Cloudflare challenge value is rejected
- **WHEN** an SSL config uses `source: "letsencrypt"`
- **AND** `letsencrypt.challenge.provider` equals `cloudflare`
- **AND** a Cloudflare challenge field has an invalid type
- **THEN** the effective SSL config SHALL disable SSL
- **AND** the system SHALL emit a single-line warning naming the invalid field

### Requirement: Settings Management Persists Cloudflare Lets Encrypt Config
The settings management flow SHALL accept and persist supported Cloudflare Let's Encrypt challenge settings.

#### Scenario: Web SSL Cloudflare settings are saved
- **WHEN** the local settings management flow submits valid `web.ssl` values using `source: "letsencrypt"` and `challenge.provider: "cloudflare"`
- **THEN** the saved global config SHALL include the Cloudflare challenge settings under `web.ssl.letsencrypt.challenge`

#### Scenario: Tunnel SSL Cloudflare settings are saved
- **WHEN** the local settings management flow submits valid `tunnel.ssl` values using `source: "letsencrypt"` and `challenge.provider: "cloudflare"`
- **THEN** the saved global config SHALL include the Cloudflare challenge settings under `tunnel.ssl.letsencrypt.challenge`

#### Scenario: Invalid Cloudflare settings are rejected
- **WHEN** the local settings management flow submits invalid Cloudflare challenge values
- **THEN** the settings save SHALL fail validation
- **AND** the validation result SHALL name the relevant Cloudflare challenge field

### Requirement: SSL Certificate Source Settings
The global config SHALL support explicit certificate sources for Web UI and tunnel SSL settings while preserving existing SSL config compatibility.

#### Scenario: Existing Web SSL file config remains valid
- **WHEN** `<wos-home>/config.json` contains `web.ssl.enabled` equal to `true`
- **AND** `web.ssl.cert` and `web.ssl.key` are non-empty strings
- **AND** `web.ssl.source` is omitted
- **THEN** the effective Web UI SSL config SHALL use the file certificate source
- **AND** it SHALL preserve the configured certificate and key paths

#### Scenario: Existing Web SSL generated config remains valid
- **WHEN** `<wos-home>/config.json` contains `web.ssl.enabled` equal to `true`
- **AND** `web.ssl.cert`, `web.ssl.key`, and `web.ssl.source` are omitted
- **THEN** the effective Web UI SSL config SHALL use the self-signed certificate source

#### Scenario: Existing tunnel SSL generated config remains valid
- **WHEN** `<wos-home>/config.json` contains `tunnel.ssl.enabled` equal to `true`
- **AND** `tunnel.ssl.cert`, `tunnel.ssl.key`, and `tunnel.ssl.source` are omitted
- **THEN** the effective tunnel SSL config SHALL use the self-signed certificate source

#### Scenario: SSL source accepts supported values
- **WHEN** `<wos-home>/config.json` contains `web.ssl.source` or `tunnel.ssl.source`
- **THEN** the value SHALL be one of `files`, `self-signed`, or `letsencrypt`

#### Scenario: Invalid SSL source is rejected by loader
- **WHEN** `<wos-home>/config.json` contains an unsupported `web.ssl.source` or `tunnel.ssl.source`
- **THEN** the effective SSL config for that listener SHALL fall back to disabled SSL
- **AND** the system SHALL emit a single-line warning to stderr naming the invalid source field

### Requirement: Let's Encrypt SSL Settings
The global config SHALL expose optional Let's Encrypt settings for Web UI and tunnel SSL listeners.

#### Scenario: Web Let's Encrypt config is valid
- **WHEN** `<wos-home>/config.json` contains `web.ssl.enabled` equal to `true`
- **AND** `web.ssl.source` equals `letsencrypt`
- **AND** `web.ssl.letsencrypt.email` is a non-empty string
- **AND** `web.ssl.letsencrypt.acceptTerms` is `true`
- **AND** the effective public Web UI hostname is a non-empty public DNS hostname
- **AND** a supported DNS-01 challenge config is present
- **THEN** the effective Web UI SSL config SHALL use the Let's Encrypt certificate source

#### Scenario: Tunnel Let's Encrypt config is valid
- **WHEN** `<wos-home>/config.json` contains `tunnel.enabled` equal to `true`
- **AND** `tunnel.domain` is a non-empty public DNS hostname
- **AND** `tunnel.ssl.enabled` is `true`
- **AND** `tunnel.ssl.source` equals `letsencrypt`
- **AND** `tunnel.ssl.letsencrypt.email` is a non-empty string
- **AND** `tunnel.ssl.letsencrypt.acceptTerms` is `true`
- **AND** a supported DNS-01 challenge config is present
- **THEN** the effective tunnel SSL config SHALL use the Let's Encrypt certificate source

#### Scenario: Let's Encrypt requires accepted terms
- **WHEN** an SSL config uses `source: "letsencrypt"`
- **AND** `letsencrypt.acceptTerms` is not `true`
- **THEN** the effective SSL config for that listener SHALL fall back to disabled SSL
- **AND** the system SHALL emit a single-line warning naming the terms acceptance field

#### Scenario: Let's Encrypt requires email
- **WHEN** an SSL config uses `source: "letsencrypt"`
- **AND** `letsencrypt.email` is missing, empty, or not a string
- **THEN** the effective SSL config for that listener SHALL fall back to disabled SSL
- **AND** the system SHALL emit a single-line warning naming the email field

#### Scenario: Web Let's Encrypt requires public hostname
- **WHEN** `web.ssl.source` equals `letsencrypt`
- **AND** the effective public Web UI hostname is missing or is not a public DNS hostname
- **THEN** the effective Web UI SSL config SHALL fall back to disabled SSL
- **AND** the system SHALL emit a single-line warning naming the public hostname requirement

#### Scenario: Tunnel Let's Encrypt requires tunnel domain
- **WHEN** `tunnel.ssl.source` equals `letsencrypt`
- **AND** the effective tunnel config is disabled or lacks a public DNS domain
- **THEN** the effective tunnel SSL config SHALL fall back to disabled SSL
- **AND** the system SHALL emit a single-line warning naming the tunnel domain requirement

### Requirement: Let's Encrypt DNS-01 Hook Settings
The global config SHALL support DNS-01 hook command settings for Let's Encrypt certificate issuance.

#### Scenario: DNS hook challenge is valid
- **WHEN** an SSL config uses `source: "letsencrypt"`
- **AND** `letsencrypt.challenge.type` equals `dns-01`
- **AND** `letsencrypt.challenge.provider` equals `hook`
- **AND** `letsencrypt.challenge.createCommand` is a non-empty string
- **AND** `letsencrypt.challenge.deleteCommand` is a non-empty string
- **THEN** the effective SSL config SHALL include the DNS hook challenge commands

#### Scenario: DNS hook challenge can configure propagation wait
- **WHEN** an SSL config uses a DNS hook challenge
- **AND** `letsencrypt.challenge.propagationSeconds` is an integer greater than or equal to zero
- **THEN** the effective SSL config SHALL include that propagation wait value

#### Scenario: Invalid DNS hook challenge is rejected
- **WHEN** an SSL config uses `source: "letsencrypt"`
- **AND** the DNS-01 hook challenge config is missing or invalid
- **THEN** the effective SSL config for that listener SHALL fall back to disabled SSL
- **AND** the system SHALL emit a single-line warning naming the invalid challenge field

### Requirement: Let's Encrypt Settings Management Save
The settings management flow SHALL validate and persist supported Let's Encrypt SSL settings.

#### Scenario: Settings save persists Web Let's Encrypt config
- **WHEN** the local settings management flow submits valid `web.ssl` values using `source: "letsencrypt"`
- **THEN** the persisted config SHALL include the submitted Web UI Let's Encrypt settings
- **AND** a subsequent global config load SHALL resolve the Web UI SSL settings as effective config

#### Scenario: Settings save persists tunnel Let's Encrypt config
- **WHEN** the local settings management flow submits valid `tunnel.ssl` values using `source: "letsencrypt"`
- **THEN** the persisted config SHALL include the submitted tunnel Let's Encrypt settings
- **AND** a subsequent global config load SHALL resolve the tunnel SSL settings as effective config

#### Scenario: Settings save rejects invalid Let's Encrypt config
- **WHEN** the local settings management flow submits invalid Let's Encrypt SSL settings
- **THEN** the system SHALL reject the update with field-specific validation errors
- **AND** it SHALL NOT overwrite the existing `config.json`

### Requirement: Terminal Backend Setting
The global config SHALL expose an optional top-level `terminalBackend` setting that selects the daemon terminal backend.

#### Scenario: terminalBackend omitted
- **WHEN** the config file omits `terminalBackend`
- **THEN** the effective terminal backend SHALL be `"default"`

#### Scenario: terminalBackend set to default
- **WHEN** the config file contains `terminalBackend` equal to `"default"`
- **THEN** the effective terminal backend SHALL be `"default"`

#### Scenario: terminalBackend set to tmux
- **WHEN** the config file contains `terminalBackend` equal to `"tmux"`
- **THEN** the effective terminal backend SHALL be `"tmux"`

#### Scenario: terminalBackend has invalid value
- **WHEN** the config file contains `terminalBackend` with a value other than `"default"` or `"tmux"`
- **THEN** the effective terminal backend SHALL fall back to `"default"`
- **AND** the system SHALL emit a single-line warning to stderr naming `terminalBackend`

### Requirement: Terminal Backend Settings Management
The global config management snapshot and save flow SHALL include the supported top-level `terminalBackend` setting.

#### Scenario: Management snapshot includes terminal backend
- **WHEN** the system builds a management snapshot for global settings
- **THEN** the snapshot SHALL include the effective `terminalBackend`
- **AND** it SHALL include raw `terminalBackend` when the config file contains a supported terminal backend value

#### Scenario: Valid terminal backend is saved
- **WHEN** the settings management flow submits `terminalBackend` equal to `"default"` or `"tmux"`
- **THEN** the system SHALL persist the submitted value in `<wos-home>/config.json`
- **AND** a subsequent global config load SHALL resolve that value as the effective terminal backend

#### Scenario: Invalid terminal backend is rejected on save
- **WHEN** the settings management flow submits `terminalBackend` with a value other than `"default"` or `"tmux"`
- **THEN** the system SHALL reject the update with a field-specific validation error for `terminalBackend`
- **AND** it SHALL NOT overwrite the existing `config.json`

### Requirement: Web Host Setting
The global config SHALL expose an optional `web.host` string that overrides the default daemon web UI / UI API listener bind address (`127.0.0.1`). The value is a single address; a comma-separated list is not supported.

#### Scenario: web.host omitted
- **WHEN** the config file omits `web` or `web.host`
- **THEN** the effective web host SHALL be `127.0.0.1`

#### Scenario: web.host set to a valid address
- **WHEN** the config file contains `web.host` as a non-empty string
- **THEN** the effective web host SHALL equal that string

#### Scenario: web.host has an invalid value
- **WHEN** the config file contains `web.host` whose value is not a non-empty string
- **THEN** the effective web host SHALL fall back to `127.0.0.1`
- **AND** the system SHALL emit a single-line warning to stderr naming the file path and the invalid value

### Requirement: Service Bind Address Setting
The global config SHALL expose an optional top-level `serviceBind` string that selects the address used to publish and advertise managed service ports. When omitted, service publishing and template resolution SHALL preserve their prior behavior (compose binds the Docker default; templates fall back to `localhost`).

#### Scenario: serviceBind omitted
- **WHEN** the config file omits `serviceBind`
- **THEN** the effective service bind address SHALL be unset
- **AND** managed compose ports SHALL publish with their prior single mapping
- **AND** `${...hostname[<port>]}` / `${...url[<port>]}` loopback fallbacks SHALL resolve to `localhost`

#### Scenario: serviceBind set to a valid address
- **WHEN** the config file contains `serviceBind` as a non-empty string
- **THEN** the effective service bind address SHALL equal that string

#### Scenario: serviceBind has an invalid value
- **WHEN** the config file contains `serviceBind` whose value is not a non-empty string
- **THEN** the effective service bind address SHALL fall back to unset
- **AND** the system SHALL emit a single-line warning to stderr naming the file path and the invalid value

### Requirement: Global Config Logging Settings
The global config SHALL expose an optional `logging` section controlling daemon file logging, defaulting to disabled.

#### Scenario: Default global config has logging disabled
- **WHEN** the system builds the default global config
- **THEN** the effective `logging.enabled` SHALL be `false`

#### Scenario: Global config loads logging settings
- **WHEN** `<wos-home>/config.json` contains a valid `logging` section (`enabled`, `level`, `modules`, `file`, `redactPrompts`, `perf`)
- **THEN** `loadGlobalConfig` SHALL include the parsed logging settings in the effective global config

#### Scenario: Global config ignores invalid logging values
- **WHEN** `<wos-home>/config.json` contains invalid `logging` values (e.g. an unknown level or a malformed `perf.slowMs`)
- **THEN** `loadGlobalConfig` SHALL fall back to the valid defaults for the affected fields
- **AND** it SHALL warn about the invalid values

### Requirement: Global Config Management Includes Logging
The global config management snapshot SHALL expose the supported raw and effective logging settings.

#### Scenario: Management snapshot includes raw logging settings
- **WHEN** `<wos-home>/config.json` contains supported `logging` values
- **THEN** the management snapshot `raw` config SHALL include those values

#### Scenario: Management snapshot includes effective logging settings
- **WHEN** the system builds a management snapshot
- **THEN** the management snapshot `effective` config SHALL include the parsed `logging` settings

#### Scenario: Settings save preserves logging settings
- **WHEN** the settings management flow saves global config without modifying the `logging` section
- **THEN** the system SHALL preserve the existing `logging` settings in `<wos-home>/config.json`
- **AND** a subsequent global config load SHALL resolve the preserved logging settings as effective config

### Requirement: Default Commit Message Provider Setting
The global config SHALL expose an optional default AI provider and model for commit-message generation, selected from the configured AI providers.

#### Scenario: Default global config has no commit-message provider
- **WHEN** the system builds the default global config
- **THEN** the effective default commit-message provider SHALL be unset

#### Scenario: Global config loads the commit-message provider
- **WHEN** `<wos-home>/config.json` contains a `commitMessages` section naming a `provider` and optional `model`
- **THEN** `loadGlobalConfig` SHALL include the parsed default commit-message provider in the effective global config

#### Scenario: Global config ignores an invalid commit-message provider
- **WHEN** `<wos-home>/config.json` `commitMessages.provider` does not name any configured AI provider
- **THEN** `loadGlobalConfig` SHALL treat the default commit-message provider as unset
- **AND** it SHALL warn about the invalid value

### Requirement: Global Config Management Includes Commit Message Provider
The global config management snapshot SHALL expose the raw and effective default commit-message provider settings, preserved across the settings save round-trip.

#### Scenario: Management snapshot includes the commit-message provider
- **WHEN** `<wos-home>/config.json` contains a supported `commitMessages` section
- **THEN** the management snapshot `raw` and `effective` config SHALL include those values

#### Scenario: Settings save preserves the commit-message provider
- **WHEN** the settings management flow saves global config without modifying the `commitMessages` section
- **THEN** the system SHALL preserve the existing `commitMessages` settings in `<wos-home>/config.json`

### Requirement: Notifications Setting
The global config SHALL expose an optional `notifications` block holding the notification rules, channel configuration, and Web Push subscription storage. It SHALL follow the existing optional-settings pattern: an absent block yields built-in defaults, a present-and-valid block merges over defaults, and invalid values fall back to safe defaults with a single-line stderr warning that names the file path and the invalid value.

The block SHALL include: `rules` keyed by notification kind with at least an `enabled` flag per kind; a `channels` object with `telegram { enabled, botToken, chatId, mode }` and `webpush { enabled }`; and storage for registered Web Push subscriptions. The Telegram `mode` SHALL be one of `always` or `when-away` and SHALL default to `when-away` when absent or invalid. Unknown rule kinds SHALL be preserved for forward compatibility. Secret values SHALL be persisted with the same owner-only protection as the file and SHALL be redactable when the config is surfaced to clients; the Telegram `mode` is not a secret and SHALL be surfaced verbatim.

#### Scenario: notifications omitted
- **WHEN** the config file omits `notifications`
- **THEN** the effective notification config SHALL have all rules and channels disabled

#### Scenario: notifications present and valid
- **WHEN** the config file contains a valid `notifications` block
- **THEN** the parsed rules and channel configuration SHALL merge over the defaults

#### Scenario: invalid notifications value falls back
- **WHEN** a value inside `notifications` is malformed or out of range
- **THEN** that value SHALL fall back to its safe default and the system SHALL emit a single-line stderr warning naming the file path and the invalid value

#### Scenario: unknown rule kind is preserved
- **WHEN** `notifications.rules` contains a kind the running build does not recognize
- **THEN** loading SHALL preserve the entry and SHALL NOT fail

#### Scenario: Telegram mode defaults to when-away
- **WHEN** the `telegram` channel config omits `mode` or carries an unrecognized value
- **THEN** the effective Telegram `mode` SHALL be `when-away`
- **AND** an unrecognized value SHALL emit a single-line stderr warning naming the file path and the invalid value

#### Scenario: Telegram mode round-trips on save
- **WHEN** the settings management flow saves global config with a valid Telegram `mode`
- **THEN** the system SHALL persist the `mode` and a subsequent load SHALL resolve it as effective config

