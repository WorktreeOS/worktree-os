import type { AgentActivityBlock } from "./agent-activity";
import type {
  DeploymentEvent,
  DeploymentStepId,
  LogChannel,
  LogStream,
  StepState,
} from "./events";
import type { Notification } from "./notifications";

// ---------- Scope identifiers ----------

export interface UnifiedEventScope {
  projectId?: string;
  sessionName?: string;
  worktreePath?: string;
  operationId?: string;
}

// ---------- Project / worktree lifecycle ----------

export interface ProjectIdentity {
  projectId: string;
  name: string;
  sourcePath: string;
}

export interface WorktreeIdentity {
  sessionName: string;
  worktreePath: string;
  projectId?: string;
}

export type WorktreeDeploymentStatus =
  | "not_started"
  | "pending"
  | "checking"
  | "running"
  | "running_partial"
  | "failed"
  | "stopped"
  | "stopping"
  | "unknown";

/**
 * Aggregate managed service counts for a deployment. `running`/`total` and
 * `stopped`/`failed`/`checking` describe Compose-level state; healthcheck
 * outcomes drive the deployment status but do not change these counts.
 */
export interface ServiceSummary {
  total: number;
  running: number;
  stopped: number;
  failed: number;
  checking: number;
}

export type ProjectLifecycleEvent =
  | { type: "project.added"; project: ProjectIdentity }
  | { type: "project.updated"; project: ProjectIdentity }
  | { type: "project.removed"; projectId: string }
  | { type: "project.stale"; projectId: string; reason?: string }
  | { type: "project.recovered"; projectId: string };

export type WorktreeCheckoutMode = "detached" | "branch";

export interface CreatedManagedWorktree {
  projectId: string;
  sourcePath: string;
  worktreePath: string;
  name: string;
  mode: WorktreeCheckoutMode;
  branch?: string;
}

export type WorktreeLifecycleEvent =
  | { type: "worktree.added"; worktree: WorktreeIdentity }
  | { type: "worktree.removed"; sessionName: string }
  | { type: "worktree.updated"; worktree: WorktreeIdentity }
  | { type: "worktree.created"; worktree: CreatedManagedWorktree }
  | {
      type: "worktree.deployment-status.changed";
      sessionName: string;
      previous?: WorktreeDeploymentStatus;
      status: WorktreeDeploymentStatus;
      /** Aggregate managed service counts when known. */
      summary?: ServiceSummary;
      /** Previous service summary when known. */
      previousSummary?: ServiceSummary;
    };

// ---------- Operation lifecycle ----------

export type UnifiedOperationKind =
  | "up"
  | "down"
  | "status"
  | "service-stop"
  | "service-restart"
  | "worktree-remove"
  | "worktree-create";
export type UnifiedOperationStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "conflict";

export interface UnifiedOperationMetadata {
  operationId: string;
  kind: UnifiedOperationKind;
  sessionName: string;
  status: UnifiedOperationStatus;
  startedAt: string;
  finishedAt?: string;
  failureMessage?: string;
}

export type OperationLifecycleEvent =
  | { type: "operation.started"; operation: UnifiedOperationMetadata }
  | { type: "operation.finished"; operation: UnifiedOperationMetadata }
  | {
      type: "operation.failed";
      operation: UnifiedOperationMetadata;
      message: string;
    }
  | {
      type: "operation.conflict";
      kind: UnifiedOperationKind;
      sessionName: string;
      active: UnifiedOperationMetadata;
    };

// ---------- Deployment progress (bridged from DeploymentEvent) ----------

export type DeploymentProgressEvent =
  | {
      type: "deployment.step";
      sessionName: string;
      operationId: string;
      step: DeploymentStepId;
      state: StepState;
      message?: string;
    }
  | {
      type: "deployment.retry";
      sessionName: string;
      operationId: string;
      attempt: number;
      maxAttempts: number;
      reason: string;
    }
  | {
      /**
       * Transient per-poll healthcheck progress during the readiness-check
       * phase. Not reconcilable snapshot state — the UI shows the latest per
       * service while the step runs and clears it on completion.
       */
      type: "deployment.healthcheck-attempt";
      sessionName: string;
      operationId: string;
      service: string;
      containerPort: number;
      attempt: number;
      maxAttempts: number;
      url: string;
      status?: number;
      error?: string;
      matched: boolean;
    }
  | {
      type: "deployment.volume-clone";
      sessionName: string;
      operationId: string;
      phase: "start" | "complete";
      path: string;
      index: number;
      total: number;
    }
  | {
      type: "deployment.services-discovered";
      sessionName: string;
      operationId: string;
      services: string[];
      composeContext: { projectName: string; composeFile: string };
    }
  | {
      type: "deployment.completed";
      sessionName: string;
      operationId: string;
      lastUp: string;
    }
  | {
      type: "deployment.failed";
      sessionName: string;
      operationId: string;
      message: string;
    };

