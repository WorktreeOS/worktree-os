import { describe, expect, test } from "bun:test";
import {
  createFakeTerminalProcess,
  createFakeTerminalRuntime,
} from "@worktreeos/daemon/terminal-layer/testing";

const SPAWN = {
  shell: "/bin/zsh",
  cwd: "/tmp/x",
  env: {},
  cols: 80,
  rows: 24,
};

describe("fake terminal process", () => {
  test("delivers emitted bytes to data listeners in order", () => {
    const fake = createFakeTerminalProcess(SPAWN);
    const received: string[] = [];
    const decoder = new TextDecoder();
    fake.process.onData((chunk) => received.push(decoder.decode(chunk)));
    fake.emit("first");
    fake.emit("second");
    expect(received).toEqual(["first", "second"]);
  });

  test("records writes from the actor side", () => {
    const fake = createFakeTerminalProcess(SPAWN);
    fake.process.write("hello");
    fake.process.write(new Uint8Array([97, 98]));
    expect(fake.writes).toHaveLength(2);
  });

  test("delivers exit exactly once and detaches listeners", () => {
    const fake = createFakeTerminalProcess(SPAWN);
    const exits: number[] = [];
    fake.process.onExit((info) => exits.push(info.exitCode ?? -1));
    fake.exit({ exitCode: 0 });
    fake.exit({ exitCode: 1 });
    expect(exits).toEqual([0]);
  });

  test("late exit subscriber receives the exit info via microtask", async () => {
    const fake = createFakeTerminalProcess(SPAWN);
    fake.exit({ exitCode: 2 });
    const received = await new Promise<number>((resolve) => {
      fake.process.onExit((info) => resolve(info.exitCode ?? -1));
    });
    expect(received).toBe(2);
  });

  test("unsubscribe stops data delivery for the detached listener", () => {
    const fake = createFakeTerminalProcess(SPAWN);
    const received: number[] = [];
    const off = fake.process.onData(() => received.push(1));
    fake.emit("a");
    off();
    fake.emit("b");
    expect(received).toEqual([1]);
  });

  test("dispose stops data delivery without sending an exit", () => {
    const fake = createFakeTerminalProcess(SPAWN);
    const events: string[] = [];
    fake.process.onData(() => events.push("data"));
    fake.process.onExit(() => events.push("exit"));
    fake.process.dispose();
    fake.emit("after-dispose");
    expect(events).toEqual([]);
    expect(fake.disposed).toBe(true);
  });
});

describe("fake terminal runtime", () => {
  test("isAvailable can be toggled for negative-path tests", () => {
    const handle = createFakeTerminalRuntime();
    expect(handle.runtime.isAvailable()).toBe(true);
    handle.setAvailable(false);
    expect(handle.runtime.isAvailable()).toBe(false);
  });

  test("records every spawn", () => {
    const handle = createFakeTerminalRuntime();
    handle.runtime.spawn(SPAWN);
    handle.runtime.spawn({ ...SPAWN, cols: 120 });
    expect(handle.spawned).toHaveLength(2);
    expect(handle.spawned[1]!.spawn.cols).toBe(120);
  });

  test("failNextSpawn throws once and clears", () => {
    const handle = createFakeTerminalRuntime();
    handle.failNextSpawn(new Error("boom"));
    expect(() => handle.runtime.spawn(SPAWN)).toThrow("boom");
    // Next spawn succeeds normally.
    handle.runtime.spawn(SPAWN);
    expect(handle.spawned).toHaveLength(1);
  });
});
