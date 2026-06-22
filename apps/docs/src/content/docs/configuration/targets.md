---
title: Targets
description: Define named service sets in the deploy config and start them with wos up --target.
---

`targets` is a top-level section of the deploy config for **named service sets**. Each
target is a non-empty list of existing services (app or deps). `wos up --target
<name>` starts only the contents of the target plus their transitive
dependencies.

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

Start a target with:

```bash
wos up --target backend
```

With the config above, `--target backend` starts `api` and `admin`, plus `api`'s
transitive dependency `db`.

## Generated mode only

Targets are part of [selective startup](/guides/selective-startup/), which works
only in generated mode. Using `--target` (or an explicit service list) in
[compose mode](/configuration/compose-mode/) is rejected with a clear error.

## Related

- [Selective startup](/guides/selective-startup/)
- [Dependencies](/configuration/dependencies/)
