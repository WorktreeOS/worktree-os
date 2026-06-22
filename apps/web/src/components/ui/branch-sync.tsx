import { ArrowUp, RefreshCw } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Ic } from "@/components/ui/inline-code";
import {
  deriveSyncControls,
  deriveSyncPosture,
  freshnessLabel,
  type SyncTone,
} from "@/lib/git-sync-logic";

/* BranchSync — the Review tab's always-visible branch sync posture row (see the
 * change `review-sync-controls`). Single source of truth for ahead/behind +
 * Fetch / Push. Quiet-workspace v3: state is a leading dot + inline word, the
 * ↑ahead / ↓behind counts are text tokens (--good / --bad), freshness is a
 * muted relative label, and a `RefreshCw` spinner marks an in-flight op. No
 * bordered status chips, no amber. The flex row wraps so a narrow host collapses
 * it to a single compact line without horizontal overflow. */

const DOT_TONE: Record<SyncTone, string> = {
  good: "bg-[color:var(--good)]",
  neutral: "bg-[color:var(--ink-2)]",
  warn: "bg-[color:var(--warn)]",
  bad: "bg-[color:var(--bad)]",
  muted: "border border-[color:var(--hair-2)]",
};

export type SyncOp = "fetch" | "push";

export function BranchSync({
  branch,
  detached,
  aheadCount,
  behindCount,
  lastFetchedAt,
  busyOp,
  onFetch,
  onPush,
}: {
  branch?: string;
  detached: boolean;
  aheadCount?: number;
  behindCount?: number;
  /** Epoch ms of the last successful client fetch this session, or null. */
  lastFetchedAt: number | null;
  /** The sync op currently in flight, or null when idle. */
  busyOp: SyncOp | null;
  onFetch: () => void;
  onPush: () => void;
}) {
  const posture = deriveSyncPosture({ detached, aheadCount, behindCount });
  const controls = deriveSyncControls(posture, { busy: busyOp !== null });
  const fresh = freshnessLabel(lastFetchedAt);

  return (
    <div
      data-testid="branch-sync"
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[color:var(--hair)] px-3 py-1.5 text-[12px]"
    >
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span
          aria-hidden
          className={cn("inline-block size-[7px] shrink-0 rounded-full", DOT_TONE[posture.tone])}
        />
        <span
          data-testid="branch-sync-word"
          className="font-medium text-[color:var(--ink)]"
        >
          {posture.word}
        </span>
        {branch && (
          <span className="min-w-0 truncate text-[color:var(--ink-2)]">
            <Ic tone="dim">{branch}</Ic>
          </span>
        )}
      </span>

      {posture.hasUpstream && (posture.ahead > 0 || posture.behind > 0) && (
        <span className="inline-flex items-center gap-2 font-mono tabular-nums">
          {posture.ahead > 0 && (
            <span
              data-testid="branch-sync-ahead"
              className="inline-flex items-center gap-0.5 text-[color:var(--good)]"
            >
              ↑{posture.ahead}
            </span>
          )}
          {posture.behind > 0 && (
            <span
              data-testid="branch-sync-behind"
              className="inline-flex items-center gap-0.5 text-[color:var(--bad)]"
            >
              ↓{posture.behind}
            </span>
          )}
        </span>
      )}

      {fresh && (
        <span
          data-testid="branch-sync-freshness"
          className="text-[color:var(--muted-foreground)]"
        >
          {fresh}
        </span>
      )}

      <span className="ml-auto inline-flex items-center gap-1">
        <Button
          variant="ghost"
          size="xs"
          onClick={onFetch}
          disabled={!controls.canFetch}
          data-testid="branch-sync-fetch"
        >
          <RefreshCw className={cn(busyOp === "fetch" && "animate-spin")} />
          Fetch
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={onPush}
          disabled={!controls.canPush}
          data-testid="branch-sync-push"
        >
          {busyOp === "push" ? (
            <RefreshCw className="animate-spin" />
          ) : (
            <ArrowUp />
          )}
          Push
        </Button>
      </span>
    </div>
  );
}
