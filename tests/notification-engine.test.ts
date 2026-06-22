import { test, expect, describe, beforeEach } from "bun:test";
import { DaemonEventBus } from "@worktreeos/daemon/event-bus";
import { NotificationEngine } from "@worktreeos/daemon/notifications/engine";
import type { NotificationChannel } from "@worktreeos/daemon/notifications/channels/types";
import {
  defaultNotificationsConfig,
  type Notification,
  type NotificationsConfig,
} from "@worktreeos/core/notifications";
import type { AgentActivityChangedEvent } from "@worktreeos/core/unified-events";
import type { AgentActivityBlock } from "@worktreeos/core/agent-activity";

function activityBlock(over: Partial<AgentActivityBlock>): AgentActivityBlock {
  return {
    state: "idle",
    agent: "claude",
    lastEvent: "stop",
    at: "2026-06-14T10:00:00.000Z",
    lastEventAt: "2026-06-14T10:00:00.000Z",
    ...over,
  };
}

function activityEvent(
  over: Partial<AgentActivityChangedEvent> & {
    activity?: Partial<AgentActivityBlock>;
  } = {},
): AgentActivityChangedEvent {
  const { activity, ...rest } = over;
  return {
    type: "agent.activity.changed",
    terminalSessionId: "sess-1",
    worktreePath: "/wt/feature-x",
    activity: activityBlock(activity ?? {}),
    source: {
      eventId: "evt-1",
      agent: "claude",
      event: "stop",
      severity: "info",
    },
    ...rest,
  };
}

/** A recording channel that can be made to reject. */
class FakeChannel implements NotificationChannel {
  readonly id: string;
  readonly delivered: Notification[] = [];
  valid = true;
  enabled = true;
  reject = false;
  constructor(id: string) {
    this.id = id;
  }
  updateConfig(): void {}
  validateConfig() {
    return this.valid ? { ok: true } : { ok: false, error: "invalid" };
  }
  isEnabled() {
    return this.enabled;
  }
  async deliver(n: Notification): Promise<void> {
    if (this.reject) throw new Error("boom");
    this.delivered.push(n);
  }
  async send(n: Notification) {
    if (this.reject) return { ok: false, error: "boom" };
    this.delivered.push(n);
    return { ok: true };
  }
}

let bus: DaemonEventBus;
let raised: Notification[];

function enabledConfig(): NotificationsConfig {
  const cfg = defaultNotificationsConfig();
  cfg.rules["agent.done"] = {
    enabled: true,
    channels: { telegram: true, webpush: true },
  };
  cfg.rules["agent.question"] = {
    enabled: true,
    channels: { telegram: true, webpush: true },
  };
  return cfg;
}

