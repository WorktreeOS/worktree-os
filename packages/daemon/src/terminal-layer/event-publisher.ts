/**
 * Bridge between terminal-layer actor lifecycle events and the daemon's
 * unified event bus.
 *
 * Lifecycle events are reconciliation hints only. They carry session id,
 * worktree path, and minimal change context — never raw PTY output or replay
 * payloads. Clients receiving a terminal lifecycle event are expected to
 * refresh the snapshot API for authoritative state.
 */

import type { DaemonEventBus } from "../event-bus";
import type { TerminalLifecycleEvent } from "./actor";

export function publishTerminalLifecycle(
  events: DaemonEventBus | undefined,
  event: TerminalLifecycleEvent,
): void {
  if (!events) return;
  const meta = event.metadata;
  switch (event.type) {
    case "created":
    case "running":
      events.publish(
        {
          type: "terminal.started",
          terminal: {
            id: meta.id,
            worktreePath: meta.worktreePath,
            status: meta.status === "running" ? "running" : "exited",
            createdAt: meta.createdAt,
            cols: meta.cols,
            rows: meta.rows,
          },
        },
        { worktreePath: meta.worktreePath },
      );
      return;
    case "attached":
      events.publish(
        {
          type: "terminal.attached",
          terminal: {
            id: meta.id,
            worktreePath: meta.worktreePath,
            attachmentId: event.attachment.attachmentId,
            attachmentCount: meta.attachments?.length ?? 0,
          },
        },
        { worktreePath: meta.worktreePath },
      );
      return;
    case "detached":
      events.publish(
        {
          type: "terminal.detached",
          terminal: {
            id: meta.id,
            worktreePath: meta.worktreePath,
            attachmentId: event.attachmentId,
            attachmentCount: meta.attachments?.length ?? 0,
          },
        },
        { worktreePath: meta.worktreePath },
      );
      return;
    case "control-changed":
      events.publish(
        {
          type: "terminal.control-changed",
          terminal: {
            id: meta.id,
            worktreePath: meta.worktreePath,
            controllerAttachmentId: event.control.controllerAttachmentId,
            changedAt: event.control.changedAt,
          },
        },
        { worktreePath: meta.worktreePath },
      );
      return;
    case "updated":
      events.publish(
        {
          type: "terminal.updated",
          terminal: {
            id: meta.id,
            worktreePath: meta.worktreePath,
            changedAt: event.changedAt,
            ...(meta.title !== undefined ? { title: meta.title } : {}),
          },
        },
        { worktreePath: meta.worktreePath },
      );
      return;
    case "exited":
      if (!meta.exit) return;
      events.publish(
        {
          type: "terminal.exited",
          terminal: {
            id: meta.id,
            worktreePath: meta.worktreePath,
            exitedAt: meta.exit.exitedAt,
            ...(typeof meta.exit.exitCode === "number"
              ? { exitCode: meta.exit.exitCode }
              : {}),
            ...(typeof meta.exit.signal === "number"
              ? { signal: meta.exit.signal }
              : {}),
          },
        },
        { worktreePath: meta.worktreePath },
      );
      return;
    case "removed":
      events.publish(
        {
          type: "terminal.removed",
          terminal: {
            id: meta.id,
            worktreePath: meta.worktreePath,
          },
        },
        { worktreePath: meta.worktreePath },
      );
      return;
  }
}
