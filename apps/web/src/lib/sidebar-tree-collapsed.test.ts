import { describe, expect, test } from "bun:test";
import {
  readCollapsedWorktrees,
  SIDEBAR_TREE_COLLAPSED_STORAGE_KEY,
  writeCollapsedWorktrees,
} from "./sidebar-tree-collapsed";

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => data.clear(),
    key: () => null,
    get length() {
      return data.size;
    },
  } as Storage;
}

describe("readCollapsedWorktrees", () => {
  test("defaults to empty with no storage", () => {
    expect(readCollapsedWorktrees(null)).toEqual(new Set());
    expect(readCollapsedWorktrees(undefined)).toEqual(new Set());
  });

  test("defaults to empty when unset", () => {
    expect(readCollapsedWorktrees(fakeStorage())).toEqual(new Set());
  });

  test("reads back a stored set of paths", () => {
    const storage = fakeStorage({
      [SIDEBAR_TREE_COLLAPSED_STORAGE_KEY]: JSON.stringify(["/wt/a", "/wt/b"]),
    });
    expect(readCollapsedWorktrees(storage)).toEqual(new Set(["/wt/a", "/wt/b"]));
  });

  test("ignores non-string entries and malformed JSON", () => {
    const storage = fakeStorage({
      [SIDEBAR_TREE_COLLAPSED_STORAGE_KEY]: JSON.stringify(["/wt/a", 42, null]),
    });
    expect(readCollapsedWorktrees(storage)).toEqual(new Set(["/wt/a"]));

    const malformed = fakeStorage({ [SIDEBAR_TREE_COLLAPSED_STORAGE_KEY]: "{not json" });
    expect(readCollapsedWorktrees(malformed)).toEqual(new Set());

    const notArray = fakeStorage({
      [SIDEBAR_TREE_COLLAPSED_STORAGE_KEY]: JSON.stringify({ a: 1 }),
    });
    expect(readCollapsedWorktrees(notArray)).toEqual(new Set());
  });

  test("falls back to empty when getItem throws", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(readCollapsedWorktrees(storage)).toEqual(new Set());
  });
});

describe("writeCollapsedWorktrees", () => {
  test("round-trips a non-empty set", () => {
    const storage = fakeStorage();
    writeCollapsedWorktrees(new Set(["/wt/a", "/wt/b"]), storage);
    expect(readCollapsedWorktrees(storage)).toEqual(new Set(["/wt/a", "/wt/b"]));
  });

  test("clears the key entirely once the set is empty", () => {
    const storage = fakeStorage({
      [SIDEBAR_TREE_COLLAPSED_STORAGE_KEY]: JSON.stringify(["/wt/a"]),
    });
    writeCollapsedWorktrees(new Set(), storage);
    expect(storage.getItem(SIDEBAR_TREE_COLLAPSED_STORAGE_KEY)).toBeNull();
  });

  test("is a no-op with no storage", () => {
    expect(() => writeCollapsedWorktrees(new Set(["/wt/a"]), null)).not.toThrow();
    expect(() => writeCollapsedWorktrees(new Set(["/wt/a"]), undefined)).not.toThrow();
  });

  test("swallows a setItem throw (quota / privacy mode)", () => {
    const storage = {
      setItem: () => {
        throw new Error("quota exceeded");
      },
    } as unknown as Storage;
    expect(() => writeCollapsedWorktrees(new Set(["/wt/a"]), storage)).not.toThrow();
  });
});
