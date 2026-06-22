import type { TerminalSessionMetadata } from "./terminal-protocol";

/* Attention grouping for the rail's Sessions mode (see
 * demo/sidebar-stream-v3.html). A flat live-session snapshot is split into four
 * ordered groups — Needs you / Unread / Working / Idle — each session landing in
 * exactly one group. Pure over the snapshot so the filter bar, the group
 * headers, and the stream order are unit-testable without the React tree
 * (mirrors lib/sidebar-scope.ts). */

export type AttentionGroupKey = "needsYou" | "unread" | "working" | "idle";

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
 *   4. else → Idle (idle agents and plain shells alike). */
function classify(session: TerminalSessionMetadata): AttentionGroupKey {
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

export function groupSessionsByAttention(
  sessions: ReadonlyArray<TerminalSessionMetadata>,
): AttentionResult {
  const groups: AttentionGroups = {
    needsYou: [],
    unread: [],
    working: [],
    idle: [],
  };

  for (const session of sessions) {
    groups[classify(session)].push(session);
  }

  // Needs you — oldest wait first (askedAt ascending).
  groups.needsYou.sort((a, b) => needsYouKey(a) - needsYouKey(b));
  // Unread — most recent output first (unreadSince descending).
  groups.unread.sort((a, b) => ms(b.unreadSince) - ms(a.unreadSince));
  // Working / Idle — most recently active first.
  groups.working.sort((a, b) => recencyKey(b) - recencyKey(a));
  groups.idle.sort((a, b) => recencyKey(b) - recencyKey(a));

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
