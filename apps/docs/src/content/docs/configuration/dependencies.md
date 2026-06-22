---
title: Dependencies
description: Declare external dependencies under deps, and wire up startup ordering with service dependencies for selective startup.
---

WorktreeOS has two related but distinct notions of "dependency":

1. **`deps.<name>`** — external services (databases, caches, …) that aren't part
   of your app's code.
2. **`app.services.<name>.dependencies`** — startup-ordering relationships used
   by selective startup.

## External dependencies (`deps`)

`deps.<name>` describes external dependencies with their own images, environment
variables, volumes, and ports:

```yaml
deps:
  db:
    image: postgres:13
    ports:
      - 5432
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: 111111
      POSTGRES_DB: api
    volumes:
      - ./.data/postgres:/var/lib/postgresql/data
```

- `deps.<name>.ports` takes **numbers only**; no healthcheck is performed for
  dependency ports.
- Reference a dependency's generated values from an app service's `environment`
  with `${deps.<name>.containerName}` and `${deps.<name>.hostPort[<port>]}`.

```yaml
app:
  services:
    api:
      environment:
        DATABASE_URL: postgres://postgres:111111@${deps.db.containerName}:5432/api
```

## Service dependencies (`dependencies`)

`app.services.<name>.dependencies` is a list of names of other services (from
`app.services` or `deps`) that this service depends on. During
[selective startup](/guides/selective-startup/), WorktreeOS transitively adds
those dependencies to the final set and emits `depends_on` in the generated
Compose file:

```yaml
app:
  services:
    app:
      ports: [3000]
      script: [bun dev]
      dependencies: [api]
    api:
      ports: [3001]
      script: [bun dev]
      dependencies: [db]
deps:
  db:
    image: postgres:13
    ports: [5432]
```

Running `wos up app` here starts `app`, `api`, and `db` — the transitive closure
of `app`'s dependencies.

## Related

- [Selective startup](/guides/selective-startup/)
- [Targets](/configuration/targets/)
- [Services and ports](/configuration/services-and-ports/)
