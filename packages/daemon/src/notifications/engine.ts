import { basename } from "node:path";
import type {
  Notification,
  NotificationKind,
  NotificationsConfig,
} from "@worktreeos/core/notifications";
import type {
  AgentActivityChangedEvent,
  UnifiedEventEnvelope,
} from "@worktreeos/core/unified-events";
import type { DaemonEventBus, Subscription } from "../event-bus";
import type { NotificationChannel } from "./channels/types";

const DEFAULT_DEDUP_WINDOW_MS = 60_000;

/**
 * Map a derived agent activity transition to a notification kind, or `null`
 * when the transition is not notable.
 *
 * `agent.done` fires only for an honest hook-`stop` idle. A synthetic
 * staleness-sweep idle (`idleKind: "stale"`) is the soft, resurrectable
 * demotion — the agent went quiet, not finished — and never raises `agent.done`.
 * `agent.question` fires when the session is blocked awaiting input.
 */
export function mapActivityToKind(
  event: AgentActivityChangedEvent,
): NotificationKind | null {
  const activity = event.activity;
  if (activity.state === "idle" && activity.idleKind === "stop") {
    return "agent.done";
  }
  if (activity.state === "awaiting-input") {
    return "agent.question";
  }
  return null;
}

/** Short display label for a notification, derived from the worktree path. */
export function worktreeLabel(event: AgentActivityChangedEvent): string {
  if (event.worktreePath) {
    const name = basename(event.worktreePath);
    if (name.length > 0) return name;
  }
  return "agent";
}

/** Click-through route for a notification. */
export function buildNotificationLink(worktreePath: string | undefined): string {
  if (worktreePath) return `/worktree?path=${encodeURIComponent(worktreePath)}`;
  return "/";
}

/**
 * Render a self-contained `Notification` from an activity transition. The
 * `dedupeKey` is stable across retried source events: it keys on the kind, the
 * session (or worktree), and the transition timestamp, so re-derivations of the
 * same transition collapse to one delivery.
 */
export function renderNotification(
  kind: NotificationKind,
  event: AgentActivityChangedEvent,
): Notification {
  const label = worktreeLabel(event);
  const dedupeAnchor =
    event.terminalSessionId ?? event.worktreePath ?? label;
  const dedupeKey = `${kind}:${dedupeAnchor}:${event.activity.at}`;
  const link = buildNotificationLink(event.worktreePath);
  const optional = {
    ...(event.worktreePath ? { worktreePath: event.worktreePath } : {}),
    ...(event.terminalSessionId
      ? { terminalSessionId: event.terminalSessionId }
      : {}),
  };

  if (kind === "agent.question") {
    const body =
      event.activity.question?.summary ??
      event.source.summary ??
      "The agent is waiting for your input.";
    return {
      kind,
      title: `Agent needs input · ${label}`,
      body,
      severity: "needs-attention",
      link,
      dedupeKey,
      ...optional,
    };
  }

  const body = event.activity.lastQuery
    ? `Finished: ${event.activity.lastQuery}`
    : "The agent finished its turn.";
  return {
    kind,
    title: `Agent finished · ${label}`,
    body,
    severity: "info",
    link,
    dedupeKey,
    ...optional,
  };
}

export interface NotificationEngineOptions {
  bus: DaemonEventBus;
  channels: NotificationChannel[];
  config: NotificationsConfig;
  /**
   * Whether any browser client is currently focused (window has OS focus and
   * the document is visible). When it returns true the user is considered
   * present, so `notification.raised` and Web Push are suppressed; when false
   * the user is away and they are delivered. Telegram follows its delivery
   * mode independently. Defaults to "never present" when unwired.
   */
  hasFocusedClient?: () => boolean;
  /** De-dup window in milliseconds. */
  dedupWindowMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Surfaced channel-delivery rejections (best-effort; never thrown). */
  onError?: (channelId: string, error: unknown) => void;
}

/**
 * The daemon notification engine. Subscribes to `agent.activity.changed`, maps
 * transitions to notification kinds, evaluates the configured rules,
 * de-duplicates, renders a channel-agnostic `Notification`, and routes it per
 * channel: `notification.raised` and Web Push fire only when no browser client
 * is focused (the user is away), while Telegram follows its delivery mode. Each
 * delivery is isolated. One decider, many deliverers.
 */
