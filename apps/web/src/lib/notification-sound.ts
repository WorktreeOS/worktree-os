// Sound channel logic, kept DOM-free so it can be unit-tested: the sound
// catalog, per-device settings (localStorage), and the loop-until-acknowledged
// controller. The thin DOM-binding layer lives in `notification-sound-bridge`.

export interface SoundOption {
  id: string;
  label: string;
  /** Asset URL, or null for the silent option. */
  src: string | null;
}

/** Curated sounds plus the silent option. */
export const SOUND_OPTIONS: readonly SoundOption[] = [
  { id: "none", label: "None (silent)", src: null },
  { id: "chime", label: "Chime", src: "/sounds/chime.wav" },
  { id: "ping", label: "Ping", src: "/sounds/ping.wav" },
  { id: "alert", label: "Alert", src: "/sounds/alert.wav" },
  { id: "knock", label: "Knock", src: "/sounds/knock.wav" },
];

/** Resolve a sound id to its asset URL, or null when silent/unknown. */
export function soundSrc(id: string): string | null {
  return SOUND_OPTIONS.find((o) => o.id === id)?.src ?? null;
}

// ---- per-device settings (localStorage) ----

export interface SoundSetting {
  soundId: string;
  /** Loop cap in ms. 0 = play once, no loop. */
  durationMs: number;
}

export interface SoundSettings {
  /** Master volume, 0..1. */
  master: number;
  byKind: Record<string, SoundSetting>;
}

export const SOUND_SETTINGS_KEY = "wos.notificationSound";

/** Built-in per-device defaults: done is silent, question pings and loops. */
export function defaultSoundSettings(): SoundSettings {
  return {
    master: 1,
    byKind: {
      "agent.done": { soundId: "none", durationMs: 0 },
      "agent.question": { soundId: "ping", durationMs: 15000 },
    },
  };
}

function clampVolume(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

/** Read per-device sound settings, merging stored values over the defaults. */
export function getSoundSettings(
  storage: Pick<Storage, "getItem"> | null | undefined,
): SoundSettings {
  const defaults = defaultSoundSettings();
  if (!storage) return defaults;
  let raw: string | null = null;
  try {
    raw = storage.getItem(SOUND_SETTINGS_KEY);
  } catch {
    return defaults;
  }
  if (!raw) return defaults;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaults;
  }
  if (!parsed || typeof parsed !== "object") return defaults;
  const obj = parsed as Record<string, unknown>;
  const out: SoundSettings = {
    master: clampVolume(obj.master, defaults.master),
    byKind: { ...defaults.byKind },
  };
  if (obj.byKind && typeof obj.byKind === "object") {
    for (const [kind, value] of Object.entries(obj.byKind as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      const soundId = typeof v.soundId === "string" ? v.soundId : "none";
      const durationMs =
        typeof v.durationMs === "number" && v.durationMs >= 0 ? v.durationMs : 0;
      out.byKind[kind] = { soundId, durationMs };
    }
  }
  return out;
}

/** Persist per-device sound settings. Best-effort. */
export function setSoundSettings(
  storage: Pick<Storage, "setItem"> | null | undefined,
  settings: SoundSettings,
): void {
  if (!storage) return;
  try {
    storage.setItem(SOUND_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Best-effort: a denied/full storage must not break the toggle.
  }
}

/** The setting for a kind, falling back to silent. */
export function soundSettingForKind(
  settings: SoundSettings,
  kind: string,
): SoundSetting {
  return settings.byKind[kind] ?? { soundId: "none", durationMs: 0 };
}

// ---- loop-until-acknowledged controller (pure) ----

export interface SoundLoopState {
  kind: string;
  startedAtMs: number;
  /** Loop cap in ms. */
  durationMs: number;
}

export type SoundLoopEvent =
  | { type: "start"; kind: string; atMs: number; durationMs: number }
  | { type: "ack"; atMs: number }
  | { type: "tick"; atMs: number };

export interface SoundLoopDecision {
  /** Kind to (re)start playing, or null. */
  play: string | null;
  /** Stop any current playback. */
  stop: boolean;
}

export interface SoundLoopResult {
  state: SoundLoopState | null;
  decision: SoundLoopDecision;
}

/**
 * Pure transition for the loop-until-acknowledged controller. `start` begins a
 * loop (tracked when a positive cap is set); `ack` stops it; `tick` stops it
 * once the kind's own duration cap elapses. Each kind's loop is bounded by the
 * `durationMs` captured at start, so different kinds use different caps.
 */
export function reduceSoundLoop(
  state: SoundLoopState | null,
  event: SoundLoopEvent,
): SoundLoopResult {
  switch (event.type) {
    case "start": {
      const next =
        event.durationMs > 0
          ? {
              kind: event.kind,
              startedAtMs: event.atMs,
              durationMs: event.durationMs,
            }
          : null;
      return { state: next, decision: { play: event.kind, stop: false } };
    }
    case "ack": {
      if (!state) return { state: null, decision: { play: null, stop: false } };
      return { state: null, decision: { play: null, stop: true } };
    }
    case "tick": {
      if (!state) return { state: null, decision: { play: null, stop: false } };
      if (event.atMs - state.startedAtMs >= state.durationMs) {
        return { state: null, decision: { play: null, stop: true } };
      }
      return { state, decision: { play: null, stop: false } };
    }
  }
}
