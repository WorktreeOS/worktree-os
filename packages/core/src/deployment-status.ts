import type {
  HealthcheckEventState,
  ServiceSummary,
  WorktreeDeploymentStatus,
} from "./unified-events";

/**
 * Active mutating operation summary used by the classifier. Only the kind and
 * status matter; the registry types are intentionally not imported to avoid
 * coupling core to daemon-only modules.
 */
export interface ClassifierActiveOperation {
  kind: "up" | "down" | "service-stop" | "service-restart" | string;
  status: "queued" | "running" | "succeeded" | "failed" | "conflict" | string;
}

/** Last finished operation summary used by the classifier. */
export interface ClassifierLatestOperation {
  status: "queued" | "running" | "succeeded" | "failed" | "conflict" | string;
}

export type ServiceCollectionState =
  | { kind: "not_initialized" }
  | { kind: "uncollected" }
  | { kind: "no_services" }
  | {
      kind: "ok";
      services: ReadonlyArray<{ state: string }>;
      healthchecks?: ReadonlyArray<{ state: HealthcheckEventState }>;
    };

export interface ClassifierInput {
  /** Initialized wos state is present (state.initialized === true). */
  initialized: boolean;
  /** Active mutating operation, if any. */
  activeOperation?: ClassifierActiveOperation | null;
  /** Latest finished/failed operation, if known. */
  latestOperation?: ClassifierLatestOperation | null;
  /**
   * Whether snapshots were collected during an active `up` healthcheck phase
   * (used to differentiate `checking` from `pending`). When true and active
   * `up` is running, classifier reports `checking` instead of `pending`.
   */
  isHealthcheckPhase?: boolean;
  /**
   * Persistent marker that the previous `up` failed before wos state was
   * initialized. Survives daemon restarts via the on-disk failure file.
   */
  hasPersistedUpFailure?: boolean;
  /** Service / healthcheck collection outcome. */
  collection: ServiceCollectionState;
}

export interface ClassifierResult {
  status: WorktreeDeploymentStatus;
  summary?: ServiceSummary;
}

const FAILURE_STATES = new Set([
  "exited",
  "dead",
  "failed",
  "error",
  "fatal",
]);

const RUNNING_STATES = new Set(["running"]);

const CHECKING_STATES = new Set([
  "starting",
  "restarting",
  "created",
  "paused",
  "removing",
]);

/**
 * Derive a deployment status and an optional service summary from initialized
 * state, active/latest operation info, and current Compose/healthcheck data.
 *
 * This is the single shared classifier used by both the session monitor and
 * the UI API snapshot endpoints — all callers should rely on this function so
 * UI badges, project list summaries, and unified events agree on lifecycle.
 */
