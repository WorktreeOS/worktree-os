# wos-notifications Specification

## Purpose
Turn the daemon's derived agent signals into notifications that reach the user when they step away. A single daemon-side notification engine subscribes to the unified event bus, matches events against per-kind rules, suppresses delivery while the user is present (any terminal has a live WebSocket connection), de-duplicates, renders a channel-agnostic `Notification`, publishes a `notification.raised` unified event, and fans the notification out to enabled channels. One decider, many deliverers: Telegram (reaches the phone), Web Push (reaches a closed browser tab), and Sound (a client-only audible cue while the tab is open). v1 defines two agent kinds — `agent.done` (honest hook-stop idle) and `agent.question` (awaiting input) — with a taxonomy designed to grow. All behavior is opt-in and off by default, and secrets are stored with owner-only permissions and never logged.

## Requirements
### Requirement: Notification kind taxonomy
The system SHALL define a versioned, extensible `NotificationKind` taxonomy in `packages/core`. v1 SHALL define `agent.done` and `agent.question`. The taxonomy SHALL be open for new kinds without breaking existing rule configuration, and unknown kinds SHALL be tolerated by config loading for forward compatibility.

#### Scenario: v1 kinds are defined
- **WHEN** the notification taxonomy is loaded
- **THEN** `agent.done` and `agent.question` SHALL be present as known kinds

#### Scenario: Unknown kind in config is tolerated
- **WHEN** a `notifications.rules` map contains a kind the running build does not recognize
- **THEN** config loading SHALL preserve the unknown entry and SHALL NOT fail

### Requirement: Channel-agnostic notification model
The system SHALL define a channel-agnostic `Notification` value in `packages/core` carrying at least `kind`, `title`, `body`, `severity` (`info` | `needs-attention`), a click-through `link`, and a `dedupeKey`, plus optional `worktreePath` and `terminalSessionId`. The model SHALL be renderable by any channel without additional daemon lookups.

#### Scenario: Rendered notification is self-contained
- **WHEN** the engine renders a notification for an event
- **THEN** the resulting `Notification` SHALL contain the title, body, severity, link, and dedupeKey needed for a channel to deliver it without further queries

### Requirement: Daemon notification engine
The daemon SHALL run a notification engine that subscribes to the unified event bus, evaluates each event against the configured rules, and for a matching, enabled, non-duplicate event renders a `Notification` and routes it per channel: it SHALL publish `notification.raised` and deliver Web Push only when no client is focused, and SHALL deliver Telegram according to the Telegram delivery mode. The engine SHALL be constructed during daemon bootstrap and SHALL NOT block event publication.

#### Scenario: Matching agent-done event raises a notification
- **WHEN** an `agent.activity.changed` event reports a honest hook-stop `idle` for a session, the `agent.done` rule is enabled, and no client is focused
- **THEN** the engine SHALL render an `agent.done` notification, publish `notification.raised`, and deliver it to every enabled channel

#### Scenario: Matching agent-question event raises a notification
- **WHEN** an `agent.activity.changed` event reports `awaiting-input` with `severity: needs-attention`, the `agent.question` rule is enabled, and no client is focused
- **THEN** the engine SHALL render an `agent.question` notification whose body carries the pending question summary, publish `notification.raised`, and fan it out per channel routing

#### Scenario: Disabled rule raises nothing
- **WHEN** a matching event arrives but its kind's rule is disabled
- **THEN** the engine SHALL NOT publish `notification.raised` and SHALL deliver to no channel

### Requirement: Done means honest stop, not staleness
The engine SHALL treat only a real `stop`-sourced `idle` as `agent.done`. A synthetic staleness-sweep `idle` (the soft, resurrectable demotion) SHALL NOT raise an `agent.done` notification.

#### Scenario: Hook-stop idle is done
- **WHEN** the activity block enters `idle` from a real `stop` event
- **THEN** the engine SHALL treat it as `agent.done`

#### Scenario: Staleness idle is not done
- **WHEN** the activity block is demoted to a staleness-sourced `idle` by the staleness sweep
- **THEN** the engine SHALL NOT raise an `agent.done` notification

