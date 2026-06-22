---
title: Port conflicts
description: What to do when host-port allocation fails or wos retries docker compose up with new ports.
---

WorktreeOS assigns a stable host port for every published container port from
`host_ports.range`. When a port is unavailable, it reallocates and, if
necessary, retries `docker compose up -d` with new ports (up to three attempts).

## When allocation gives up

If startup fails with a host-port bind error after the internal retries:

- The error explains that host-port allocation could not be completed.
- Check `host_ports.range` in the deploy config (default `20000..29999`). The
  range may be **too narrow** or **fully occupied** on the host.

```yaml
host_ports:
  range:
    start: 20000
    end: 29999
```

Widen the range, or free host ports that other processes hold, then retry.

## Other Docker Compose failures

Image-pull failures, container exits, and similar issues surface as standard
Docker Compose errors. Use the [web UI](/guides/web-ui/) for container logs
rather than re-running `wos up` blindly.

## Compose-mode port stripping

In [compose mode](/configuration/compose-mode/), WorktreeOS drops
`services.*.ports` from your Compose file and publishes only `compose.expose`
entries on assigned host ports. If a port you expected isn't published, confirm
it's listed in `compose.expose` as `service:port`.

## Related

- [Services and ports](/configuration/services-and-ports/)
- [Worktrees](/concepts/worktrees/)