// ---------- Compose / service / healthcheck / tunnel ----------

export interface ComposeServiceSnapshot {
  service: string;
  state: string;
  status?: string;
}

export type ComposeStatusEvent = {
  type: "compose.status.changed";
  sessionName: string;
  previous?: ComposeServiceSnapshot[];
  current: ComposeServiceSnapshot[];
};

export type ServiceLifecycleEvent =
  | {
      type: "service.discovered";
      sessionName: string;
      service: string;
      state: string;
      status?: string;
    }
  | {
      type: "service.started";
      sessionName: string;
      service: string;
      state: string;
      status?: string;
    }
  | {
      type: "service.stopped";
      sessionName: string;
      service: string;
      state: string;
      status?: string;
    }
  | {
      type: "service.crashed";
      sessionName: string;
      service: string;
      state: string;
      status?: string;
    }
  | {
      type: "service.removed";
      sessionName: string;
      service: string;
    }
  | {
      type: "service.state.changed";
      sessionName: string;
      service: string;
      previous?: { state: string; status?: string };
      state: string;
      status?: string;
    };

export type HealthcheckEventState =
  | "healthy"
  | "failed"
  | "failed-allowed"
  | "disabled"
  | "waiting";

export type HealthcheckStatusEvent = {
  type: "healthcheck.changed";
  sessionName: string;
  service: string;
  containerPort: number;
  previous?: HealthcheckEventState;
  state: HealthcheckEventState;
  observedStatus?: number;
  expectedStatus?: number;
  url?: string;
  message?: string;
};

export type TunnelEventState = "active" | "failed" | "closed";

export type TunnelLifecycleEvent =
  | {
      type: "tunnel.opened";
      sessionName: string;
      service: string;
      containerPort: number;
      hostPort: number;
      url: string;
      hostname: string;
    }
  | {
      type: "tunnel.failed";
      sessionName: string;
      service: string;
      containerPort: number;
      hostPort: number;
      message: string;
    }
  | {
      type: "tunnel.closed";
      sessionName: string;
      service: string;
      containerPort: number;
    }
  | {
      type: "tunnel.reset";
      sessionName: string;
    }
  | {
      type: "tunnel.dropped";
      sessionName: string;
    };

// ---------- Log appended ----------

export type LogAppendedEvent = {
  type: "log.appended";
  sessionName: string;
  channel: LogChannel;
  stream: LogStream;
  chunk: string;
};

// ---------- Terminal sessions ----------

export type TerminalSessionLifecycleEvent =
  | {
      type: "terminal.started";
      terminal: {
        id: string;
        worktreePath: string;
        status: "running" | "exited";
        createdAt: string;
        cols?: number;
        rows?: number;
      };
    }
  | {
      type: "terminal.attached";
      terminal: {
        id: string;
        worktreePath: string;
        attachmentId?: string;
        attachmentCount?: number;
      };
    }
  | {
      type: "terminal.detached";
      terminal: {
        id: string;
        worktreePath: string;
        attachmentId?: string;
        attachmentCount?: number;
      };
    }
  | {
      type: "terminal.control-changed";
      terminal: {
        id: string;
        worktreePath: string;
        controllerAttachmentId: string | null;
        changedAt: string;
      };
    }
  | {
      type: "terminal.updated";
      terminal: {
        id: string;
        worktreePath: string;
        changedAt: string;
        /** Current title when one is set; omitted when the title was cleared. */
        title?: string;
      };
    }
  | {
      type: "terminal.exited";
      terminal: {
        id: string;
        worktreePath: string;
        exitedAt: string;
        exitCode?: number;
        signal?: number;
      };
    }
  | {
      type: "terminal.removed";
      terminal: { id: string; worktreePath: string };
    };

// ---------- Agent activity ----------

/**
 * Published when an ingested agent activity event changes a session's
 * derived activity state. Self-contained so subscribers (including the
 * future notification engine) can render it without additional lookups.
 * Emitted at most once per ingested `source.eventId`.
 */
export type AgentActivityChangedEvent = {
  type: "agent.activity.changed";
  /** Terminal session the activity is bound to, when resolved. */
  terminalSessionId?: string;
  worktreePath: string;
  /** Derived activity block after applying the event. */
  activity: AgentActivityBlock;
  /** Originating plugin event, abridged. */
  source: {
    eventId: string;
    agent: string;
    event: string;
    severity: "info" | "needs-attention";
    summary?: string;
  };
};

// ---------- Notifications ----------

/**
 * Published by the notification engine when it renders a notification for a
 * matching, non-suppressed, non-duplicate source event. Carries the rendered,
 * channel-agnostic notification so subscribers (delivery channels, the open web
 * client, a future inbox) render it without additional lookups.
 */
