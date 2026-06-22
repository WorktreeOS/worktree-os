import { test, expect, describe, beforeEach } from "bun:test";
import { DaemonEventBus } from "@worktreeos/daemon/event-bus";
import { NotificationService } from "@worktreeos/daemon/notifications/service";
import type { NotificationChannel } from "@worktreeos/daemon/notifications/channels/types";
import {
  defaultNotificationsConfig,
  type Notification,
  type NotificationsConfig,
} from "@worktreeos/core/notifications";
import type { AgentActivityChangedEvent } from "@worktreeos/core/unified-events";

/** A recording channel standing in for Telegram / Web Push. */
class FakeChannel implements NotificationChannel {
  readonly id: string;
  readonly delivered: Notification[] = [];
  constructor(id: string) {
    this.id = id;
  }
  updateConfig(): void {}
  validateConfig() {
    return { ok: true as const };
  }
  isEnabled() {
    return true;
  }
  async deliver(n: Notification): Promise<void> {
    this.delivered.push(n);
  }
  async send(n: Notification) {
    this.delivered.push(n);
    return { ok: true as const };
  }
}

function enabledConfig(): NotificationsConfig {
  const cfg = defaultNotificationsConfig();
  cfg.rules["agent.done"] = {
    enabled: true,
    channels: { telegram: true, webpush: true },
  };
  return cfg;
}

function doneEvent(at: string): AgentActivityChangedEvent {
  return {
    type: "agent.activity.changed",
    terminalSessionId: "sess-1",
    worktreePath: "/wt/feature-x",
    activity: {
      state: "idle",
      idleKind: "stop",
      agent: "claude",
      lastEvent: "stop",
      at,
      lastEventAt: at,
    },
    source: {
      eventId: `evt-${at}`,
      agent: "claude",
      event: "stop",
      severity: "info",
    },
  } as AgentActivityChangedEvent;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("NotificationService presence gate", () => {
  let bus: DaemonEventBus;
  let raised: Notification[];

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

  function makeService(channels: { tg: FakeChannel; wp: FakeChannel }) {
    return new NotificationService({
      bus,
      config: enabledConfig(),
      vapid: { publicKey: "test", privateJwk: {} as JsonWebKey },
      telegram: channels.tg,
      webpush: channels.wp,
    });
  }

  test("a focused client suppresses delivery; an away report restores it", async () => {
    const tg = new FakeChannel("telegram");
    const wp = new FakeChannel("webpush");
    const svc = makeService({ tg, wp });
    svc.start();

    // A focused client (as POST /ui/v1/presence would record) suppresses
    // Web Push + notification.raised; default Telegram mode is when-away.
    svc.touchPresence("c1", "focused");
    bus.publish(doneEvent("2026-06-14T10:00:00.000Z"));
    await flush();
    expect(raised).toHaveLength(0);
    expect(wp.delivered).toHaveLength(0);
    expect(tg.delivered).toHaveLength(0);

    // The client goes away — a fresh transition is now delivered.
    svc.touchPresence("c1", "away");
    bus.publish(doneEvent("2026-06-14T10:05:00.000Z"));
    await flush();
    expect(raised).toHaveLength(1);
    expect(wp.delivered).toHaveLength(1);
    expect(tg.delivered).toHaveLength(1);

    svc.stop();
  });
});
