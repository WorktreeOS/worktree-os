---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

### Style guide

The web frontend uses the **quiet-workspace v3** visual language. The page should read as a calm document about a worktree, not as an operator console. Treat "everything is fine" as the default visual state; deployment, failure, and warnings are *local accents*, never global chrome.

**Living references**

- Token set + base styles: `apps/web/src/index.css`.
- Visual reference HTML: `demo/design_v3.html` (do not delete; sync visual tweaks against it).
- Left-rail reference HTML — `demo/sidebar-worktree-band-v3.html` is the canonical rail reference. The rail is a **single unified surface** — there is **no rail mode and no mode switch**. Top to bottom: a scope control (a project / `Active now`) → an attention **filter bar** (`All` + Needs you / Unread / Working / Idle, neutral counts) + a `New session` launcher → a live-session **stream** grouped by attention (project identity **tiles**, the working state animates the tile border; no per-row status dot — the group states the state) → a collapsible **Worktrees band** (the project's full worktree inventory + management) → a **profile footer**. `Add project` lives in the scope dropdown. Do not delete; keep `apps/web/src/components/sidebar.tsx` in sync with it.
  - **Worktrees band** — beneath the stream, the project's full inventory (every worktree, including idle ones with no live session). Flat rows: leading status dot (`StatusDot`/`statusDotVariant`) + Geist-Mono branch name + `root` badge for the source + a quiet status word and live-session count (`· N`); a `⋯` overflow opens the worktree actions menu (Open worktree · New session here · Rename · Add note · state-aware Start/Restart/Stop · Remove). Band rows are flat — no expansion, no nested runtime/sessions/`New terminal` (sessions are in the stream; runtime is in the dossier / Runtime tab). The header carries `New worktree`; the band is collapsible (`wos.sidebar.bandCollapsed`). In `Active now` scope the band groups worktrees by project, each group header carrying its own `New worktree`. Worktree drag-reorder is offered in project scope; project-group drag-reorder in `Active now`.
  - **Profile footer** — grounds the rail: avatar + name/plan line + a control cluster with `Home` (links `/`, always shown), the theme control, and `Settings` (links `/settings`, hidden for public sessions). There are no top `Home`/`Settings` navigation rows — they live in the footer.
  - `demo/sidebar-stream-v3.html` and `demo/side-menu-v3.html` are **no longer canonical** (they illustrate the retired Sessions/Worktrees modes); kept on disk for history only.
- Central worktree document reference HTML: `demo/worktree-page-v3.html` — the "work dossier" central page (identity + editable intent hero, `now` line, Branch & changes ledger + change summary, Sessions, single runtime summary line, continue-actions row). Canonical for `apps/web/src/routes/worktree/worktree-overview.tsx` the way `design_v3.html` is for surfaces and `sidebar-worktree-band-v3.html` is for the rail; do not delete, keep the overview in sync with it.
- Primitives: `apps/web/src/components/ui/*`.
- Document shell + surface variants: `apps/web/src/routes/worktree/document.tsx` + `worktree-overview.tsx` / `worktree-deploying.tsx` / `worktree-failed.tsx` / `worktree-not-started.tsx`.

**Anti-patterns (legacy "mission console" language — do NOT reintroduce)**

- No KPI tiles, corner-ticks, gradient hero, "tape" indeterminate stripes, pulse rings on dots.
- No `01 SECTION` / mono section numbers. Section headers are plain Geist sans, weight 600.
- No bordered status chips for `running` / `healthy` / `stopped` — express state via leading dot + inline word (`running · healthy`).
- No `--signal-active-soft` / `--signal-warn-soft` / `--signal-error-soft` / `--grid-line` / `--grid-dot` tokens. They are removed; do not re-add.
- No `JetBrains Mono`, no `Inter`/`Roboto`/system-sans fallbacks, no serif anywhere.

**Tokens**

- v3-specific: `--surface` (white document), `--shell` (warm off-white outer), `--ink` / `--ink-2` (foreground tiers), `--hair` / `--hair-2` (1px dividers, 2 tiers), `--chip-bg` (inline-code chip), `--accent-cmd` (amber, *commands only*), `--good` / `--bad` / `--warn` (text-only colors for diff / status words), `--unread` (blue, exclusively for the unread-session modifier: bold session name + small filled trailing dot on `TerminalSessionRow` / `SessionRow`; never reuse `--accent-cmd`).
- Project identity palette: `--p-1 … --p-36` (light + dark) — 36 curated, maximally-distinct hues used only to color the rail's session-stream project tiles (`ProjectTile`, via `color-mix`). Authored in OKLCH with golden-angle hue stepping (gamut-mapped to sRGB) and ordered so any prefix is maximally dispersed. The palette spans the **full hue wheel** — it is *not* hue-excluded from the status semantics: a project tile is a large rounded-square monogram, a different visual class from the 7px `StatusDot`, so a red/green tile does not read as health. The amber `--accent-cmd` band stays reserved for `/slash-command` prefixes. A project's slot is **persisted** on its registry record (`colorSlot`, assigned round-robin by least-used slot so the first projects get the most distinct colors) and is **user-overridable** in Settings → Projects via a swatch-grid picker; `projectTile(project)` (`lib/project-identity.ts`) maps the slot to `--p-{n}`. The slot count must equal `PROJECT_PALETTE_SIZE` in `project-registry.ts`.
- shadcn-compatible aliases (`--background`, `--foreground`, `--card`, `--border`, `--muted-foreground`, `--accent`, `--destructive`, `--radius`) are preserved and remapped onto v3 values — keep using them in shadcn-style primitives. Both light and dark variants are defined in `index.css`.

**Primitives — compose new UI from these**

| Primitive | Use |
|---|---|
| `Button` | 30pt pill with hairline border. Variants: `default` / `solid` (black fill) / `ghost` / `danger`. Sizes `xs` / `sm` / `md` / `lg`. |
| `IconButton` | 28pt round, lucide icon at 16px, hover-fill only. |
| `SplitButton` | For `Stop ▾` style actions. |
| `Ic` / `InlineCode` | Inline code chip in Geist Mono at `0.92em` for paths, ports, branch names, commands. |
| `CommandPill` | `/slash-command <arg>` row with amber prefix + timestamp/refresh. Amber is exclusive to the slash prefix. |
| `TodoBanner` | `N of M completed` / `failed` / `running` status banner with spinner for live states. |
| `HairlineList` + `HairlineRow` | Service / tunnel rows: `dot 1fr ports actions` grid. Replaces card-style `ServiceCard`. |
| `Composer` | Bottom command input (`+`, `Run command…`, model selector, mic). Currently a visual stub — keep `aria-disabled`. |
| `WindowChrome` | Top bar: macOS traffic lights + breadcrumb (`<branch> — WorktreeOS`) + sidebar/search/history tools. |
| `Rail` / `RailGroup` / `RailRow` | Left sidebar shell — a **single unified surface, no rail mode**. Top: scope control → attention filter bar + `New session` launcher → a `StreamSessionRow` stream grouped by attention → a collapsible **Worktrees band** (`WorktreeBandRow`: status dot + Geist Mono branch name + `root` badge + status word + `· N` count + `⋯` actions menu) → a profile footer (avatar / plan-meta + `Home` / theme / `Settings`). `New worktree` lives in the band header (per-project group header in `Active now`); `Add project` lives in the scope dropdown. |
| `StatusDot` | 7px leading health dot for rail rows. Variants `run` / `partial` / `fail` (filled) and `stopped` / `idle` (hollow rings). `statusDotVariant(status)` maps a `DeploymentStatus`. Colours from tokens (`--good` / `--bad` / `--muted-foreground` / `--hair-2`) + status amber `#F59E0B`; never `--accent-cmd`. |
| `SegmentedControl` | `variant="filter"` — the rail's **attention filter bar** (`All` / `Needs you` / `Unread` / `Working` / `Idle`, each with a count); pass `countTone="neutral"` for the rail's plain group counts (the red `danger` count stays reserved for an attention segment like Mission Control's `Waiting`). `variant="mode"` — the chip-bg track switch primitive (icons + neutral count badge); not used by the rail, retained for `review-sidebar.tsx` (Review view/layout toggles). `size="touch"` enlarges hit targets. |
| `TerminalSessionRow` | One open session row with status dot + agent glyph/label (brand-tinted) or shell glyph/label + active command + age, Attach / Kill on hover. Unread sessions (`unreadSince`) render a bold name + small filled `--unread` trailing dot. Renders the shared `TelemetryCluster` on line 2. **No longer mounted in the rail** (the worktree tree it lived in was retired for the Worktrees band); retained as a primitive. |
| `StreamSessionRow` | One live session in the rail's session stream: `ProjectTile` + agent glyph (`terminalAgent`) + title (`terminalLabel`; bold name + `--unread` trailing dot when unread) on line 1; worktree name (+ command, for shells) + `TelemetryCluster` on line 2; an amber permission line for `awaiting-input`. **No** leading status dot — the attention group conveys the state; the working state animates the `ProjectTile` border. Trailing hover actions: attach · new-here · kill (Attach inline on touch). |
| `WorktreeBandRow` | One flat worktree row in the rail's Worktrees band: leading `StatusDot` (`statusDotVariant`) + Geist-Mono `worktreeLabel` + `root` badge for the source + a quiet status word (`runtimeStatusWord`) and live-session count (`· N`); a trailing action cluster (hover-revealed on desktop, always shown on touch) with a quick `New session` (`+`) shortcut and a `⋯` overflow opening the worktree actions menu (Open · New session here · Rename · Add note · state-aware Start/Restart/Stop · Remove). No expansion — sessions are in the stream, runtime in the dossier. Draggable in project scope. |
| `ProjectTile` | Rounded-square monogram tile giving a project its identity in the session stream: `color-mix` fill + inset ring in the project color (`projectTile()` → `--p-*` slot + monogram). When `working`, a bead traces the tile border in the project color (`.tile-run` SVG runner in `index.css`, removed under `prefers-reduced-motion`). Always a rounded square — never a circle. |
| `TelemetryCluster` | The shared line-2 telemetry cluster (context meter + `contextUsed` · `mainTokens`, reds past the warn threshold, wrapped in `TelemetryPopover`). Rendered identically by `TerminalSessionRow` and `StreamSessionRow` so the two rows cannot drift. Keeps the `rail-terminal-telemetry` / `-context` / `-tokens` test ids. |
| `AttentionGroupHeader` | The quiet divider above each non-empty session-stream group: colored dot (amber / `--unread` / `--good` / `--muted-foreground`) + group name + count. |
| `NewSessionLauncher` | The rail's `New session` `+` popover beside the filter bar: pick a target worktree (grouped by project) → create a plain terminal via `createTerminalLayerSession({ worktreePath })` and attach. No agent picker (deferred). |
| `Ledger` | Quiet label/value grid (`rows` of `{label, value}`) for the worktree dossier's branch posture spine (upstream / working-tree / last-commit). Muted labels, `--ink-2` values; callers pass only rows with data. No chips, no borders. |
| `ChangeSummaryRow` | One changed file on the dossier: mono path + `+N` / `−M` (`--good` / `--bad` text) + a 5-cell diff bar whose green/red split mirrors the additions/deletions ratio. Presentation only; the parent gates it on already-loaded Review diff data. |
| `SessionRow` | One open terminal session on the dossier's Sessions section: agent glyph (brand-tinted for Claude Code / Codex / OpenCode via `terminal-agents`, else neutral shell glyph) + name/command + live/exited state with age + primary `Attach`. Answers "where is my agent"; never appears in the Runtime tab. Unread sessions get the same bold-name + `--unread` trailing-dot treatment as `TerminalSessionRow`. |
| `RuntimeSummaryLine` | The dossier's one-line runtime demotion: `StatusDot` + status word + quiet `facts` (service count, representative exposed address, freshness) + an `Open Runtime` / `Start in Runtime` handoff, with an optional `meta` line beneath. The central document SHALL NOT render service rows, ports, tunnels, logs, or controls — those stay in the Runtime tab. |
| `ErrorBlock` | Soft-red diagnostic block with stack trace + inline-chip citation. Failed surface only. |
| `Checkbox` | Plain check, used in NotStarted options (`Run migrations`, `Reset database`, etc.). |

Do not bypass these primitives with ad-hoc divs. If a primitive is missing, add it to `apps/web/src/components/ui/` rather than inlining.

**Worktree page shape**

`worktree.tsx` is decomposed by state into surface components rendered inside one `<Document>` shell (`WindowChrome` → `Rail` → `Document.Head` / `.Body` / `.Footer` with `Composer` + context line):

- `worktree-overview.tsx` — the central "work dossier" for **every** deployment status (running / partial / stopped / not-started). Anatomy per `demo/worktree-page-v3.html`: identity + editable `IntentBlock` hero → `NowLine` (branch facts + one quiet status word) → `Branch & changes` (`Ledger` + `ChangeSummaryRow` preview gated on loaded Review data) → `Sessions` (`SessionRow`, agent-aware) → single `RuntimeSummaryLine` (handoff to the Runtime tab) → continue-actions row (Review / Files / Terminal / Open web). Renders no service rows, ports, tunnels, runtime logs, or lifecycle controls — those live in the Runtime tab.
- `worktree-deploying.tsx` — live `CommandPill` with timer → spinning `TodoBanner` → numbered pipeline steps → `<pre>` log tail.
- `worktree-failed.tsx` — red `TodoBanner` (`Step N failed`) → `ErrorBlock` → steps up to failure → action row `Retry from failed step / Open log / Reset volume`.
- `worktree-not-started.tsx` — branch H1 → prose → checkbox options → action row `Start worktree / Open terminal only`.

Behavioural hooks (`useWorktreeDetail`, `useDeploymentAction`, daemon events) stay shared in the route container — surfaces are presentation only.

**Typography & iconography**

- Sans: **Geist** for everything; mono: **Geist Mono** for inline code / ports / branches / commands. Both loaded via Google Fonts in `apps/web/index.html`. `var(--font-mono)` resolves to Geist Mono.
- Icons: **`lucide-react`** only. Stroke-width `1.75`. Sizes are baked into primitives (14 in `Button`, 15 in rail rows, 16 in `IconButton`). The Stop square is `lucide` `square` with `fill: currentColor`.

**Color rules**

- Amber `--accent-cmd` is reserved for `/slash-command` prefixes. Never use it for headings, focus rings, links, or filled buttons.
- Status is dot + word, never a bordered chip. Diff `+12` / `−3` use `--good` / `--bad` on text only, never as backgrounds.
- Active rail row uses a soft fill, not an accent-colored border.

**Motion**

- Page-load: staggered `reveal` on `Document.Body` children (translateY 6px → 0, opacity), delays 30/80/140/200/260/320 ms.
- `TodoBanner` spinner: `animate-spin` ~1.1s.
- No pulse rings on dots, no animated gradients, no per-step indeterminate stripes.

**Other constraints**

- Use `react-router` for frontend routing. Don't use TanStack Router for this project.
- Keep frontend code in `apps/web`; shared non-frontend logic should come from workspace packages.
- Cover light + dark, desktop + iPad (tailwind `md:` / `lg:`) + phone sanity check (390pt). Don't introduce custom `@media` blocks when a breakpoint utility fits.
- All source code, UI strings, code comments, and committed file content in this repo are English-only.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
