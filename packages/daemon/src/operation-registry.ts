import type { DeploymentEvent, DeploymentObserver } from "@worktreeos/core/events";
import {
  type OperationEventEnvelope,
  type OperationKind,
  type OperationMetadata,
  type OperationStatus,
  type OperationTerminalEnvelope,
  type StreamEnvelope,
} from "./daemon-protocol";

const DEFAULT_HISTORY = 4000;

/** Mutating kinds occupy a session lock. */
export function isMutatingKind(kind: OperationKind): boolean {
  return (
    kind === "up" ||
    kind === "down" ||
    kind === "service-stop" ||
    kind === "service-restart" ||
    kind === "worktree-remove" ||
    kind === "worktree-create"
  );
}

export interface OperationRecord {
  operationId: string;
  sessionName: string;
  kind: OperationKind;
  status: OperationStatus;
  startedAt: string;
  finishedAt?: string;
  failureMessage?: string;
  /** Bounded envelope history for late subscribers. */
  history: StreamEnvelope[];
  /** Live subscribers receiving new envelopes. */
  subscribers: Set<(env: StreamEnvelope) => void>;
}

export interface ActiveOperationView {
  metadata: OperationMetadata;
  record: OperationRecord;
}

export interface RegistryOptions {
  historyCapacity?: number;
  now?: () => Date;
  newId?: () => string;
}

/**
 * In-memory operation registry. Enforces per-session mutating-operation
 * exclusivity, retains bounded envelope history for late subscribers, and
 * exposes a streaming observer that fans out events to live listeners.
 */
export class OperationRegistry {
  private readonly ops = new Map<string, OperationRecord>();
  private readonly activeMutating = new Map<string, string>(); // sessionName -> operationId
  private readonly historyCapacity: number;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(opts: RegistryOptions = {}) {
    this.historyCapacity = opts.historyCapacity ?? DEFAULT_HISTORY;
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? (() => crypto.randomUUID());
  }

  /**
   * Try to start a new operation. Returns a record on success, or a conflict
   * describing the existing active operation when the session is busy and the
   * new operation is mutating.
   */
  begin(
    sessionName: string,
    kind: OperationKind,
  ):
    | { ok: true; record: OperationRecord }
    | { ok: false; conflict: ActiveOperationView } {
    if (isMutatingKind(kind)) {
      const activeId = this.activeMutating.get(sessionName);
      if (activeId) {
        const active = this.ops.get(activeId);
        if (active && active.status === "running") {
          return {
            ok: false,
            conflict: {
              metadata: toMetadata(active),
              record: active,
            },
          };
        }
        // Stale entry — clear before starting.
        this.activeMutating.delete(sessionName);
      }
    }
    const record: OperationRecord = {
      operationId: this.newId(),
      sessionName,
      kind,
      status: "running",
      startedAt: this.now().toISOString(),
      history: [],
      subscribers: new Set(),
    };
    this.ops.set(record.operationId, record);
    if (isMutatingKind(kind)) {
      this.activeMutating.set(sessionName, record.operationId);
    }
    return { ok: true, record };
  }

  /** Create an observer that records & broadcasts envelopes for one operation. */
  observerFor(record: OperationRecord): DeploymentObserver {
    let sequence = 0;
    return {
      emit: (event: DeploymentEvent) => {
        sequence += 1;
        const env: OperationEventEnvelope = {
          operationId: record.operationId,
          sessionName: record.sessionName,
          sequence,
          timestamp: this.now().toISOString(),
          event,
        };
        this.pushEnvelope(record, env);
      },
    };
  }

  /** Mark operation as terminated and emit a terminal envelope. */
  finish(
    record: OperationRecord,
    status: Extract<OperationStatus, "succeeded" | "failed">,
    failureMessage?: string,
  ): void {
    record.status = status;
    record.finishedAt = this.now().toISOString();
    if (failureMessage) record.failureMessage = failureMessage;
    if (isMutatingKind(record.kind)) {
      const id = this.activeMutating.get(record.sessionName);
      if (id === record.operationId) this.activeMutating.delete(record.sessionName);
    }
    const term: OperationTerminalEnvelope = {
      operationId: record.operationId,
      sessionName: record.sessionName,
      sequence: record.history.length + 1,
      timestamp: this.now().toISOString(),
      terminal: failureMessage ? { status, failureMessage } : { status },
    };
    this.pushEnvelope(record, term);
    for (const sub of record.subscribers) {
      try {
        sub(term);
      } catch {
        /* swallow listener errors */
      }
    }
    record.subscribers.clear();
  }

  get(operationId: string): OperationRecord | undefined {
    return this.ops.get(operationId);
  }

  activeMutatingFor(sessionName: string): OperationRecord | null {
    const id = this.activeMutating.get(sessionName);
    if (!id) return null;
    return this.ops.get(id) ?? null;
  }

  /**
   * Return the most recently started operation for a session, regardless of
   * its status. Used by UI status classification to surface failed/succeeded
   * states after an operation has finished.
   */
  latestForSession(sessionName: string): OperationRecord | null {
    let latest: OperationRecord | null = null;
    for (const r of this.ops.values()) {
      if (r.sessionName !== sessionName) continue;
      if (!latest || r.startedAt > latest.startedAt) latest = r;
    }
    return latest;
  }

  metadata(record: OperationRecord): OperationMetadata {
    return toMetadata(record);
  }

  /**
   * Subscribe to live envelopes. Returns the buffered history plus an
   * unsubscribe function. The buffered envelopes are delivered first by the
   * caller's loop — they are NOT replayed through the live listener.
   */
  subscribe(
    record: OperationRecord,
    listener: (env: StreamEnvelope) => void,
  ): { history: StreamEnvelope[]; unsubscribe: () => void } {
    const history = record.history.slice();
    if (record.status === "succeeded" || record.status === "failed") {
      return { history, unsubscribe: () => {} };
    }
    record.subscribers.add(listener);
    return {
      history,
      unsubscribe: () => record.subscribers.delete(listener),
    };
  }

  private pushEnvelope(record: OperationRecord, env: StreamEnvelope): void {
    record.history.push(env);
    const overflow = record.history.length - this.historyCapacity;
    if (overflow > 0) record.history.splice(0, overflow);
    for (const sub of record.subscribers) {
      try {
        sub(env);
      } catch {
        /* swallow listener errors */
      }
    }
  }
}

function toMetadata(r: OperationRecord): OperationMetadata {
  return {
    operationId: r.operationId,
    sessionName: r.sessionName,
    kind: r.kind,
    status: r.status,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    failureMessage: r.failureMessage,
  };
}