export function classifyDeploymentStatus(
  input: ClassifierInput,
): ClassifierResult {
  const active = input.activeOperation;
  const isActiveUp =
    !!active && active.status === "running" && active.kind === "up";

  // An active `up` overrides the uninitialized state: first launch is a real
  // pending deployment even before wos state is persisted. A failed last
  // operation surfaces `failed` so a crashed init script does not bounce the
  // worktree back to `not_started`. Other mutating ops (down/service-stop/
  // service-restart) require initialized state and do not get this override.
  if (!input.initialized) {
    if (isActiveUp) {
      const sum = summarizeFromCollection(input.collection);
      return { status: "pending", summary: sum };
    }
    if (
      input.latestOperation?.status === "failed" ||
      input.hasPersistedUpFailure === true
    ) {
      return {
        status: "failed",
        summary: { total: 0, running: 0, stopped: 0, failed: 0, checking: 0 },
      };
    }
    return {
      status: "not_started",
      summary: { total: 0, running: 0, stopped: 0, failed: 0, checking: 0 },
    };
  }

  const isActiveMutating =
    !!active &&
    active.status === "running" &&
    (active.kind === "up" ||
      active.kind === "down" ||
      active.kind === "service-stop" ||
      active.kind === "service-restart");

  // Active mutating operation: differentiate stop ops from start ops so UI
  // can render "Stopping..." vs "Deploying" without inspecting activeOperation.kind.
  // `service-restart` stays in pending because its end state is a running service.
  if (isActiveMutating) {
    if (active!.kind === "down" || active!.kind === "service-stop") {
      const sum = summarizeFromCollection(input.collection);
      return { status: "stopping", summary: sum };
    }
    if (input.isHealthcheckPhase && active!.kind === "up") {
      const sum = summarizeFromCollection(input.collection);
      return { status: "checking", summary: sum };
    }
    const sum = summarizeFromCollection(input.collection);
    return { status: "pending", summary: sum };
  }

  // No active op — drive status from service / healthcheck data.
  const col = input.collection;
  if (col.kind === "uncollected") {
    return { status: "unknown" };
  }

  if (col.kind === "no_services") {
    return {
      status: "stopped",
      summary: { total: 0, running: 0, stopped: 0, failed: 0, checking: 0 },
    };
  }

  // Initialized but state-only (no compose collection at all).
  if (col.kind === "not_initialized") {
    // Defensive: initialized=true but caller said not_initialized → unknown.
    return { status: "unknown" };
  }

  const summary = summarizeServices(col.services);
  // Healthchecks influence partial/running status but not service counts.
  const hcRequiredOk = healthchecksOk(col.healthchecks);
  const hcAnyFailed = healthchecksAnyFailed(col.healthchecks);
  const hcAnyWaiting = healthchecksAnyWaiting(col.healthchecks);

  if (summary.total === 0) {
    return { status: "stopped", summary };
  }
  if (summary.failed > 0) {
    if (summary.running > 0) return { status: "running_partial", summary };
    if (input.latestOperation?.status === "failed") {
      return { status: "failed", summary };
    }
    return { status: "failed", summary };
  }
  if (summary.running === 0) {
    return { status: "stopped", summary };
  }
  // At least one service is running.
  if (summary.running < summary.total) {
    return { status: "running_partial", summary };
  }
  // All managed services are running.
  if (hcAnyFailed) {
    return { status: "running_partial", summary };
  }
  if (hcAnyWaiting) {
    // Waiting healthchecks outside an explicit `up` healthcheck phase mean
    // availability is degraded for at least one port.
    return { status: "running_partial", summary };
  }
  if (hcRequiredOk) {
    return { status: "running", summary };
  }
  return { status: "running", summary };
}

function summarizeFromCollection(
  col: ServiceCollectionState,
): ServiceSummary | undefined {
  if (col.kind === "ok") return summarizeServices(col.services);
  if (col.kind === "no_services") {
    return { total: 0, running: 0, stopped: 0, failed: 0, checking: 0 };
  }
  if (col.kind === "not_initialized") {
    return { total: 0, running: 0, stopped: 0, failed: 0, checking: 0 };
  }
  return undefined;
}

export function summarizeServices(
  services: ReadonlyArray<{ state: string }>,
): ServiceSummary {
  let running = 0;
  let stopped = 0;
  let failed = 0;
  let checking = 0;
  for (const svc of services) {
    const s = svc.state.toLowerCase();
    if (RUNNING_STATES.has(s)) running += 1;
    else if (FAILURE_STATES.has(s)) failed += 1;
    else if (CHECKING_STATES.has(s)) checking += 1;
    else stopped += 1;
  }
  return { total: services.length, running, stopped, failed, checking };
}

function healthchecksOk(
  hcs?: ReadonlyArray<{ state: HealthcheckEventState }>,
): boolean {
  if (!hcs || hcs.length === 0) return true;
  return hcs.every(
    (h) =>
      h.state === "healthy" ||
      h.state === "disabled" ||
      h.state === "failed-allowed",
  );
}

function healthchecksAnyFailed(
  hcs?: ReadonlyArray<{ state: HealthcheckEventState }>,
): boolean {
  if (!hcs) return false;
  return hcs.some((h) => h.state === "failed");
}

function healthchecksAnyWaiting(
  hcs?: ReadonlyArray<{ state: HealthcheckEventState }>,
): boolean {
  if (!hcs) return false;
  return hcs.some((h) => h.state === "waiting");
}

/** Compare two summaries; returns true when they match exactly. */
export function serviceSummaryEqual(
  a?: ServiceSummary,
  b?: ServiceSummary,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.total === b.total &&
    a.running === b.running &&
    a.stopped === b.stopped &&
    a.failed === b.failed &&
    a.checking === b.checking
  );
}
