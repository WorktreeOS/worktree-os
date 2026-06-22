---
title: Arguments
description: Declare runtime arguments in the deploy config and pass them per deployment with --arg, with shell-style defaults in environment values.
---

`arguments` is a top-level section of the deploy config listing **runtime argument
names** the project accepts. Each entry is a shell environment-style identifier
(`[A-Za-z_][A-Za-z0-9_]*`); names must be unique. Runtime arguments are
supported in generated and shell modes; they are not available in compose mode.

```yaml
arguments:
  - API_URL

app:
  image: node:22
  services:
    api:
      ports: [3000]
      environment:
        EMPL_API_URL: ${API_URL:-https://empl-dev.test-wa.ru}
        DATABASE_URL: postgres://postgres:111111@${deps.db.containerName}:5432/api
deps:
  db:
    image: postgres:13
    ports: [5432]
```

## Referencing arguments in `environment`

Inline service `environment` values reference a declared argument with
shell-style expansion:

- `${API_URL}` — fails if no non-empty value was submitted for `API_URL`.
- `${API_URL:-https://empl-dev.test-wa.ru}` — falls back to the literal default
  when no non-empty value was submitted.

Referencing an undeclared name (`${UNKNOWN}` or `${UNKNOWN:-x}`) fails before
Docker Compose starts. Existing WorktreeOS templates such as
`${deps.db.containerName}` and `${app.services.api.hostPort[3000]}` keep working
alongside runtime arguments.

## Passing values on the CLI

Pass values with one or more `--arg KEY=VALUE` flags. The `--arg=KEY=VALUE` form
is also accepted, and `--arg` combines freely with `-d`, `--force`, `--target`,
and explicit service lists:

```bash
wos up --arg API_URL=https://empl-stage.test-wa.ru
wos up -d --target lk-zup --arg API_URL=https://empl-stage.test-wa.ru
```

## In the web UI

The deployment start/restart modal renders a text input for every declared
runtime argument. Leaving an input blank omits that key from the submitted
payload, so the template default still applies. The sidebar "Start" quick action
submits without runtime arguments and is best used when every declared argument
has a default.

## Related

- [Services and ports](/configuration/services-and-ports/)
- [Detached startup](/guides/detached-startup/)
