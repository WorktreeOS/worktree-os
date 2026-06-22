import { useMemo, type ReactNode } from "react";
import { ExternalLink, FileText, RotateCw, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Ic } from "@/components/ui/inline-code";
import { TodoBanner, type TodoTone } from "@/components/ui/todo-banner";
import { HairlineList } from "@/components/ui/hairline-list";
import { DocumentSection } from "@/routes/worktree/document";
import { LogsPanelBody } from "@/components/logs-panel";
import { WorktreeNotStarted } from "@/routes/worktree/worktree-not-started";
import { WorktreeDeploying } from "@/routes/worktree/worktree-deploying";
import { WorktreeFailed } from "@/routes/worktree/worktree-failed";
import { cn } from "@/lib/utils";
import { formatBytes, formatCpuPercent } from "@/lib/format-usage";
import {
  type AppPortHealthcheckResult,
  type LogChannel,
  type PortMapping,
  type ServiceStatus,
  type TunnelSnapshot,
  type WorktreeDetailResponse,
} from "@/lib/ui-api";
import {
  deriveActiveOp,
  inferEmphasizedChannel,
  selectStepProgress,
  type HealthcheckAttemptProgress,
  type InitStepStatus,
  type WorktreeSurface,
} from "@/lib/worktree-view-model";
import { type DeploymentActionSelection } from "@/lib/deployment-selection";

type ActionPending = null | "up" | "down" | "service" | "remove";

type StepProgress = ReturnType<typeof selectStepProgress>;

type RuntimePanelBodyProps = {
  detail: WorktreeDetailResponse;
  surface: WorktreeSurface;
  initStep: InitStepStatus | null;
  stepProgress: StepProgress;
  healthcheckAttempts: ReadonlyMap<string, HealthcheckAttemptProgress>;
  actionPending: ActionPending;
  canStart: boolean;
  canRestart: boolean;
  canStop: boolean;
  /** Selected runtime log channel, or `null` to default to `init`. */
  channel: LogChannel | null;
  onStartSubmit: (
    force: boolean,
    selection: DeploymentActionSelection,
  ) => Promise<void> | void;
  onRestart: () => void;
  onStop: () => void;
  onServiceAction: (service: string, action: "stop" | "restart") => void;
  /** Selects the runtime log channel for the embedded logs region. */
  onSelectChannel: (channel: LogChannel) => void;
};

/**
 * Runtime tab body for the worktree detail page, rendered full-width when the
 * Runtime tab is active. Owns the full deployment lifecycle — launch setup,
 * deployment progress, failure recovery, running services/tunnels/controls —
 * plus channel-scoped logs. The Overview tab carries the stable
 * development-context dossier.
 */
export function RuntimePanelBody({
  detail,
  surface,
  initStep,
  stepProgress,
  healthcheckAttempts,
  actionPending,
  canStart,
  canRestart,
  canStop,
  channel,
  onStartSubmit,
  onRestart,
  onStop,
  onServiceAction,
  onSelectChannel,
}: RuntimePanelBodyProps) {
  if (surface.kind === "not-started") {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorktreeNotStarted
          onStartSubmit={onStartSubmit}
          launching={actionPending === "up"}
          canStart={canStart}
          detail={detail}
        />
      </div>
    );
  }

  if (surface.kind === "in-progress") {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorktreeDeploying
          detail={detail}
          steps={stepProgress}
          initStep={initStep}
          healthcheckAttempts={healthcheckAttempts}
          onStop={onStop}
          stopPending={actionPending === "down"}
        />
      </div>
    );
  }

  if (surface.kind === "failed") {
    const emphasized = inferEmphasizedChannel(surface, initStep);
    return (
      <RuntimeSplit
        top={
          <WorktreeFailed
            surface={surface}
            emphasizedChannel={emphasized}
            onOpenLogs={onSelectChannel}
            onRetry={onRestart}
            canRetry={canRestart || canStart}
            onStop={onStop}
            stopPending={actionPending === "down"}
            detail={detail}
          />
        }
        logs={
          <LogsPanelBody
            detail={detail}
            channel={channel ?? emphasized ?? "init"}
            onSelectChannel={onSelectChannel}
          />
        }
      />
    );
  }

  // A stopped worktree has no live services and no streaming logs, so collapse
  // the panel to a single quiet "Stopped" banner with a Restart handoff.
  if (detail.worktree.status === "stopped") {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <RuntimeStoppedSection
          detail={detail}
          canRestart={canRestart}
          actionPending={actionPending}
          onRestart={onRestart}
        />
      </div>
    );
  }

  // running / running_partial / stopping / unknown
  return (
    <RuntimeSplit
      top={
        <RuntimeRunningSection
          detail={detail}
          actionPending={actionPending}
          canRestart={canRestart}
          canStop={canStop}
          activeChannel={channel}
          onRestart={onRestart}
          onStop={onStop}
          onServiceAction={onServiceAction}
          onSelectChannel={onSelectChannel}
        />
      }
      logs={
        <LogsPanelBody
          detail={detail}
          channel={channel ?? "init"}
          onSelectChannel={onSelectChannel}
        />
      }
    />
  );
}

