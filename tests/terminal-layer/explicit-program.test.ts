import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalSessionManager } from "@worktreeos/daemon/terminal-layer/manager";
import { createFakeTerminalRuntime } from "@worktreeos/daemon/terminal-layer/testing";
import type { AttachmentSink } from "@worktreeos/daemon/terminal-layer/actor";
import type { TerminalServerFrame } from "@worktreeos/daemon/terminal-layer/protocol";

const decoder = new TextDecoder();

function capturingSink(): { sink: AttachmentSink; frames: TerminalServerFrame[] } {
  const frames: TerminalServerFrame[] = [];
  return {
    frames,
    sink: {
      send: (frame) => frames.push(frame),
      close: () => {},
      bufferedAmount: () => 0,
    },
  };
}

const EXEC_ARGS = [
  "compose",
  "-p",
  "wos-demo",
  "-f",
  "/sess/compose.yaml",
  "exec",
  "api",
  "sh",
];

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "wos-term-exec-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("explicit-program terminal sessions", () => {
  test("spawns the explicit program and argv", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    await mgr.create({ worktreePath: tmp, shell: "docker", args: EXEC_ARGS });
    expect(r.spawned.length).toBe(1);
    expect(r.spawned[0]!.spawn.shell).toBe("docker");
    expect(r.spawned[0]!.spawn.args).toEqual(EXEC_ARGS);
  });

  test("forwards input and resize to the spawned process", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    const meta = await mgr.create({
      worktreePath: tmp,
      shell: "docker",
      args: EXEC_ARGS,
    });
    const { sink } = capturingSink();
    const attachment = await mgr.attach(meta.id, {
      attachmentId: "a1",
      clientId: "c1",
      cols: 80,
      rows: 24,
      desiredControl: "controller",
      sink,
    });
    await mgr.input(meta.id, attachment.attachmentId, "ls\n");
    await mgr.resize(meta.id, attachment.attachmentId, 120, 40);
    const proc = r.spawned[0]!;
    expect(proc.writes.map((w) => decoder.decode(w))).toContain("ls\n");
    expect(proc.resizes).toContainEqual({ cols: 120, rows: 40 });
  });

  test("propagates the spawned process exit code in the exit frame", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    const meta = await mgr.create({
      worktreePath: tmp,
      shell: "docker",
      args: EXEC_ARGS,
    });
    const { sink, frames } = capturingSink();
    await mgr.attach(meta.id, {
      attachmentId: "a1",
      clientId: "c1",
      cols: 80,
      rows: 24,
      desiredControl: "controller",
      sink,
    });
    r.spawned[0]!.exit({ exitCode: 7 });
    await Promise.resolve();
    const exitFrame = frames.find((f) => f.type === "exit");
    expect(exitFrame).toBeDefined();
    expect(exitFrame!.type === "exit" && exitFrame.exit.exitCode).toBe(7);
    expect(mgr.get(meta.id)?.exit?.exitCode).toBe(7);
  });
});
