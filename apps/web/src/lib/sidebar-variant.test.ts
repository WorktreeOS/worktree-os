import { describe, expect, test } from "bun:test";
import {
  readSidebarVariant,
  SIDEBAR_VARIANT_STORAGE_KEY,
  writeSidebarVariant,
} from "./sidebar-variant";

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

describe("readSidebarVariant", () => {
  test("defaults to v3 with no storage", () => {
    expect(readSidebarVariant(null)).toBe("v3");
    expect(readSidebarVariant(undefined)).toBe("v3");
  });

  test("defaults to v3 when the key is unset", () => {
    expect(readSidebarVariant(fakeStorage())).toBe("v3");
  });

  test("reads v4 when explicitly stored", () => {
    const storage = fakeStorage({ [SIDEBAR_VARIANT_STORAGE_KEY]: "v4" });
    expect(readSidebarVariant(storage)).toBe("v4");
  });

  test("falls back to v3 for an unrecognized stored value", () => {
    const storage = fakeStorage({ [SIDEBAR_VARIANT_STORAGE_KEY]: "bogus" });
    expect(readSidebarVariant(storage)).toBe("v3");
  });

  test("falls back to v3 when getItem throws", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(readSidebarVariant(storage)).toBe("v3");
  });
});

describe("writeSidebarVariant", () => {
  test("round-trips through a fake storage", () => {
    const storage = fakeStorage();
    writeSidebarVariant(storage, "v4");
    expect(readSidebarVariant(storage)).toBe("v4");
    writeSidebarVariant(storage, "v3");
    expect(readSidebarVariant(storage)).toBe("v3");
  });

  test("is a no-op with no storage", () => {
    expect(() => writeSidebarVariant(null, "v4")).not.toThrow();
    expect(() => writeSidebarVariant(undefined, "v4")).not.toThrow();
  });

  test("swallows a setItem throw (quota / privacy mode)", () => {
    const storage = {
      setItem: () => {
        throw new Error("quota exceeded");
      },
    } as unknown as Storage;
    expect(() => writeSidebarVariant(storage, "v4")).not.toThrow();
  });
});
