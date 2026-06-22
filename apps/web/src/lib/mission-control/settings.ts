/**
 * `localStorage`-backed Mission Control display settings: the pane geometry
 * mode and the snapshot refresh cadence. Read/write helpers are pure given the
 * storage object, so they can be unit-tested with a fake `Storage`.
 */

import {
  DEFAULT_GEOMETRY_MODE,
  GEOMETRY_MODES,
  type GeometryMode,
} from "./geometry";

const GEOMETRY_KEY = "wos.mc.geometry";
const CADENCE_KEY = "wos.mc.cadence";

/** Cadence bounds (ms) — mirror the daemon's server-side clamp. */
export const CADENCE_MIN_MS = 250;
export const CADENCE_MAX_MS = 5_000;
export const CADENCE_DEFAULT_MS = 1_000;

/** Discrete cadence options surfaced by the cadence selector. */
export const CADENCE_OPTIONS_MS = [250, 500, 1_000, 2_000, 5_000] as const;

export interface MissionControlSettings {
  geometry: GeometryMode;
  cadenceMs: number;
}

export function clampCadenceMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return CADENCE_DEFAULT_MS;
  return Math.max(CADENCE_MIN_MS, Math.min(CADENCE_MAX_MS, Math.round(value)));
}

function isGeometryMode(value: unknown): value is GeometryMode {
  return (
    typeof value === "string" &&
    (GEOMETRY_MODES as readonly string[]).includes(value)
  );
}

function safeStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readGeometryMode(storage?: Storage): GeometryMode {
  const s = safeStorage(storage);
  if (!s) return DEFAULT_GEOMETRY_MODE;
  try {
    const raw = s.getItem(GEOMETRY_KEY);
    return isGeometryMode(raw) ? raw : DEFAULT_GEOMETRY_MODE;
  } catch {
    return DEFAULT_GEOMETRY_MODE;
  }
}

export function writeGeometryMode(mode: GeometryMode, storage?: Storage): void {
  const s = safeStorage(storage);
  if (!s) return;
  try {
    s.setItem(GEOMETRY_KEY, mode);
  } catch {
    /* storage full / unavailable — non-fatal */
  }
}

export function readCadenceMs(storage?: Storage): number {
  const s = safeStorage(storage);
  if (!s) return CADENCE_DEFAULT_MS;
  try {
    const raw = s.getItem(CADENCE_KEY);
    if (raw === null) return CADENCE_DEFAULT_MS;
    return clampCadenceMs(Number(raw));
  } catch {
    return CADENCE_DEFAULT_MS;
  }
}

export function writeCadenceMs(value: number, storage?: Storage): void {
  const s = safeStorage(storage);
  if (!s) return;
  try {
    s.setItem(CADENCE_KEY, String(clampCadenceMs(value)));
  } catch {
    /* non-fatal */
  }
}

export function readMissionControlSettings(
  storage?: Storage,
): MissionControlSettings {
  return {
    geometry: readGeometryMode(storage),
    cadenceMs: readCadenceMs(storage),
  };
}
