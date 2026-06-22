import { describe, expect, test } from "bun:test";
import {
  TerminalSessionActor,
  type AttachmentSink,
} from "@worktreeos/daemon/terminal-layer/actor";
import { createFakeTerminalRuntime } from "@worktreeos/daemon/terminal-layer/testing";
import {
  TERMINAL_PROTOCOL_VERSION,
  type TerminalServerFrame,
} from "@worktreeos/daemon/terminal-layer/protocol";

interface CapturedSink extends AttachmentSink {
  readonly frames: TerminalServerFrame[];
  readonly closes: Array<{ code?: number; reason?: string }>;
  setBuffered(amount: number): void;
}

function makeSink(): CapturedSink {
  const frames: TerminalServerFrame[] = [];
  const closes: Array<{ code?: number; reason?: string }> = [];
  let buffered = 0;
  return {
    frames,
    closes,
    setBuffered(n) {
      buffered = n;
    },
    send(frame) {
      frames.push(frame);
    },
    close(code, reason) {
      closes.push({ ...(typeof code === "number" ? { code } : {}), ...(reason !== undefined ? { reason } : {}) });
    },
    bufferedAmount() {
      return buffered;
    },
  };
}

function lastOfType<T extends TerminalServerFrame["type"]>(
  sink: CapturedSink,
  type: T,
): Extract<TerminalServerFrame, { type: T }> | undefined {
  for (let i = sink.frames.length - 1; i >= 0; i -= 1) {
    const f = sink.frames[i]!;
    if (f.type === type) return f as Extract<TerminalServerFrame, { type: T }>;
  }
  return undefined;
}

async function newRunningActor() {
  const runtime = createFakeTerminalRuntime();
  const actor = new TerminalSessionActor({
    id: "t1",
    worktreePath: "/wt",
    runtime: runtime.runtime,
    spawn: {
      shell: "/bin/zsh",
      cwd: "/wt",
      env: {},
      cols: 80,
      rows: 24,
    },
  });
  await actor.start();
  return { actor, runtime };
}

describe("TerminalSessionActor lifecycle", () => {
  test("start transitions creating → running", async () => {
    const { actor } = await newRunningActor();
    expect(actor.snapshot().status).toBe("running");
  });

  test("first controller attach sends hello-ack with isController=true", async () => {
    const { actor } = await newRunningActor();
    const sink = makeSink();
    await actor.attach({
      attachmentId: "a1",
      cols: 80,
      rows: 24,
      desiredControl: "controller",
      sink,
    });
    const ack = lastOfType(sink, "hello-ack");
    expect(ack).toBeDefined();
    expect(ack!.v).toBe(TERMINAL_PROTOCOL_VERSION);
    expect(ack!.control.controllerAttachmentId).toBe("a1");
  });

  test("second attach as controller-desired attaches as viewer", async () => {
    const { actor } = await newRunningActor();
    const a = makeSink();
    const b = makeSink();
    await actor.attach({
      attachmentId: "a1",
      cols: 80,
      rows: 24,
      desiredControl: "controller",
      sink: a,
    });
    await actor.attach({
      attachmentId: "a2",
      cols: 80,
      rows: 24,
      desiredControl: "controller",
      sink: b,
    });
    const meta = actor.snapshot();
    expect(meta.control?.controllerAttachmentId).toBe("a1");
    const ack = lastOfType(b, "hello-ack")!;
    expect(ack.session.control?.controllerAttachmentId).toBe("a1");
  });
});

describe("TerminalSessionActor backend session processId override", () => {
  test("snapshot.processId and activeCommandResolver receive backend session pid", async () => {
    const runtime = createFakeTerminalRuntime();
    const seen: Array<number | undefined> = [];
    const actor = new TerminalSessionActor({
      id: "t1",
      worktreePath: "/wt",
      runtime: runtime.runtime,
      spawn: {
        shell: "/bin/zsh",
        cwd: "/wt",
        env: {},
        cols: 80,
        rows: 24,
      },
      backend: {
        id: "tmux",
        label: "tmux",
        isAvailable: () => ({ available: true }),
        async createSession() {
          throw new Error("not used");
        },
        async onDaemonShutdown() {},
        async terminateSession() {},
      },
      backendSession: {
        id: "t1",
        backend: "tmux",
        worktreePath: "/wt",
        cwd: "/wt",
        shell: "/bin/zsh",
        cols: 80,
        rows: 24,
        createdAt: new Date().toISOString(),
        processId: 4242,
      },
      activeCommandResolver: (rootPid) => {
        seen.push(rootPid);
        return rootPid === 4242
          ? {
              pid: 4243,
              ppid: 4242,
              pgid: 4243,
              command: "/opt/claude/bin/claude",
              args: "claude code",
              agent: "claude",
            }
          : undefined;
      },
    });
    await actor.start();
    const meta = actor.snapshot();
    // The actor must surface the backend session's processId (tmux pane PID),
    // not the transport-level attach-client PID, so the snapshot and any
    // downstream process detection target the user's real shell tree.
    expect(meta.processId).toBe(4242);
    expect(meta.activeCommand?.agent).toBe("claude");
    expect(seen).toContain(4242);
  });
});

