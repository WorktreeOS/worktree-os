import { LogBuffer } from "@worktreeos/ui/log-buffer";
import type { LogChannel, LogStream, ServicesDiscoveredContext } from "@worktreeos/core/events";
import {
  startServiceFollowers,
  stopServiceFollowers,
  type ServiceFollower,
} from "@worktreeos/runtime/service-logs";

/**
 * Default Docker Compose `--tail` count for newly opened service log streams.
 * Spec `make-service-logs-on-demand` mandates 1000 immediate-context lines.
 */
export const DEFAULT_SERVICE_TAIL = 1000;

/**
 * Per-stream bounded active tail size. Shared subscribers joining an already
 * active stream get this many trailing lines replayed before live chunks.
 */
export const DEFAULT_ACTIVE_BUFFER_CAPACITY = 1000;

export interface DaemonSession {
  sessionName: string;
  /** Bounded init log buffer. Daemon-owned because init is finite diagnostics. */
  initBuffer: LogBuffer | null;
  /**
   * Bounded deployment log buffer. Daemon-owned because deployment output
   * (release-ports / compose-up / status / healthcheck) is finite operation
   * diagnostics, mirroring the init buffer. Lets clients replay and follow the
   * live deploy tail while an `up` is in progress.
   */
  deploymentBuffer: LogBuffer | null;
  /** Active request-scoped Docker Compose log streams keyed by service name. */
  serviceStreams: Map<string, ActiveServiceStream>;
}

export interface ActiveServiceStream {
  readonly service: string;
  readonly channel: LogChannel;
  /** Bounded tail buffer for late subscribers joining the active stream. */
  readonly buffer: LogBuffer;
  follower: ServiceFollower | null;
}

export interface SessionLogChunk {
  channel: LogChannel;
  service: string;
  stream: LogStream;
  chunk: string;
}

export type SessionLogListener = (chunk: SessionLogChunk) => void;

export interface SessionLogSubscription {
  history: SessionLogChunk[];
  unsubscribe: () => void;
}

export interface SessionSubscribeOptions {
  /**
   * Restrict the subscription to a single channel. When omitted, the
   * subscription preserves the legacy service-only behavior as a request-scoped
   * aggregate stream — init chunks are not delivered.
   */
  channel?: LogChannel;
}

export interface FollowerStarter {
  (opts: {
    ctx: ServicesDiscoveredContext;
    services: string[];
    sink: (service: string, stream: LogStream, chunk: string) => void;
    env?: Record<string, string>;
    /**
     * Session the services belong to. Docker-API-backed starters use this to
     * resolve the current managed container from the Docker state cache;
     * Compose-based starters ignore it.
     */
    sessionName?: string;
  }): ServiceFollower[];
}

/**
 * Compose-mode-aware context used to spawn `docker compose logs --follow`
 * subprocesses on demand. Resolved per session by the daemon when a log
 * subscription arrives.
 */
export interface ServiceStreamContext {
  ctx: ServicesDiscoveredContext;
  env?: Record<string, string>;
  /**
   * When set, restricts which service names may have streams (compose-mode
   * managed-services allowlist). Subscriptions for other services stay open
   * (quiet channel) but never spawn followers.
   */
  allowedServices?: string[];
  /**
   * Aggregate service list used for the legacy no-channel subscription path.
   * The daemon enumerates running services via `docker compose ps` so the
   * compatibility stream covers every visible service.
   */
  aggregateServices?: string[];
}

export type ServiceStreamContextResolver = (
  sessionName: string,
) => Promise<ServiceStreamContext | null>;

interface SubscriberEntry {
  listener: SessionLogListener;
  channel: LogChannel | undefined;
  /** Service names this subscriber is currently attached to as a live consumer. */
  attached: Set<string>;
}

/**
 * Daemon-side registry of session log streams.
 *
 * After change `make-service-logs-on-demand`, this registry no longer owns
 * long-lived `docker compose logs --follow` followers. Service log followers
 * are spawned only when a client subscribes to a `service:<name>` channel and
 * are stopped when the last subscriber for that service disconnects.
 *
 * Init logs remain daemon-owned because they are finite setup diagnostics
 * produced by wos-controlled operations, not by long-running services.
 */
