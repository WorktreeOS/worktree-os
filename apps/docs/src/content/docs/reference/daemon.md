---
title: Daemon behavior
description: Daemon lifecycle, config.json keys, and an overview of optional public tunnels and HTTPS.
---

The local daemon owns Docker operations and session state, and serves the web
UI. This page covers its lifecycle, the `config.json` keys, and the optional
remote-access surface.

## Lifecycle and auto-start

- **Auto-start.** `up`, `down`, and `status` first check `/v1/health` on the
  socket. If there is no response, they start `wos start --foreground` in the
  background and wait for its health check. If the daemon doesn't come up within
  the timeout, the command fails with a hint to start it manually.
- **Busy session.** Only one mutating operation (`up` or `down`) can be active
  per session. A concurrent `up`/`down` responds with 409 and the active
  operation id; the CLI writes `session <name> is busy (active op <id>)` to
  stderr. This is a safe refusal — the client does not bypass the daemon.
- **Explicit restart.** `wos restart` stops the current daemon (by the PID from
  the health check), removes `daemon.sock` and `daemon.json`, starts a fresh
  instance, and waits for its health check. Docker services keep running — the
  restart affects only the control plane. Works from any directory.
- **Stale socket.** If the socket exists but doesn't answer health, it's a
  leftover from a crashed daemon. The CLI removes it and starts fresh on the
  next call. For explicit cleanup use `wos restart` or remove the files:
  `rm <wos-home>/daemon.sock <wos-home>/daemon.json`.
- **One daemon per `<wos-home>`.** Setting `WOS_HOME` gives each value its own
  daemon, isolating CI and local environments.
- **Client disconnect.** Closing the web UI or a CLI client does not stop Docker
  services or kill daemon-owned log followers. Services run until `wos down`.

## `config.json`

`<wos-home>/config.json` is optional user configuration. Supported keys:

- **`web.port`** — integer in `[1, 65535]`, defaults to `4949`.
- **`web.host`** — single address the web UI / UI API listener binds to,
  defaults to `127.0.0.1`. Set a LAN address (e.g. `192.168.1.18`) to reach
  the web UI from another device. Lists are not supported; an invalid value
  falls back to `127.0.0.1`.
- **`serviceBind`** — optional LAN address for managed service ports. In
  generated-compose mode each managed port is published on **both**
  `127.0.0.1` and this address (keeping the loopback tunnel proxy and
  healthchecks working), and the `localhost` fallback of `url[<port>]` /
  `hostname[<port>]` / `WOS_SERVICE_HOSTNAME` resolves to it. An active
  tunnel still wins. Advisory in shell mode — the process must bind
  `0.0.0.0` (or honor `WOS_SERVICE_HOSTNAME`) to be reachable. Editable
  from the web UI Settings page.
- **`web.public`** — optional public daemon web/UI API publication
  (`enabled`, `hostname`, `secret`). Disabled by default.
- **`tunnel`** — public tunnel settings (see below).
- **`healthcheck`** — global default timings for app-port healthchecks
  (`timeout`, `start_period`, `interval`, `request_timeout`, `retries`). Any
  option omitted falls back to built-in defaults (`3m`/`15s`/`5s`/`10s`/`20`).
  Per-port settings in the deploy config take precedence. See
  [Healthchecks](/configuration/healthchecks/).

```jsonc
{
  "web": {
    "port": 4949,
    "host": "127.0.0.1",
    "public": {
      "enabled": false,
      "hostname": "wos.example.com",
      "secret": "change-me"
    }
  },
  "serviceBind": "192.168.1.18",
  "healthcheck": {
    "timeout": "5m",
    "start_period": "30s",
    "interval": "5s",
    "retries": 30,
    "request_timeout": "15s"
  }
}
```

Changes to `config.json` are **not** picked up live — update the file and run
`wos restart`. If the web port is busy at startup, the web UI is disabled while
the Unix-socket API keeps working.

You can edit every supported key from the web UI's local-only Settings page
(`/settings`); see [Using the web UI](/guides/web-ui/).

:::caution
Treat `<wos-home>/config.json` as a sensitive local file — it stores secrets
(`web.public.secret`, `tunnel.webUi.secret`) in plaintext.
:::

## Optional public tunnels

WorktreeOS runs a single daemon-owned HTTP server that routes requests by `Host`
header to local listener ports. The tunnel listener is the only remote-facing
surface; the local web UI listener stays loopback-only. Tunnels are configured
under `tunnel` in `config.json`:

```jsonc
{
  "tunnel": {
    "enabled": true,             // false by default; starts the listener only
    "port": 5858,                // public listener port (default 5858)
    "domain": "example.com",     // required when enabled: true
    "serviceTunnels": {
      "enabled": true,           // publishes per-service routes
      "whitelistIps": []         // exact IPs allowed; [] = all
    },
    "webUi": {
      "enabled": true,           // publishes the management UI
      "subdomain": "wos",        // DNS label or full hostname under domain
      "secret": "change-me",     // required when webUi.enabled: true
      "terminalEnabled": false,
      "whitelistIps": []
    }
  }
}
```

Key behaviors:

- `tunnel.enabled: true` starts the listener but does **not** publish service
  ports — that needs `tunnel.serviceTunnels.enabled: true`. When enabled,
  `wos up` registers routes named `{worktree}-{service}.{domain}` (conflicts get
  an automatic increment).
- Tunnels do **not** block deployment: a failed registration leaves the port's
  status `FAILED` and the `hostname[...]` template resolves to `localhost`.
- Tunnel routes are session-scoped: they close on a repeat `wos up`, on
  `wos down`, on failure, and when the daemon stops. On `wos restart` active
  service routes are restored for running services with valid WorktreeOS labels.
- Both route classes accept an exact-IP `whitelistIps` list; a non-empty list
  returns `403` for any other source IP.
- The public web UI (`tunnel.webUi`) is fully opt-in, requires a shared secret,
  and is fail-soft. The legacy Unix-socket `/v1/*` API is never exposed over the
  public route.

## HTTPS

Remote HTTPS terminates at the tunnel listener via `tunnel.ssl`. The local web
UI listener is always HTTP on loopback. Three certificate sources are supported
via `source`: `self-signed` (default; browser trust exception required),
`files` (your own `cert`/`key`), and `letsencrypt` (DNS-01 challenge with
Cloudflare or a custom hook, supporting wildcard certs for `*.<domain>`). SSL
settings are restart-required and fail-soft.

:::danger
Without `tunnel.ssl`, WorktreeOS serves plain HTTP and any public secret travels
in cleartext. Only enable public access on trusted networks, enable HTTPS, or
front WorktreeOS with an HTTPS-terminating proxy before exposing it to the
internet.
:::

For the full Let's Encrypt configuration (providers, DNS hook environment
variables, storage layout, renewal, staging vs. production), see the
[`README`](https://github.com/kwolfy/depboy/blob/main/README.md) tunnel section.

## Related

- [Daemon and web UI](/concepts/daemon-and-web-ui/)
- [Daemon errors](/troubleshooting/daemon-errors/)
