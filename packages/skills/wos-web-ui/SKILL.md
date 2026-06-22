---
name: wos-web-ui
description: Open or print the wos web UI URL with wos web and wos web --no-open, including worktree detail URLs printed by wos up.
tags: [cli, web, ui]
---

# wos-web-ui

Use this skill when the user wants to **open the wos web UI**, get its URL for use in another tool, or understand the worktree detail URL printed by `wos up`.

## When to use this skill

- The user says "open wos", "show me the dashboard", or "open the web UI".
- The user wants the web UI URL without launching a browser (for example, to embed it in a script, share with another agent, or open in a remote browser).
- You need to interpret the URL printed at the end of `wos up` or `wos up -d`.

## `wos web`

`wos web` ensures the daemon is running, prints the web UI URL on a single stdout line, and launches the platform's default browser at that URL.

```sh
wos web
```

Behavior to remember:

- The command works from **any directory** — it does not require a Git worktree.
- If no daemon is running, wos starts it before reading the URL.
- The default web UI URL is `http://127.0.0.1:4949` (override port via global config; URL becomes `https://127.0.0.1:<port>` when `web.ssl` is enabled — see `wos-config`).
- On macOS the command uses `open`, on Linux `xdg-open`, on Windows `start`.

Exit semantics:

- Success → exit `0`, URL on stdout, browser opened.
- The web UI is disabled (no `webUrl` reported by the daemon) → stderr error explaining how to free the configured port or change `web.port`, exit non-zero.
- Browser launcher missing or non-zero → URL is still on stdout; a single-line warning goes to stderr; exit `0`.

## `wos web --no-open`

Same as `wos web` but **does not** launch a browser. Use it when:

- The agent only needs to know the URL (for example, to paste into a remote browser or another tool).
- The user is on a headless host without a browser.
- The user explicitly does not want a new browser window.

```sh
wos web --no-open
```

Exit semantics: prints the URL to stdout, no launcher invocation, exit `0` on success.

## Worktree detail URLs

When `wos up` and `wos up -d` succeed and the daemon reports a web UI base URL, the CLI prints a URL that opens the **worktree detail route** for the current worktree:

- Use that URL to give the user (or another agent) a deep link to logs, statuses, and tunnel info for that worktree.
- If the daemon metadata does not include a web UI URL, the CLI still reports the command outcome but states that the web URL is unavailable. That is not a deployment failure — it just means the web UI is disabled or unreachable.

## Common patterns

- **Open the dashboard:** `wos web`.
- **Get the URL only:** `wos web --no-open` and capture stdout.
- **Deep link to a worktree after deploy:** copy the URL printed at the end of `wos up` or `wos up -d`.

## Safety guidance

- The web UI is the right place to send the user for **observation** (logs, healthchecks, tunnel state). Do not use the CLI to scrape that information in a loop — point the user at the URL instead.
- If the user is on a remote machine, prefer `--no-open` to avoid launching a browser on the wrong host.
- `wos web` is read-mostly from wos's perspective: it starts the daemon if needed, but does not mutate deployments or session state.
