import type { DaemonEventBus } from "./event-bus";
import type {
  ComposeServiceSnapshot,
  HealthcheckEventState,
  ServiceLifecycleEvent,
  ServiceSummary,
  WorktreeDeploymentStatus,
} from "@worktreeos/core/unified-events";
import {
  classifyDeploymentStatus,
  serviceSummaryEqual,
} from "@worktreeos/core/deployment-status";

export interface MonitorSnapshot {
  compose: ComposeServiceSnapshot[];
  healthchecks: Array<{
    service: string;
    containerPort: number;
    state: HealthcheckEventState;
    observedStatus?: number;
    expectedStatus?: number;
    url?: string;
    message?: string;
  }>;
  tunnels: Array<
    | {
        service: string;
        containerPort: number;
        hostPort: number;
        state: "active";
        url: string;
        hostname: string;
      }
    | {
        service: string;
        containerPort: number;
        hostPort: number;
        state: "failed";
        message: string;
      }
  >;
}

export interface SnapshotCollector {
  collect(): Promise<MonitorSnapshot>;
}

export interface SessionMonitorOptions {
  intervalMs?: number;
  /** Override the timer source (tests). */
  schedule?: (cb: () => void, ms: number) => { cancel(): void };
}

interface SessionMonitor {
  sessionName: string;
  worktreePath?: string;
  collector: SnapshotCollector;
  previous?: MonitorSnapshot;
  /** Last published aggregate status; undefined until first transition. */
  lastStatus?: WorktreeDeploymentStatus;
  /** Last published aggregate service summary. */
  lastSummary?: ServiceSummary;
  timer: { cancel(): void } | null;
  stopped: boolean;
}

const DEFAULT_INTERVAL_MS = 5000;

const FAILURE_STATES = new Set([
  "exited",
  "dead",
  "failed",
  "error",
  "fatal",
]);

const STOPPED_STATES = new Set(["stopped", "removed", "paused"]);

function defaultSchedule(cb: () => void, ms: number): { cancel(): void } {
  const handle = setInterval(cb, ms);
  return { cancel: () => clearInterval(handle) };
}

/**
 * Daemon-owned registry of session monitors. Each monitor periodically
 * collects compose/healthcheck/tunnel snapshots and emits unified events for
 * observed transitions. Errors during snapshot collection are isolated and
 * do not stop the monitor or the daemon.
 */
export class SessionMonitorRegistry {
  private readonly monitors = new Map<string, SessionMonitor>();
  private readonly intervalMs: number;
  private readonly schedule: (
    cb: () => void,
    ms: number,
  ) => { cancel(): void };

  constructor(
    private readonly events: DaemonEventBus,
    opts: SessionMonitorOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.schedule = opts.schedule ?? defaultSchedule;
  }

  /**
   * Start or refresh a monitor for `sessionName`. Replaces the collector
   * implementation when the session is already monitored.
   */
  start(
    sessionName: string,
    collector: SnapshotCollector,
    worktreePath?: string,
  ): void {
    const existing = this.monitors.get(sessionName);
    if (existing) {
      existing.collector = collector;
      if (worktreePath !== undefined) existing.worktreePath = worktreePath;
      return;
    }
    const monitor: SessionMonitor = {
      sessionName,
      worktreePath,
      collector,
      previous: undefined,
      timer: null,
      stopped: false,
    };
    this.monitors.set(sessionName, monitor);
    monitor.timer = this.schedule(() => {
      void this.tick(monitor);
    }, this.intervalMs);
  }

  /** Stop monitoring `sessionName`. Safe to call when there is no monitor. */
  stop(sessionName: string): void {
    const monitor = this.monitors.get(sessionName);
    if (!monitor) return;
    monitor.stopped = true;
    monitor.timer?.cancel();
    this.monitors.delete(sessionName);
  }

  /** Drop every monitor. Used at daemon shutdown. */
  shutdown(): void {
    for (const monitor of this.monitors.values()) {
      monitor.stopped = true;
      monitor.timer?.cancel();
    }
    this.monitors.clear();
  }

  /** Force one collection cycle now (tests). */
  async tickNow(sessionName: string): Promise<void> {
    const monitor = this.monitors.get(sessionName);
    if (!monitor) return;
    await this.tick(monitor);
  }

  has(sessionName: string): boolean {
    return this.monitors.has(sessionName);
  }

  size(): number {
    return this.monitors.size;
  }

