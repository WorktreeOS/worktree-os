import { describe, expect, test } from "bun:test";
import {
  CADENCE_DEFAULT_MS,
  CADENCE_MAX_MS,
  CADENCE_MIN_MS,
  clampCadenceMs,
  readCadenceMs,
  readGeometryMode,
  readMissionControlSettings,
  writeCadenceMs,
  writeGeometryMode,
} from "./settings";
import { DEFAULT_GEOMETRY_MODE } from "./geometry";

/** Minimal in-memory Storage stand-in. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => map.delete(k),
    setItem: (k, v) => {
      map.set(k, String(v));
    },
  } as Storage;
}

describe("clampCadenceMs", () => {
  test("clamps below the minimum", () => {
    expect(clampCadenceMs(10)).toBe(CADENCE_MIN_MS);
  });
  test("clamps above the maximum", () => {
    expect(clampCadenceMs(999_999)).toBe(CADENCE_MAX_MS);
  });
  test("falls back to default for non-positive / NaN", () => {
    expect(clampCadenceMs(0)).toBe(CADENCE_DEFAULT_MS);
    expect(clampCadenceMs(-5)).toBe(CADENCE_DEFAULT_MS);
    expect(clampCadenceMs(Number.NaN)).toBe(CADENCE_DEFAULT_MS);
  });
});

describe("geometry mode persistence", () => {
  test("round-trips a valid mode", () => {
    const s = fakeStorage();
    writeGeometryMode("proportional", s);
    expect(readGeometryMode(s)).toBe("proportional");
  });
  test("falls back to the default for a missing / invalid value", () => {
    const s = fakeStorage();
    expect(readGeometryMode(s)).toBe(DEFAULT_GEOMETRY_MODE);
    s.setItem("wos.mc.geometry", "bogus");
    expect(readGeometryMode(s)).toBe(DEFAULT_GEOMETRY_MODE);
  });
});

describe("cadence persistence", () => {
  test("stores a clamped value and reads it back", () => {
    const s = fakeStorage();
    writeCadenceMs(10, s);
    expect(readCadenceMs(s)).toBe(CADENCE_MIN_MS);
    writeCadenceMs(2_000, s);
    expect(readCadenceMs(s)).toBe(2_000);
  });
  test("missing value reads the default", () => {
    expect(readCadenceMs(fakeStorage())).toBe(CADENCE_DEFAULT_MS);
  });
});

describe("readMissionControlSettings", () => {
  test("bundles geometry + cadence", () => {
    const s = fakeStorage();
    writeGeometryMode("fit", s);
    writeCadenceMs(500, s);
    expect(readMissionControlSettings(s)).toEqual({
      geometry: "fit",
      cadenceMs: 500,
    });
  });
});
