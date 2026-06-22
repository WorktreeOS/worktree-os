import type { DeploymentEvent, DeploymentObserver } from "@worktreeos/core/events";
import {
  deploymentEventToUnified,
  type UnifiedEventPayload,
  type UnifiedOperationKind,
  type UnifiedOperationMetadata,
  type UnifiedOperationStatus,
  type WorktreeDeploymentStatus,
} from "@worktreeos/core/unified-events";
import type { DaemonEventBus } from "./event-bus";
import type { OperationMetadata } from "./daemon-protocol";
import type { OperationRecord } from "./operation-registry";
import type { ProjectRecord } from "@worktreeos/core/project-registry";
import type {
  ActiveTunnelSnapshot,
  FailedTunnelSnapshot,
  TunnelEventPublisher,
} from "@worktreeos/runtime/tunnel-registry";
import type { CreatedManagedWorktree } from "@worktreeos/core/unified-events";

export interface OperationScope {
  operationId: string;
  sessionName: string;
  worktreePath?: string;
}

function toUnifiedMeta(
  record: OperationRecord | OperationMetadata,
): UnifiedOperationMetadata {
  return {
    operationId: record.operationId,
    kind: record.kind as UnifiedOperationKind,
    sessionName: record.sessionName,
    status: record.status as UnifiedOperationStatus,
    startedAt: record.startedAt,
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    ...(record.failureMessage ? { failureMessage: record.failureMessage } : {}),
  };
}

export function publishOperationStarted(
  events: DaemonEventBus | undefined,
  record: OperationRecord,
  worktreePath?: string,
): void {
  if (!events) return;
  events.publish(
    { type: "operation.started", operation: toUnifiedMeta(record) },
    {
      operationId: record.operationId,
      sessionName: record.sessionName,
      worktreePath,
    },
  );
}

/**
 * Publish a worktree deployment status transition. Used by the daemon to
 * surface pending state for an `up` operation before the session monitor
 * (which only starts after service discovery) can emit its own transitions.
 */
export function publishWorktreeStatusChanged(
  events: DaemonEventBus | undefined,
  sessionName: string,
  status: WorktreeDeploymentStatus,
  scope: { operationId?: string; worktreePath?: string } = {},
): void {
  if (!events) return;
  events.publish(
    { type: "worktree.deployment-status.changed", sessionName, status },
    {
      sessionName,
      ...(scope.operationId ? { operationId: scope.operationId } : {}),
      ...(scope.worktreePath ? { worktreePath: scope.worktreePath } : {}),
    },
  );
}

export function publishOperationFinished(
  events: DaemonEventBus | undefined,
  record: OperationRecord,
  worktreePath?: string,
): void {
  if (!events) return;
  const meta = toUnifiedMeta(record);
  if (record.status === "failed") {
    events.publish(
      {
        type: "operation.failed",
        operation: meta,
        message: record.failureMessage ?? "",
      },
      {
        operationId: record.operationId,
        sessionName: record.sessionName,
        worktreePath,
      },
    );
    return;
  }
  events.publish(
    { type: "operation.finished", operation: meta },
    {
      operationId: record.operationId,
      sessionName: record.sessionName,
      worktreePath,
    },
  );
}

export function publishOperationConflict(
  events: DaemonEventBus | undefined,
  kind: UnifiedOperationKind,
  sessionName: string,
  active: OperationMetadata,
  worktreePath?: string,
): void {
  if (!events) return;
  events.publish(
    {
      type: "operation.conflict",
      kind,
      sessionName,
      active: toUnifiedMeta(active),
    },
    { sessionName, worktreePath },
  );
}

export function publishWorktreeUpdated(
  events: DaemonEventBus | undefined,
  identity: { sessionName: string; worktreePath: string; projectId?: string },
): void {
  if (!events) return;
  events.publish(
    { type: "worktree.updated", worktree: identity },
    {
      sessionName: identity.sessionName,
      worktreePath: identity.worktreePath,
      ...(identity.projectId ? { projectId: identity.projectId } : {}),
    },
  );
}

/** Publish that the global workflow status catalog changed (snapshot hint). */
export function publishStatusCatalogChanged(
  events: DaemonEventBus | undefined,
): void {
  if (!events) return;
  events.publish({ type: "status.catalog.changed" }, {});
}

/** Publish a worktree's workflow status assignment / order change. */
export function publishWorktreeBoardChanged(
  events: DaemonEventBus | undefined,
  worktreePath: string,
  statusId: string | null,
  order?: number,
): void {
  if (!events) return;
  events.publish(
    {
      type: "worktree.board.changed",
      worktreePath,
      statusId,
      ...(order !== undefined ? { order } : {}),
    },
    { worktreePath },
  );
}

/** Publish that a worktree's comments changed (added/removed) — refetch hint. */
export function publishWorktreeCommentChanged(
  events: DaemonEventBus | undefined,
  worktreePath: string,
): void {
  if (!events) return;
  events.publish(
    { type: "worktree.comment.changed", worktreePath },
    { worktreePath },
  );
}

export function publishWorktreeRemoved(
  events: DaemonEventBus | undefined,
  sessionName: string,
  worktreePath?: string,
): void {
  if (!events) return;
  events.publish(
    { type: "worktree.removed", sessionName },
    {
      sessionName,
      ...(worktreePath ? { worktreePath } : {}),
    },
  );
}

