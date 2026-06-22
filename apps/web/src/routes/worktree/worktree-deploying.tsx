import { useEffect, useState } from "react";
import { Check, Loader, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TodoBanner } from "@/components/ui/todo-banner";
import { DocumentSection } from "@/routes/worktree/document";
import { LogsView } from "@/components/logs-view";
import { cn } from "@/lib/utils";
import type { LogChannel, WorktreeDetailResponse } from "@/lib/ui-api";
import {
  deploymentStepLabel,
  formatStepDuration,
  healthcheckAttemptOutcome,
  selectStepProgress,
  type HealthcheckAttemptProgress,
  type InitStepStatus,
} from "@/lib/worktree-view-model";

type StepProgress = ReturnType<typeof selectStepProgress>;

type WorktreeDeployingProps = {
  detail: WorktreeDetailResponse;
  steps: StepProgress;
  initStep: InitStepStatus | null;
  healthcheckAttempts: ReadonlyMap<string, HealthcheckAttemptProgress>;
  /** Stop the in-flight deployment (abort + full teardown). */
  onStop: () => void;
  /** A teardown is already in flight; disables the Stop control. */
  stopPending: boolean;
};

function StepMarker({ state }: { state: StepProgress[number]["state"] }) {
  if (state === "running") {
    return (
      <span
        className="relative z-[1] inline-grid place-items-center size-4 rounded-full bg-[color:var(--accent-cmd-soft)] text-[color:var(--accent-cmd)]"
        aria-hidden
      >
        <Loader className="size-2.5 animate-spin" />
      </span>
    );
  }
  if (state === "done") {
    return (
      <span
        className="relative z-[1] inline-grid place-items-center size-4 rounded-full bg-[color:color-mix(in_oklch,var(--good)_16%,transparent)] text-[color:var(--good)]"
        aria-hidden
      >
        <Check className="size-2.5" />
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span
        className="relative z-[1] inline-grid place-items-center size-4 rounded-full bg-[color:color-mix(in_oklch,var(--bad)_18%,transparent)] text-[color:var(--bad)]"
        aria-hidden
      >
        <X className="size-2.5" />
      </span>
    );
  }
  return (
    <span
      className="relative z-[1] inline-grid place-items-center size-4 rounded-full bg-[color:var(--chip-bg)] text-[color:var(--muted-foreground)]"
      aria-hidden
    >
      <span className="size-1.5 rounded-full bg-current" />
    </span>
  );
}

/**
 * Live elapsed counter for the currently-running step. Mounts only for the
 * running step so at most one interval runs; it stops when the step leaves
 * `running`. Diffs client `now` against the server-issued `startedAt`.
 */