  private async tick(monitor: SessionMonitor): Promise<void> {
    if (monitor.stopped) return;
    let snapshot: MonitorSnapshot;
    try {
      snapshot = await monitor.collector.collect();
    } catch {
      // Snapshot collection failure must not terminate the monitor.
      return;
    }
    if (monitor.stopped) return;
    if (!monitor.previous) {
      monitor.previous = snapshot;
      // Establish initial aggregate status without publishing.
      const initial = computeAggregate(snapshot);
      monitor.lastStatus = initial.status;
      monitor.lastSummary = initial.summary;
      return;
    }
    this.diffCompose(monitor, snapshot);
    this.diffHealthchecks(monitor, snapshot);
    this.diffTunnels(monitor, snapshot);
    this.diffDeploymentStatus(monitor, snapshot);
    monitor.previous = snapshot;
  }

  private diffCompose(monitor: SessionMonitor, next: MonitorSnapshot): void {
    const prev = monitor.previous!.compose;
    const prevMap = new Map(prev.map((s) => [s.service, s]));
    const nextMap = new Map(next.compose.map((s) => [s.service, s]));

    // Emit compose.status.changed when the normalized snapshot differs.
    if (!sameComposeList(prev, next.compose)) {
      this.events.publish(
        {
          type: "compose.status.changed",
          sessionName: monitor.sessionName,
          previous: prev,
          current: next.compose,
        },
        {
          sessionName: monitor.sessionName,
          worktreePath: monitor.worktreePath,
        },
      );
    }

    for (const [service, current] of nextMap) {
      const previous = prevMap.get(service);
      if (!previous) {
        this.publishServiceEvent(monitor, {
          type: "service.discovered",
          sessionName: monitor.sessionName,
          service,
          state: current.state,
          status: current.status,
        });
        continue;
      }
      if (
        previous.state === current.state &&
        previous.status === current.status
      ) {
        continue;
      }
      const event = classifyServiceTransition(
        monitor.sessionName,
        service,
        previous,
        current,
      );
      this.publishServiceEvent(monitor, event);
    }
    for (const [service, previous] of prevMap) {
      if (!nextMap.has(service)) {
        this.publishServiceEvent(monitor, {
          type: "service.removed",
          sessionName: monitor.sessionName,
          service,
        });
        void previous;
      }
    }
  }

  private diffHealthchecks(
    monitor: SessionMonitor,
    next: MonitorSnapshot,
  ): void {
    const prev = monitor.previous!.healthchecks;
    const prevMap = new Map(
      prev.map((h) => [healthKey(h.service, h.containerPort), h]),
    );
    for (const current of next.healthchecks) {
      const previous = prevMap.get(
        healthKey(current.service, current.containerPort),
      );
      if (previous && previous.state === current.state) continue;
      this.events.publish(
        {
          type: "healthcheck.changed",
          sessionName: monitor.sessionName,
          service: current.service,
          containerPort: current.containerPort,
          previous: previous?.state,
          state: current.state,
          observedStatus: current.observedStatus,
          expectedStatus: current.expectedStatus,
          url: current.url,
          message: current.message,
        },
        {
          sessionName: monitor.sessionName,
          worktreePath: monitor.worktreePath,
        },
      );
    }
  }

  private diffTunnels(monitor: SessionMonitor, next: MonitorSnapshot): void {
    const prev = monitor.previous!.tunnels;
    const prevMap = new Map(
      prev.map((t) => [healthKey(t.service, t.containerPort), t]),
    );
    const nextMap = new Map(
      next.tunnels.map((t) => [healthKey(t.service, t.containerPort), t]),
    );
    for (const [key, current] of nextMap) {
      const previous = prevMap.get(key);
      if (!previous) {
        if (current.state === "active") {
          this.events.publish(
            {
              type: "tunnel.opened",
              sessionName: monitor.sessionName,
              service: current.service,
              containerPort: current.containerPort,
              hostPort: current.hostPort,
              url: current.url,
              hostname: current.hostname,
            },
            { sessionName: monitor.sessionName },
          );
        } else {
          this.events.publish(
            {
              type: "tunnel.failed",
              sessionName: monitor.sessionName,
              service: current.service,
              containerPort: current.containerPort,
              hostPort: current.hostPort,
              message: current.message,
            },
            { sessionName: monitor.sessionName },
          );
        }
        continue;
      }
      if (previous.state !== current.state) {
        if (current.state === "active") {
          this.events.publish(
            {
              type: "tunnel.opened",
              sessionName: monitor.sessionName,
              service: current.service,
              containerPort: current.containerPort,
              hostPort: current.hostPort,
              url: current.url,
              hostname: current.hostname,
            },
            { sessionName: monitor.sessionName },
          );
        } else {
          this.events.publish(
            {
              type: "tunnel.failed",
              sessionName: monitor.sessionName,
              service: current.service,
              containerPort: current.containerPort,
              hostPort: current.hostPort,
              message: current.message,
            },
            { sessionName: monitor.sessionName },
          );
        }
      }
    }
    for (const [key, previous] of prevMap) {
      if (!nextMap.has(key)) {
        this.events.publish(
          {
            type: "tunnel.closed",
            sessionName: monitor.sessionName,
            service: previous.service,
            containerPort: previous.containerPort,
          },
          { sessionName: monitor.sessionName },
        );
      }
    }
  }

