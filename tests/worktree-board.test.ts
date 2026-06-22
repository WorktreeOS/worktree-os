import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  appendOrder,
  clearAssignment,
  getAssignment,
  loadBoard,
  needsNormalization,
  orderBetween,
  reassignStatusToUnassigned,
  setAssignment,
  WorktreeBoardError,
} from "@worktreeos/core/worktree-board";

let tmpHome: string;
let filePath: string;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "wos-board-"));
  filePath = join(tmpHome, "board.json");
});

afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true });
});

describe("fractional order helper", () => {
  test("orderBetween covers the four placements", () => {
    expect(orderBetween(undefined, undefined)).toBe(0);
    expect(orderBetween(undefined, 5)).toBe(4);
    expect(orderBetween(5, undefined)).toBe(6);
    expect(orderBetween(2, 4)).toBe(3);
  });

  test("midpoint inserts strictly between neighbors without touching them", () => {
    const mid = orderBetween(2, 3);
    expect(mid).toBeGreaterThan(2);
    expect(mid).toBeLessThan(3);
    expect(mid).toBe(2.5);
  });

  test("appendOrder appends after the current max", () => {
    expect(appendOrder(undefined)).toBe(0);
    expect(appendOrder(7)).toBe(8);
  });

  test("needsNormalization detects exhausted gaps", () => {
    expect(needsNormalization([0, 1, 2])).toBe(false);
    expect(needsNormalization([0, 0.0000001, 1])).toBe(true);
  });
});

describe("board store", () => {
  test("empty store when file is absent", async () => {
    const board = await loadBoard({ filePath });
    expect(board.assignments).toEqual({});
  });

  test("setAssignment and getAssignment round-trip", async () => {
    const wt = resolve(tmpHome, "wt-a");
    await setAssignment(wt, "review", 2.5, { filePath });
    const board = await loadBoard({ filePath });
    expect(getAssignment(board, wt)).toEqual({ statusId: "review", order: 2.5 });
  });

  test("clearAssignment marks unassigned", async () => {
    const wt = resolve(tmpHome, "wt-a");
    await setAssignment(wt, "review", 1, { filePath });
    await clearAssignment(wt, { filePath });
    const board = await loadBoard({ filePath });
    expect(getAssignment(board, wt)).toBeUndefined();
  });

  test("reassignStatusToUnassigned drops only the deleted status", async () => {
    const a = resolve(tmpHome, "wt-a");
    const b = resolve(tmpHome, "wt-b");
    await setAssignment(a, "review", 0, { filePath });
    await setAssignment(b, "develop", 0, { filePath });
    await reassignStatusToUnassigned("review", { filePath });
    const board = await loadBoard({ filePath });
    expect(getAssignment(board, a)).toBeUndefined();
    expect(getAssignment(board, b)).toEqual({ statusId: "develop", order: 0 });
  });

  test("setAssignment rejects invalid status id and order", async () => {
    const wt = resolve(tmpHome, "wt-a");
    await expect(setAssignment(wt, "", 0, { filePath })).rejects.toBeInstanceOf(
      WorktreeBoardError,
    );
    await expect(
      setAssignment(wt, "review", Number.NaN, { filePath }),
    ).rejects.toBeInstanceOf(WorktreeBoardError);
  });

  test("tolerates malformed / stale entries on read", async () => {
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        assignments: {
          "/abs/ok": { statusId: "review", order: 1 },
          "/abs/bad1": { statusId: "", order: 1 },
          "/abs/bad2": { statusId: "x", order: "nope" },
          "/abs/bad3": "garbage",
        },
      }),
    );
    const board = await loadBoard({ filePath });
    expect(Object.keys(board.assignments)).toEqual([resolve("/abs/ok")]);
  });
});
