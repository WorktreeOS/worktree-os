import {
  hardcodedHealthcheckDefaults,
  type AppPortSpec,
  type WosConfig,
  type ResolvedHealthcheckDefaults,
} from "@worktreeos/core/config";
import { hostLabelFromMapping } from "@worktreeos/ui/host-link";
import type { PortMapping, ServiceStatus } from "@worktreeos/compose/ps";

export type AppPortHealthcheckState =
  | "healthy"
  | "failed"
  | "failed-allowed"
  | "disabled"
  | "waiting";

export interface AppPortHealthcheckResult {
  service: string;
  containerPort: number;
  state: AppPortHealthcheckState;
  enabled: boolean;
  allowFailure: boolean;
  url?: string;
  expectedStatus?: number;
  observedStatus?: number;
  timeoutMs?: number;
  startPeriodMs?: number;
  intervalMs?: number;
  retries?: number;
  message?: string;
}

export type HealthcheckHttpClient = (
  url: string,
  signal: AbortSignal,
) => Promise<{ status: number }>;

export type HealthcheckMode = "wait" | "single";

/**
 * Build the scope set for status-time healthcheck collection from the
 * currently observed Compose service snapshot. Status, CLI, and monitor call
 * sites pass this set into `runAppPortHealthchecks` / `waitingHealthcheckSnapshot`
 * so that selective generated-compose deployments do not produce phantom
 * healthcheck rows for configured app services that are absent from the
 * current deployed snapshot.
 */
export function deployedAppServiceNames(
  services: ReadonlyArray<ServiceStatus>,
): ReadonlySet<string> {
  return new Set(services.map((s) => s.service));
}

export interface RunAppPortHealthchecksOptions {
  config: WosConfig;
  services: ServiceStatus[];
  /** Test seam — defaults to `fetch`. */
  http?: HealthcheckHttpClient;
  /**
   * `"wait"` polls each enabled port until success or the configured
   * readiness settings are exhausted. `"single"` performs one bounded attempt.
   * Defaults to `"single"`.
   */
  mode?: HealthcheckMode;
  /**
   * Effective defaults for timing fields (`timeout`, `start_period`,
   * `interval`, `retries`) when the per-port spec omits them. Pass the result
   * of `effectiveHealthcheckDefaults(globalConfig)`; falls back to the
   * hardcoded constants when omitted.
   */
  defaults?: ResolvedHealthcheckDefaults;
  /**
   * Called once per wait-mode attempt with the URL probed and the outcome.
   * Use this to surface per-attempt progress in the UI so "stuck in waiting"
   * is diagnosable from stdout instead of guessing.
   */
  onAttempt?: (attempt: HealthcheckAttempt) => void;
  /** Time source for the wait loop (tests). */
  now?: () => number;
  /** Sleep helper for the wait loop (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Abort signal — when fired, the wait loop exits early. */
  signal?: AbortSignal;
  /**
   * When provided, healthchecks run only for services included in this set.
   * Used by selective `up` to skip healthchecks for services that were not
   * generated for this deployment. Undefined means "all configured services".
   */
  selectedServices?: ReadonlySet<string>;
}

export interface HealthcheckAttempt {
  service: string;
  containerPort: number;
  url: string;
  attempt: number;
  /** HTTP status when the request succeeded; `undefined` on transport error. */
  status?: number;
  /** Set when the attempt threw or timed out. */
  error?: string;
  /** `true` when the status matched `expectedStatus`. */
  matched: boolean;
}

/**
 * Per-HTTP-attempt cap for `mode: "single"` (status command and daemon
 * monitor). Stays short so periodic status snapshots don't block on slow
 * services. Wait-mode uses the configurable `requestTimeoutMs` instead.
 */
const SINGLE_ATTEMPT_TIMEOUT_MS = 2000;

