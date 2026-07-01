import type { TerminalSessionMetadata } from "./terminal-protocol";

/* Attention grouping for the rail's Sessions mode (see
 * demo/sidebar-stream-v3.html). A flat live-session snapshot is split into four
 * ordered groups — Needs you / Unread / Working / Idle — each session landing in
 * exactly one group. Pure over the snapshot so the filter bar, the group
 * headers, and the stream order are unit-testable without the React tree
 * (mirrors lib/sidebar-scope.ts). */

export type AttentionGroupKey = "needsYou" | "unread" | "working" | "idle";

/** The stream/tree filter union — every attention group plus the "all" catch-all. */
export type StreamFilter = "all" | AttentionGroupKey;

/** Attention groups in render order, with the label the filter bar / group
 * headers show. Shared by the v3 stream and the v4 tree so the two variants
 * can never drift on group naming or order. */
export const STREAM_GROUPS: ReadonlyArray<{
  key: AttentionGroupKey;
  label: string;
}> = [
  { key: "needsYou", label: "Needs you" },
  { key: "unread", label: "Unread" },
  { key: "working", label: "Working" },
  { key: "idle", label: "Idle" },
];

export interface AttentionGroups {
  needsYou: TerminalSessionMetadata[];
  unread: TerminalSessionMetadata[];
  working: TerminalSessionMetadata[];
  idle: TerminalSessionMetadata[];
}

export interface AttentionCounts {
  needsYou: number;
  unread: number;
  working: number;
  idle: number;
  total: number;
}

export interface AttentionResult {
  groups: AttentionGroups;
  counts: AttentionCounts;
}

/* Cluster key for the optional secondary ordering: where a session's worktree
 * sits in the rail's manual band order (project rank, then worktree rank within
 * that project). Lower ranks sort first; unknown paths sink to the bottom. */
export interface StreamOrderKey {
  project: number;
  worktree: number;
}

/** ISO timestamp → epoch ms; missing / unparseable falls back to 0. */
function ms(iso: string | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** Classify a session into exactly one attention group, by D2 precedence:
 *   1. awaiting-input → Needs you (wins even if also unread)
 *   2. else unread output present → Unread
 *   3. else working → Working
 *   4. else → Idle (idle agents and plain shells alike).
 * Exported so the v4 worktree tree can tag each session with the same
 * category the v3 stream groups by, from one source of truth. */
export function classifySessionAttention(
  session: TerminalSessionMetadata,
): AttentionGroupKey {
  if (session.agentActivity?.state === "awaiting-input") return "needsYou";
  if (session.unreadSince) return "unread";
  if (session.agentActivity?.state === "working") return "working";
  return "idle";
}

/* Needs you — oldest wait first: a session blocked the longest is the most
 * urgent. Keyed by question.askedAt, falling back to the activity timestamp. */
function needsYouKey(s: TerminalSessionMetadata): number {
  const activity = s.agentActivity;
  const asked = activity?.question?.askedAt;
  return asked ? ms(asked) : ms(activity?.at);
}

/* Working / Idle — most recently active first. */
function recencyKey(s: TerminalSessionMetadata): number {
  return (
    ms(s.agentTelemetry?.updatedAt) || ms(s.agentActivity?.at) || ms(s.createdAt)
  );
}

/* When `orderKey` is supplied, the rows of a group are first clustered by the
 * band's manual order (project, then worktree) so sibling sessions sit
 * together; the group's time comparator only breaks ties inside one worktree.
 * Array.sort is stable, so equal keys keep insertion order. Without `orderKey`
 * the group falls back to the pure time order. */
function groupComparator(
  timeCmp: (a: TerminalSessionMetadata, b: TerminalSessionMetadata) => number,
  orderKey?: (session: TerminalSessionMetadata) => StreamOrderKey,
): (a: TerminalSessionMetadata, b: TerminalSessionMetadata) => number {
  if (!orderKey) return timeCmp;
  return (a, b) => {
    const ka = orderKey(a);
    const kb = orderKey(b);
    if (ka.project !== kb.project) return ka.project - kb.project;
    if (ka.worktree !== kb.worktree) return ka.worktree - kb.worktree;
    return timeCmp(a, b);
  };
}

export function groupSessionsByAttention(
  sessions: ReadonlyArray<TerminalSessionMetadata>,
  orderKey?: (session: TerminalSessionMetadata) => StreamOrderKey,
): AttentionResult {
  const groups: AttentionGroups = {
    needsYou: [],
    unread: [],
    working: [],
    idle: [],
  };

  for (const session of sessions) {
    groups[classifySessionAttention(session)].push(session);
  }

  // Needs you — oldest wait first (askedAt ascending).
  groups.needsYou.sort(
    groupComparator((a, b) => needsYouKey(a) - needsYouKey(b), orderKey),
  );
  // Unread — most recent output first (unreadSince descending).
  groups.unread.sort(
    groupComparator((a, b) => ms(b.unreadSince) - ms(a.unreadSince), orderKey),
  );
  // Working / Idle — most recently active first.
  groups.working.sort(
    groupComparator((a, b) => recencyKey(b) - recencyKey(a), orderKey),
  );
  groups.idle.sort(
    groupComparator((a, b) => recencyKey(b) - recencyKey(a), orderKey),
  );

  const counts: AttentionCounts = {
    needsYou: groups.needsYou.length,
    unread: groups.unread.length,
    working: groups.working.length,
    idle: groups.idle.length,
    total:
      groups.needsYou.length +
      groups.unread.length +
      groups.working.length +
      groups.idle.length,
  };

  return { groups, counts };
}

/** Order a single worktree tree node's sessions for the v4 tree: needs-you
 * first (oldest wait first), then unread (most recent first), then working,
 * then idle (each most-recently-active first) — i.e. `STREAM_GROUPS` order,
 * each group internally sorted by its existing comparator. Reuses
 * `groupSessionsByAttention` rather than re-deriving urgency logic. */
export function orderSessionsForTreeNode(
  sessions: ReadonlyArray<TerminalSessionMetadata>,
): TerminalSessionMetadata[] {
  const { groups } = groupSessionsByAttention(sessions);
  return STREAM_GROUPS.flatMap((g) => groups[g.key]);
}