describe("TerminalSessionActor createdAt", () => {
  test("restored actor keeps the backend session's createdAt", async () => {
    const runtime = createFakeTerminalRuntime();
    const originalCreatedAt = "2026-01-01T00:00:00.000Z";
    const actor = new TerminalSessionActor({
      id: "t1",
      worktreePath: "/wt",
      runtime: runtime.runtime,
      spawn: { shell: "/bin/zsh", cwd: "/wt", env: {}, cols: 80, rows: 24 },
      backendSession: {
        id: "t1",
        backend: "tmux",
        worktreePath: "/wt",
        cwd: "/wt",
        shell: "/bin/zsh",
        cols: 80,
        rows: 24,
        createdAt: originalCreatedAt,
      },
    });
    await actor.start();
    // A daemon restart restores this actor from persisted tmux metadata; its
    // age must reflect the original creation time, not the restore time.
    expect(actor.snapshot().createdAt).toBe(originalCreatedAt);
  });

  test("fresh actor without a backend session stamps its own createdAt", async () => {
    const before = Date.now();
    const { actor } = await newRunningActor();
    const createdAt = new Date(actor.snapshot().createdAt).getTime();
    expect(createdAt).toBeGreaterThanOrEqual(before);
    expect(createdAt).toBeLessThanOrEqual(Date.now());
  });
});

