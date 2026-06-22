// Pure logic for the Review tab's branch sync posture row. `apps/web` has no
// render-test harness, so the posture word, button gating, and freshness label
// derivations live here as pure functions covered by `bun test`; `BranchSync`
// itself stays a thin presentational component.

export type SyncStateWord =
  | "up to date"
  | "ahead"
  | "behind"
  | "diverged"
  | "no upstream";

/** Semantic tone for the leading dot + word; the component maps it to tokens. */
export type SyncTone = "good" | "neutral" | "warn" | "bad" | "muted";

export interface SyncPostureInput {
  /** Detached HEAD has no upstream tracking. */
  detached: boolean;
  /** Commits ahead of upstream; omitted when detached / no upstream. */
  aheadCount?: number;
  /** Commits behind upstream; omitted when detached / no upstream. */
  behindCount?: number;
}

export interface SyncPosture {
  word: SyncStateWord;
  tone: SyncTone;
  /** Whether the branch tracks an upstream (false → detached / no upstream). */
  hasUpstream: boolean;
  ahead: number;
  behind: number;
}

/**
 * Derives the sync state word + tone from the branch's ahead/behind posture.
 * A detached HEAD or a branch whose ahead/behind counts are absent (the daemon
 * omits them with no upstream) resolves to `no upstream`. Otherwise the word is
 * `up to date` (level), `ahead`, `behind`, or `diverged` (both > 0).
 */
export function deriveSyncPosture(input: SyncPostureInput): SyncPosture {
  const hasUpstream =
    !input.detached &&
    typeof input.aheadCount === "number" &&
    typeof input.behindCount === "number";
  if (!hasUpstream) {
    return {
      word: "no upstream",
      tone: "muted",
      hasUpstream: false,
      ahead: 0,
      behind: 0,
    };
  }
  const ahead = Math.max(0, input.aheadCount ?? 0);
  const behind = Math.max(0, input.behindCount ?? 0);
  if (ahead > 0 && behind > 0) {
    return { word: "diverged", tone: "bad", hasUpstream, ahead, behind };
  }
  if (ahead > 0) {
    return { word: "ahead", tone: "neutral", hasUpstream, ahead, behind };
  }
  if (behind > 0) {
    return { word: "behind", tone: "warn", hasUpstream, ahead, behind };
  }
  return { word: "up to date", tone: "good", hasUpstream, ahead, behind };
}

export interface SyncControls {
  /** `Fetch` is always available unless an operation is in flight. */
  canFetch: boolean;
  /** `Push` requires unpushed commits and no in-flight operation. */
  canPush: boolean;
}

/**
 * Resolves Fetch/Push enabled flags. Push is gated on having unpushed commits
 * (`ahead > 0`); a diverged branch still enables Push so the daemon can reject
 * it as non-fast-forward and the UI can prompt the user to fetch first. Both
 * actions are disabled while a sync operation is in flight (one at a time).
 */
export function deriveSyncControls(
  posture: SyncPosture,
  opts: { busy: boolean },
): SyncControls {
  if (opts.busy) return { canFetch: false, canPush: false };
  return {
    canFetch: true,
    canPush: posture.hasUpstream && posture.ahead > 0,
  };
}

/**
 * Compact relative freshness label for the last client-side fetch, e.g.
 * `fetched just now` / `fetched 5m ago`. Returns null when no fetch has run
 * this session. `now` is injectable for deterministic tests.
 */
export function freshnessLabel(
  lastFetchedAt: number | null,
  now: number = Date.now(),
): string | null {
  if (lastFetchedAt === null) return null;
  const seconds = Math.max(0, Math.round((now - lastFetchedAt) / 1000));
  if (seconds < 60) return "fetched just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `fetched ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `fetched ${hours}h ago`;
  const days = Math.round(hours / 24);
  return `fetched ${days}d ago`;
}
