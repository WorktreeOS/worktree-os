import { describe, expect, test } from "bun:test";
import { SnapshotCoalescer, type SnapshotFrame } from "./snapshot-stream";
import type { TerminalSessionMetadata } from "../terminal-protocol";

function session(id: string): TerminalSessionMetadata {
  return {
    id,
    worktreePath: "/wt/x",
    status: "running",
    shell: "/bin/zsh",
    cwd: "/wt/x",
    cols: 80,
    rows: 24,
    createdAt: "2026-06-15T10:00:00.000Z",
  };
}

function frame(id: string, line: string): SnapshotFrame {
  return {
    id,
    session: session(id),
    snapshot: { available: true, snapshot: { lines: [line], cols: 80, rows: 24 } },
  };
}

describe("SnapshotCoalescer", () => {
  test("coalesces multiple pushes within one tick into a single flush", () => {
    const flushes: Array<ReadonlyMap<string, SnapshotFrame>> = [];
    let pending: (() => void) | null = null;
    const coalescer = new SnapshotCoalescer(
      (latest) => flushes.push(new Map(latest)),
      (cb) => {
        pending = cb;
      },
    );

    coalescer.push(frame("a", "1"));
    coalescer.push(frame("b", "1"));
    coalescer.push(frame("a", "2")); // newer frame for "a" supersedes
    // Nothing has flushed yet — only one tick was scheduled.
    expect(flushes).toHaveLength(0);

    pending!(); // run the scheduled tick
    expect(flushes).toHaveLength(1);
    const flushed = flushes[0]!;
    expect(flushed.size).toBe(2);
    expect(flushed.get("a")?.snapshot).toMatchObject({ available: true });
    // The latest "a" frame won.
    const a = flushed.get("a")!;
    if (a.snapshot.available) expect(a.snapshot.snapshot.lines).toEqual(["2"]);
  });

  test("schedules a fresh tick after a flush", () => {
    let flushCount = 0;
    let pending: (() => void) | null = null;
    const coalescer = new SnapshotCoalescer(
      () => {
        flushCount += 1;
      },
      (cb) => {
        pending = cb;
      },
    );

    coalescer.push(frame("a", "1"));
    pending!();
    expect(flushCount).toBe(1);

    coalescer.push(frame("a", "2"));
    expect(flushCount).toBe(1); // not flushed until the next tick runs
    pending!();
    expect(flushCount).toBe(2);
  });

  test("remove drops a session's latest frame", () => {
    let latestSize = -1;
    let pending: (() => void) | null = null;
    const coalescer = new SnapshotCoalescer(
      (latest) => {
        latestSize = latest.size;
      },
      (cb) => {
        pending = cb;
      },
    );
    coalescer.push(frame("a", "1"));
    coalescer.push(frame("b", "1"));
    coalescer.remove("a");
    pending!();
    expect(latestSize).toBe(1);
  });
});