export class NotificationEngine {
  private config: NotificationsConfig;
  private readonly bus: DaemonEventBus;
  private readonly channels: NotificationChannel[];
  private readonly hasFocusedClient: () => boolean;
  private readonly dedupWindowMs: number;
  private readonly now: () => number;
  private readonly onError?: (channelId: string, error: unknown) => void;
  /** dedupeKey -> expiry timestamp (ms). */
  private readonly recent = new Map<string, number>();
  private subscription: Subscription | null = null;

  constructor(opts: NotificationEngineOptions) {
    this.bus = opts.bus;
    this.channels = opts.channels;
    this.config = opts.config;
    this.hasFocusedClient = opts.hasFocusedClient ?? (() => false);
    this.dedupWindowMs = opts.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
    this.now = opts.now ?? (() => Date.now());
    this.onError = opts.onError;
    for (const channel of this.channels) channel.updateConfig(this.config);
  }

  /** Subscribe to the bus. New events only — replayed history is ignored. */
  start(): void {
    if (this.subscription) return;
    this.subscription = this.bus.subscribe(
      (env) => this.onEnvelope(env),
      { filter: { types: ["agent.activity.changed"] } },
    );
  }

  /** Detach from the bus. */
  stop(): void {
    this.subscription?.unsubscribe();
    this.subscription = null;
  }

  /** Apply an updated config to the engine and all channels. */
  updateConfig(config: NotificationsConfig): void {
    this.config = config;
    for (const channel of this.channels) channel.updateConfig(config);
  }

  private onEnvelope(env: UnifiedEventEnvelope): void {
    if (env.event.type !== "agent.activity.changed") return;
    this.handleActivity(env.event, env.sessionName);
  }

  /**
   * Evaluate one activity transition. Exposed for unit tests of the decision
   * logic (rule gating, presence routing, dedup) independent of the bus.
   */
  handleActivity(
    event: AgentActivityChangedEvent,
    sessionName?: string,
  ): void {
    const kind = mapActivityToKind(event);
    if (!kind) return;

    const rule = this.config.rules[kind];
    if (!rule || !rule.enabled) return;

    const notification = renderNotification(kind, event);
    // Dedup once, before routing, so a single transition never double-fires
    // across channels.
    if (this.isDuplicate(notification.dedupeKey)) return;

    // Presence is computed once per event; each output is routed independently.
    // `notification.raised` (in-app feed + Sound) and Web Push fire only when no
    // client is focused; Telegram follows its delivery mode, read live from the
    // current config so a settings change applies without restart.
    const away = !this.hasFocusedClient();
    const telegramMode = this.config.channels.telegram.mode;
    const telegramSend =
      rule.channels.telegram && (telegramMode === "always" || away);
    const webpushSend = rule.channels.webpush && away;

    if (away) {
      this.bus.publish(
        { type: "notification.raised", notification },
        {
          ...(event.worktreePath ? { worktreePath: event.worktreePath } : {}),
          ...(sessionName ? { sessionName } : {}),
        },
      );
    }

    this.fanOut(notification, { telegram: telegramSend, webpush: webpushSend });
  }

  private isDuplicate(key: string): boolean {
    const now = this.now();
    for (const [existing, expiry] of this.recent) {
      if (expiry <= now) this.recent.delete(existing);
    }
    if (this.recent.has(key)) return true;
    this.recent.set(key, now + this.dedupWindowMs);
    return false;
  }

  /**
   * Fan out to every routed, enabled, valid channel. Each delivery is fired
   * independently and isolated: a throwing or rejecting channel never blocks
   * the engine or the other channels.
   */
  private fanOut(
    notification: Notification,
    routing: { telegram: boolean; webpush: boolean },
  ): void {
    for (const channel of this.channels) {
      const routed = routing[channel.id as "telegram" | "webpush"];
      if (!routed) continue;
      if (!channel.isEnabled()) continue;
      if (!channel.validateConfig().ok) continue;
      try {
        const result = channel.deliver(notification);
        if (result && typeof result.catch === "function") {
          result.catch((err) => this.onError?.(channel.id, err));
        }
      } catch (err) {
        this.onError?.(channel.id, err);
      }
    }
  }
}
