# wos pi extension

Maps [pi](https://github.com/earendil-works/pi) lifecycle hooks to
`AgentActivityEvent` emissions delivered fire-and-forget to the wos daemon. It
mirrors `packages/plugin-opencode`: pi's extension API is a TypeScript
event-subscription model (`pi.on(<event>, async (event, ctx) => …)`, files loaded
via `jiti` from `~/.pi/agent/extensions/`), installed by a file write rather than
a marketplace CLI — so the two plugins share the same `payload.ts` / `send.ts`
delivery shape and the same single-source install model.

## Event mapping (pi lifecycle hook → AgentActivityEvent)

| pi event | Event | resulting state |
|---|---|---|
| `session_start` | `session_start` | idle (bootstrap); binds the session JSONL (`detail.transcriptPath`, `detail.source`) |
| `before_agent_start` | `prompt_submit` | working (summary = the resolved prompt) |
| `tool_execution_end` / `turn_end` | `heartbeat` | working (liveness) |
| `agent_end` | `stop` | idle |

Every emitted event is tagged `agent: "pi"`. The extension emits **no**
`permission_request` / `question_asked` events (deferred scope): pi auto-runs its
tools, so a pi session reports working / idle but never the amber "needs you"
(`awaiting-input`) state through this plugin.

All handlers are best-effort and tolerant: a missing, renamed, or
differently-shaped pi event degrades to less telemetry and never throws, blocks
pi, or alters pi behavior.

## Fire-and-forget delivery

Events POST to `${WOS_DAEMON_URL}/ui/v1/agent-events` with bearer token
`WOS_AGENT_TOKEN` and a ~1s timeout. The daemon injects
`WOS_TERMINAL_SESSION_ID` / `WOS_AGENT_TOKEN` / `WOS_DAEMON_URL` into the PTY pi
runs in (inherited by the extension), so attribution to the terminal session
needs no plugin-side configuration. When the daemon URL or token is absent from
the environment the extension recovers them from `~/.wos/daemon.json` (web URL)
and `~/.wos/agent-token`, and skips silently when still unavailable.

## Install model (single source of truth)

There is no pi plugin marketplace/version CLI, so — like opencode — the install
state is installed/not-installed only (never `outdated`). The daemon installs the
extension by writing a thin shim at `~/.pi/agent/extensions/wos/index.ts` that
re-exports the default factory from the daemon-resolved absolute path to this
package's `src/index.ts`. Detection = the shim exists and references the bundled
source; `ensureAgentPluginsInjected` rewrites a stale shim path idempotently.