function LiveStepDuration({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <>{formatStepDuration(now - new Date(startedAt).getTime())}</>;
}

/** Renders the duration text for a step node — the marker already conveys state. */
function StepDuration({ entry }: { entry: StepProgress[number] }) {
  if (entry.state === "running") {
    if (!entry.startedAt) return null;
    return <LiveStepDuration startedAt={entry.startedAt} />;
  }
  if (entry.state === "done" || entry.state === "failed") {
    if (!entry.startedAt || !entry.completedAt) return null;
    const ms =
      new Date(entry.completedAt).getTime() -
      new Date(entry.startedAt).getTime();
    return <>{formatStepDuration(ms)}</>;
  }
  return null;
}

/** Tone for a step's label, mirroring its marker state. */
function stepLabelTone(state: StepProgress[number]["state"]): string {
  switch (state) {
    case "running":
      return "text-[color:var(--ink)] font-medium";
    case "done":
      return "text-[color:var(--ink-2)]";
    case "failed":
      return "text-[color:var(--bad)] font-medium";
    default:
      return "text-[color:var(--muted-foreground)]";
  }
}

/**
 * Quiet live progress lines beneath the readiness-check step — one per
 * in-flight service: `waiting for <svc> · attempt N/M · last: <outcome>`.
 */
function HealthcheckAttemptLines({
  attempts,
}: {
  attempts: ReadonlyMap<string, HealthcheckAttemptProgress>;
}) {
  const entries = [...attempts.values()].sort((a, b) =>
    a.service.localeCompare(b.service),
  );
  if (entries.length === 0) return null;
  return (
    <div
      data-testid="healthcheck-attempt-progress"
      className="mt-3 flex flex-col gap-1 border-t border-[color:var(--hair)] pt-3 font-mono text-[12px] text-[color:var(--muted-foreground)] tabular-nums"
    >
      {entries.map((a) => (
        <span key={a.service} data-service={a.service}>
          waiting for {a.service} · attempt {a.attempt}/{a.maxAttempts} · last:{" "}
          {healthcheckAttemptOutcome(a)}
        </span>
      ))}
    </div>
  );
}

export function WorktreeDeploying({
  detail,
  steps,
  initStep,
  healthcheckAttempts,
  onStop,
  stopPending,
}: WorktreeDeployingProps) {
  const totalDone = steps.filter((s) => s.state === "done").length;
  const runningStep = steps.find((s) => s.state === "running");
  const initRunning =
    initStep?.state === "running" &&
    (initStep.kind === "first-run-setup" || initStep.kind === "init-script");
  // Default to the init tail while first-run setup is live (its output lands on
  // the `init` channel); otherwise follow the deployment channel.
  const [logChannel, setLogChannel] = useState<LogChannel>(
    initRunning ? "init" : "deployment",
  );

  const stopAction = (
    <Button
      onClick={onStop}
      disabled={stopPending}
      data-testid="deploying-stop"
      className="text-[color:var(--bad)] hover:text-[color:var(--bad)]"
    >
      <Square fill="currentColor" strokeWidth={0} className="size-[10px]" />
      Stop deployment
    </Button>
  );

  return (
    <div
      className="flex-1 overflow-auto bg-[color:var(--surface)]"
      data-testid="worktree-progress"
    >
      <div className="mx-auto w-full max-w-[880px] px-6 md:px-14 pt-9 pb-6 flex flex-col gap-3.5">
        <DocumentSection
          title="Pipeline"
          meta={`${steps.length} steps`}
          actions={stopAction}
        >
          <TodoBanner
            tone="running"
            meta={
              runningStep
                ? deploymentStepLabel(runningStep.id)
                : `${totalDone} of ${steps.length}`
            }
            className="mb-4"
          >
            <strong>{totalDone}</strong> of <strong>{steps.length}</strong> steps complete
          </TodoBanner>
          {/* Horizontal pipeline: equal-width nodes connected by hairlines that
           * fill in as each step completes. Compact enough to read at a glance
           * inside the Runtime panel rather than a tall vertical list. */}
          <ol
            data-testid="deployment-steps"
            aria-label="Deployment steps"
            className="grid"
            style={{
              gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))`,
            }}
          >
            {steps.map((entry, idx) => {
              const prevSettled =
                idx > 0 &&
                (steps[idx - 1]!.state === "done" ||
                  steps[idx - 1]!.state === "failed");
              return (
                <li
                  key={entry.id}
                  data-step-id={entry.id}
                  data-step-state={entry.state}
                  className="relative flex flex-col items-center gap-1.5 px-0.5 pb-1 text-center"
                >
                  {idx > 0 ? (
                    <span
                      aria-hidden
                      className={cn(
                        "absolute top-2 h-px -translate-y-1/2",
                        prevSettled
                          ? "bg-[color:color-mix(in_oklch,var(--good)_45%,transparent)]"
                          : "bg-[color:var(--hair-2)]",
                      )}
                      style={{
                        left: "calc(-50% + 8px)",
                        right: "calc(50% + 8px)",
                      }}
                    />
                  ) : null}
                  <StepMarker state={entry.state} />
                  <span
                    className={cn(
                      "text-[10.5px] leading-tight line-clamp-2",
                      stepLabelTone(entry.state),
                    )}
                    title={deploymentStepLabel(entry.id)}
                  >
                    {deploymentStepLabel(entry.id)}
                  </span>
                  <span
                    data-testid="step-duration"
                    className="min-h-[12px] font-mono text-[10px] text-[color:var(--muted-foreground)] tabular-nums"
                  >
                    <StepDuration entry={entry} />
                  </span>
                </li>
              );
            })}
          </ol>
          {runningStep?.id === "healthcheck" ? (
            <HealthcheckAttemptLines attempts={healthcheckAttempts} />
          ) : null}
        </DocumentSection>

        <DocumentSection
          title="Logs"
          actions={
            <div className="inline-flex items-center gap-1.5">
              {(["deployment", "init"] as const).map((ch) => (
                <button
                  key={ch}
                  type="button"
                  onClick={() => setLogChannel(ch)}
                  aria-pressed={logChannel === ch}
                  data-testid={`deploying-log-channel-${ch}`}
                  className={cn(
                    "inline-flex h-7 shrink-0 items-center rounded-md border px-2.5 font-mono text-[11px] transition-colors",
                    logChannel === ch
                      ? "border-[color:var(--ink-2)] bg-[color:var(--chip-bg)] text-[color:var(--ink)]"
                      : "border-[color:var(--hair-2)] text-[color:var(--muted-foreground)] hover:text-[color:var(--ink)]",
                  )}
                >
                  {ch}
                </button>
              ))}
            </div>
          }
        >
          <div
            data-testid="deploying-inline-logs"
            className="rounded-[10px] border border-[color:var(--hair-2)] overflow-hidden"
          >
            <div className="h-64 overflow-hidden">
              <LogsView
                sessionName={detail.worktree.sessionName}
                channel={logChannel}
                compact
              />
            </div>
          </div>
        </DocumentSection>
      </div>
    </div>
  );
}
