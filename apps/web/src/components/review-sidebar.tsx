import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlignLeft,
  ChevronLeft,
  Columns2,
  GitPullRequestArrow,
  LayoutList,
  PanelLeft,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";
import { useUiApi } from "@/lib/api-context";
import { useIsCompactViewport } from "@/lib/viewport";
import {
  UiGitWriteError,
  type ReviewDiffResponse,
  type WorktreeSummary,
} from "@/lib/ui-api";
import {
  allStagedAction,
  changeTotals,
  isFullyStaged,
  mergeChanges,
  type ChangeEntry,
} from "@/lib/review-explorer-logic";
import { ReviewExplorer } from "@/components/review-explorer";
import { ReviewComposer, type CommitOptions } from "@/components/review-composer";
import { BranchSync, type SyncOp } from "@/components/ui/branch-sync";
import { DiffDetail, type DiffLayout } from "@/components/diff-detail";
import { toast } from "@/components/ui/sonner";

interface ReviewState {
  data: ReviewDiffResponse | null;
  loading: boolean;
  error: string | null;
  /** Whether the very first response for this path has arrived. */
  loaded: boolean;
}

export type { ReviewState };

export function useReviewState(path: string | null): {
  state: ReviewState;
  refresh: () => Promise<void>;
} {
  const api = useUiApi();
  const [state, setState] = useState<ReviewState>({
    data: null,
    loading: false,
    error: null,
    loaded: false,
  });

  const pathRef = useRef(path);
  pathRef.current = path;

  const refresh = useCallback(async () => {
    const current = pathRef.current;
    if (!current) return;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const data = await api.getReviewDiff(current);
      if (pathRef.current !== current) return;
      setState({ data, loading: false, error: null, loaded: true });
    } catch (e) {
      if (pathRef.current !== current) return;
      setState((prev) => ({
        data: prev.data,
        loading: false,
        error: (e as Error).message,
        loaded: true,
      }));
    }
  }, [api]);

  useEffect(() => {
    setState({ data: null, loading: false, error: null, loaded: false });
  }, [path]);

  return { state, refresh };
}

const VIEW_OPTIONS = [
  { value: "explorer", label: "Explorer", icon: PanelLeft },
  { value: "all", label: "View diff", icon: LayoutList },
] as const;

const LAYOUT_OPTIONS = [
  { value: "inline", label: "Inline", icon: AlignLeft },
  { value: "split", label: "Split", icon: Columns2 },
] as const;

/**
 * Review tab content for the worktree detail page, rendered full-width when the
 * Review tab is active. A unified `Changes` explorer + single-file diff with a
 * commit composer, plus a `View diff` toggle back to the all-files stacked view
 * and an inline / split toggle. Whole-file staging maps to Git; viewed tracking
 * is client-side.
 */