describe("TerminalSessionActor title", () => {
  test("setTitle sets, changes, and clears the snapshot title", async () => {
    const { actor } = await newRunningActor();
    expect(actor.snapshot().title).toBeUndefined();
    await actor.setTitle("api logs");
    expect(actor.snapshot().title).toBe("api logs");
    await actor.setTitle("codex review");
    expect(actor.snapshot().title).toBe("codex review");
    await actor.setTitle(undefined);
    expect(actor.snapshot().title).toBeUndefined();
  });

  test("setTitle preserves attachments and control ownership", async () => {
    const { actor } = await newRunningActor();
    const sink = makeSink();
    await actor.attach({
      attachmentId: "a1",
      cols: 80,
      rows: 24,
      desiredControl: "controller",
      sink,
    });
    await actor.setTitle("named");
    const meta = actor.snapshot();
    expect(meta.title).toBe("named");
    expect(meta.status).toBe("running");
    expect(meta.control?.controllerAttachmentId).toBe("a1");
    expect(meta.attachments?.map((a) => a.attachmentId)).toEqual(["a1"]);
  });

  test("setTitle emits an updated lifecycle event with the new metadata", async () => {
    const runtime = createFakeTerminalRuntime();
    const events: Array<{ type: string; title?: string; changedAt?: string }> = [];
    const actor = new TerminalSessionActor({
      id: "t1",
      worktreePath: "/wt",
      runtime: runtime.runtime,
      spawn: { shell: "/bin/zsh", cwd: "/wt", env: {}, cols: 80, rows: 24 },
      onLifecycle: (e) =>
        events.push({
          type: e.type,
          ...(e.type === "updated"
            ? { title: e.metadata.title, changedAt: e.changedAt }
            : {}),
        }),
    });
    await actor.start();
    await actor.setTitle("build");
    const updated = events.find((e) => e.type === "updated");
    expect(updated).toBeDefined();
    expect(updated!.title).toBe("build");
    expect(typeof updated!.changedAt).toBe("string");
  });

  test("setTitle records provenance: user by default, agent when given", async () => {
    const { actor } = await newRunningActor();
    await actor.setTitle("api logs");
    expect(actor.snapshot().titleSource).toBe("user");
    await actor.setTitle("Fix login bug", "agent");
    expect(actor.snapshot().title).toBe("Fix login bug");
    expect(actor.snapshot().titleSource).toBe("agent");
    await actor.setTitle(undefined);
    expect(actor.snapshot().title).toBeUndefined();
    expect(actor.snapshot().titleSource).toBeUndefined();
  });

  test("restored actor adopts the backend session title", async () => {
    const runtime = createFakeTerminalRuntime();
    const actor = new TerminalSessionActor({
      id: "t1",
      worktreePath: "/wt",
      runtime: runtime.runtime,
      spawn: { shell: "/bin/zsh", cwd: "/wt", env: {}, cols: 80, rows: 24 },
      backendSession: {
        id: "t1",
        backend: "tmux",
        worktreePath: "/wt",
        cwd: "/wt",
        shell: "/bin/zsh",
        cols: 80,
        rows: 24,
        createdAt: new Date().toISOString(),
        title: "migrations",
      },
    });
    await actor.start();
    expect(actor.snapshot().title).toBe("migrations");
    // Legacy records carry no provenance; default to user so agent activity
    // never clobbers a restored title.
    expect(actor.snapshot().titleSource).toBe("user");
  });

  test("setTitle routes persistence through the backend and reflects failure", async () => {
    const runtime = createFakeTerminalRuntime();
    const persisted: Array<string | undefined> = [];
    let failNext = false;
    const backendSession = {
      id: "t1",
      backend: "tmux" as const,
      worktreePath: "/wt",
      cwd: "/wt",
      shell: "/bin/zsh",
      cols: 80,
      rows: 24,
      createdAt: new Date().toISOString(),
    };
    const actor = new TerminalSessionActor({
      id: "t1",
      worktreePath: "/wt",
      runtime: runtime.runtime,
      spawn: { shell: "/bin/zsh", cwd: "/wt", env: {}, cols: 80, rows: 24 },
      backend: {
        id: "tmux",
        label: "tmux",
        isAvailable: () => ({ available: true }),
        async createSession() {
          throw new Error("not used");
        },
        async onDaemonShutdown() {},
        async terminateSession() {},
        async persistTitle(_session, title) {
          if (failNext) throw new Error("disk full");
          persisted.push(title);
        },
      },
      backendSession,
    });
    await actor.start();
    await actor.setTitle("persisted");
    expect(persisted).toEqual(["persisted"]);
    expect(actor.snapshot().title).toBe("persisted");
    expect((backendSession as { title?: string }).title).toBe("persisted");
    // A persistence failure must leave the previous title intact.
    failNext = true;
    await expect(actor.setTitle("doomed")).rejects.toThrow(/disk full/);
    expect(actor.snapshot().title).toBe("persisted");
  });
});