export type NotificationRaisedEvent = {
  type: "notification.raised";
  notification: Notification;
};

// ---------- Workflow status / board / comments ----------

/**
 * Snapshot-reconcilable hints for the Kanban board and worktree dossier. The
 * payloads carry only identity so clients refetch the affected snapshot (the
 * status catalog, the project list, or a worktree's comments) rather than
 * embedding full state.
 */
export type WorktreeBoardEvent =
  | {
      /** The global workflow status catalog was created/updated/reordered or had a status deleted. */
      type: "status.catalog.changed";
    }
  | {
      /** A worktree's workflow status assignment or order changed. */
      type: "worktree.board.changed";
      worktreePath: string;
      /** New status id, or null when the worktree became unassigned. */
      statusId: string | null;
      /** New within-status order; omitted when unassigned. */
      order?: number;
    }
  | {
      /** A worktree comment was added or removed. */
      type: "worktree.comment.changed";
      worktreePath: string;
    };

// ---------- Certificate lifecycle ----------

export type CertificateListenerKind = "web" | "tunnel";
export type CertificateSourceType = "files" | "self-signed" | "letsencrypt";
export type CertificateLifecycleState =
  | "issued"
  | "renewed"
  | "activated"
  | "failed";

export type CertificateLifecycleEvent =
  | {
      type: "certificate.issued";
      listenerKind: CertificateListenerKind;
      source: CertificateSourceType;
      hostnames: string[];
      notAfter?: string;
    }
  | {
      type: "certificate.renewed";
      listenerKind: CertificateListenerKind;
      source: CertificateSourceType;
      hostnames: string[];
      notAfter?: string;
    }
  | {
      type: "certificate.activated";
      listenerKind: CertificateListenerKind;
      source: CertificateSourceType;
      activatedAt: string;
    }
  | {
      type: "certificate.failed";
      listenerKind: CertificateListenerKind;
      source: CertificateSourceType;
      phase: string;
      message: string;
    };

// ---------- Union of all payloads ----------

export type UnifiedEventPayload =
  | ProjectLifecycleEvent
  | WorktreeLifecycleEvent
  | OperationLifecycleEvent
  | DeploymentProgressEvent
  | ComposeStatusEvent
  | ServiceLifecycleEvent
  | HealthcheckStatusEvent
  | TunnelLifecycleEvent
  | LogAppendedEvent
  | TerminalSessionLifecycleEvent
  | AgentActivityChangedEvent
  | NotificationRaisedEvent
  | WorktreeBoardEvent
  | CertificateLifecycleEvent;

export type UnifiedEventType = UnifiedEventPayload["type"];

export interface UnifiedEventEnvelope<
  P extends UnifiedEventPayload = UnifiedEventPayload,
> {
  id: number;
  timestamp: string;
  type: P["type"];
  projectId?: string;
  sessionName?: string;
  worktreePath?: string;
  operationId?: string;
  event: P;
}

// ---------- DeploymentEvent bridge helpers ----------

/**
 * Convert a legacy operation-scoped `DeploymentEvent` into one or more
 * unified payloads. Returns an empty array for events that have no unified
 * equivalent.
 */
export function deploymentEventToUnified(
  sessionName: string,
  operationId: string,
  event: DeploymentEvent,
): UnifiedEventPayload[] {
  switch (event.type) {
    case "step":
      return [
        {
          type: "deployment.step",
          sessionName,
          operationId,
          step: event.id,
          state: event.state,
          message: event.message,
        },
      ];
    case "log":
      return [
        {
          type: "log.appended",
          sessionName,
          channel: event.channel,
          stream: event.stream,
          chunk: event.chunk,
        },
      ];
    case "services-discovered":
      return [
        {
          type: "deployment.services-discovered",
          sessionName,
          operationId,
          services: event.services,
          composeContext: event.composeContext,
        },
      ];
    case "volume-clone":
      return [
        {
          type: "deployment.volume-clone",
          sessionName,
          operationId,
          phase: event.phase,
          path: event.path,
          index: event.index,
          total: event.total,
        },
      ];
    case "retry":
      return [
        {
          type: "deployment.retry",
          sessionName,
          operationId,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          reason: event.reason,
        },
      ];
    case "healthcheck-attempt":
      return [
        {
          type: "deployment.healthcheck-attempt",
          sessionName,
          operationId,
          service: event.service,
          containerPort: event.containerPort,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          url: event.url,
          status: event.status,
          error: event.error,
          matched: event.matched,
        },
      ];
    case "complete":
      return [
        {
          type: "deployment.completed",
          sessionName,
          operationId,
          lastUp: event.lastUp,
        },
      ];
    case "failure":
      return [
        {
          type: "deployment.failed",
          sessionName,
          operationId,
          message: event.message,
        },
      ];
  }
}