/**
 * Stopped surface — a single calm "Stopped" banner. A stopped worktree has no
 * running services to status and no live logs to stream, so the panel shows
 * only the banner (with deploy freshness, when known) plus a Restart handoff.
 */
function RuntimeStoppedSection({
  detail,
  canRestart,
  actionPending,
  onRestart,
}: {
  detail: WorktreeDetailResponse;
  canRestart: boolean;
  actionPending: ActionPending;
  onRestart: () => void;
}) {
  const freshness = freshnessSnippet(detail);
  return (
    <div
      className="flex-1 overflow-auto bg-[color:var(--surface)]"
      data-testid="runtime-stopped"
    >
      <div className="px-5 pt-5 pb-6 flex flex-col gap-3.5">
        <TodoBanner
          tone="idle"
          meta={freshness ?? undefined}
          data-testid="runtime-stopped-banner"
        >
          Stopped
        </TodoBanner>
        {canRestart ? (
          <div>
            <Button
              variant="solid"
              disabled={actionPending !== null}
              onClick={onRestart}
              data-testid="runtime-restart"
            >
              <RotateCw
                className={actionPending === "up" ? "animate-spin" : undefined}
              />
              Restart
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Two-region runtime layout: the operational surface scrolls on top and the
 * channel-scoped logs viewer sits below it, so the active service stays visible
 * while its logs stream.
 */
function RuntimeSplit({ top, logs }: { top: ReactNode; logs: ReactNode }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 min-w-0 flex-[1.4] flex-col overflow-hidden">
        {top}
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col border-t border-[color:var(--hair)]">
        {logs}
      </div>
    </div>
  );
}

/* ====================================================================
 * Running surface — services, tunnels, controls, deploy freshness, and
 * the aggregate resource summary. Config readiness and identity stay in
 * the central development-context overview.
 * ==================================================================== */

type RuntimeRunningSectionProps = {
  detail: WorktreeDetailResponse;
  actionPending: ActionPending;
  canRestart: boolean;
  canStop: boolean;
  activeChannel: LogChannel | null;
  onRestart: () => void;
  onStop: () => void;
  onServiceAction: (service: string, action: "stop" | "restart") => void;
  onSelectChannel: (channel: LogChannel) => void;
};

function RuntimeRunningSection({
  detail,
  actionPending,
  canRestart,
  canStop,
  activeChannel,
  onRestart,
  onStop,
  onServiceAction,
  onSelectChannel,
}: RuntimeRunningSectionProps) {
  const activeOp = deriveActiveOp(detail);
  const busy =
    (activeOp !== undefined && activeOp.status === "running") ||
    actionPending !== null;
  const summary = detail.worktree.serviceSummary;
  const usage = detail.worktree.resourceUsage;
  const aggCpu = formatCpuPercent(usage?.cpuPercent);
  const aggMem = formatBytes(usage?.memUsedBytes);
  const usageLine = [aggCpu ? `${aggCpu} CPU` : null, aggMem]
    .filter((s): s is string => s !== null)
    .join(" · ");
  const tunnels = detail.tunnels;
  const freshness = freshnessSnippet(detail);
  const commitsSinceDeploy = detail.deployFreshness?.commitsSinceDeploy ?? 0;
  const isRunningSurface =
    detail.worktree.status === "running" ||
    detail.worktree.status === "running_partial";

  const tone: TodoTone = (() => {
    if (detail.worktree.status === "failed") return "failed";
    if (
      detail.worktree.status === "stopped" ||
      detail.worktree.status === "not_started"
    )
      return "idle";
    if (
      detail.worktree.status === "pending" ||
      detail.worktree.status === "checking"
    )
      return "running";
    return "done";
  })();

  const todoText = summary ? (
    <>
      <strong>{summary.running}</strong> of <strong>{summary.total}</strong>{" "}
      services{" "}
      {isRunningSurface
        ? "running"
        : detail.worktree.status === "stopped"
          ? "stopped"
          : "tracked"}
    </>
  ) : (
    <span>Worktree snapshot</span>
  );

  const serviceActions = (
    <div className="inline-flex items-center gap-2">
      <Button disabled={!canRestart} onClick={onRestart} data-testid="runtime-restart">
        <RotateCw
          className={actionPending === "up" ? "animate-spin" : undefined}
        />
        Restart
      </Button>
      <Button
        disabled={!canStop || actionPending === "down"}
        onClick={onStop}
        data-testid="runtime-stop"
        className="text-[color:var(--bad)] hover:text-[color:var(--bad)]"
      >
        <Square fill="currentColor" strokeWidth={0} className="size-[10px]" />
        Stop
      </Button>
    </div>
  );

  return (
    <div
      className="flex-1 overflow-auto bg-[color:var(--surface)]"
      data-testid="runtime-running"
    >
      <div className="px-5 pt-5 pb-6 flex flex-col gap-3.5">
        {detail.statusError ? (
          <div className="rounded-[10px] border border-[color:color-mix(in_oklch,var(--warn)_35%,transparent)] bg-[color:color-mix(in_oklch,var(--warn)_8%,transparent)] px-3.5 py-2 text-[13px] text-[color:var(--warn)]">
            <strong className="font-semibold">warn</strong>
            <span className="mx-2 opacity-50">·</span>
            Failed to collect status: {detail.statusError}
          </div>
        ) : null}

        <DocumentSection
          title="Services"
          meta={
            detail.services.length > 0
              ? `${detail.services.length} ${detail.services.length === 1 ? "unit" : "units"}`
              : undefined
          }
          actions={serviceActions}
        >
          <TodoBanner
            tone={tone}
            meta={freshness ?? undefined}
            data-testid="runtime-todo"
            className="mb-3.5"
          >
            {todoText}
          </TodoBanner>
          {usageLine ? (
            <p
              className="mb-3.5 text-[12.5px] text-[color:var(--muted-foreground)]"
              data-testid="runtime-resource-usage"
            >
              {usageLine}
            </p>
          ) : null}
          {commitsSinceDeploy > 0 ? (
            <p
              className="mb-3.5 text-[12.5px] text-[color:var(--ink-2)]"
              data-testid="runtime-redeploy-hint"
            >
              {commitsSinceDeploy}{" "}
              {commitsSinceDeploy === 1 ? "commit" : "commits"} since deploy
              <span className="mx-1.5 opacity-50">·</span>
              <button
                type="button"
                disabled={!canRestart}
                onClick={onRestart}
                className="underline underline-offset-2 hover:text-[color:var(--ink)] disabled:opacity-50"
              >
                redeploy?
              </button>
            </p>
          ) : null}
          {detail.services.length === 0 ? (
            <p className="text-[13.5px] text-[color:var(--muted-foreground)] italic">
              no managed services
            </p>
          ) : (
            <HairlineList data-testid="services-list">
              {detail.services.map((svc) => (
                <ServiceRow
                  key={svc.service}
                  service={svc}
                  healthchecks={detail.appPortHealthchecks}
                  tunnels={tunnels}
                  disabled={busy}
                  pending={actionPending === "service"}
                  active={activeChannel === `service:${svc.service}`}
                  onAction={(action) => onServiceAction(svc.service, action)}
                  onOpenLogs={() => onSelectChannel(`service:${svc.service}`)}
                />
              ))}
            </HairlineList>
          )}
        </DocumentSection>

        {tunnels.length > 0 ? (
          <DocumentSection
            title="Tunnels"
            meta={`${tunnels.filter((t) => t.state === "active").length} of ${tunnels.length} active`}
          >
            <HairlineList>
              {tunnels.map((t, i) => (
                <TunnelRow
                  key={`${t.service}-${t.containerPort}-${i}`}
                  tunnel={t}
                  index={i + 1}
                />
              ))}
            </HairlineList>
          </DocumentSection>
        ) : null}
      </div>
    </div>
  );
}

function normalizeHost(hostIp: string | undefined): string | undefined {
  if (hostIp === "0.0.0.0" || hostIp === "::") return "localhost";
  return hostIp;
}

function dedupePorts(ports: PortMapping[]): PortMapping[] {
  const seen = new Set<string>();
  const out: PortMapping[] = [];
  for (const p of ports) {
    const host = normalizeHost(p.hostIp) ?? "";
    const proto = (p.protocol || "tcp").toLowerCase();
    const key = `${host}:${p.hostPort ?? ""}|${p.containerPort}/${proto}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function formatRelative(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const diff = Date.now() - d.getTime();
  if (diff < 0) return null;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}

/**
 * Compact uptime since `iso`, e.g. `14m`, `2h`, `3d`. Mirrors the buckets of
 * `formatRelative` but without the trailing "ago" so it reads as `up <rel>`.
 */
function formatUptime(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const diff = Date.now() - d.getTime();
  if (diff < 0) return null;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/**
 * Quiet deploy-freshness snippet: `deployed <rel> · took <n>s`. Falls back to
 * the persisted `lastUp` timestamp when explicit freshness is absent. Returns
 * `null` when there is no last-deploy time at all.
 */
function freshnessSnippet(detail: WorktreeDetailResponse): string | null {
  const lastUpAt = detail.deployFreshness?.lastUpAt ?? detail.state?.lastUp;
  const rel = formatRelative(lastUpAt);
  if (!rel) return null;
  const took = formatDuration(detail.deployFreshness?.deployDurationMs);
  return took ? `deployed ${rel} · took ${took}` : `deployed ${rel}`;
}

function ServiceDot({ state }: { state: string }) {
  const tone =
    state === "running"
      ? "bg-[#22C55E]"
      : state === "exited" || state === "stopped"
        ? "bg-[color:var(--muted-foreground)]"
        : "bg-[color:var(--warn)]";
  return (
    <span
      aria-hidden
      className={cn("inline-block size-[7px] rounded-full align-middle", tone)}
    />
  );
}

function HealthSummary({
  service,
  healthchecks,
}: {
  service: string;
  healthchecks: AppPortHealthcheckResult[];
}) {
  const hcs = healthchecks.filter((h) => h.service === service);
  if (hcs.length === 0) return null;
  const healthy = hcs.filter((h) => h.state === "healthy").length;
  const all = hcs.length;
  const isAllHealthy = healthy === all;
  return (
    <>
      <span className="opacity-50">·</span>
      <span
        className={cn(
          isAllHealthy
            ? "text-[color:var(--muted-foreground)]"
            : "text-[color:var(--warn)]",
        )}
      >
        {isAllHealthy ? "healthy" : `${healthy}/${all} healthy`}
      </span>
    </>
  );
}

function ServiceRow({
  service,
  healthchecks,
  tunnels,
  disabled,
  pending,
  active,
  onAction,
  onOpenLogs,
}: {
  service: ServiceStatus;
  healthchecks: AppPortHealthcheckResult[];
  tunnels: TunnelSnapshot[];
  disabled: boolean;
  pending: boolean;
  /** Highlight the row when its log channel is the selected runtime channel. */
  active: boolean;
  onAction: (action: "stop" | "restart") => void;
  onOpenLogs: () => void;
}) {
  const ports = useMemo(() => dedupePorts(service.ports), [service.ports]);
  const uptime = formatUptime(service.startedAt);
  const restarts = service.restartCount ?? 0;
  const cpu = formatCpuPercent(service.resourceUsage?.cpuPercent);
  const mem = formatBytes(service.resourceUsage?.memUsedBytes);
  const tunnelsByPort = useMemo(() => {
    const map = new Map<number, TunnelSnapshot>();
    for (const t of tunnels) {
      if (t.service === service.service) map.set(t.containerPort, t);
    }
    return map;
  }, [tunnels, service.service]);

  return (
    <div
      data-testid="service-card"
      data-service={service.service}
      data-active={active ? "true" : undefined}
      aria-current={active ? "true" : undefined}
      className={cn(
        "py-3 grid grid-cols-[minmax(0,1.1fr)_minmax(0,1.9fr)_auto] gap-5 items-baseline",
        active && "bg-[color:var(--hover)] -mx-1.5 px-1.5 rounded",
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <ServiceDot state={service.state} />
          <span className="font-medium text-[14px] text-[color:var(--ink)] truncate" title={service.service}>
            {service.service}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-[13px] text-[color:var(--muted-foreground)]">
          <span>{service.state}</span>
          <HealthSummary service={service.service} healthchecks={healthchecks} />
          {service.status ? (
            <>
              <span className="opacity-50">·</span>
              <span className="truncate normal-case">{service.status}</span>
            </>
          ) : null}
          {uptime ? (
            <>
              <span className="opacity-50">·</span>
              <span>up {uptime}</span>
            </>
          ) : null}
          {restarts > 0 ? (
            <>
              <span className="opacity-50">·</span>
              <span>
                {restarts} {restarts === 1 ? "restart" : "restarts"}
              </span>
            </>
          ) : null}
          {cpu ? (
            <>
              <span className="opacity-50">·</span>
              <span data-testid={`service-cpu:${service.service}`}>{cpu} CPU</span>
            </>
          ) : null}
          {mem ? (
            <>
              <span className="opacity-50">·</span>
              <span data-testid={`service-mem:${service.service}`}>{mem}</span>
            </>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-1.5 min-w-0">
        {ports.length === 0 ? (
          <span className="text-[13px] text-[color:var(--muted-foreground)]">
            no exposed ports
          </span>
        ) : (
          ports.map((port) => {
            const host = normalizeHost(port.hostIp);
            const proto = (port.protocol || "tcp").toLowerCase();
            const url =
              host !== undefined && proto === "tcp" && port.hostPort !== undefined
                ? `http://${host}:${port.hostPort}`
                : undefined;
            const tunnel = tunnelsByPort.get(port.containerPort);
            return (
              <div
                key={`${port.hostIp ?? ""}:${port.hostPort ?? ""}-${port.containerPort}-${proto}`}
                className="flex items-baseline gap-2.5 flex-wrap text-[13px] text-[color:var(--ink-2)]"
              >
                <Ic tone="dim">→</Ic>
                {url && port.hostPort !== undefined ? (
                  <Ic href={url} target="_blank" rel="noreferrer">
                    {host}:{port.hostPort}
                  </Ic>
                ) : (
                  <Ic>
                    {host ?? "?"}:{port.hostPort ?? "?"}
                  </Ic>
                )}
                <span className="text-[12.5px] text-[color:var(--muted-foreground)]">
                  → {port.containerPort}/{proto}
                </span>
                {tunnel && tunnel.state === "active" ? (
                  <>
                    <span className="text-[12.5px] text-[color:var(--muted-foreground)]">
                      tunnel ·
                    </span>
                    <Ic href={tunnel.url} target="_blank" rel="noreferrer">
                      {tunnel.hostname}
                    </Ic>
                  </>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      <div className="inline-flex items-center gap-0.5 self-start pt-0.5">
        <IconButton
          aria-label={`Open ${service.service} logs`}
          data-testid={`open-service-logs:${service.service}`}
          onClick={onOpenLogs}
        >
          <FileText />
        </IconButton>
        <IconButton
          aria-label={`Restart ${service.service}`}
          disabled={disabled}
          onClick={() => onAction("restart")}
        >
          <RotateCw className={pending ? "animate-spin" : undefined} />
        </IconButton>
        <IconButton
          aria-label={`Stop ${service.service}`}
          disabled={disabled}
          tone="danger"
          onClick={() => onAction("stop")}
        >
          <Square fill="currentColor" strokeWidth={0} className="!size-[10px]" />
        </IconButton>
      </div>
    </div>
  );
}

function TunnelRow({ tunnel, index }: { tunnel: TunnelSnapshot; index: number }) {
  const isActive = tunnel.state === "active";
  return (
    <div className="py-2.5 grid grid-cols-[28px_minmax(0,1fr)_auto] gap-3 items-center">
      <span className="font-mono text-[11.5px] text-[color:var(--muted-foreground)]">
        {index}.
      </span>
      <div className="min-w-0 flex flex-wrap items-baseline gap-2">
        {isActive && "hostname" in tunnel ? (
          <Ic href={tunnel.url} target="_blank" rel="noreferrer">
            {tunnel.hostname}
          </Ic>
        ) : (
          <Ic tone="danger">tunnel failed</Ic>
        )}
        <span className="text-[12.5px] text-[color:var(--muted-foreground)]">
          → {tunnel.service} <Ic tone="dim">:{tunnel.containerPort}</Ic>
        </span>
        {tunnel.state === "failed" && tunnel.message ? (
          <span className="text-[12px] text-[color:var(--bad)]">{tunnel.message}</span>
        ) : null}
      </div>
      <div className="inline-flex items-center gap-1">
        {isActive && "url" in tunnel ? (
          <>
            <Button
              size="xs"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(tunnel.url);
                } catch {
                  /* ignore */
                }
              }}
            >
              Copy
            </Button>
            <Button size="xs" asChild>
              <a href={tunnel.url} target="_blank" rel="noreferrer">
                <ExternalLink />
                Open
              </a>
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