### Requirement: Suppress delivery while a browser client is focused
The engine SHALL determine user presence from a daemon-side presence registry of focused browser clients rather than from terminal attachment. A client SHALL count as present only while it reports **strict focus** — its window has OS focus AND its document is visible. Presence SHALL be global: while any registered client is focused, the user is present. While the user is present, the engine SHALL NOT publish `notification.raised` and SHALL NOT deliver Web Push; when no client is focused, it SHALL publish and deliver them. Terminal attachment state SHALL NOT gate notifications.

#### Scenario: Focused client suppresses Web Push and notification.raised
- **WHEN** a matching, enabled, non-duplicate event arrives while at least one registered client is focused
- **THEN** the engine SHALL NOT publish `notification.raised` and SHALL NOT deliver Web Push

#### Scenario: No focused client delivers
- **WHEN** a matching, enabled, non-duplicate event arrives while no registered client is focused
- **THEN** the engine SHALL publish `notification.raised` and SHALL deliver Web Push to enabled subscriptions

#### Scenario: Terminal attachment alone does not suppress
- **WHEN** a matching event arrives while a terminal has a live WebSocket attachment but no client is focused
- **THEN** the engine SHALL treat the user as away and deliver the notification

### Requirement: Client presence reporting
The web client SHALL report its focus state to the daemon so the engine can gate on real presence. It SHALL report `focused` when its window has OS focus and the document is visible, and `away` otherwise, identifying itself with a per-window client id stable for the lifetime of the page. While focused, the client SHALL refresh its presence with a periodic heartbeat so a crashed or disconnected client expires. On page hide or unload it SHALL make a best-effort `away` report. The daemon SHALL expire a focused client whose heartbeat lapses beyond a bounded TTL and thereafter treat it as away.

#### Scenario: Focus and visibility are reported as focused
- **WHEN** the client's window gains focus and its document is visible
- **THEN** the client SHALL report `focused` for its client id and the daemon SHALL count it as a focused client

#### Scenario: Blur or hidden is reported as away
- **WHEN** the client's window loses focus or its document becomes hidden
- **THEN** the client SHALL report `away` and the daemon SHALL stop counting it as focused

#### Scenario: Heartbeat keeps presence live
- **WHEN** the client remains focused beyond the heartbeat interval
- **THEN** the client SHALL re-assert `focused` and the daemon SHALL keep counting it as focused

#### Scenario: Lapsed heartbeat expires presence
- **WHEN** a focused client stops sending heartbeats and its TTL elapses
- **THEN** the daemon SHALL treat that client as away

#### Scenario: Best-effort away on unload
- **WHEN** the client's page is hidden or unloaded
- **THEN** the client SHALL send a best-effort `away` report, with the TTL as the backstop if it is lost

### Requirement: Telegram delivery mode
The Telegram channel SHALL support a per-configuration delivery mode controlling whether presence gates it. `when-away` (the default) SHALL deliver only when no client is focused; `always` SHALL deliver on every matching, enabled, non-duplicate event regardless of presence, because Telegram reaches a separate device. The mode SHALL default to `when-away` so existing configurations keep their suppress-while-present behavior. Web Push SHALL always behave as `when-away`. The Settings → Notifications Telegram block SHALL expose the mode, and notification config responses SHALL include it (it is not a secret).

#### Scenario: when-away suppresses while focused
- **WHEN** the Telegram mode is `when-away` and a matching event arrives while a client is focused
- **THEN** the engine SHALL NOT deliver the Telegram notification

#### Scenario: when-away delivers while away
- **WHEN** the Telegram mode is `when-away` and a matching event arrives while no client is focused
- **THEN** the engine SHALL deliver the Telegram notification

#### Scenario: always delivers while focused
- **WHEN** the Telegram mode is `always` and a matching, enabled, non-duplicate event arrives while a client is focused
- **THEN** the engine SHALL deliver the Telegram notification even though Web Push and `notification.raised` are suppressed

#### Scenario: Default mode is when-away
- **WHEN** a notifications config has no Telegram `mode`
- **THEN** the effective mode SHALL be `when-away`

### Requirement: Notification de-duplication
The engine SHALL de-duplicate notifications by `dedupeKey` within a bounded recent window so that retried or repeated source events do not produce repeated deliveries.

#### Scenario: Duplicate within window is dropped
- **WHEN** two source events render the same `dedupeKey` within the dedup window
- **THEN** only the first SHALL be delivered and publish `notification.raised`