export async function runAppPortHealthchecks(
  opts: RunAppPortHealthchecksOptions,
): Promise<AppPortHealthcheckResult[]> {
  const http = opts.http ?? defaultHealthcheckHttpClient;
  const mode: HealthcheckMode = opts.mode ?? "single";
  const defaults = opts.defaults ?? hardcodedHealthcheckDefaults();
  const now = opts.now ?? (() => Date.now());
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const statusByService = new Map<string, ServiceStatus>();
  for (const s of opts.services) statusByService.set(s.service, s);

  const targets: { service: string; port: AppPortSpec; mapping?: PortMapping }[] = [];
  const appServices = opts.config.app?.services ?? {};
  const selectedServices = opts.selectedServices;
  for (const service of sortedKeys(appServices)) {
    if (selectedServices && !selectedServices.has(service)) continue;
    const svc = appServices[service]!;
    const sorted = [...svc.ports].sort((a, b) => a.containerPort - b.containerPort);
    const status = statusByService.get(service);
    for (const port of sorted) {
      const mapping = status?.ports.find(
        (p) => p.containerPort === port.containerPort && p.hostPort !== undefined,
      );
      targets.push({ service, port, mapping });
    }
  }

  const results = await Promise.all(
    targets.map((t) =>
      checkOne(
        t.service,
        t.port,
        t.mapping,
        http,
        mode,
        defaults,
        now,
        sleep,
        opts.signal,
        opts.onAttempt,
      ),
    ),
  );
  return results;
}

async function checkOne(
  service: string,
  port: AppPortSpec,
  mapping: PortMapping | undefined,
  http: HealthcheckHttpClient,
  mode: HealthcheckMode,
  defaults: ResolvedHealthcheckDefaults,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  signal?: AbortSignal,
  onAttempt?: (attempt: HealthcheckAttempt) => void,
): Promise<AppPortHealthcheckResult> {
  if (port.healthcheck.enabled === false) {
    return {
      service,
      containerPort: port.containerPort,
      state: "disabled",
      enabled: false,
      allowFailure: port.allowFailure,
    };
  }
  const hc = port.healthcheck;
  const timing = healthcheckTiming(hc, defaults);
  if (!mapping || mapping.hostPort === undefined) {
    return failureResult(
      service,
      port,
      hc,
      timing,
      undefined,
      undefined,
      `no published host port for app.services.${service} container port ${port.containerPort}`,
    );
  }
  const host = hostLabelFromMapping(mapping);
  const url = `http://${host}:${mapping.hostPort}${hc.url}`;

  if (mode === "single") {
    return await singleAttempt(
      service,
      port,
      hc,
      timing,
      url,
      http,
      Math.min(SINGLE_ATTEMPT_TIMEOUT_MS, timing.timeoutMs),
    );
  }

  // wait mode: poll until success, total timeout, or post-start retries are exhausted
  const startedAt = now();
  const deadline = startedAt + timing.timeoutMs;
  let failedAttempts = 0;
  let attemptNumber = 0;
  let lastMessage: string | undefined;
  let lastObservedStatus: number | undefined;
  while (true) {
    if (signal?.aborted) break;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    const perAttempt = Math.min(timing.requestTimeoutMs, remaining);
    attemptNumber += 1;
    const attempt = await attemptOnce(url, http, perAttempt, signal);
    if (signal?.aborted) break;
    const matched =
      attempt.kind === "ok" && statusMatchesExpected(attempt.status, hc.expectedStatus);
    onAttempt?.({
      service,
      containerPort: port.containerPort,
      url,
      attempt: attemptNumber,
      status: attempt.kind === "ok" ? attempt.status : undefined,
      error: attempt.kind === "error" ? attempt.message : undefined,
      matched,
    });
    const elapsedAfterAttempt = now() - startedAt;
    if (matched && attempt.kind === "ok") {
      return {
        service,
        containerPort: port.containerPort,
        state: "healthy",
        enabled: true,
        allowFailure: port.allowFailure,
        url,
        expectedStatus: hc.expectedStatus,
        observedStatus: attempt.status,
        timeoutMs: timing.timeoutMs,
        startPeriodMs: timing.startPeriodMs,
        intervalMs: timing.intervalMs,
        retries: timing.retries,
      };
    }
    if (attempt.kind === "ok") {
      lastObservedStatus = attempt.status;
      lastMessage = describeStatusMismatch(hc.expectedStatus, attempt.status);
    } else {
      lastObservedStatus = undefined;
      lastMessage = attempt.message;
    }
    if (elapsedAfterAttempt >= timing.startPeriodMs) {
      failedAttempts += 1;
      if (failedAttempts >= timing.retries) break;
    }
    const remainingAfter = deadline - now();
    if (remainingAfter <= 0) break;
    await sleep(Math.min(timing.intervalMs, remainingAfter));
  }
  return failureResult(
    service,
    port,
    hc,
    timing,
    url,
    lastObservedStatus,
    lastMessage ?? `healthcheck did not become healthy within ${timing.timeoutMs}ms`,
  );
}

