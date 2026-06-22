import { describe, expect, test } from "bun:test";
import {
  WORKTREE_ORDER_STORAGE_KEY,
  applyWorktreeOrder,
  pruneWorktreeOrder,
  readWorktreeOrder,
  writeWorktreeOrder,
} from "./sidebar-worktree-order";

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

function w(path: string) {
  return { path };
}

describe("readWorktreeOrder", () => {
  test("returns stored string paths", () => {
    const storage = fakeStorage({
      [WORKTREE_ORDER_STORAGE_KEY]: JSON.stringify(["/b", "/a"]),
    });
    expect(readWorktreeOrder(storage)).toEqual(["/b", "/a"]);
  });

  test("empty storage yields an empty array", () => {
    expect(readWorktreeOrder(fakeStorage())).toEqual([]);
  });

  test("garbage / non-array storage yields an empty array", () => {
    expect(
      readWorktreeOrder(fakeStorage({ [WORKTREE_ORDER_STORAGE_KEY]: "}{" })),
    ).toEqual([]);
    expect(
      readWorktreeOrder(
        fakeStorage({ [WORKTREE_ORDER_STORAGE_KEY]: JSON.stringify("x") }),
      ),
    ).toEqual([]);
  });
});

describe("writeWorktreeOrder", () => {
  test("round-trips through read", () => {
    const storage = fakeStorage();
    writeWorktreeOrder(["/a", "/b"], storage);
    expect(readWorktreeOrder(storage)).toEqual(["/a", "/b"]);
  });
});

describe("applyWorktreeOrder", () => {
  // Canonical (sortWorktreesForSidebar) order: failed/source/rest already ranked.
  const worktrees = [w("/failed"), w("/source"), w("/a"), w("/b")];

  test("known paths come first in stored order, rest keep canonical order", () => {
    expect(
      applyWorktreeOrder(worktrees, ["/b", "/a"]).map((x) => x.path),
    ).toEqual(["/b", "/a", "/failed", "/source"]);
  });

  test("a newly created worktree keeps its canonical rank after the ordered ones", () => {
    // /a, /b dragged; /failed and /source are not in the stored order.
    expect(
      applyWorktreeOrder(worktrees, ["/a", "/b"]).map((x) => x.path),
    ).toEqual(["/a", "/b", "/failed", "/source"]);
  });

  test("empty stored order keeps the canonical order", () => {
    expect(applyWorktreeOrder(worktrees, []).map((x) => x.path)).toEqual([
      "/failed",
      "/source",
      "/a",
      "/b",
    ]);
  });

  test("tolerates stale / cross-project paths not present in the list", () => {
    // /other belongs to another project (or is gone); it is skipped.
    expect(
      applyWorktreeOrder(worktrees, ["/other", "/b"]).map((x) => x.path),
    ).toEqual(["/b", "/failed", "/source", "/a"]);
  });

  test("works over a filtered subset (Active-now / Home read sites)", () => {
    // Active now shows only a subset; the flat order still projects correctly.
    const subset = [w("/a"), w("/b")];
    expect(
      applyWorktreeOrder(subset, ["/b", "/source", "/a"]).map((x) => x.path),
    ).toEqual(["/b", "/a"]);
  });

  test("returns a fresh array (no input mutation)", () => {
    const out = applyWorktreeOrder(worktrees, ["/b"]);
    expect(out).not.toBe(worktrees);
    expect(worktrees.map((x) => x.path)).toEqual([
      "/failed",
      "/source",
      "/a",
      "/b",
    ]);
  });
});

describe("pruneWorktreeOrder", () => {
  test("drops paths that are no longer known, preserving order", () => {
    expect(
      pruneWorktreeOrder(["/a", "/gone", "/b"], new Set(["/a", "/b"])),
    ).toEqual(["/a", "/b"]);
  });

  test("no-op when every path is still known", () => {
    expect(pruneWorktreeOrder(["/a", "/b"], new Set(["/a", "/b"]))).toEqual([
      "/a",
      "/b",
    ]);
  });
});