### Requirement: Channel abstraction and failure isolation
The system SHALL define a `NotificationChannel` interface with a stable `id`, a `deliver(notification)` operation, and a `validateConfig` operation. The engine SHALL deliver to channels best-effort: a channel that throws, rejects, or is slow SHALL NOT block the engine, SHALL NOT prevent delivery to other channels, and SHALL NOT fail event publication.

#### Scenario: One channel failure does not affect others
- **WHEN** the engine fans a notification out to multiple channels and one channel's `deliver` rejects
- **THEN** the remaining channels SHALL still receive the notification and the engine SHALL continue processing events

#### Scenario: Adding a channel requires no engine change
- **WHEN** a new channel implementing the interface is registered
- **THEN** the engine SHALL fan notifications out to it using only the interface, with no change to matching or rendering logic

### Requirement: Telegram channel
The system SHALL provide a Telegram channel that, when enabled and configured with a bot token and chat id, delivers a notification by calling the Telegram Bot API `sendMessage`. The channel SHALL validate that both a non-empty token and chat id are present before it is considered deliverable.

#### Scenario: Enabled Telegram channel delivers
- **WHEN** the Telegram channel is enabled with a valid token and chat id and the engine fans out a notification
- **THEN** the channel SHALL POST a message containing the notification title and body to the Telegram Bot API

#### Scenario: Incomplete Telegram config is not deliverable
- **WHEN** the Telegram channel is enabled but the token or chat id is missing
- **THEN** `validateConfig` SHALL report it as invalid and the channel SHALL not attempt delivery

### Requirement: Web Push channel
The daemon SHALL act as a Web Push sender. It SHALL generate a VAPID keypair once and persist it in the daemon state directory with owner-only permissions. It SHALL expose the VAPID public key to the web client, accept and store browser push subscriptions, and deliver notifications by sending an encrypted Web Push message to each stored subscription for which the Web Push channel is enabled. A subscription that the push service reports as gone SHALL be removed from storage.

#### Scenario: VAPID keypair is generated once and persisted
- **WHEN** the daemon starts and no VAPID keypair exists
- **THEN** it SHALL generate one and persist it with owner-only permissions, and SHALL reuse it on subsequent starts

#### Scenario: Browser subscription is stored
- **WHEN** the web client POSTs a valid push subscription
- **THEN** the daemon SHALL persist it and use it for future Web Push deliveries

#### Scenario: Enabled Web Push channel delivers to subscriptions
- **WHEN** the Web Push channel is enabled and the engine fans out a notification
- **THEN** the daemon SHALL send an encrypted push message to each stored subscription

#### Scenario: Expired subscription is pruned
- **WHEN** the push service reports a subscription as gone or expired during delivery
- **THEN** the daemon SHALL remove that subscription from storage

### Requirement: Service worker push handling
The web service worker SHALL handle `push` events by displaying the carried notification, and SHALL continue to focus or navigate to the notification's link on `notificationclick`.

#### Scenario: Push event shows a notification
- **WHEN** the service worker receives a `push` event carrying a notification payload
- **THEN** it SHALL display a notification with the payload's title, body, and click-through data

#### Scenario: Click navigates to the link
- **WHEN** the user clicks a displayed notification
- **THEN** the service worker SHALL focus an existing client and navigate it to the notification link, or open a new window at that link

### Requirement: Sound channel is client-only and per-event
The web client SHALL play an audible cue for a `notification.raised` event while the tab is open, using a per-kind sound selected by the user. The sound SHALL be configurable independently for each notification kind, including a "none/silent" option. Sound configuration SHALL be stored per device in `localStorage`, not in the daemon config.

#### Scenario: Per-kind sound is played
- **WHEN** a `notification.raised` event of a given kind arrives and the user has selected a non-silent sound for that kind
- **THEN** the web client SHALL play the selected sound for that kind

#### Scenario: Silent selection plays nothing
- **WHEN** the user has selected "none/silent" for a kind
- **THEN** the web client SHALL play no sound for that kind

#### Scenario: Sound config is per device
- **WHEN** the user changes a sound selection or duration
- **THEN** the change SHALL be persisted to `localStorage` and SHALL NOT be sent to the daemon config

### Requirement: Sound loops until acknowledged within a per-event cap
For each kind, the sound SHALL loop until the user acknowledges it or the kind's configured duration cap elapses, whichever comes first. Acknowledgement SHALL be any of: the window gaining focus, the document becoming visible, or an explicit dismiss/click. The loop-until-acknowledge decision logic SHALL be implemented as a pure, unit-testable function independent of the DOM.