describe("TerminalSessionActor output sequencing & replay", () => {
  test("output frames carry monotonic seq from 1", async () => {
    const { actor, runtime } = await newRunningActor();
    const sink = makeSink();
    await actor.attach({
      attachmentId: "a1",
      cols: 80,
      rows: 24,
      desiredControl: "controller",
      sink,
    });
    runtime.spawned[0]!.emit("hello");
    runtime.spawned[0]!.emit("world");
    // The actor processes data synchronously inside its onData handler so
    // frames are already in the sink when emit returns.
    const outputs = sink.frames.filter((f) => f.type === "output");
    expect(outputs.map((f) => (f as any).seq)).toEqual([1, 2]);
  });

  test("late attach gets replay frames followed by replay-done, then live", async () => {
    const { actor, runtime } = await newRunningActor();
    const early = makeSink();
    await actor.attach({
      attachmentId: "e1",
      cols: 80,
      rows: 24,
      desiredControl: "controller",
      sink: early,
    });
    runtime.spawned[0]!.emit("first");
    runtime.spawned[0]!.emit("second");

    const late = makeSink();
    await actor.attach({
      attachmentId: "l1",
      cols: 80,
      rows: 24,
      desiredControl: "viewer",
      sink: late,
    });
    const replayOutputs = late.frames.filter(
      (f) => f.type === "output" && (f as any).replay,
    );
    expect(replayOutputs).toHaveLength(2);
    expect(late.frames.some((f) => f.type === "replay-done")).toBe(true);

    runtime.spawned[0]!.emit("live");
    const liveOutputs = late.frames.filter(
      (f) => f.type === "output" && !(f as any).replay,
    );
    expect(liveOutputs).toHaveLength(1);
    expect((liveOutputs[0] as any).data).toBe("live");
  });

  test("attach with lastSeenOutputSeq older than retained reports replay-gap", async () => {
    const runtime = createFakeTerminalRuntime();
    const actor = new TerminalSessionActor({
      id: "t1",
      worktreePath: "/wt",
      runtime: runtime.runtime,
      spawn: { shell: "/bin/zsh", cwd: "/wt", env: {}, cols: 80, rows: 24 },
      historyCapacityBytes: 4,
    });
    await actor.start();
    runtime.spawned[0]!.emit("aaaa"); // 1
    runtime.spawned[0]!.emit("bbbb"); // 2 → drops 1
    const sink = makeSink();
    await actor.attach({
      attachmentId: "a1",
      cols: 80,
      rows: 24,
      desiredControl: "viewer",
      sink,
      lastSeenOutputSeq: 0,
    });
    expect(sink.frames.some((f) => f.type === "error" && (f as any).code === "replay-gap")).toBe(true);
  });

  test("replay gap prepends tracked-mode restore prefix to the first replay frame", async () => {
    const runtime = createFakeTerminalRuntime();
    const actor = new TerminalSessionActor({
      id: "t1",
      worktreePath: "/wt",
      runtime: runtime.runtime,
      spawn: { shell: "/bin/zsh", cwd: "/wt", env: {}, cols: 80, rows: 24 },
      historyCapacityBytes: 4,
    });
    await actor.start();
    // Mode-setting bytes land in chunk 1, which the journal then evicts.
    runtime.spawned[0]!.emit("\x1b[?1049h\x1b[?2004h"); // 1
    runtime.spawned[0]!.emit("tail"); // 2 → drops 1
    const sink = makeSink();
    await actor.attach({
      attachmentId: "a1",
      cols: 80,
      rows: 24,
      desiredControl: "viewer",
      sink,
      lastSeenOutputSeq: 0,
    });
    const replays = sink.frames.filter(
      (f) => f.type === "output" && (f as any).replay,
    );
    expect(replays).toHaveLength(1);
    expect((replays[0] as any).data).toBe("\x1b[?1049h\x1b[?2004htail");
  });

  test("gapless replay carries no restore prefix", async () => {
    const runtime = createFakeTerminalRuntime();
    const actor = new TerminalSessionActor({
      id: "t1",
      worktreePath: "/wt",
      runtime: runtime.runtime,
      spawn: { shell: "/bin/zsh", cwd: "/wt", env: {}, cols: 80, rows: 24 },
    });
    await actor.start();
    runtime.spawned[0]!.emit("\x1b[?1049h");
    runtime.spawned[0]!.emit("tail");
    const sink = makeSink();
    await actor.attach({
      attachmentId: "a1",
      cols: 80,
      rows: 24,
      desiredControl: "viewer",
      sink,
    });
    const replays = sink.frames.filter(
      (f) => f.type === "output" && (f as any).replay,
    );
    expect(replays.map((f) => (f as any).data)).toEqual(["\x1b[?1049h", "tail"]);
  });

  test("replay gap triggers backend refreshScreenState when the backend implements it", async () => {
    const runtime = createFakeTerminalRuntime();
    const refreshed: string[] = [];
    const backendSession = {
      id: "t1",
      backend: "tmux" as const,
      worktreePath: "/wt",
      cwd: "/wt",
      shell: "/bin/zsh",
      cols: 80,
      rows: 24,
      createdAt: new Date().toISOString(),
      meta: { tmuxSessionName: "wos-term-t1" },
    };
    const actor = new TerminalSessionActor({
      id: "t1",
      worktreePath: "/wt",
      runtime: runtime.runtime,
      spawn: { shell: "/bin/zsh", cwd: "/wt", env: {}, cols: 80, rows: 24 },
      historyCapacityBytes: 4,
      backend: {
        id: "tmux",
        label: "tmux",
        isAvailable: () => ({ available: true }),
        async createSession() {
          throw new Error("not used");
        },
        async onDaemonShutdown() {},
        async terminateSession() {},
        refreshScreenState(session) {
          refreshed.push(session.id);
        },
      },
      backendSession,
    });
    await actor.start();
    runtime.spawned[0]!.emit("aaaa"); // 1
    runtime.spawned[0]!.emit("bbbb"); // 2 → drops 1
    const sink = makeSink();
    await actor.attach({
      attachmentId: "a1",
      cols: 80,
      rows: 24,
      desiredControl: "viewer",
      sink,
      lastSeenOutputSeq: 0,
    });
    // The gap means this client can never recover the missed bytes; the actor
    // must ask the backend to re-emit the full screen state alongside the
    // replay-gap error.
    expect(sink.frames.some((f) => f.type === "error" && (f as any).code === "replay-gap")).toBe(true);
    expect(refreshed).toEqual(["t1"]);
  });

  test("replay gap without a refresh-capable backend only reports the error", async () => {
    const runtime = createFakeTerminalRuntime();
    const actor = new TerminalSessionActor({
      id: "t1",
      worktreePath: "/wt",
      runtime: runtime.runtime,
      spawn: { shell: "/bin/zsh", cwd: "/wt", env: {}, cols: 80, rows: 24 },
      historyCapacityBytes: 4,
    });
    await actor.start();
    runtime.spawned[0]!.emit("aaaa");
    runtime.spawned[0]!.emit("bbbb");
    const sink = makeSink();
    // Must not throw even though no backend/refresh hook is present.
    await actor.attach({
      attachmentId: "a1",
      cols: 80,
      rows: 24,
      desiredControl: "viewer",
      sink,
      lastSeenOutputSeq: 0,
    });
    expect(sink.frames.some((f) => f.type === "error" && (f as any).code === "replay-gap")).toBe(true);
  });

  test("multi-byte UTF-8 split across two PTY chunks is reassembled", async () => {
    const { actor, runtime } = await newRunningActor();
    const sink = makeSink();
    await actor.attach({
      attachmentId: "a1",
      cols: 80,
      rows: 24,
      desiredControl: "controller",
      sink,
    });
    // "Используйте" — "ь" is bytes [0xD1, 0x8C]. Split so D1 ends chunk 1
    // and 8C starts chunk 2; a stateless decoder would emit U+FFFD twice.
    const word = new TextEncoder().encode("Используйте");
    const splitAt = word.length - 1;
    runtime.spawned[0]!.emit(word.subarray(0, splitAt));
    runtime.spawned[0]!.emit(word.subarray(splitAt));
    const outputs = sink.frames.filter((f) => f.type === "output");
    const joined = outputs.map((f) => (f as any).data as string).join("");
    expect(joined).toBe("Используйте");
    expect(joined.includes("�")).toBe(false);
  });

  test("replay reassembles multi-byte UTF-8 across journal chunk boundaries", async () => {
    const { actor, runtime } = await newRunningActor();
    // Two chunks that split the trailing Cyrillic char of the word.
    const word = new TextEncoder().encode("Используйте");
    runtime.spawned[0]!.emit(word.subarray(0, word.length - 1));
    runtime.spawned[0]!.emit(word.subarray(word.length - 1));

    const late = makeSink();
    await actor.attach({
      attachmentId: "l1",
      cols: 80,
      rows: 24,
      desiredControl: "viewer",
      sink: late,
    });
    const replayOutputs = late.frames.filter(
      (f) => f.type === "output" && (f as any).replay,
    );
    const joined = replayOutputs.map((f) => (f as any).data as string).join("");
    expect(joined.endsWith("Используйте")).toBe(true);
    expect(joined.includes("�")).toBe(false);
  });
});