export function publishWorktreeCreated(
  events: DaemonEventBus | undefined,
  worktree: CreatedManagedWorktree,
  scope: { sessionName?: string; operationId?: string } = {},
): void {
  if (!events) return;
  events.publish(
    { type: "worktree.created", worktree },
    {
      worktreePath: worktree.worktreePath,
      projectId: worktree.projectId,
      ...(scope.sessionName ? { sessionName: scope.sessionName } : {}),
      ...(scope.operationId ? { operationId: scope.operationId } : {}),
    },
  );
}

export function publishProjectAdded(
  events: DaemonEventBus | undefined,
  record: ProjectRecord,
): void {
  if (!events) return;
  events.publish(
    {
      type: "project.added",
      project: {
        projectId: record.id,
        name: record.displayName,
        sourcePath: record.sourcePath,
      },
    },
    { projectId: record.id },
  );
}

export function publishProjectUpdated(
  events: DaemonEventBus | undefined,
  record: ProjectRecord,
): void {
  if (!events) return;
  events.publish(
    {
      type: "project.updated",
      project: {
        projectId: record.id,
        name: record.displayName,
        sourcePath: record.sourcePath,
      },
    },
    { projectId: record.id },
  );
}

/**
 * Wrap a base `DeploymentObserver` so that every emitted event is also
 * mirrored as one or more unified events on the bus. The returned observer
 * still forwards the original event to `base`, preserving operation NDJSON
 * stream behavior for legacy clients.
 */
export function wrapObserverWithUnified(
  base: DeploymentObserver,
  events: DaemonEventBus | undefined,
  scope: OperationScope,
): DeploymentObserver {
  if (!events) return base;
  return {
    emit(event: DeploymentEvent) {
      base.emit(event);
      const unified = deploymentEventToUnified(
        scope.sessionName,
        scope.operationId,
        event,
      );
      for (const payload of unified) {
        publishUnified(events, payload, scope);
      }
    },
  };
}

function publishUnified(
  events: DaemonEventBus,
  payload: UnifiedEventPayload,
  scope: OperationScope,
): void {
  events.publish(payload, {
    operationId: scope.operationId,
    sessionName: scope.sessionName,
    worktreePath: scope.worktreePath,
  });
}

/** Build a tunnel event publisher backed by the unified event bus. */
export function createTunnelEventPublisher(
  events: DaemonEventBus,
): TunnelEventPublisher {
  return {
    publishOpened(sessionName: string, snapshot: ActiveTunnelSnapshot) {
      events.publish(
        {
          type: "tunnel.opened",
          sessionName,
          service: snapshot.service,
          containerPort: snapshot.containerPort,
          hostPort: snapshot.hostPort,
          url: snapshot.url,
          hostname: snapshot.hostname,
        },
        { sessionName },
      );
    },
    publishFailed(sessionName: string, snapshot: FailedTunnelSnapshot) {
      events.publish(
        {
          type: "tunnel.failed",
          sessionName,
          service: snapshot.service,
          containerPort: snapshot.containerPort,
          hostPort: snapshot.hostPort,
          message: snapshot.message,
        },
        { sessionName },
      );
    },
    publishClosed(
      sessionName: string,
      args: { service: string; containerPort: number },
    ) {
      events.publish(
        {
          type: "tunnel.closed",
          sessionName,
          service: args.service,
          containerPort: args.containerPort,
        },
        { sessionName },
      );
    },
    publishReset(sessionName: string) {
      events.publish({ type: "tunnel.reset", sessionName }, { sessionName });
    },
    publishDropped(sessionName: string) {
      events.publish({ type: "tunnel.dropped", sessionName }, { sessionName });
    },
  };
}

export interface CertificateEventPublisher {
  publishIssued(args: {
    listenerKind: "web" | "tunnel";
    source: "files" | "self-signed" | "letsencrypt";
    hostnames: string[];
    notAfter?: string;
  }): void;
  publishRenewed(args: {
    listenerKind: "web" | "tunnel";
    source: "files" | "self-signed" | "letsencrypt";
    hostnames: string[];
    notAfter?: string;
  }): void;
  publishActivated(args: {
    listenerKind: "web" | "tunnel";
    source: "files" | "self-signed" | "letsencrypt";
    activatedAt: string;
  }): void;
  publishFailed(args: {
    listenerKind: "web" | "tunnel";
    source: "files" | "self-signed" | "letsencrypt";
    phase: string;
    message: string;
  }): void;
}

export function createCertificateEventPublisher(
  events: DaemonEventBus,
): CertificateEventPublisher {
  return {
    publishIssued(a) {
      events.publish({
        type: "certificate.issued",
        listenerKind: a.listenerKind,
        source: a.source,
        hostnames: a.hostnames,
        ...(a.notAfter ? { notAfter: a.notAfter } : {}),
      });
    },
    publishRenewed(a) {
      events.publish({
        type: "certificate.renewed",
        listenerKind: a.listenerKind,
        source: a.source,
        hostnames: a.hostnames,
        ...(a.notAfter ? { notAfter: a.notAfter } : {}),
      });
    },
    publishActivated(a) {
      events.publish({
        type: "certificate.activated",
        listenerKind: a.listenerKind,
        source: a.source,
        activatedAt: a.activatedAt,
      });
    },
    publishFailed(a) {
      events.publish({
        type: "certificate.failed",
        listenerKind: a.listenerKind,
        source: a.source,
        phase: a.phase,
        message: a.message,
      });
    },
  };
}