#### Scenario: Loop stops on acknowledgement
- **WHEN** a kind's sound is looping and the user focuses the tab, the document becomes visible, or the user dismisses it
- **THEN** the sound SHALL stop before the duration cap

#### Scenario: Loop stops at the duration cap
- **WHEN** a kind's sound is looping and no acknowledgement occurs
- **THEN** the sound SHALL stop when the kind's configured duration cap elapses

#### Scenario: Duration cap is per event
- **WHEN** two kinds have different duration caps configured
- **THEN** each kind's looping SHALL be bounded by its own cap

### Requirement: Audio autoplay unlock
Because browser autoplay policy blocks audio without a prior user gesture, the web client SHALL unlock its audio context on a user gesture and SHALL provide a per-sound "Test" control that previews the sound and serves as the unlock gesture. When audio is locked, a missed sound SHALL degrade silently without affecting visual or Web Push delivery.

#### Scenario: Test previews and unlocks
- **WHEN** the user activates a sound's "Test" control
- **THEN** the client SHALL play that sound and SHALL treat the gesture as unlocking the audio context

#### Scenario: Locked audio degrades silently
- **WHEN** a notification arrives before audio has been unlocked
- **THEN** no sound SHALL play, no error SHALL surface, and visual and Web Push delivery SHALL be unaffected

### Requirement: Notification settings surface
The Settings → Notifications page SHALL present a per-event configuration where each notification kind exposes its enable toggle (daemon rule), its Telegram and Web Push channel toggles, its sound selection with a "Test" control, and its loop-duration cap. The page SHALL provide a Telegram connect block (bot token and chat id with an in-UI helper for obtaining the chat id and a test-send action) and a Web Push "Enable on this device" action that subscribes the browser. Daemon-backed settings SHALL persist through daemon endpoints; sound settings SHALL persist in `localStorage`. The existing per-device deploy-failure toggle SHALL remain available.

#### Scenario: Per-event row controls a kind
- **WHEN** the user toggles a kind's enable, channel toggles, sound, or loop cap on the page
- **THEN** the corresponding daemon rule/channel settings SHALL be saved through the daemon and the sound settings SHALL be saved to `localStorage`

#### Scenario: Telegram connect validates before relying on it
- **WHEN** the user enters a Telegram token and chat id and triggers the test-send action
- **THEN** the page SHALL attempt a Telegram delivery and report success or failure before the channel is relied upon

#### Scenario: Enable Web Push subscribes this device
- **WHEN** the user activates "Enable on this device" and grants permission
- **THEN** the browser SHALL subscribe with the daemon's VAPID public key and the subscription SHALL be POSTed to and stored by the daemon

### Requirement: Notification configuration endpoints
The daemon SHALL expose authenticated endpoints to read and update the daemon-backed notification settings (rules and channel configuration), to register a Web Push subscription, and to send a test notification through a channel. Responses that include channel configuration SHALL redact secret values such as the Telegram bot token.

#### Scenario: Channel config is saved
- **WHEN** an authenticated request updates notification rules or channel configuration
- **THEN** the daemon SHALL persist the change to the global config and apply it to the running engine

#### Scenario: Push subscription endpoint stores the subscription
- **WHEN** an authenticated request POSTs a browser push subscription
- **THEN** the daemon SHALL store it for Web Push delivery

#### Scenario: Test notification exercises a channel
- **WHEN** an authenticated request asks to send a test notification through a channel
- **THEN** the daemon SHALL attempt delivery through that channel and report the outcome

#### Scenario: Secrets are redacted in responses
- **WHEN** the daemon returns notification channel configuration to the UI
- **THEN** secret values such as the Telegram bot token SHALL be redacted

### Requirement: Secrets and disabled-by-default posture
All new notification behavior SHALL be off by default. Channel secrets and push subscriptions SHALL be stored with owner-only file permissions and SHALL never be written to logs.

#### Scenario: Defaults notify nothing
- **WHEN** no `notifications` configuration is present
- **THEN** all rules and channels SHALL be treated as disabled and no notification SHALL be delivered

#### Scenario: Secrets are not logged
- **WHEN** the engine or a channel processes configuration containing a secret
- **THEN** the secret SHALL NOT appear in any log output