export class DaemonSessionRegistry {
  private readonly sessions = new Map<string, DaemonSession>();
  private readonly subscribers = new Map<string, Set<SubscriberEntry>>();
  private readonly initCapacity: number;
  private readonly activeCapacity: number;
  private readonly tail: number;
  private readonly starter: FollowerStarter;
  private resolver: ServiceStreamContextResolver | undefined;

  constructor(opts: {
    /** Init buffer capacity. Defaults to the active stream capacity. */
    capacity?: number;
    /** Active service stream tail buffer capacity. */
    activeCapacity?: number;
    /** Docker Compose `--tail` count for newly spawned followers. */
    tail?: number;
    starter?: FollowerStarter;
    streamContextResolver?: ServiceStreamContextResolver;
  } = {}) {
    this.activeCapacity = opts.activeCapacity ?? opts.capacity ?? DEFAULT_ACTIVE_BUFFER_CAPACITY;
    this.initCapacity = opts.capacity ?? DEFAULT_ACTIVE_BUFFER_CAPACITY;
    this.tail = opts.tail ?? DEFAULT_SERVICE_TAIL;
    this.starter = opts.starter ?? defaultDaemonStarter;
    this.resolver = opts.streamContextResolver;
  }

  setStreamContextResolver(resolver: ServiceStreamContextResolver | undefined): void {
    this.resolver = resolver;
  }

  has(sessionName: string): boolean {
    return this.sessions.has(sessionName);
  }

  get(sessionName: string): DaemonSession | undefined {
    return this.sessions.get(sessionName);
  }

  /**
   * Buffer an init log chunk for diagnostic replay. Delivered live to
   * subscribers selecting the init channel.
   */
  appendInit(sessionName: string, stream: LogStream, chunk: string): void {
    const session = this.ensureSession(sessionName);
    if (!session.initBuffer) session.initBuffer = new LogBuffer(this.initCapacity);
    session.initBuffer.append(stream, chunk);
    this.deliver(sessionName, {
      channel: "init",
      service: "init",
      stream,
      chunk,
    });
  }

  /**
   * Buffer a deployment log chunk (release-ports / compose-up / status /
   * healthcheck output) for diagnostic replay. Delivered live to subscribers
   * selecting the deployment channel so the deploy tail is visible while an
   * `up` is still running.
   */
  appendDeployment(sessionName: string, stream: LogStream, chunk: string): void {
    const session = this.ensureSession(sessionName);
    if (!session.deploymentBuffer) {
      session.deploymentBuffer = new LogBuffer(this.initCapacity);
    }
    session.deploymentBuffer.append(stream, chunk);
    this.deliver(sessionName, {
      channel: "deployment",
      service: "deployment",
      stream,
      chunk,
    });
  }

  /**
   * Subscribe to a session log stream. For `service:<name>` channels this
   * starts or reuses a request-scoped Docker Compose log follower with
   * `--tail 1000`; the follower stops when the last subscriber disconnects.
   *
   * For the `init` channel, replays the daemon-owned init buffer and delivers
   * subsequent init chunks via the listener.
   *
   * Without a channel, behaves as a request-scoped aggregate service stream:
   * the daemon enumerates services through the registered context resolver and
   * starts on-demand followers for each one. Init chunks are excluded.
   */
  subscribe(
    sessionName: string,
    listener: SessionLogListener,
    opts: SessionSubscribeOptions = {},
  ): SessionLogSubscription {
    let set = this.subscribers.get(sessionName);
    if (!set) {
      set = new Set();
      this.subscribers.set(sessionName, set);
    }
    const entry: SubscriberEntry = {
      listener,
      channel: opts.channel,
      attached: new Set(),
    };
    set.add(entry);

    const history: SessionLogChunk[] = [];
    const session = this.sessions.get(sessionName);

    if (opts.channel === "init") {
      if (session?.initBuffer) {
        for (const line of session.initBuffer.snapshot()) {
          history.push({
            channel: "init",
            service: "init",
            stream: line.stream,
            chunk: line.text + "\n",
          });
        }
      }
    } else if (opts.channel === "deployment") {
      if (session?.deploymentBuffer) {
        for (const line of session.deploymentBuffer.snapshot()) {
          history.push({
            channel: "deployment",
            service: "deployment",
            stream: line.stream,
            chunk: line.text + "\n",
          });
        }
      }
    } else if (opts.channel && opts.channel.startsWith("service:")) {
      const service = opts.channel.slice("service:".length);
      // If a stream is already active, replay its bounded tail buffer so the
      // subscriber sees recent context before live chunks. Then ensure the
      // follower exists; new subscribers join the shared follower.
      const existing = session?.serviceStreams.get(service);
      if (existing) {
        for (const line of existing.buffer.snapshot()) {
          history.push({
            channel: existing.channel,
            service,
            stream: line.stream,
            chunk: line.text + "\n",
          });
        }
        entry.attached.add(service);
      } else {
        // Kick off async follower startup. Subscriber stays attached via
        // entry.attached once the stream comes up so it receives live chunks.
        void this.ensureServiceStreamForSubscriber(sessionName, service, entry);
      }
    } else {
      // No-channel aggregate compatibility stream. Replay tails of any
      // already-active service streams, then resolve compose ps to spawn
      // followers for remaining services so this subscriber sees all
      // service:* output.
      if (session) {
        for (const stream of session.serviceStreams.values()) {
          for (const line of stream.buffer.snapshot()) {
            history.push({
              channel: stream.channel,
              service: stream.service,
              stream: line.stream,
              chunk: line.text + "\n",
            });
          }
          entry.attached.add(stream.service);
        }
      }
      void this.ensureAggregateStreamsForSubscriber(sessionName, entry);
    }

    return {
      history,
      unsubscribe: () => this.removeSubscriber(sessionName, entry),
    };
  }

