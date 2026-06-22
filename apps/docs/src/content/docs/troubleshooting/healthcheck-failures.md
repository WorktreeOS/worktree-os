---
title: Healthcheck failures
description: Interpret waiting/failed healthcheck states and fix slow-warming services or misconfigured URLs.
---

If `wos up` fails after Compose startup with a healthcheck error, or
`wos status` shows a `failed` healthcheck, work through these checks.

## Read the status first

`wos status` reports each port's healthcheck:

- `healthy` — the URL returned the expected status in time.
- `waiting` — still polling within `start_period` / `timeout` / `retries`.
- `failed` — the budget expired without a healthy response (`allow_failure`
  false).
- `failed (allowed)` — failed, but the port has `allow_failure: true` —
  informational unless you expected success.
- `disabled` — the port has `healthcheck: false`.

## Common causes

- **Status mismatch.** The app responded but with the wrong code. Compare
  expected vs. observed status in the output. If you set `status: N`, the check
  is strict; the lenient default accepts any response below 500.
- **Wrong URL.** The configured `url` must start with `/` and must be a path the
  app actually serves.
- **`waiting` lingers.** The app is slow to come up. Increase `start_period`,
  `timeout`, or `retries` per port, or globally in `config.json`.
- **Slow first response.** If the first request to `/` takes longer than
  `request_timeout` (default `10s`), every attempt times out even with a live
  container. Increase `request_timeout` in `config.json` (Spring, Rails, ML
  servers commonly need this).

```jsonc
{
  "healthcheck": {
    "timeout": "5m",
    "start_period": "30s",
    "request_timeout": "15s"
  }
}
```

Global `config.json` changes are restart-required (`wos restart`); per-port
deploy-config values take precedence.

## When a failure is acceptable

If the port doesn't need to gate the deployment, set `allow_failure: true` (it
will show as `failed (allowed)`), or disable the check with `healthcheck: false`.
Don't silently treat an unexpected `failed (allowed)` as healthy.

## Related

- [Healthchecks](/configuration/healthchecks/)
- [Deployment lifecycle](/concepts/deployment-lifecycle/)