describe("TerminalSessionActor control semantics", () => {
  test("viewer input is rejected with control-denied", async () => {
    const { actor, runtime } = await newRunningActor();
    const ctrl = makeSink();
    const view = makeSink();
    await actor.attach({
      attachmentId: "c1",
      cols: 80,
      rows: 24,
      desiredControl: "controller",
      sink: ctrl,
    });
    await actor.attach({
      attachmentId: "v1",
      cols: 80,
      rows: 24,
      desiredControl: "viewer",
      sink: view,
    });
    await actor.input("v1", "x");
    expect(runtime.spawned[0]!.writes.length).toBe(0);
    expect(view.frames.some((f) => f.type === "error" && (f as any).code === "control-denied")).toBe(true);
  });

  test("request transfers control from current controller to requester", async () => {
    const { actor } = await newRunningActor();
    const ctrl = makeSink();
    const view = makeSink();
    await actor.attach({
      attachmentId: "c1",
      cols: 80,
      rows: 24,
      desiredControl: "controller",
      sink: ctrl,
    });
    await actor.attach({
      attachmentId: "v1",
      cols: 80,
      rows: 24,
      desiredControl: "viewer",
      sink: view,
    });
    await actor.requestControl("v1");
    expect(actor.snapshot().control?.controllerAttachmentId).toBe("v1");
    // Both attachments receive a control frame with their new ownership state.
    expect(view.frames.some((f) => f.type === "control" && (f as any).isController === true)).toBe(true);
    expect(ctrl.frames.some((f) => f.type === "control" && (f as any).isController === false)).toBe(true);
  });

  test("release relinquishes control without transferring to anyone", async () => {
    const { actor } = await newRunningActor();
    const sink = makeSink();
    await actor.attach({
      attachmentId: "c1",
      cols: 80,
      rows: 24,
      desiredControl: "controller",
      sink,
    });
    await actor.releaseControl("c1");
    expect(actor.snapshot().control?.controllerAttachmentId).toBeNull();
  });
});

