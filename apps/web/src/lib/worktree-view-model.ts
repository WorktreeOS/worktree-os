// Pure view-model helpers for the selected worktree route. Centralizes the
// decision of which Runtime-tab surface to render (overview, in-progress,
// failed, not-started) so the route component stays focused on layout. Logs
// are not a standalone surface — they render inside the Runtime tab.

import type {
  DeploymentStatus,
  DeploymentStepId,
  LogChannel,
  OperationMetadata,
  WorktreeDetailResponse,
} from "./ui-api";

export type InitStepKind = "first-run-setup" | "init-script";
export type InitStepState = "running" | "done" | "failed";

export interface InitStepStatus {
  kind: InitStepKind;
  state: InitStepState;
}

/**
 * Resolved central surface for the worktree route. Progress/failure-derived
 * surfaces come first, then overview as the default for healthy/stopped/
 * unknown states.
 */
export type WorktreeSurface =
  | { kind: "not-started" }
  | { kind: "in-progress" }
  | {
      kind: "failed";
      channel?: LogChannel;
      message?: string;
      step?: DeploymentStepId;
      logTail?: string[];
    }
  | { kind: "overview" };

export function deriveActiveOp(
  detail: WorktreeDetailResponse,
): OperationMetadata | undefined {
  return detail.activeOperation ?? detail.worktree.activeOperation;
}

export function isActiveUp(
  activeOp: OperationMetadata | undefined,
): boolean {
  return activeOp?.kind === "up" && activeOp.status === "running";
}

export function hasRunningOp(
  status: DeploymentStatus,
  activeOp: OperationMetadata | undefined,
): boolean {
  return (
    (activeOp !== undefined && activeOp.status === "running") ||
    status === "pending" ||
    status === "checking"
  );
}

export interface SelectSurfaceInput {
  detail: WorktreeDetailResponse;
  initStep: InitStepStatus | null;
}

export function selectWorktreeSurface(
  input: SelectSurfaceInput,
): WorktreeSurface {
  const { detail } = input;
  const status = detail.worktree.status;
  const activeOp = deriveActiveOp(detail);
  const active = hasRunningOp(status, activeOp);

  if (status === "not_started" && !active) {
    return { kind: "not-started" };
  }
  // `stopping` keeps the overview surface so the user sees services winding
  // down rather than the deployment in-progress (steps) screen.
  if (status === "stopping") {
    return { kind: "overview" };
  }
  if (isActiveUp(activeOp) || status === "pending" || status === "checking") {
    return { kind: "in-progress" };
  }
  if (status === "failed") {
    const fc = detail.failureContext;
    return {
      kind: "failed",
      ...(fc?.channel ? { channel: fc.channel } : {}),
      ...(fc?.message ? { message: fc.message } : {}),
      ...(fc?.step ? { step: fc.step } : {}),
      ...(fc?.logTail && fc.logTail.length > 0 ? { logTail: fc.logTail } : {}),
    };
  }
  if (input.initStep?.state === "failed") {
    return {
      kind: "failed",
      channel: "init",
      step: input.initStep.kind,
    };
  }
  return { kind: "overview" };
}

export interface InitDiagnostic {
  kind: "idle" | "running" | "succeeded" | "failed";
  step?: InitStepKind;
}

export function deriveInitDiagnostic(
  initStep: InitStepStatus | null,
): InitDiagnostic {
  if (!initStep) return { kind: "idle" };
  if (initStep.state === "running") {
    return { kind: "running", step: initStep.kind };
  }
  if (initStep.state === "done") {
    return { kind: "succeeded", step: initStep.kind };
  }
  return { kind: "failed", step: initStep.kind };
}

/**
 * Channel to auto-emphasize on a failed surface when the daemon could not
 * provide one. Used as a best-effort hint when failureContext is missing — for
 * example after a daemon restart that lost in-memory operation history.
 */
export function inferEmphasizedChannel(
  surface: WorktreeSurface,
  initStep: InitStepStatus | null,
): LogChannel | null {
  if (surface.kind === "failed" && surface.channel) return surface.channel;
  if (surface.kind === "failed" && initStep?.state === "failed") {
    return "init";
  }
  return null;
}

export type StepState = "pending" | "running" | "done" | "failed";

export const DEPLOYMENT_STEP_ORDER: DeploymentStepId[] = [
  "prepare",
  "release-ports",
  "first-run-setup",
  "init-script",
  "compose-up",
  "status",
  "healthcheck",
];

/**
 * Per-step record tracked client-side. `startedAt` / `completedAt` are
 * captured from the unified event envelope timestamp so durations can be
 * derived without any server change.
 */
export interface StepRecord {
  state: StepState;
  startedAt?: string;
  completedAt?: string;
}

export interface StepProgressEntry {
  id: DeploymentStepId;
  state: StepState;
  startedAt?: string;
  completedAt?: string;
}

export function applyStepEvent(
  state: ReadonlyMap<DeploymentStepId, StepRecord>,
  step: DeploymentStepId,
  next: StepState,
  timestamp?: string,
): Map<DeploymentStepId, StepRecord> {
  const updated = new Map(state);
  const prev = state.get(step);
  const record: StepRecord = { ...prev, state: next };
  if (next === "running" && timestamp) {
    record.startedAt = timestamp;
  }
  if ((next === "done" || next === "failed") && timestamp) {
    record.completedAt = timestamp;
  }
  updated.set(step, record);
  return updated;
}

export function selectStepProgress(
  state: ReadonlyMap<DeploymentStepId, StepRecord>,
): StepProgressEntry[] {
  return DEPLOYMENT_STEP_ORDER.map((id) => {
    const record = state.get(id);
    return {
      id,
      state: record?.state ?? "pending",
      ...(record?.startedAt ? { startedAt: record.startedAt } : {}),
      ...(record?.completedAt ? { completedAt: record.completedAt } : {}),
    };
  });
}

/** Formats a whole-second duration: `3s` under a minute, `1m22s` past it. */
export function formatStepDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/**
 * Latest healthcheck-attempt progress for one service, mirrored from the
 * transient `deployment.healthcheck-attempt` event stream. Keyed per service
 * (one in-flight line per service) on the deploying screen.
 */
export interface HealthcheckAttemptProgress {
  service: string;
  attempt: number;
  maxAttempts: number;
  status?: number;
  error?: string;
  matched: boolean;
}

/**
 * Outcome word for a healthcheck attempt, matching the CLI wording
 * (`ok` / `HTTP 503` / the error text).
 */
export function healthcheckAttemptOutcome(
  attempt: Pick<HealthcheckAttemptProgress, "matched" | "status" | "error">,
): string {
  if (attempt.matched) return "ok";
  if (attempt.status !== undefined) return `HTTP ${attempt.status}`;
  return attempt.error ?? "error";
}

export function deploymentStepLabel(id: DeploymentStepId): string {
  switch (id) {
    case "prepare":
      return "Preparing";
    case "release-ports":
      return "Releasing ports";
    case "first-run-setup":
      return "First-run setup";
    case "init-script":
      return "init-script";
    case "compose-up":
      return "Starting services";
    case "status":
      return "Collecting status";
    case "healthcheck":
      return "Readiness check";
  }
}