export function ReviewPanelBody({
  path,
  worktree,
  state,
  refresh,
  onMutated,
}: {
  path: string;
  worktree: WorktreeSummary;
  state: ReviewState;
  refresh: () => Promise<void>;
  /** Called after a commit / branch creation so the route can reload detail. */
  onMutated?: () => void;
}) {
  const api = useUiApi();

  useEffect(() => {
    if (!state.loaded && !state.loading) void refresh();
  }, [refresh, state.loaded, state.loading]);

  const data = state.data;
  const changes = useMemo(() => mergeChanges(data), [data]);
  const total = changes.length;
  const totals = useMemo(() => changeTotals(changes), [changes]);

  const compact = useIsCompactViewport();
  const [view, setView] = useState<"explorer" | "all">("explorer");
  const [layout, setLayout] = useState<DiffLayout>("inline");
  const [activeIndex, setActiveIndex] = useState(0);
  // On compact viewports the explorer and the diff detail are separate screens
  // (list ↔ detail); this flag selects the detail screen.
  const [mobileDetail, setMobileDetail] = useState(false);
  const [viewed, setViewed] = useState<Set<string>>(() => new Set());
  const [staging, setStaging] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState("");
  const [generating, setGenerating] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [aiConfigured, setAiConfigured] = useState(false);
  // Branch sync posture: a local override applied immediately from a fetch/push
  // response (so the row updates without waiting for the next detail poll), the
  // in-flight op (one at a time), and the client-side last-fetch timestamp.
  const [syncPosture, setSyncPosture] = useState<{
    aheadCount?: number;
    behindCount?: number;
  } | null>(null);
  const [syncBusy, setSyncBusy] = useState<SyncOp | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);

  useEffect(() => {
    setActiveIndex(0);
    setViewed(new Set());
    setMessage("");
    setMobileDetail(false);
    setSyncPosture(null);
    setLastFetchedAt(null);
  }, [path]);

  // Once a fresh detail reload lands with canonical ahead/behind counts, drop
  // the local override so the row tracks the daemon's recomputed posture.
  useEffect(() => {
    setSyncPosture(null);
  }, [worktree.aheadCount, worktree.behindCount]);

  // Load settings once to drive the composer's AI gating without a round-trip.
  useEffect(() => {
    let cancelled = false;
    void api
      .getSettingsConfig()
      .then((res) => {
        if (!cancelled) {
          setAiConfigured(res.config.effective.aiProviders.length > 0);
        }
      })
      .catch(() => {
        /* gating stays disabled; the composer falls back to type-a-message */
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    setActiveIndex((prev) =>
      total === 0 ? 0 : Math.min(Math.max(0, prev), total - 1),
    );
  }, [total]);

  const activeEntry: ChangeEntry | undefined = changes[Math.min(activeIndex, Math.max(0, total - 1))];
  const activePath = activeEntry?.path ?? null;

  const toggleReviewed = useCallback((p: string) => {
    setViewed((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }, []);

  // Selecting a file activates it and, on compact viewports, opens the detail
  // screen over the list.
  const handleSelect = useCallback(
    (p: string) => {
      setActiveIndex(changes.findIndex((c) => c.path === p));
      if (compact) setMobileDetail(true);
    },
    [changes, compact],
  );

  const changeView = useCallback((next: "explorer" | "all") => {
    setView(next);
    setMobileDetail(false);
  }, []);

  // ---- keyboard: j/k move the active file, v toggles reviewed ----
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const editable =
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        target?.isContentEditable;
      if (editable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "j") {
        e.preventDefault();
        setActiveIndex((p) => Math.min(p + 1, Math.max(0, total - 1)));
      } else if (e.key === "k") {
        e.preventDefault();
        setActiveIndex((p) => Math.max(p - 1, 0));
      } else if (e.key === "v" && activePath) {
        e.preventDefault();
        toggleReviewed(activePath);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [total, activePath, toggleReviewed]);

  // ---- staging ----
  const applyStage = useCallback(
    async (paths: string[], action: "stage" | "unstage") => {
      if (paths.length === 0) return;
      setStaging((prev) => new Set([...prev, ...paths]));
      try {
        if (action === "stage") await api.gitStage({ path, files: paths });
        else await api.gitUnstage({ path, files: paths });
        await refresh();
      } catch (e) {
        toast.error("Staging failed", { description: (e as Error).message });
      } finally {
        setStaging((prev) => {
          const next = new Set(prev);
          for (const p of paths) next.delete(p);
          return next;
        });
      }
    },
    [api, path, refresh],
  );

  const onToggleStage = useCallback(
    // A fully-staged file unstages; an unstaged OR partial file stages (a
    // partial click completes staging the remaining hunks).
    (entry: ChangeEntry) =>
      void applyStage([entry.path], isFullyStaged(entry) ? "unstage" : "stage"),
    [applyStage],
  );
  const onToggleAllStaged = useCallback(() => {
    const { action, paths } = allStagedAction(changes);
    void applyStage(paths, action);
  }, [applyStage, changes]);

  // ---- generation ----
  const doGenerate = useCallback(async (): Promise<string | null> => {
    setGenerating(true);
    try {
      const res = await api.gitCommitMessage({ path });
      setMessage(res.message);
      return res.message;
    } catch (e) {
      if (e instanceof UiGitWriteError && e.code === "no-provider-configured") {
        toast.error("No AI provider configured", {
          description: "Set a default commit-message provider in Settings.",
        });
      } else {
        toast.error("Generation failed", { description: (e as Error).message });
      }
      return null;
    } finally {
      setGenerating(false);
    }
  }, [api, path]);

  // ---- commit ----
  const onCommit = useCallback(
    async ({ push, amend, stageAll }: CommitOptions) => {
      // The quick "Commit all" action (git add --all first) shows a
      // bottom-corner progress toast that resolves into the final result; the
      // curated commit keeps its inline button feedback + one-shot result toast.
      const toastId = stageAll
        ? toast.loading(push ? "Staging all & pushing…" : "Staging all & committing…")
        : undefined;
      const resolveError = (title: string, description: string) => {
        if (toastId !== undefined) toast.error(title, { id: toastId, description });
        else toast.error(title, { description });
      };
      try {
        let msg = message.trim();
        const needsGeneration = !msg && !amend;
        // Bail before staging when no message can be produced at all. The quick
        // button is disabled in this case; this guards direct invocations.
        if (needsGeneration && !aiConfigured) {
          if (toastId !== undefined) {
            resolveError(
              "Type a commit message",
              "No AI provider configured to auto-generate one.",
            );
          }
          return;
        }
        if (stageAll) {
          setCommitting(true);
          await api.gitStage({ path, files: [], all: true });
          await refresh();
        }
        if (needsGeneration) {
          const generated = await doGenerate();
          if (!generated) {
            // doGenerate surfaced its own error toast; drop the progress one.
            if (toastId !== undefined) toast.dismiss(toastId);
            return;
          }
          msg = generated.trim();
        }
        setCommitting(true);
        const res = await api.gitCommit({
          path,
          message: msg.length > 0 ? msg : message,
          push,
          amend,
        });
        const title = amend
          ? "Commit amended"
          : push
            ? "Committed & pushed"
            : "Committed";
        const description = `${res.sha} · ${res.summary.split("\n")[0] ?? ""}`;
        if (toastId !== undefined) toast.success(title, { id: toastId, description });
        else toast.success(title, { description });
        setMessage("");
        setViewed(new Set());
        await refresh();
        onMutated?.();
      } catch (e) {
        if (e instanceof UiGitWriteError && e.code === "nothing-staged") {
          resolveError(
            "Nothing staged",
            "Stage at least one file before committing.",
          );
        } else {
          resolveError("Commit failed", (e as Error).message);
        }
      } finally {
        setCommitting(false);
      }
    },
    [api, path, message, aiConfigured, doGenerate, refresh, onMutated],
  );

  const onCreateBranch = useCallback(
    async (name: string) => {
      if (name.length === 0) return;
      try {
        await api.gitBranch({ path, name });
        toast.success("Branch created", { description: name });
        onMutated?.();
      } catch (e) {
        toast.error("Branch creation failed", {
          description: (e as Error).message,
        });
      }
    },
    [api, path, onMutated],
  );

  // ---- branch sync (fetch / push) ----
  const onFetch = useCallback(async () => {
    if (syncBusy) return;
    setSyncBusy("fetch");
    try {
      const res = await api.gitFetch({ path });
      setSyncPosture({ aheadCount: res.aheadCount, behindCount: res.behindCount });
      setLastFetchedAt(Date.now());
      onMutated?.();
    } catch (e) {
      toast.error("Fetch failed", { description: (e as Error).message });
    } finally {
      setSyncBusy(null);
    }
  }, [api, path, syncBusy, onMutated]);

  const onPush = useCallback(async () => {
    if (syncBusy) return;
    setSyncBusy("push");
    try {
      const res = await api.gitPush({ path });
      setSyncPosture({ aheadCount: res.aheadCount, behindCount: res.behindCount });
      toast.success("Pushed", {
        description: res.summary.length > 0 ? res.summary.split("\n")[0] : undefined,
      });
      onMutated?.();
    } catch (e) {
      // A non-fast-forward rejection means the branch is behind upstream; with
      // no Pull in scope, point the user at Fetch. The row keeps its prior state.
      if (e instanceof UiGitWriteError && e.code === "non-fast-forward") {
        toast.error("Push rejected", {
          description: "Fetch first — the branch is behind its upstream.",
        });
      } else {
        toast.error("Push failed", { description: (e as Error).message });
      }
    } finally {
      setSyncBusy(null);
    }
  }, [api, path, syncBusy, onMutated]);

  const branchSeed =
    worktree.displayName ?? worktree.branch ?? path.split("/").pop() ?? "work";

  const effectiveAhead = syncPosture ? syncPosture.aheadCount : worktree.aheadCount;
  const effectiveBehind = syncPosture
    ? syncPosture.behindCount
    : worktree.behindCount;

  return (
    <div
      data-testid="review-sidebar"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-[color:var(--hair)] px-3 py-1.5">
        <span className="inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-[color:var(--ink)]">
          <GitPullRequestArrow className="size-[14px] text-[color:var(--muted-foreground)]" />
          Review
        </span>
        <SegmentedControl
          options={VIEW_OPTIONS}
          value={view}
          onChange={(v) => changeView(v as "explorer" | "all")}
          stretch={false}
          ariaLabel="Review view"
          data-testid="review-view"
        />
        {/* The inline/split toggle only matters when a diff is on screen — hide
            it on the compact list screen to keep the toolbar narrow. */}
        {(!compact || mobileDetail || view === "all") && (
          <SegmentedControl
            options={LAYOUT_OPTIONS}
            value={layout}
            onChange={(v) => setLayout(v as DiffLayout)}
            stretch={false}
            ariaLabel="Diff layout"
            data-testid="review-layout"
          />
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => void refresh()}
          aria-label="Refresh diff"
          title="Refresh diff"
          data-testid="review-refresh"
          className="inline-grid size-7 place-items-center rounded-md text-[color:var(--muted-foreground)] hover:bg-[color:var(--hover)] hover:text-[color:var(--ink)]"
        >
          <RefreshCw className={cn("size-3.5", state.loading && "animate-spin")} />
        </button>
      </div>

      <BranchSync
        branch={worktree.branch}
        detached={worktree.detached}
        aheadCount={effectiveAhead}
        behindCount={effectiveBehind}
        lastFetchedAt={lastFetchedAt}
        busyOp={syncBusy}
        onFetch={() => void onFetch()}
        onPush={() => void onPush()}
      />

      <div className="min-h-0 flex-1">
        {state.error && !state.data ? (
          <ReviewError error={state.error} onRetry={refresh} />
        ) : !state.loaded || !data ? (
          <ReviewSkeleton />
        ) : view === "explorer" ? (
          compact ? (
            mobileDetail && activeEntry ? (
              <div className="flex h-full min-h-0 flex-col">
                <button
                  type="button"
                  onClick={() => setMobileDetail(false)}
                  data-testid="review-mobile-back"
                  className="inline-flex shrink-0 items-center gap-1 border-b border-[color:var(--hair)] px-2.5 py-2 text-[12.5px] text-[color:var(--ink-2)]"
                >
                  <ChevronLeft className="size-[15px]" />
                  Changes
                </button>
                <DiffDetail
                  key={activeEntry.path}
                  file={activeEntry.file}
                  layout={layout}
                  reviewed={activePath ? viewed.has(activePath) : false}
                  onToggleReviewed={() =>
                    activePath && toggleReviewed(activePath)
                  }
                />
              </div>
            ) : (
              <div className="grid h-full min-h-0 grid-rows-[1fr_auto]">
                <ReviewExplorer
                  changes={changes}
                  activeId={activePath}
                  viewed={viewed}
                  staging={staging}
                  onSelect={handleSelect}
                  onToggleStage={onToggleStage}
                  onToggleAllStaged={onToggleAllStaged}
                  onToggleReviewed={toggleReviewed}
                />
                <ReviewComposer
                  branch={worktree.branch}
                  detached={worktree.detached}
                  head={worktree.head}
                  stagedCount={totals.stagedCount}
                  changedCount={total}
                  aiConfigured={aiConfigured}
                  message={message}
                  onMessageChange={setMessage}
                  generating={generating}
                  committing={committing}
                  onGenerate={() => void doGenerate()}
                  onCommit={(opts) => void onCommit(opts)}
                  onCreateBranch={(name) => void onCreateBranch(name)}
                  branchSeed={branchSeed}
                />
              </div>
            )
          ) : (
            <div className="grid min-h-0 h-full grid-cols-[minmax(300px,360px)_minmax(0,1fr)]">
              <div className="grid min-h-0 grid-rows-[1fr_auto]">
                <ReviewExplorer
                  changes={changes}
                  activeId={activePath}
                  viewed={viewed}
                  staging={staging}
                  onSelect={handleSelect}
                  onToggleStage={onToggleStage}
                  onToggleAllStaged={onToggleAllStaged}
                  onToggleReviewed={toggleReviewed}
                />
                <ReviewComposer
                  branch={worktree.branch}
                  detached={worktree.detached}
                  head={worktree.head}
                  stagedCount={totals.stagedCount}
                  changedCount={total}
                  aiConfigured={aiConfigured}
                  message={message}
                  onMessageChange={setMessage}
                  generating={generating}
                  committing={committing}
                  onGenerate={() => void doGenerate()}
                  onCommit={(opts) => void onCommit(opts)}
                  onCreateBranch={(name) => void onCreateBranch(name)}
                  branchSeed={branchSeed}
                />
              </div>
              <div className="flex min-h-0 min-w-0">
                {activeEntry ? (
                  <DiffDetail
                    key={activeEntry.path}
                    file={activeEntry.file}
                    layout={layout}
                    reviewed={activePath ? viewed.has(activePath) : false}
                    onToggleReviewed={() =>
                      activePath && toggleReviewed(activePath)
                    }
                  />
                ) : (
                  <div className="grid flex-1 place-items-center text-[12.5px] text-[color:var(--muted-foreground)]">
                    {total === 0
                      ? "Working tree clean — nothing to review."
                      : "Select a file to view its diff."}
                  </div>
                )}
              </div>
            </div>
          )
        ) : (
          <div className="min-h-0 h-full overflow-auto" data-testid="review-all">
            {total === 0 ? (
              <div className="grid h-full place-items-center text-[12.5px] text-[color:var(--muted-foreground)]">
                Working tree clean — nothing to review.
              </div>
            ) : (
              changes.map((entry) => (
                <DiffDetail
                  key={entry.path}
                  file={entry.file}
                  layout={layout}
                  variant="stacked"
                  reviewed={viewed.has(entry.path)}
                  onToggleReviewed={() => toggleReviewed(entry.path)}
                />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ReviewError({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => Promise<void>;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="inline-flex items-center gap-1.5 text-[12px] text-[color:var(--bad)]">
        <span className="inline-block size-[7px] rounded-full bg-[color:var(--bad)]" />
        diff failed
      </div>
      <div className="break-words font-mono text-xs text-[color:var(--muted-foreground)]">
        {error}
      </div>
      <Button variant="default" size="sm" onClick={() => void onRetry()}>
        Retry
      </Button>
    </div>
  );
}

function ReviewSkeleton() {
  return (
    <div
      data-testid="review-skeleton"
      className="flex flex-col gap-2 p-3"
      aria-busy="true"
      aria-label="Loading diff"
    >
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="reveal h-16 rounded-lg border border-[color:var(--hair)] bg-[color:var(--shell)]"
          style={{ animationDelay: `${i * 80}ms` }}
        />
      ))}
    </div>
  );
}

