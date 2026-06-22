import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  ExternalLink,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitPullRequestArrow,
  Loader2,
  Pencil,
  Play,
  SquareTerminal,
  Terminal as TerminalIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Ic } from "@/components/ui/inline-code";
import { Ledger, type LedgerRow } from "@/components/ui/ledger";
import { ChangeSummaryRow } from "@/components/ui/change-summary-row";
import { SessionRow } from "@/components/ui/session-row";
import { RuntimeSummaryLine } from "@/components/ui/runtime-summary-line";
import { StatusDot, statusDotVariant } from "@/components/ui/status-dot";
import { DocumentSection } from "@/routes/worktree/document";
import {
  WorkflowStatusControl,
  WorktreeComments,
} from "@/routes/worktree/dossier-task";
import { useUiApi } from "@/lib/api-context";
import { useTerminalSessions } from "@/lib/terminal-sessions-context";
import { terminalAgent } from "@/lib/terminal-agents";
import type { TerminalSessionMetadata } from "@/lib/terminal-protocol";
import { formatBytes, formatCpuPercent } from "@/lib/format-usage";
import { formatRelativeTime } from "@/lib/utils";
import {
  type DeploymentStatus,
  type ReviewDiffResponse,
  type WorktreeDetailResponse,
} from "@/lib/ui-api";

/** One changed file surfaced in the Branch & changes preview. */
export type ChangedFile = {
  path: string;
  additions: number;
  deletions: number;
};

/** Aggregate review totals plus an optional per-file breakdown. The breakdown
 * is a progressive enhancement: it is only present when Review diff data is
 * already loaded, so the dossier never triggers a diff request of its own. */
export type ReviewSummary = {
  additions: number;
  deletions: number;
  changedFiles: number;
  files?: ReadonlyArray<ChangedFile>;
};

/** Shape already-loaded Review diff data into the dossier's review summary —
 * totals plus a per-file breakdown ordered by change magnitude. */
export function summarizeReview(data: ReviewDiffResponse): ReviewSummary {
  const byPath = new Map<string, ChangedFile>();
  for (const set of [data.unstaged, data.staged]) {
    for (const f of set.files) {
      const path = f.newPath ?? f.oldPath ?? f.id;
      const cur = byPath.get(path) ?? { path, additions: 0, deletions: 0 };
      cur.additions += f.additions;
      cur.deletions += f.deletions;
      byPath.set(path, cur);
    }
  }
  const files = [...byPath.values()].sort(
    (a, b) => b.additions + b.deletions - (a.additions + a.deletions),
  );
  return {
    additions: data.totalAdditions,
    deletions: data.totalDeletions,
    changedFiles: data.totalChangedFiles,
    files,
  };
}

/** Cap on changed files listed inline before deferring the rest to Review. */
const MAX_PREVIEW_FILES = 6;

type WorktreeOverviewProps = {
  detail: WorktreeDetailResponse;
  reviewSummary: ReviewSummary | null;
  terminalCount: number;
  onOpenRuntime: () => void;
  onOpenReview: () => void;
  onOpenFiles: () => void;
  onOpenTerminal: (sessionId?: string) => void;
  /** Open the rename control for a terminal session. */
  onRenameSession: (session: TerminalSessionMetadata) => void;
  /** Invoked after the intent (note) is saved so the route can reload. */
  onNoteSaved: () => void;
};

/** Worktree title: persisted display name, else branch, else detached HEAD, else dir. */
function titleLabel(detail: WorktreeDetailResponse): string {
  const wt = detail.worktree;
  if (wt.displayName) return wt.displayName;
  if (wt.branch) return wt.branch;
  if (wt.detached && wt.head) return `detached @ ${wt.head.slice(0, 7)}`;
  return wt.path.split("/").pop() || wt.path;
}

function statusLabel(status: DeploymentStatus): string {
  switch (status) {
    case "running":
      return "running";
    case "running_partial":
      return "running partial";
    case "pending":
      return "deploying";
    case "checking":
      return "checking";
    case "stopping":
      return "stopping";
    case "stopped":
      return "stopped";
    case "failed":
      return "failed";
    case "not_started":
      return "idle";
    default:
      return "unknown";
  }
}