type AttemptOutcome =
  | { kind: "ok"; status: number }
  | { kind: "error"; message: string };

async function attemptOnce(
  url: string,
  http: HealthcheckHttpClient,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<AttemptOutcome> {
  if (signal?.aborted) return { kind: "error", message: "aborted" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const { status } = await http(url, controller.signal);
    return { kind: "ok", status };
  } catch (e) {
    if (signal?.aborted) return { kind: "error", message: "aborted" };
    const err = e as Error & { name?: string };
    const message =
      err.name === "AbortError" || /aborted|timeout/i.test(err.message ?? "")
        ? `healthcheck attempt timed out after ${timeoutMs}ms`
        : `healthcheck request failed: ${err.message ?? String(err)}`;
    return { kind: "error", message };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function singleAttempt(
  service: string,
  port: AppPortSpec,
  hc: Extract<AppPortSpec["healthcheck"], { enabled: true }>,
  timing: ResolvedHealthcheckDefaults,
  url: string,
  http: HealthcheckHttpClient,
  timeoutMs: number,
): Promise<AppPortHealthcheckResult> {
  const attempt = await attemptOnce(url, http, timeoutMs);
  if (attempt.kind === "ok" && statusMatchesExpected(attempt.status, hc.expectedStatus)) {
    return {
      service,
      containerPort: port.containerPort,
      state: "healthy",
      enabled: true,
      allowFailure: port.allowFailure,
      url,
      expectedStatus: hc.expectedStatus,
      observedStatus: attempt.status,
      timeoutMs: timing.timeoutMs,
      startPeriodMs: timing.startPeriodMs,
      intervalMs: timing.intervalMs,
      retries: timing.retries,
    };
  }
  if (attempt.kind === "ok") {
    return failureResult(
      service,
      port,
      hc,
      timing,
      url,
      attempt.status,
      describeStatusMismatch(hc.expectedStatus, attempt.status),
    );
  }
  return failureResult(service, port, hc, timing, url, undefined, attempt.message);
}

/**
 * Lenient by default: when the user did not pin `status:` in YAML, any
 * response below 500 counts as healthy ("service is responding"). When they
 * did pin a code, require exact equality.
 */
function statusMatchesExpected(observed: number, expected: number | undefined): boolean {
  if (expected === undefined) return observed < 500;
  return observed === expected;
}

function describeStatusMismatch(expected: number | undefined, observed: number): string {
  if (expected === undefined) return `expected HTTP <500, got ${observed}`;
  return `expected HTTP ${expected}, got ${observed}`;
}

function failureResult(
  service: string,
  port: AppPortSpec,
  hc: Extract<AppPortSpec["healthcheck"], { enabled: true }>,
  timing: ResolvedHealthcheckDefaults,
  url: string | undefined,
  observedStatus: number | undefined,
  message: string,
): AppPortHealthcheckResult {
  return {
    service,
    containerPort: port.containerPort,
    state: port.allowFailure ? "failed-allowed" : "failed",
    enabled: true,
    allowFailure: port.allowFailure,
    url,
    expectedStatus: hc.expectedStatus,
    observedStatus,
    timeoutMs: timing.timeoutMs,
    startPeriodMs: timing.startPeriodMs,
    intervalMs: timing.intervalMs,
    retries: timing.retries,
    message,
  };
}

export function waitingHealthcheckSnapshot(
  config: WosConfig,
  services: ServiceStatus[] = [],
  defaults?: ResolvedHealthcheckDefaults,
  selectedServices?: ReadonlySet<string>,
): AppPortHealthcheckResult[] {
  const effective = defaults ?? hardcodedHealthcheckDefaults();
  const out: AppPortHealthcheckResult[] = [];
  const statusByService = new Map<string, ServiceStatus>();
  for (const s of services) statusByService.set(s.service, s);
  const appServices = config.app?.services ?? {};
  for (const service of sortedKeys(appServices)) {
    if (selectedServices && !selectedServices.has(service)) continue;
    const svc = appServices[service]!;
    const sorted = [...svc.ports].sort((a, b) => a.containerPort - b.containerPort);
    const status = statusByService.get(service);
    for (const port of sorted) {
      if (port.healthcheck.enabled === false) {
        out.push({
          service,
          containerPort: port.containerPort,
          state: "disabled",
          enabled: false,
          allowFailure: port.allowFailure,
        });
        continue;
      }
      const hc = port.healthcheck;
      const timing = healthcheckTiming(hc, effective);
      const mapping = status?.ports.find(
        (p) => p.containerPort === port.containerPort && p.hostPort !== undefined,
      );
      const url =
        mapping && mapping.hostPort !== undefined
          ? `http://${hostLabelFromMapping(mapping)}:${mapping.hostPort}${hc.url}`
          : undefined;
      out.push({
        service,
        containerPort: port.containerPort,
        state: "waiting",
        enabled: true,
        allowFailure: port.allowFailure,
        url,
        expectedStatus: hc.expectedStatus,
        timeoutMs: timing.timeoutMs,
        startPeriodMs: timing.startPeriodMs,
        intervalMs: timing.intervalMs,
        retries: timing.retries,
      });
    }
  }
  return out;
}

function healthcheckTiming(
  hc: Extract<AppPortSpec["healthcheck"], { enabled: true }>,
  defaults: ResolvedHealthcheckDefaults,
): ResolvedHealthcheckDefaults {
  return {
    timeoutMs: hc.timeoutMs ?? defaults.timeoutMs,
    startPeriodMs: hc.startPeriodMs ?? defaults.startPeriodMs,
    intervalMs: hc.intervalMs ?? defaults.intervalMs,
    retries: hc.retries ?? defaults.retries,
    requestTimeoutMs: defaults.requestTimeoutMs,
  };
}

export const defaultHealthcheckHttpClient: HealthcheckHttpClient = async (
  url,
  signal,
) => {
  // Follow redirects so the check matches the *final* status. An app that
  // 302s `/` → `/login` would otherwise look broken to wos even though
  // curl reports it healthy.
  const response = await fetch(url, {
    method: "GET",
    signal,
    redirect: "follow",
  });
  return { status: response.status };
};

export function hasRequiredHealthcheckFailure(
  results: AppPortHealthcheckResult[],
): boolean {
  return results.some((r) => r.state === "failed");
}

export function summarizeHealthcheckFailures(
  results: AppPortHealthcheckResult[],
): string {
  const failed = results.filter((r) => r.state === "failed");
  if (failed.length === 0) return "";
  return failed
    .map((r) => {
      const where = r.url ? ` (${r.url})` : "";
      const reason = r.message ?? "healthcheck failed";
      return `app.services.${r.service}:${r.containerPort}${where} — ${reason}`;
    })
    .join("; ");
}

function sortedKeys<T>(obj: Record<string, T>): string[] {
  return Object.keys(obj).sort();
}