beforeEach(() => {
  bus = new DaemonEventBus();
  raised = [];
  bus.subscribe(
    (env) => {
      if (env.event.type === "notification.raised") {
        raised.push(env.event.notification);
      }
    },
    { filter: { types: ["notification.raised"] } },
  );
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("NotificationEngine decision logic", () => {
  test("honest hook-stop idle raises agent.done and fans out", async () => {
    const tg = new FakeChannel("telegram");
    const engine = new NotificationEngine({
      bus,
      channels: [tg],
      config: enabledConfig(),
    });
    engine.handleActivity(
      activityEvent({ activity: { state: "idle", idleKind: "stop" } }),
    );
    await flush();
    expect(raised).toHaveLength(1);
    expect(raised[0]?.kind).toBe("agent.done");
    expect(raised[0]?.severity).toBe("info");
    expect(tg.delivered).toHaveLength(1);
  });

  test("staleness-sourced idle raises nothing", () => {
    const engine = new NotificationEngine({
      bus,
      channels: [],
      config: enabledConfig(),
    });
    engine.handleActivity(
      activityEvent({ activity: { state: "idle", idleKind: "stale" } }),
    );
    expect(raised).toHaveLength(0);
  });

  test("awaiting-input raises agent.question with needs-attention", () => {
    const engine = new NotificationEngine({
      bus,
      channels: [],
      config: enabledConfig(),
    });
    engine.handleActivity(
      activityEvent({
        activity: {
          state: "awaiting-input",
          question: { summary: "Approve edit?", askedAt: "x" },
        },
        source: {
          eventId: "q",
          agent: "claude",
          event: "question_asked",
          severity: "needs-attention",
        },
      }),
    );
    expect(raised).toHaveLength(1);
    expect(raised[0]?.kind).toBe("agent.question");
    expect(raised[0]?.severity).toBe("needs-attention");
    expect(raised[0]?.body).toBe("Approve edit?");
  });

  test("disabled rule is a no-op", () => {
    const cfg = enabledConfig();
    cfg.rules["agent.done"]!.enabled = false;
    const engine = new NotificationEngine({ bus, channels: [], config: cfg });
    engine.handleActivity(
      activityEvent({ activity: { state: "idle", idleKind: "stop" } }),
    );
    expect(raised).toHaveLength(0);
  });

  test("a focused client suppresses Web Push and notification.raised", async () => {
    const tg = new FakeChannel("telegram");
    const wp = new FakeChannel("webpush");
    const engine = new NotificationEngine({
      bus,
      channels: [tg, wp],
      config: enabledConfig(), // telegram mode defaults to when-away
      hasFocusedClient: () => true,
    });
    engine.handleActivity(
      activityEvent({ activity: { state: "idle", idleKind: "stop" } }),
    );
    await flush();
    expect(raised).toHaveLength(0);
    expect(wp.delivered).toHaveLength(0);
    // when-away Telegram is also suppressed while a client is focused.
    expect(tg.delivered).toHaveLength(0);
  });

  test("no focused client delivers raised, Web Push and Telegram", async () => {
    const tg = new FakeChannel("telegram");
    const wp = new FakeChannel("webpush");
    const engine = new NotificationEngine({
      bus,
      channels: [tg, wp],
      config: enabledConfig(),
      hasFocusedClient: () => false,
    });
    engine.handleActivity(
      activityEvent({ activity: { state: "idle", idleKind: "stop" } }),
    );
    await flush();
    expect(raised).toHaveLength(1);
    expect(wp.delivered).toHaveLength(1);
    expect(tg.delivered).toHaveLength(1);
  });

  test("Telegram mode 'always' delivers while a client is focused", async () => {
    const cfg = enabledConfig();
    cfg.channels.telegram.mode = "always";
    const tg = new FakeChannel("telegram");
    const wp = new FakeChannel("webpush");
    const engine = new NotificationEngine({
      bus,
      channels: [tg, wp],
      config: cfg,
      hasFocusedClient: () => true,
    });
    engine.handleActivity(
      activityEvent({ activity: { state: "idle", idleKind: "stop" } }),
    );
    await flush();
    // Telegram still reaches the phone; the focused browser stays quiet.
    expect(tg.delivered).toHaveLength(1);
    expect(wp.delivered).toHaveLength(0);
    expect(raised).toHaveLength(0);
  });

  test("Telegram mode 'when-away' suppresses while a client is focused", async () => {
    const cfg = enabledConfig();
    cfg.channels.telegram.mode = "when-away";
    const tg = new FakeChannel("telegram");
    const engine = new NotificationEngine({
      bus,
      channels: [tg],
      config: cfg,
      hasFocusedClient: () => true,
    });
    engine.handleActivity(
      activityEvent({ activity: { state: "idle", idleKind: "stop" } }),
    );
    await flush();
    expect(tg.delivered).toHaveLength(0);
  });

  test("an unwired engine treats the user as away and delivers", async () => {
    // No focus signal is wired — terminal attachment no longer gates anything,
    // so the default is "away" and a matching event is delivered.
    const tg = new FakeChannel("telegram");
    const engine = new NotificationEngine({
      bus,
      channels: [tg],
      config: enabledConfig(),
    });
    engine.handleActivity(
      activityEvent({ activity: { state: "idle", idleKind: "stop" } }),
    );
    await flush();
    expect(raised).toHaveLength(1);
    expect(tg.delivered).toHaveLength(1);
  });

  test("de-dups within the window, fires again after it elapses", () => {
    let clock = 1000;
    const engine = new NotificationEngine({
      bus,
      channels: [],
      config: enabledConfig(),
      dedupWindowMs: 5000,
      now: () => clock,
    });
    const ev = activityEvent({ activity: { state: "idle", idleKind: "stop" } });
    engine.handleActivity(ev);
    engine.handleActivity(ev); // duplicate within window
    expect(raised).toHaveLength(1);
    clock += 6000; // window elapsed
    engine.handleActivity(ev);
    expect(raised).toHaveLength(2);
  });

  test("one channel failure does not affect others", async () => {
    const tg = new FakeChannel("telegram");
    const wp = new FakeChannel("webpush");
    tg.reject = true;
    const errors: string[] = [];
    const engine = new NotificationEngine({
      bus,
      channels: [tg, wp],
      config: enabledConfig(),
      onError: (id) => errors.push(id),
    });
    engine.handleActivity(
      activityEvent({ activity: { state: "idle", idleKind: "stop" } }),
    );
    await flush();
    expect(raised).toHaveLength(1);
    expect(wp.delivered).toHaveLength(1);
    expect(errors).toContain("telegram");
  });

  test("does not route to a channel a kind has disabled", async () => {
    const cfg = enabledConfig();
    cfg.rules["agent.done"]!.channels = { telegram: false, webpush: true };
    const tg = new FakeChannel("telegram");
    const wp = new FakeChannel("webpush");
    const engine = new NotificationEngine({ bus, channels: [tg, wp], config: cfg });
    engine.handleActivity(
      activityEvent({ activity: { state: "idle", idleKind: "stop" } }),
    );
    await flush();
    expect(tg.delivered).toHaveLength(0);
    expect(wp.delivered).toHaveLength(1);
  });
});