  /**
   * Clear the init buffer and stop any active service streams. The session
   * entry and subscriber set survive so subscribers see chunks from new
   * streams after the operation restarts the deployment.
   */
  async resetSession(sessionName: string): Promise<void> {
    const session = this.sessions.get(sessionName);
    if (!session) return;
    session.initBuffer?.clear();
    session.initBuffer = null;
    session.deploymentBuffer?.clear();
    session.deploymentBuffer = null;
    await this.teardownAllStreams(session);
  }

  /** Stop streams and drop the session entry entirely. */
  async drop(sessionName: string): Promise<void> {
    const session = this.sessions.get(sessionName);
    if (!session) return;
    this.sessions.delete(sessionName);
    this.subscribers.delete(sessionName);
    await this.teardownAllStreams(session);
  }

  /** Stop every active stream and clear all state. Called at daemon shutdown. */
  async shutdown(): Promise<void> {
    const followers: ServiceFollower[] = [];
    for (const session of this.sessions.values()) {
      for (const stream of session.serviceStreams.values()) {
        if (stream.follower) followers.push(stream.follower);
      }
    }
    this.sessions.clear();
    this.subscribers.clear();
    await stopServiceFollowers(followers);
  }

  private async ensureServiceStreamForSubscriber(
    sessionName: string,
    service: string,
    entry: SubscriberEntry,
  ): Promise<void> {
    const session = this.ensureSession(sessionName);
    const existing = session.serviceStreams.get(service);
    if (existing) {
      entry.attached.add(service);
      return;
    }
    const context = await this.resolver?.(sessionName);
    if (!context) return;
    if (context.allowedServices && !context.allowedServices.includes(service)) {
      return;
    }
    // Subscriber may have already gone away while we were resolving. In that
    // case do not spawn a follower for nothing.
    const subs = this.subscribers.get(sessionName);
    if (!subs || !subs.has(entry)) return;
    this.startServiceStream(sessionName, service, context);
    // The new stream's subscriber set is computed from this.subscribers, so
    // the entry is implicitly attached. Mark it for cleanup bookkeeping.
    entry.attached.add(service);
  }

  private async ensureAggregateStreamsForSubscriber(
    sessionName: string,
    entry: SubscriberEntry,
  ): Promise<void> {
    const context = await this.resolver?.(sessionName);
    if (!context) return;
    const subs = this.subscribers.get(sessionName);
    if (!subs || !subs.has(entry)) return;
    const services = context.aggregateServices ?? [];
    const session = this.ensureSession(sessionName);
    for (const service of services) {
      if (context.allowedServices && !context.allowedServices.includes(service)) {
        continue;
      }
      if (!session.serviceStreams.has(service)) {
        this.startServiceStream(sessionName, service, context);
      }
      entry.attached.add(service);
    }
  }