function normalizeHost(hostIp: string | undefined): string {
  if (!hostIp || hostIp === "0.0.0.0" || hostIp === "::") return "localhost";
  return hostIp;
}

/** First http-capable exposed port across the worktree's services, or null.
 * Used for the runtime summary's representative address and the Open web link
 * (the latter is also surfaced from the mobile `More` sheet). */
export function representativeExposed(
  detail: WorktreeDetailResponse,
): { port: number; url: string } | null {
  for (const svc of detail.services) {
    for (const p of svc.ports) {
      const proto = (p.protocol || "tcp").toLowerCase();
      if (proto !== "tcp" || p.hostPort === undefined) continue;
      const host = normalizeHost(p.hostIp);
      return { port: p.hostPort, url: `http://${host}:${p.hostPort}` };
    }
  }
  return null;
}

/** Number of services a not-started worktree would launch, best-effort. */
function configuredServiceCount(detail: WorktreeDetailResponse): number {
  return (
    detail.deploymentOptions?.appServices.length ??
    detail.launchPreview?.serviceCount ??
    detail.worktree.serviceSummary?.total ??
    detail.serviceSummary?.total ??
    0
  );
}

function configFileName(detail: WorktreeDetailResponse): string | null {
  const cfg = detail.projectConfig;
  if (cfg.status === "unknown") return null;
  return cfg.path.split("/").pop() ?? cfg.path;
}

/**
 * Inline-editable intent block. Renders the persisted note as purpose-framed
 * prose with a hover edit affordance; with no note it offers a quiet "Add
 * intent" line. Editing mirrors the topbar note: Enter saves, Shift+Enter
 * inserts a newline, Escape cancels.
 */
