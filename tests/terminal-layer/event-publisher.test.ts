import { describe, expect, test } from "bun:test";
import { DaemonEventBus } from "@worktreeos/daemon/event-bus";
import { publishTerminalLifecycle } from "@worktreeos/daemon/terminal-layer/event-publisher";
import type { TerminalSessionMetadata } from "@worktreeos/daemon/terminal-layer/types";

function meta(overrides: Partial<TerminalSessionMetadata> = {}): TerminalSessionMetadata {
  return {
    id: "t1",
    worktreePath: "/wt",
    status: "running",
    shell: "/bin/zsh",
    cwd: "/wt",
    cols: 80,
    rows: 24,
    createdAt: "2026-05-23T00:00:00.000Z",
    ...overrides,
  };
}

describe("publishTerminalLifecycle", () => {
  test("created event becomes terminal.started", () => {
    const bus = new DaemonEventBus();
    const captured: string[] = [];
    bus.subscribe((env) => captured.push(env.type));
    publishTerminalLifecycle(bus, { type: "created", metadata: meta() });
    expect(captured.includes("terminal.started")).toBe(true);
  });

  test("attached event carries the new attachment count", () => {
    const bus = new DaemonEventBus();
    const captured: any[] = [];
    bus.subscribe((env) => captured.push(env.event));
    publishTerminalLifecycle(bus, {
      type: "attached",
      metadata: meta({ attachments: [{ attachmentId: "a1", isController: true, attachedAt: "x" }] }),
      attachment: { attachmentId: "a1", isController: true, attachedAt: "x" },
    });
    const ev = captured.find((e) => e.type === "terminal.attached");
    expect(ev.terminal.attachmentId).toBe("a1");
    expect(ev.terminal.attachmentCount).toBe(1);
  });

  test("detached event carries attachmentId", () => {
    const bus = new DaemonEventBus();
    const captured: any[] = [];
    bus.subscribe((env) => captured.push(env.event));
    publishTerminalLifecycle(bus, {
      type: "detached",
      metadata: meta(),
      attachmentId: "a1",
    });
    expect(captured.some((e) => e.type === "terminal.detached" && e.terminal.attachmentId === "a1")).toBe(true);
  });

  test("control-changed event includes the new controller id", () => {
    const bus = new DaemonEventBus();
    const captured: any[] = [];
    bus.subscribe((env) => captured.push(env.event));
    publishTerminalLifecycle(bus, {
      type: "control-changed",
      metadata: meta(),
      control: { controllerAttachmentId: "a2", changedAt: "x" },
    });
    const ev = captured.find((e) => e.type === "terminal.control-changed");
    expect(ev.terminal.controllerAttachmentId).toBe("a2");
  });

  test("exited event publishes terminal.exited with exit code", () => {
    const bus = new DaemonEventBus();
    const captured: any[] = [];
    bus.subscribe((env) => captured.push(env.event));
    publishTerminalLifecycle(bus, {
      type: "exited",
      metadata: meta({
        status: "exited",
        exit: { exitedAt: "2026-05-23T00:01:00.000Z", exitCode: 0 },
      }),
    });
    const ev = captured.find((e) => e.type === "terminal.exited");
    expect(ev.terminal.exitCode).toBe(0);
  });

  test("updated event becomes terminal.updated with id, path, changedAt, and title", () => {
    const bus = new DaemonEventBus();
    const captured: any[] = [];
    bus.subscribe((env) => captured.push(env.event));
    publishTerminalLifecycle(bus, {
      type: "updated",
      metadata: meta({ title: "api logs" }),
      changedAt: "2026-05-23T00:02:00.000Z",
    });
    const ev = captured.find((e) => e.type === "terminal.updated");
    expect(ev).toBeDefined();
    expect(ev.terminal.id).toBe("t1");
    expect(ev.terminal.worktreePath).toBe("/wt");
    expect(ev.terminal.changedAt).toBe("2026-05-23T00:02:00.000Z");
    expect(ev.terminal.title).toBe("api logs");
  });

  test("updated event omits the title when it was cleared", () => {
    const bus = new DaemonEventBus();
    const captured: any[] = [];
    bus.subscribe((env) => captured.push(env.event));
    publishTerminalLifecycle(bus, {
      type: "updated",
      metadata: meta(),
      changedAt: "2026-05-23T00:03:00.000Z",
    });
    const ev = captured.find((e) => e.type === "terminal.updated");
    expect(ev).toBeDefined();
    expect("title" in ev.terminal).toBe(false);
  });

  test("event payloads never carry PTY output or replay data", () => {
    const bus = new DaemonEventBus();
    const captured: any[] = [];
    bus.subscribe((env) => captured.push(env.event));
    publishTerminalLifecycle(bus, { type: "created", metadata: meta() });
    publishTerminalLifecycle(bus, {
      type: "attached",
      metadata: meta(),
      attachment: { attachmentId: "a1", isController: true, attachedAt: "x" },
    });
    for (const ev of captured) {
      const json = JSON.stringify(ev);
      expect(json).not.toMatch(/replay/i);
      expect(json).not.toMatch(/output/i);
      expect(json).not.toMatch(/history/i);
    }
  });
});
