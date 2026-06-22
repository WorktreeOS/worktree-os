/* Personal, per-browser ordering for the rail's terminal-session rows. The
 * canonical session list stays authoritative (terminal-sessions-context emits
 * `createdAt` order and resyncs every 2.5s); this is a render-time projection
 * over it, persisted in localStorage alongside pins / expansion / scope.
 *
 * The stored value is a single flat array of session ids across every
 * worktree. Per-worktree projection filters it to that worktree's session ids,
 * so cross-worktree ids are simply ignored. Defensive parse mirrors
 * `pinned-worktrees.ts`; the storage param stays injectable like
 * `panel-width.ts` so read/write are unit-testable without a global. */

export const TERMINAL_ORDER_STORAGE_KEY = "wos.sidebar.terminalOrder";

export function readTerminalOrder(
  storage?: Pick<Storage, "getItem"> | null,
): string[] {
  const store =
    storage ??
    (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return [];
  try {
    const raw = store.getItem(TERMINAL_ORDER_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

export function writeTerminalOrder(
  value: ReadonlyArray<string>,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  const store =
    storage ??
    (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return;
  try {
    store.setItem(TERMINAL_ORDER_STORAGE_KEY, JSON.stringify([...value]));
  } catch {
    /* ignore quota / privacy mode */
  }
}

/* Project the canonical (createdAt-ordered) sessions onto the stored order:
 * sessions whose id is in `orderedIds` come first in that order, then any
 * remaining session (newly spawned or never reordered) in its incoming
 * `createdAt` order. Stale / cross-worktree ids in `orderedIds` are tolerated
 * (they match no session and are skipped). */
export function applySessionOrder<T extends { id: string }>(
  sessions: ReadonlyArray<T>,
  orderedIds: ReadonlyArray<string>,
): T[] {
  if (orderedIds.length === 0) return [...sessions];
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const known: T[] = [];
  for (const id of orderedIds) {
    const s = byId.get(id);
    if (s && !seen.has(id)) {
      known.push(s);
      seen.add(id);
    }
  }
  const unknown = sessions.filter((s) => !seen.has(s.id));
  return [...known, ...unknown];
}

/* Drop ids that no longer correspond to a live session, preserving order. No
 * write side-effect — the caller persists if the result differs. */
export function pruneTerminalOrder(
  orderedIds: ReadonlyArray<string>,
  liveSessionIds: ReadonlySet<string>,
): string[] {
  return orderedIds.filter((id) => liveSessionIds.has(id));
}
