import { describe, expect, test } from "bun:test";
import {
  TERMINAL_ORDER_STORAGE_KEY,
  applySessionOrder,
  pruneTerminalOrder,
  readTerminalOrder,
  writeTerminalOrder,
} from "./sidebar-terminal-order";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    map,
  };
}

/* Minimal session shape — the projection only needs `id`; `createdAt` is
 * carried to make the "incoming order is createdAt order" intent explicit. */
function s(id: string, createdAt: string) {
  return { id, createdAt };
}

describe("readTerminalOrder", () => {
  test("returns stored string ids", () => {
    const storage = fakeStorage({
      [TERMINAL_ORDER_STORAGE_KEY]: JSON.stringify(["b", "a"]),
    });
    expect(readTerminalOrder(storage)).toEqual(["b", "a"]);
  });

  test("empty storage yields an empty array", () => {
    expect(readTerminalOrder(fakeStorage())).toEqual([]);
  });

  test("garbage / non-array storage yields an empty array", () => {
    expect(
      readTerminalOrder(
        fakeStorage({ [TERMINAL_ORDER_STORAGE_KEY]: "not json" }),
      ),
    ).toEqual([]);
    expect(
      readTerminalOrder(
        fakeStorage({ [TERMINAL_ORDER_STORAGE_KEY]: JSON.stringify({}) }),
      ),
    ).toEqual([]);
  });

  test("filters non-string entries", () => {
    expect(
      readTerminalOrder(
        fakeStorage({
          [TERMINAL_ORDER_STORAGE_KEY]: JSON.stringify(["a", 1, null, "b"]),
        }),
      ),
    ).toEqual(["a", "b"]);
  });
});

describe("writeTerminalOrder", () => {
  test("round-trips through read", () => {
    const storage = fakeStorage();
    writeTerminalOrder(["x", "y"], storage);
    expect(readTerminalOrder(storage)).toEqual(["x", "y"]);
  });
});

describe("applySessionOrder", () => {
  const sessions = [s("a", "1"), s("b", "2"), s("c", "3")];

  test("known ids come first in stored order", () => {
    expect(applySessionOrder(sessions, ["c", "a"]).map((x) => x.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  test("a newly spawned session appends after the ordered ones", () => {
    // `a`, `b` reordered; `c` is new and not in the stored order.
    expect(applySessionOrder(sessions, ["b", "a"]).map((x) => x.id)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  test("multiple unknowns keep their incoming (createdAt) order", () => {
    expect(applySessionOrder(sessions, ["c"]).map((x) => x.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  test("empty stored order keeps the incoming order", () => {
    expect(applySessionOrder(sessions, []).map((x) => x.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("tolerates stale / cross-worktree ids not present in the list", () => {
    // `z` belongs to another worktree (or is gone); it is skipped, not errored.
    expect(applySessionOrder(sessions, ["z", "b"]).map((x) => x.id)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  test("ignores duplicate ids in the stored order", () => {
    expect(applySessionOrder(sessions, ["a", "a", "b"]).map((x) => x.id)).toEqual(
      ["a", "b", "c"],
    );
  });

  test("returns a fresh array (no input mutation)", () => {
    const out = applySessionOrder(sessions, ["b"]);
    expect(out).not.toBe(sessions);
    expect(sessions.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
});

describe("pruneTerminalOrder", () => {
  test("drops ids that are no longer live, preserving order", () => {
    expect(
      pruneTerminalOrder(["a", "b", "c"], new Set(["c", "a"])),
    ).toEqual(["a", "c"]);
  });

  test("no-op when every id is still live", () => {
    expect(pruneTerminalOrder(["a", "b"], new Set(["a", "b"]))).toEqual([
      "a",
      "b",
    ]);
  });

  test("empties when none are live", () => {
    expect(pruneTerminalOrder(["a", "b"], new Set())).toEqual([]);
  });
});
