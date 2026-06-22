---
title: Healthchecks
description: How WorktreeOS HTTP-checks app ports during wos up, the lenient default, per-port options, and global defaults.
---

For each app port WorktreeOS runs an HTTP healthcheck after the services start
successfully, and only completes `wos up` once every **required** healthcheck
has passed. This applies to the Docker-backed generated and compose modes and to
[shell mode](/configuration/shell-mode/) alike — in shell mode the check polls
the host port the service process binds.

## How the check runs

`wos up` polls the port repeatedly within the overall `timeout` window
(default `3m`). Errors during `start_period` (default `15s`) are not counted
against `retries`; WorktreeOS then waits `interval` (default `5s`) between
attempts and ends the check after `retries` failed attempts (default `20`) or
once `timeout` elapses.

While the check is in progress the status reads `waiting` (yellow); if it ends
without a successful response, it reads `FAILED`.

## The lenient default

By default any HTTP response **below 500** (200, 204, 301/302, 401/403/404, …)
is treated as success — it means the service is accepting connections. 5xx codes
and network errors are failures.

The numeric port notation is equivalent to an object with default values:
`healthcheck: { url: "/" }` plus timeouts from the global settings, and
`allow_failure: false`.

## Per-port options

The full set of fields is
`healthcheck: { url, status, timeout, start_period, interval, retries }`:

- `url` must start with `/`.
- `status` is within `100..599`. Adding `status: N` makes the check **strict**
  (e.g. `status: 204` accepts only `204`).
- durations accept a number of milliseconds or strings with `ms`, `s`, `m`
  suffixes; `retries` is a positive integer.

Special values:

- `healthcheck: false` — disable the check for that port.
- `allow_failure: true` — a failing check does not abort `wos up`; it appears in
  status as failed (allowed).

```yaml
app:
  services:
    api:
      ports:
        - 3000                # default healthcheck GET / -> < 500
        - port: 3002
          healthcheck:
            url: /health
            status: 204
            timeout: 1m
            start_period: 10s
            interval: 10s
            retries: 3
        - port: 4000
          healthcheck: false  # port without a check
        - port: 5000
          allow_failure: true # a failed check does not abort up
```

Timing parameters not provided per port fall back to the `healthcheck` block in
`<wos-home>/config.json`, and if absent there too, to the built-in defaults.

## Global defaults

To change timings for every service in the project (or across projects) without
editing the deploy config, add a `healthcheck` section to
`<wos-home>/config.json`:

```jsonc
{
  "healthcheck": {
    "timeout": "5m",         // a string with ms|s|m suffix or a number of ms
    "start_period": "30s",
    "interval": "5s",
    "retries": 30,
    "request_timeout": "15s" // how long to wait for a single HTTP response
  }
}
```

`request_timeout` is the limit for an **individual** HTTP call within the waiting
window (default `10s`). If a service warms up slowly (Spring, Rails, an ML
server) and the first request to `/` takes longer than 10 seconds, healthchecks
keep failing on per-attempt timeout even with a live container — increase
`request_timeout`.

Any field explicitly set in the deploy config (including numeric per-port values)
takes precedence over the global `config.json`. Changes take effect after a daemon
restart (`wos restart`).

## Status values

`wos status` reports each port's healthcheck as one of:

- `healthy` — the configured URL returned the expected status in time.
- `waiting` — still polling within `start_period` / `timeout` / `retries`.
- `failed` — the budget expired without a healthy response and `allow_failure`
  is false.
- `failed (allowed)` — failed, but the port has `allow_failure: true`.
- `disabled` — the port has `healthcheck: false`.

See [Healthcheck failures](/troubleshooting/healthcheck-failures/) for
debugging.
