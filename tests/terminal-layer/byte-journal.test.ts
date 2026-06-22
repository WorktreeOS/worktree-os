import { describe, expect, test } from "bun:test";
import { ByteJournal } from "@worktreeos/daemon/terminal-layer/byte-journal";

const encoder = new TextEncoder();

function b(s: string): Uint8Array {
  return encoder.encode(s);
}

describe("ByteJournal", () => {
  test("assigns monotonic sequence numbers starting at 1", () => {
    const j = new ByteJournal();
    const a = j.append(b("a"));
    const c = j.append(b("c"));
    expect(a.seq).toBe(1);
    expect(c.seq).toBe(2);
    expect(j.latestSequence()).toBe(2);
  });

  test("empty chunks do not advance the sequence", () => {
    const j = new ByteJournal();
    const empty = j.append(new Uint8Array());
    expect(empty.seq).toBe(0);
    expect(j.latestSequence()).toBe(0);
    const one = j.append(b("x"));
    expect(one.seq).toBe(1);
  });

  test("evicts oldest chunks once capacity is exceeded", () => {
    const j = new ByteJournal({ capacityBytes: 6 });
    j.append(b("aaa")); // 3
    j.append(b("bbb")); // 6
    j.append(b("ccc")); // 9 → drops "aaa"
    expect(j.bytesRetained()).toBeLessThanOrEqual(6);
    expect(j.firstRetainedSequence()).toBeGreaterThan(1);
  });

  test("planReplay returns no chunks when fromSeq is current latest", () => {
    const j = new ByteJournal();
    j.append(b("a"));
    j.append(b("b"));
    const plan = j.planReplay(2);
    expect(plan.complete).toBe(true);
    expect(plan.gap).toBe(false);
    expect(plan.chunks).toEqual([]);
  });

  test("planReplay returns chunks after fromSeq when retained", () => {
    const j = new ByteJournal();
    j.append(b("a")); // 1
    j.append(b("b")); // 2
    j.append(b("c")); // 3
    const plan = j.planReplay(1);
    expect(plan.chunks.map((c) => c.seq)).toEqual([2, 3]);
    expect(plan.complete).toBe(true);
  });

  test("planReplay reports gap when fromSeq is older than retained", () => {
    const j = new ByteJournal({ capacityBytes: 4 });
    j.append(b("aaaa")); // 1
    j.append(b("bbbb")); // 2 → drops 1
    const plan = j.planReplay(0);
    expect(plan.gap).toBe(true);
    expect(plan.complete).toBe(false);
    expect(plan.chunks[0]!.seq).toBe(2);
  });

  test("boundary advertises latest sequence and retained bytes", () => {
    const j = new ByteJournal();
    j.append(b("hi"));
    const boundary = j.boundary();
    expect(boundary.latestSeq).toBe(1);
    expect(boundary.firstRetainedSeq).toBe(1);
    expect(boundary.retainedBytes).toBe(2);
    expect(boundary.checkpointSeq).toBeUndefined();
  });

  test("clear drops retained chunks but preserves latest sequence", () => {
    const j = new ByteJournal();
    j.append(b("a"));
    j.append(b("b"));
    j.clear();
    expect(j.bytesRetained()).toBe(0);
    expect(j.latestSequence()).toBe(2);
    expect(j.planReplay(0).gap).toBe(false);
  });
});
