import type {
  UnifiedEventEnvelope,
  UnifiedEventPayload,
  UnifiedEventScope,
  UnifiedEventType,
} from "@worktreeos/core/unified-events";

const DEFAULT_HISTORY_CAPACITY = 4000;

export interface PublishOptions extends UnifiedEventScope {
  /** Override the timestamp (tests). */
  timestamp?: string;
}

export interface SubscriptionFilter {
  /** Match envelopes whose `sessionName` is in this list. Omit to match any. */
  sessionNames?: string[];
  /** Match envelopes whose `projectId` is in this list. Omit to match any. */
  projectIds?: string[];
  /** Match envelopes whose `worktreePath` is in this list. Omit to match any. */
  worktreePaths?: string[];
  /** Match envelopes whose payload `type` is in this set. Omit to match any. */
  types?: UnifiedEventType[];
}

export interface SubscribeOptions {
  filter?: SubscriptionFilter;
  /**
   * Replay retained history with id > `sinceId`. When omitted no history is
   * replayed at subscription time; clients can still inspect the returned
   * `history` snapshot.
   */
  sinceId?: number;
}

export interface Subscription {
  /** Replayable history matching the filter and `sinceId` (if provided). */
  history: UnifiedEventEnvelope[];
  /** Detach the listener and free resources. */
  unsubscribe(): void;
}

export interface EventBusOptions {
  historyCapacity?: number;
  now?: () => Date;
}

export type EventListener = (env: UnifiedEventEnvelope) => void;

interface SubscriberRecord {
  listener: EventListener;
  filter?: SubscriptionFilter;
}

/**
 * In-memory daemon event bus. Assigns monotonic ids, retains bounded
 * history for replay, and fans envelopes to filtered subscribers. Subscriber
 * errors are isolated and never block publication.
 */
export class DaemonEventBus {
  private readonly historyCapacity: number;
  private readonly now: () => Date;
  private readonly history: UnifiedEventEnvelope[] = [];
  private readonly subscribers = new Set<SubscriberRecord>();
  private nextId = 1;

  constructor(opts: EventBusOptions = {}) {
    this.historyCapacity = opts.historyCapacity ?? DEFAULT_HISTORY_CAPACITY;
    this.now = opts.now ?? (() => new Date());
  }

  /** Publish a unified payload. Returns the envelope that was emitted. */
  publish<P extends UnifiedEventPayload>(
    payload: P,
    opts: PublishOptions = {},
  ): UnifiedEventEnvelope<P> {
    const envelope: UnifiedEventEnvelope<P> = {
      id: this.nextId++,
      timestamp: opts.timestamp ?? this.now().toISOString(),
      type: payload.type,
      ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
      ...(opts.sessionName !== undefined ? { sessionName: opts.sessionName } : {}),
      ...(opts.worktreePath !== undefined
        ? { worktreePath: opts.worktreePath }
        : {}),
      ...(opts.operationId !== undefined ? { operationId: opts.operationId } : {}),
      event: payload,
    };
    this.history.push(envelope);
    const overflow = this.history.length - this.historyCapacity;
    if (overflow > 0) this.history.splice(0, overflow);
    for (const sub of this.subscribers) {
      if (!matches(envelope, sub.filter)) continue;
      try {
        sub.listener(envelope);
      } catch {
        /* subscriber failures are isolated */
      }
    }
    return envelope;
  }

  /** Subscribe to envelopes. The returned `history` is filtered + replayable. */
  subscribe(listener: EventListener, opts: SubscribeOptions = {}): Subscription {
    const record: SubscriberRecord = { listener, filter: opts.filter };
    this.subscribers.add(record);
    const history = this.history
      .filter((env) => matches(env, opts.filter))
      .filter((env) => opts.sinceId === undefined || env.id > opts.sinceId)
      .slice();
    return {
      history,
      unsubscribe: () => {
        this.subscribers.delete(record);
      },
    };
  }

  /** Detach all subscribers and clear history. Used on daemon shutdown. */
  shutdown(): void {
    this.subscribers.clear();
    this.history.length = 0;
  }

  /** Test/diagnostic accessor. */
  get retainedCount(): number {
    return this.history.length;
  }

  /** Test/diagnostic accessor. */
  get subscriberCount(): number {
    return this.subscribers.size;
  }
}

function matches(
  envelope: UnifiedEventEnvelope,
  filter: SubscriptionFilter | undefined,
): boolean {
  if (!filter) return true;
  if (filter.sessionNames && filter.sessionNames.length > 0) {
    if (
      envelope.sessionName === undefined ||
      !filter.sessionNames.includes(envelope.sessionName)
    ) {
      return false;
    }
  }
  if (filter.projectIds && filter.projectIds.length > 0) {
    if (
      envelope.projectId === undefined ||
      !filter.projectIds.includes(envelope.projectId)
    ) {
      return false;
    }
  }
  if (filter.worktreePaths && filter.worktreePaths.length > 0) {
    if (
      envelope.worktreePath === undefined ||
      !filter.worktreePaths.includes(envelope.worktreePath)
    ) {
      return false;
    }
  }
  if (filter.types && filter.types.length > 0) {
    if (!filter.types.includes(envelope.type)) return false;
  }
  return true;
}
