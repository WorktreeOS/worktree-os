---
title: Selective startup
description: Start a subset of services with an explicit list or a named target, plus their transitive dependencies.
---

By default `wos up` brings up every service. In **generated mode** you can start
just a subset, and WorktreeOS adds their transitive dependencies automatically.

## Explicit service list

Pass a comma-separated list of service names as the positional argument:

```bash
wos up app,api
```

WorktreeOS starts those services plus anything they declare in
`app.services.<name>.dependencies`, transitively, and emits `depends_on` in the
generated Compose file.

## Named targets

Define reusable sets under the top-level `targets` section of the deploy config. Each
target is a non-empty list of existing services (app or deps):

```yaml
targets:
  app:
    - app
  backend:
    - api
    - admin

app:
  image: node:22
  init_script:
    - bun install
  services:
    app:
      ports: [3000]
      script: [bun dev]
      dependencies: [api]
    api:
      ports: [3001]
      script: [bun dev]
      init_script:
        - cd packages/api && bun install
      dependencies: [db]
    admin:
      ports: [3002]
      script: [bun dev]
deps:
  db:
    image: postgres:13
    ports: [5432]
```

Then start one with `--target`:

```bash
wos up --target backend
```

This starts the contents of the target plus transitive dependencies.

## Generated mode only

Selective startup works **only** in generated mode (`mode: generated` or no
`mode`). Running with an explicit service list or a target in `mode: compose` is
rejected with a clear error — compose mode always brings up everything described
in your Compose file through `compose.expose`.

## Related

- [Dependencies](/configuration/dependencies/)
- [Targets](/configuration/targets/)
- [Services and ports](/configuration/services-and-ports/)
