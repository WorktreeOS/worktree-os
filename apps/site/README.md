# @worktreeos/site

The WorktreeOS presentation site — a single static page, no React, no build step.
Its centerpiece is a **live emulation** of the product: the attention-grouped
Sessions rail on the left and a work surface on the right that plays a scripted
afternoon (agent spawns → parallel work → permission pause → `wos up` deploy →
live + exposed). Scrubbable scenes, play/pause, light/dark, reduced-motion fallback.

## Run

```bash
# either open the file directly…
open apps/site/index.html

# …or serve it (right MIME types, optional PORT):
bun run apps/site/serve.ts        # → http://localhost:4950
```

## Files

| File | Role |
|---|---|
| `index.html` | Page markup + all editorial sections; the demo shell is filled by JS. |
| `styles.css` | quiet-workspace v3 tokens (lifted from `apps/web/src/index.css`) + page + demo styles. |
| `demo.js` | The emulation engine — scene timeline, rail/surface renderers, transport. |
| `main.js` | Page chrome — theme toggle, sticky nav, scroll reveals, copy button. |
| `serve.ts` | Optional Bun static server. |

## Design notes

- Visual language is the product's own **quiet-workspace v3** (Geist / Geist Mono,
  warm ivory shell, hairline rules, state expressed as *dot + word*). Amber
  (`--accent-cmd`) stays reserved for command prompts. Tokens mirror the app so the
  two surfaces cannot drift.
- The drama is one living element + typesetting and negative space — no gradient
  meshes, KPI tiles, or pulse rings (the app's documented anti-patterns).
- Fonts and `lucide` icons load from CDN, matching the repo's existing demo HTML.