  private startServiceStream(
    sessionName: string,
    service: string,
    context: ServiceStreamContext,
  ): ActiveServiceStream {
    const session = this.ensureSession(sessionName);
    const channel: LogChannel = `service:${service}`;
    const stream: ActiveServiceStream = {
      service,
      channel,
      buffer: new LogBuffer(this.activeCapacity),
      follower: null,
    };
    session.serviceStreams.set(service, stream);
    const followers = this.starter({
      ctx: context.ctx,
      services: [service],
      env: context.env,
      sessionName,
      sink: (svc, st, chunk) => {
        const current = session.serviceStreams.get(service);
        if (!current) return;
        current.buffer.append(st, chunk);
        this.deliver(sessionName, {
          channel,
          service,
          stream: st,
          chunk,
        });
      },
    });
    stream.follower = followers[0] ?? null;
    if (!stream.follower) {
      session.serviceStreams.delete(service);
    }
    return stream;
  }

  private deliver(sessionName: string, chunk: SessionLogChunk): void {
    const subs = this.subscribers.get(sessionName);
    if (!subs) return;
    for (const sub of subs) {
      if (!matchesChannel(chunk.channel, sub.channel)) continue;
      try {
        sub.listener(chunk);
      } catch {
        /* swallow subscriber errors */
      }
    }
  }

  private removeSubscriber(sessionName: string, entry: SubscriberEntry): void {
    const subs = this.subscribers.get(sessionName);
    if (!subs) return;
    subs.delete(entry);
    if (subs.size === 0) this.subscribers.delete(sessionName);
    const session = this.sessions.get(sessionName);
    if (!session) return;
    // Tear down any service stream that no remaining subscriber cares about.
    for (const service of entry.attached) {
      if (!this.serviceHasInterestedSubscriber(sessionName, service)) {
        void this.teardownServiceStream(session, service);
      }
    }
  }

  private serviceHasInterestedSubscriber(
    sessionName: string,
    service: string,
  ): boolean {
    const subs = this.subscribers.get(sessionName);
    if (!subs) return false;
    const channel: LogChannel = `service:${service}`;
    for (const sub of subs) {
      if (sub.channel === channel) return true;
      if (sub.channel === undefined && sub.attached.has(service)) return true;
    }
    return false;
  }

  private async teardownServiceStream(
    session: DaemonSession,
    service: string,
  ): Promise<void> {
    const stream = session.serviceStreams.get(service);
    if (!stream) return;
    session.serviceStreams.delete(service);
    stream.buffer.clear();
    if (stream.follower) {
      await stopServiceFollowers([stream.follower]);
    }
  }

  private async teardownAllStreams(session: DaemonSession): Promise<void> {
    const followers: ServiceFollower[] = [];
    for (const stream of session.serviceStreams.values()) {
      stream.buffer.clear();
      if (stream.follower) followers.push(stream.follower);
    }
    session.serviceStreams.clear();
    await stopServiceFollowers(followers);
  }

  private ensureSession(sessionName: string): DaemonSession {
    let session = this.sessions.get(sessionName);
    if (!session) {
      session = {
        sessionName,
        initBuffer: null,
        deploymentBuffer: null,
        serviceStreams: new Map(),
      };
      this.sessions.set(sessionName, session);
    }
    return session;
  }
}

function matchesChannel(
  channel: LogChannel,
  requested: LogChannel | undefined,
): boolean {
  if (requested) return channel === requested;
  // Legacy compatibility path: deliver only service:* chunks when no channel
  // is requested. Init chunks must not bleed into the legacy aggregate stream.
  return channel.startsWith("service:");
}

const defaultDaemonStarter: FollowerStarter = ({ ctx, services, sink, env }) => {
  return startServiceFollowers({
    ctx: {
      projectName: ctx.projectName,
      composeFile: ctx.composeFile,
      composeFiles: ctx.composeFiles,
    },
    services,
    env,
    observer: {
      emit(ev) {
        if (ev.type === "log") {
          const service = serviceFromChannel(ev.channel);
          if (service) sink(service, ev.stream, ev.chunk);
        }
      },
    },
  });
};

function serviceFromChannel(channel: string): string | null {
  if (channel.startsWith("service:")) return channel.slice("service:".length);
  return null;
}
