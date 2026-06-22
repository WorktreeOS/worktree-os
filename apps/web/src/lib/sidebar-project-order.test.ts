import { describe, expect, test } from "bun:test";
import {
  PROJECT_ORDER_STORAGE_KEY,
  applyProjectOrder,
  readProjectOrder,
  writeProjectOrder,
} from "./sidebar-project-order";

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

function p(id: string) {
  return { id };
}

describe("readProjectOrder", () => {
  test("returns stored string ids", () => {
    const storage = fakeStorage({
      [PROJECT_ORDER_STORAGE_KEY]: JSON.stringify(["p2", "p1"]),
    });
    expect(readProjectOrder(storage)).toEqual(["p2", "p1"]);
  });

  test("empty storage yields an empty array", () => {
    expect(readProjectOrder(fakeStorage())).toEqual([]);
  });

  test("garbage / non-array storage yields an empty array", () => {
    expect(
      readProjectOrder(fakeStorage({ [PROJECT_ORDER_STORAGE_KEY]: "{" })),
    ).toEqual([]);
    expect(
      readProjectOrder(
        fakeStorage({ [PROJECT_ORDER_STORAGE_KEY]: JSON.stringify(7) }),
      ),
    ).toEqual([]);
  });
});

describe("writeProjectOrder", () => {
  test("round-trips through read", () => {
    const storage = fakeStorage();
    writeProjectOrder(["p1", "p2"], storage);
    expect(readProjectOrder(storage)).toEqual(["p1", "p2"]);
  });
});

describe("applyProjectOrder", () => {
  const projects = [p("p1"), p("p2"), p("p3")];

  test("known ids come first in stored order", () => {
    expect(
      applyProjectOrder(projects, ["p3", "p1"]).map((x) => x.id),
    ).toEqual(["p3", "p1", "p2"]);
  });

  test("a newly registered project appears last (registration order)", () => {
    // p1, p2 reordered; p3 registered afterward and absent from stored order.
    expect(applyProjectOrder(projects, ["p2", "p1"]).map((x) => x.id)).toEqual([
      "p2",
      "p1",
      "p3",
    ]);
  });

  test("empty stored order keeps registration order", () => {
    expect(applyProjectOrder(projects, []).map((x) => x.id)).toEqual([
      "p1",
      "p2",
      "p3",
    ]);
  });

  test("tolerates stale ids not present in the list", () => {
    expect(
      applyProjectOrder(projects, ["gone", "p2"]).map((x) => x.id),
    ).toEqual(["p2", "p1", "p3"]);
  });

  test("returns a fresh array (no input mutation)", () => {
    const out = applyProjectOrder(projects, ["p2"]);
    expect(out).not.toBe(projects);
    expect(projects.map((x) => x.id)).toEqual(["p1", "p2", "p3"]);
  });
});