describe("TerminalSessionActor exit handling", () => {
  test("PTY exit notifies attachments with status + exit frame and closes them", async () => {
    const { actor, runtime } = await newRunningActor();
    const sink = makeSink();
    await actor.attach({
      attachmentId: "a1",
      cols: 80,
      rows: 24,
      desiredControl: "controller",
      sink,
    });
    runtime.spawned[0]!.exit({ exitCode: 2 });
    // Exit handling is queued; let the microtask run.
    await Promise.resolve();
    await Promise.resolve();
    expect(actor.snapshot().status).toBe("exited");
    expect(actor.snapshot().exit?.exitCode).toBe(2);
    expect(sink.frames.some((f) => f.type === "exit")).toBe(true);
    expect(sink.closes.length).toBeGreaterThan(0);
  });

  test("attaching to an already-exited session sends exit and closes", async () => {
    const { actor, runtime } = await newRunningActor();
    runtime.spawned[0]!.exit({ exitCode: 0 });
    await Promise.resolve();
    await Promise.resolve();
    const sink = makeSink();
    await actor.attach({
      attachmentId: "a1",
      cols: 80,
      rows: 24,
      desiredControl: "viewer",
      sink,
    });
    expect(sink.frames.some((f) => f.type === "hello-ack")).toBe(true);
    expect(sink.frames.some((f) => f.type === "exit")).toBe(true);
    expect(sink.closes.length).toBe(1);
  });
});

describe("TerminalSessionActor detach & backpressure", () => {
  test("detach removes attachment and broadcasts the new list", async () => {
    const { actor } = await newRunningActor();
    const ctrl = makeSink();
    const view = makeSink();
    await actor.attach({
      attachmentId: "c1",
      cols: 80,
      rows: 24,
      desiredControl: "controller",
      sink: ctrl,
    });
    await actor.attach({
      attachmentId: "v1",
      cols: 80,
      rows: 24,
      desiredControl: "viewer",
      sink: view,
    });
    await actor.detach("v1");
    expect(actor.snapshot().attachments?.map((a) => a.attachmentId)).toEqual(["c1"]);
    expect(ctrl.frames.some((f) => f.type === "attachments")).toBe(true);
  });

  test("slow client exceeding budget receives backpressure error and is closed", async () => {
    const runtime = createFakeTerminalRuntime();
    const actor = new TerminalSessionActor({
      id: "t1",
      worktreePath: "/wt",
      runtime: runtime.runtime,
      spawn: { shell: "/bin/zsh", cwd: "/wt", env: {}, cols: 80, rows: 24 },
      perAttachmentQueueBytes: 100,
    });
    await actor.start();
    const slow = makeSink();
    slow.setBuffered(200);
    await actor.attach({
      attachmentId: "a1",
      cols: 80,
      rows: 24,
      desiredControl: "viewer",
      sink: slow,
    });
    runtime.spawned[0]!.emit("data");
    expect(slow.frames.some((f) => f.type === "error" && (f as any).code === "backpressure")).toBe(true);
    expect(slow.closes.length).toBeGreaterThan(0);
    expect(actor.snapshot().status).toBe("running");
  });
});