function IntentBlock({
  detail,
  onNoteSaved,
}: {
  detail: WorktreeDetailResponse;
  onNoteSaved: () => void;
}) {
  const api = useUiApi();
  const note = detail.worktree.note;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(note ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const open = () => {
    setValue(note ?? "");
    setError(null);
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    setError(null);
    setPending(false);
  };
  const save = async () => {
    const trimmed = value.trim();
    if (trimmed === (note ?? "")) {
      cancel();
      return;
    }
    setPending(true);
    setError(null);
    try {
      await api.submitWorktreeNote({ path: detail.worktree.path, note: trimmed });
      setEditing(false);
      onNoteSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  if (editing) {
    return (
      <div className="flex flex-col gap-1.5">
        <textarea
          ref={inputRef}
          rows={3}
          value={value}
          disabled={pending}
          placeholder="What is this worktree for?"
          data-testid="overview-intent-input"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void save();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          className="w-full resize-none rounded-[8px] border border-[color:var(--hair-2)] bg-[color:var(--surface)] px-3 py-2 text-[14.5px] leading-[1.55] text-[color:var(--ink)] focus:outline-none focus:ring-1 focus:ring-[color:var(--ink)]/30"
        />
        <div className="flex items-center gap-2">
          <Button size="sm" variant="solid" disabled={pending} onClick={() => void save()}>
            {pending ? <Loader2 className="animate-spin" /> : null}
            Save
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={cancel}>
            Cancel
          </Button>
          {error ? (
            <span
              data-testid="overview-intent-error"
              className="text-[12px] text-[color:var(--bad)]"
            >
              {error}
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  if (note) {
    return (
      <div className="group/intent flex items-start gap-2" data-testid="overview-intent">
        <p className="m-0 text-[15px] leading-[1.6] text-[color:var(--ink-2)]">
          {note}
        </p>
        <IconButton
          size="sm"
          aria-label="Edit intent"
          onClick={open}
          className="opacity-0 transition-opacity group-hover/intent:opacity-100"
        >
          <Pencil />
        </IconButton>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={open}
      data-testid="overview-intent-add"
      className="inline-flex items-center gap-1.5 text-[14px] text-[color:var(--muted-foreground)] transition-colors hover:text-[color:var(--ink)]"
    >
      <Pencil className="size-3.5" strokeWidth={1.75} />
      Add intent — what is this worktree for?
    </button>
  );
}

/** Quiet "more" link sitting on the right of a section header. */
function SectionMore({
  label,
  onClick,
  testId,
}: {
  label: string;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="inline-flex items-center gap-1 text-[12.5px] text-[color:var(--ink-2)] underline-offset-2 transition-colors hover:text-[color:var(--ink)] hover:underline"
    >
      {label}
      <ArrowRight className="size-3" strokeWidth={1.75} />
    </button>
  );
}

/** The `now` strip: branch facts first, deployment status as one quiet word. */
function NowLine({ detail }: { detail: WorktreeDetailResponse }) {
  const wt = detail.worktree;
  const status = wt.status;
  const segments: ReactNode[] = [];

  const ahead = wt.aheadCount;
  const behind = wt.behindCount;
  if (
    typeof ahead === "number" &&
    typeof behind === "number" &&
    (ahead > 0 || behind > 0)
  ) {
    const parts: string[] = [];
    if (ahead > 0) parts.push(`↑${ahead} ahead`);
    if (behind > 0) parts.push(`↓${behind} behind`);
    segments.push(
      <span key="ab" className="inline-flex items-center gap-1.5">
        <GitBranch
          className="size-[13px] text-[color:var(--muted-foreground)]"
          strokeWidth={1.75}
          aria-hidden
        />
        {parts.join(" · ")}
      </span>,
    );
  }

  if (typeof wt.uncommittedCount === "number" && wt.uncommittedCount > 0) {
    segments.push(<span key="unc">{wt.uncommittedCount} uncommitted</span>);
  }

  // A worktree with no running services is the resting state, not a status
  // worth announcing — omit the runtime word entirely when not started.
  if (status !== "not_started") {
    segments.push(
      <span key="status" className="inline-flex items-center gap-1.5">
        <StatusDot variant={statusDotVariant(status)} />
        {statusLabel(status)}
      </span>,
    );

    const deployedRel = formatRelativeTime(
      detail.deployFreshness?.lastUpAt ?? detail.state?.lastUp,
    );
    if (deployedRel) {
      segments.push(
        <span key="fresh" className="text-[color:var(--muted-foreground)]">
          deployed {deployedRel}
        </span>,
      );
    }
  }

  if (segments.length === 0) return null;

  return (
    <div
      className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] text-[color:var(--ink-2)]"
      data-testid="overview-now"
    >
      {segments.map((seg, i) => (
        <span key={i} className="inline-flex items-center gap-2.5">
          {i > 0 ? (
            <span aria-hidden className="text-[color:var(--muted-foreground)]/70">
              ·
            </span>
          ) : null}
          {seg}
        </span>
      ))}
    </div>
  );
}

/** Branch ledger rows derived from available git-posture fields. */
function branchLedgerRows(detail: WorktreeDetailResponse): LedgerRow[] {
  const wt = detail.worktree;
  const rows: LedgerRow[] = [];

  // Branch is the spine of the git posture and stays visible even when a custom
  // display name takes over the title.
  if (wt.branch) {
    rows.push({ label: "Branch", value: <Ic>{wt.branch}</Ic> });
  } else if (wt.detached && wt.head) {
    rows.push({ label: "Branch", value: `detached @ ${wt.head.slice(0, 7)}` });
  }

  const ahead = wt.aheadCount;
  const behind = wt.behindCount;
  if (typeof ahead === "number" && typeof behind === "number") {
    rows.push({
      label: "Upstream",
      value: `↑${ahead} ahead · ↓${behind} behind`,
    });
  }

  if (typeof wt.uncommittedCount === "number") {
    rows.push({
      label: "Working tree",
      value:
        wt.uncommittedCount > 0
          ? `${wt.uncommittedCount} uncommitted`
          : "clean",
    });
  }

  if (wt.lastCommitHash) {
    const rel = formatRelativeTime(wt.lastCommitTime);
    rows.push({
      label: "Last commit",
      value: (
        <>
          <Ic>{wt.lastCommitHash}</Ic>
          {rel ? (
            <span className="text-[color:var(--muted-foreground)]">{rel}</span>
          ) : null}
          {wt.lastCommitSubject ? (
            <span
              className="truncate text-[color:var(--ink-2)]"
              title={wt.lastCommitSubject}
            >
              {wt.lastCommitSubject}
            </span>
          ) : null}
        </>
      ),
    });
  }

  return rows;
}

/** Quiet facts for the runtime summary line, keyed off deployment status. */
function runtimeFacts(
  detail: WorktreeDetailResponse,
  exposed: { port: number; url: string } | null,
): ReactNode[] {
  const status = detail.worktree.status;
  const facts: ReactNode[] = [];

  if (status === "not_started") {
    const count = configuredServiceCount(detail);
    facts.push(
      <span key="configured">
        {count} {count === 1 ? "service" : "services"} configured
      </span>,
    );
    const file = configFileName(detail);
    if (file) facts.push(<Ic key="file">{file}</Ic>);
    return facts;
  }

  const summary = detail.worktree.serviceSummary ?? detail.serviceSummary;
  if (summary) {
    facts.push(
      <span key="count">
        {summary.running} of {summary.total} services running
      </span>,
    );
  }
  if (exposed) {
    facts.push(
      <span key="exposed">
        <Ic href={exposed.url} target="_blank" rel="noreferrer">
          :{exposed.port}
        </Ic>{" "}
        exposed
      </span>,
    );
  }
  const activeTunnels = detail.tunnels.filter((t) => t.state === "active").length;
  if (activeTunnels > 0) {
    facts.push(
      <span key="tunnels">
        {activeTunnels} {activeTunnels === 1 ? "tunnel" : "tunnels"} live
      </span>,
    );
  }
  const usage = detail.worktree.resourceUsage;
  const usageParts = [
    formatBytes(usage?.memUsedBytes),
    formatCpuPercent(usage?.cpuPercent),
  ].filter(Boolean);
  if (usageParts.length > 0) {
    facts.push(<span key="usage">{usageParts.join(" · ")}</span>);
  }
  return facts;
}

/** Quiet runtime-meta line beneath the summary: config + freshness, or the
 * first-run hint / config warning for a not-started worktree. */
function runtimeMeta(detail: WorktreeDetailResponse): ReactNode {
  const cfg = detail.projectConfig;
  const status = detail.worktree.status;

  if (cfg.status === "missing" || cfg.status === "invalid") {
    return (
      <span data-testid="overview-config-meta" className="text-[color:var(--bad)]">
        <Ic>{configFileName(detail) ?? "deploy config"}</Ic>{" "}
        {cfg.status === "missing" ? "is missing" : "failed to parse"}{" "}
        — open Runtime to resolve
      </span>
    );
  }

  if (status === "not_started") {
    return (
      <span data-testid="overview-config-meta">
        First run installs deps and applies migrations — set up once, then{" "}
        <Ic>wos up</Ic> is instant.
      </span>
    );
  }

  const file = configFileName(detail);
  const mode = cfg.status === "valid" ? cfg.mode : null;
  const segments: ReactNode[] = [];
  if (file) {
    segments.push(
      <span key="via">
        via <Ic>{file}</Ic>
        {mode ? ` · ${mode} mode` : ""}
      </span>,
    );
  }
  const commits = detail.deployFreshness?.commitsSinceDeploy ?? 0;
  if (commits > 0) {
    segments.push(
      <span key="commits">
        {commits} {commits === 1 ? "commit" : "commits"} since deploy
      </span>,
    );
  }
  if (segments.length === 0) return null;
  return (
    <span data-testid="overview-config-meta">
      {segments.map((seg, i) => (
        <span key={i}>
          {i > 0 ? <span className="mx-1.5 opacity-50">·</span> : null}
          {seg}
        </span>
      ))}
    </span>
  );
}

/**
 * Selected-worktree central document as a development "work dossier" (see
 * demo/worktree-page-v3.html): identity + editable intent lead, a `now` line of
 * branch facts with one quiet status word, a Branch & changes spine, an
 * agent-aware Sessions section, and runtime reduced to a single summary line
 * that hands off to the Runtime panel. The same anatomy renders for every
 * deployment status, including not-started. Full operational detail — services,
 * ports, tunnels, logs, lifecycle controls — lives in the Runtime panel.
 */
export function WorktreeOverview({
  detail,
  reviewSummary,
  terminalCount,
  onOpenRuntime,
  onOpenReview,
  onOpenFiles,
  onOpenTerminal,
  onRenameSession,
  onNoteSaved,
}: WorktreeOverviewProps) {
  const wt = detail.worktree;
  const status = wt.status;
  const isNotStarted = status === "not_started";

  const sessions = useTerminalSessions(wt.path);
  const agentCount = sessions.filter((s) => terminalAgent(s)).length;

  const ledgerRows = branchLedgerRows(detail);
  const hasChanges = !!reviewSummary && reviewSummary.changedFiles > 0;
  const previewFiles = reviewSummary?.files?.slice(0, MAX_PREVIEW_FILES) ?? [];

  const exposed = representativeExposed(detail);

  return (
    <div
      className="flex-1 overflow-auto bg-[color:var(--surface)]"
      data-testid="worktree-overview"
    >
      <div className="mx-auto flex w-full max-w-[720px] flex-col px-6 pb-8 pt-9 md:px-14">
        {detail.statusError ? (
          <div
            className="mb-4 rounded-[10px] border border-[color:color-mix(in_oklch,var(--warn)_35%,transparent)] bg-[color:color-mix(in_oklch,var(--warn)_8%,transparent)] px-3.5 py-2 text-[13px] text-[color:var(--warn)]"
            data-testid="overview-status-error"
          >
            <strong className="font-semibold">warn</strong>
            <span className="mx-2 opacity-50">·</span>
            Failed to collect status: {detail.statusError}
          </div>
        ) : null}

        {/* HERO — identity + intent. Status is not the headline. */}
        <header className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <h1
              className="m-0 text-[22px] font-semibold tracking-[-0.01em] text-[color:var(--ink)]"
              title={titleLabel(detail)}
            >
              {titleLabel(detail)}
            </h1>
            <span className="text-[13px] text-[color:var(--muted-foreground)]">
              {detail.projectName ? `${detail.projectName} · ` : ""}
              {wt.isSource ? "primary worktree" : "secondary worktree"}
            </span>
          </div>
          <div
            className="flex items-center gap-1.5 text-[12px] text-[color:var(--muted-foreground)]"
            title={wt.path}
            data-testid="overview-path"
          >
            <FolderGit2
              className="size-3.5 shrink-0"
              strokeWidth={1.75}
              aria-hidden
            />
            <span className="truncate font-mono">{wt.path}</span>
          </div>
          <IntentBlock detail={detail} onNoteSaved={onNoteSaved} />
          <NowLine detail={detail} />
          <WorkflowStatusControl detail={detail} onChanged={onNoteSaved} />
        </header>

        {/* BRANCH & CHANGES — the spine. */}
        <DocumentSection
          title="Branch & changes"
          meta={
            hasChanges
              ? `+${reviewSummary.additions} −${reviewSummary.deletions} across ${reviewSummary.changedFiles} ${reviewSummary.changedFiles === 1 ? "file" : "files"}`
              : undefined
          }
          actions={
            <SectionMore
              label="Review changes"
              onClick={onOpenReview}
              testId="overview-review-changes"
            />
          }
        >
          {ledgerRows.length > 0 ? <Ledger rows={ledgerRows} /> : null}

          {previewFiles.length > 0 ? (
            <div className="mt-4" data-testid="overview-changes">
              {previewFiles.map((f) => (
                <ChangeSummaryRow
                  key={f.path}
                  path={f.path}
                  additions={f.additions}
                  deletions={f.deletions}
                />
              ))}
            </div>
          ) : reviewSummary && !hasChanges ? (
            <p className="m-0 mt-3 text-[13px] text-[color:var(--muted-foreground)]">
              Working tree clean — no changes to review.
            </p>
          ) : null}
        </DocumentSection>

        {/* SESSIONS — "where is my agent". */}
        <DocumentSection
          title="Sessions"
          meta={
            sessions.length > 0
              ? `${sessions.length} running${agentCount > 0 ? ` · ${agentCount} ${agentCount === 1 ? "agent" : "agents"}` : ""}`
              : undefined
          }
          actions={
            sessions.length > 0 ? (
              <SectionMore
                label="Open terminal"
                onClick={() => onOpenTerminal()}
                testId="overview-sessions-more"
              />
            ) : undefined
          }
        >
          {sessions.length > 0 ? (
            <div data-testid="overview-sessions">
              {sessions.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  onAttach={() => onOpenTerminal(s.id)}
                  onRename={() => onRenameSession(s)}
                />
              ))}
            </div>
          ) : (
            <div
              className="flex items-center gap-3 rounded-[11px] border border-[color:var(--hair)] bg-[color:var(--shell)] px-4 py-3.5"
              data-testid="overview-sessions-empty"
            >
              <span
                aria-hidden
                className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-[color:var(--chip-bg)] text-[color:var(--muted-foreground)]"
              >
                <TerminalIcon className="size-4" strokeWidth={1.75} />
              </span>
              <span className="flex-1 text-[13.5px] text-[color:var(--muted-foreground)]">
                No open terminals in this worktree.
              </span>
              <Button
                size="sm"
                onClick={() => onOpenTerminal()}
                data-testid="overview-open-terminal-empty"
              >
                <TerminalIcon />
                Open terminal
              </Button>
            </div>
          )}
        </DocumentSection>

        {/* COMMENTS — the worktree-as-task log. Description stays the note above. */}
        <DocumentSection title="Comments">
          <WorktreeComments path={wt.path} />
        </DocumentSection>

        {/* RUNTIME — one quiet line + handoff. Detail lives in the panel. */}
        <DocumentSection
          title="Runtime"
          meta={isNotStarted ? "idle" : "summary"}
        >
          <RuntimeSummaryLine
            testId="overview-runtime-summary"
            dotVariant={statusDotVariant(status)}
            status={statusLabel(status)}
            facts={runtimeFacts(detail, exposed)}
            actionLabel={isNotStarted ? "Start in Runtime" : "Open Runtime"}
            onAction={onOpenRuntime}
            meta={runtimeMeta(detail)}
          />
        </DocumentSection>

        {/* CONTINUE — entry points, never a launch console. */}
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Button onClick={onOpenReview} data-testid="overview-review">
            <GitPullRequestArrow />
            Review
            {hasChanges ? (
              <span className="ml-1 font-mono text-[11px] tabular-nums">
                <span className="text-[color:var(--good)]">
                  +{reviewSummary.additions}
                </span>
                <span className="ml-0.5 text-[color:var(--bad)]">
                  −{reviewSummary.deletions}
                </span>
              </span>
            ) : null}
          </Button>
          <Button onClick={onOpenFiles} data-testid="overview-files">
            <FolderOpen />
            Files
          </Button>
          <Button onClick={() => onOpenTerminal()} data-testid="overview-terminal">
            <SquareTerminal />
            Terminal
            {terminalCount > 0 ? (
              <span className="ml-1 font-mono text-[11px] tabular-nums text-[color:var(--muted-foreground)]">
                {terminalCount}
              </span>
            ) : null}
          </Button>
          <span className="flex-1" />
          {exposed ? (
            <Button variant="solid" asChild data-testid="overview-open-web">
              <a href={exposed.url} target="_blank" rel="noreferrer">
                <ExternalLink />
                Open web
              </a>
            </Button>
          ) : isNotStarted ? (
            <Button
              variant="solid"
              onClick={onOpenRuntime}
              data-testid="overview-start"
            >
              <Play />
              Start worktree
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