  private diffDeploymentStatus(
    monitor: SessionMonitor,
    next: MonitorSnapshot,
  ): void {
    const aggregate = computeAggregate(next);
    const prevStatus = monitor.lastStatus;
    const prevSummary = monitor.lastSummary;
    const statusChanged = prevStatus !== aggregate.status;
    const summaryChanged = !serviceSummaryEqual(prevSummary, aggregate.summary);
    if (!statusChanged && !summaryChanged) return;
    this.events.publish(
      {
        type: "worktree.deployment-status.changed",
        sessionName: monitor.sessionName,
        ...(prevStatus !== undefined ? { previous: prevStatus } : {}),
        status: aggregate.status,
        ...(aggregate.summary ? { summary: aggregate.summary } : {}),
        ...(prevSummary ? { previousSummary: prevSummary } : {}),
      },
      {
        sessionName: monitor.sessionName,
        worktreePath: monitor.worktreePath,
      },
    );
    monitor.lastStatus = aggregate.status;
    monitor.lastSummary = aggregate.summary;
  }

  private publishServiceEvent(
    monitor: SessionMonitor,
    event: ServiceLifecycleEvent,
  ): void {
    this.events.publish(event, {
      sessionName: monitor.sessionName,
      worktreePath: monitor.worktreePath,
    });
  }
}

function sameComposeList(
  a: ComposeServiceSnapshot[],
  b: ComposeServiceSnapshot[],
): boolean {
  if (a.length !== b.length) return false;
  const byName = new Map(a.map((s) => [s.service, s]));
  for (const s of b) {
    const prev = byName.get(s.service);
    if (!prev) return false;
    if (prev.state !== s.state || prev.status !== s.status) return false;
  }
  return true;
}

function classifyServiceTransition(
  sessionName: string,
  service: string,
  previous: ComposeServiceSnapshot,
  current: ComposeServiceSnapshot,
): ServiceLifecycleEvent {
  const prevState = previous.state.toLowerCase();
  const nextState = current.state.toLowerCase();
  if (
    prevState === "running" &&
    (FAILURE_STATES.has(nextState) || nextState === "restarting")
  ) {
    return {
      type: "service.crashed",
      sessionName,
      service,
      state: current.state,
      status: current.status,
    };
  }
  if (prevState !== "running" && nextState === "running") {
    return {
      type: "service.started",
      sessionName,
      service,
      state: current.state,
      status: current.status,
    };
  }
  if (prevState === "running" && STOPPED_STATES.has(nextState)) {
    return {
      type: "service.stopped",
      sessionName,
      service,
      state: current.state,
      status: current.status,
    };
  }
  return {
    type: "service.state.changed",
    sessionName,
    service,
    previous: { state: previous.state, status: previous.status },
    state: current.state,
    status: current.status,
  };
}

function computeAggregate(snapshot: MonitorSnapshot): {
  status: WorktreeDeploymentStatus;
  summary?: ServiceSummary;
} {
  // The monitor only runs for initialized sessions, so the classifier always
  // receives `initialized: true`. Snapshots collected by the runtime collector
  // already filter out the internal init service.
  return classifyDeploymentStatus({
    initialized: true,
    collection: {
      kind: "ok",
      services: snapshot.compose.map((s) => ({ state: s.state })),
      healthchecks: snapshot.healthchecks.map((h) => ({ state: h.state })),
    },
  });
}

function healthKey(service: string, port: number): string {
  return `${service}:${port}`;
}
