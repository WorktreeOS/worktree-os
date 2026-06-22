// Browser-local mirror of the daemon's unified event types. Kept in sync by
// hand so the web bundle does not need to import node-only packages.

import type { LogStream } from "./events";

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

export interface ServiceSummary {
  total: number;
  running: number;
  stopped: number;
  failed: number;
  checking: number;
}

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

export type DeploymentStepId =
  | "prepare"
  | "release-ports"
  | "first-run-setup"
  | "init-script"
  | "compose-up"
  | "status"
  | "healthcheck";

export type StepState = "pending" | "running" | "done" | "failed";

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
      summary?: ServiceSummary;
      previousSummary?: ServiceSummary;
    };

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
  | { type: "service.removed"; sessionName: string; service: string }
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
  | { type: "tunnel.reset"; sessionName: string }
  | { type: "tunnel.dropped"; sessionName: string };

export type LogAppendedEvent = {
  type: "log.appended";
  sessionName: string;
  channel: string;
  stream: LogStream;
  chunk: string;
};

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

export type WorktreeBoardEvent =
  | { type: "status.catalog.changed" }
  | {
      type: "worktree.board.changed";
      worktreePath: string;
      statusId: string | null;
      order?: number;
    }
  | { type: "worktree.comment.changed"; worktreePath: string };

/** Channel-agnostic notification carried by `notification.raised`. */
export interface WebNotification {
  kind: string;
  title: string;
  body: string;
  severity: "info" | "needs-attention";
  link: string;
  dedupeKey: string;
  worktreePath?: string;
  terminalSessionId?: string;
}

export type NotificationRaisedEvent = {
  type: "notification.raised";
  notification: WebNotification;
};

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
  | NotificationRaisedEvent
  | WorktreeBoardEvent;

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
