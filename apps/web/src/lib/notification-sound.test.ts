import { test, expect, describe } from "bun:test";
import {
  defaultSoundSettings,
  getSoundSettings,
  reduceSoundLoop,
  setSoundSettings,
  soundSettingForKind,
  soundSrc,
  type SoundLoopState,
} from "./notification-sound";

function fakeStorage(): Pick<Storage, "getItem" | "setItem"> & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

describe("sound catalog", () => {
  test("silent option resolves to null, known ids to a src", () => {
    expect(soundSrc("none")).toBeNull();
    expect(soundSrc("ping")).toBe("/sounds/ping.wav");
    expect(soundSrc("unknown")).toBeNull();
  });
});

describe("sound settings persistence", () => {
  test("returns defaults when nothing stored", () => {
    expect(getSoundSettings(fakeStorage())).toEqual(defaultSoundSettings());
  });

  test("round-trips through storage and merges over defaults", () => {
    const storage = fakeStorage();
    const next = defaultSoundSettings();
    next.master = 0.5;
    next.byKind["agent.done"] = { soundId: "chime", durationMs: 8000 };
    setSoundSettings(storage, next);
    const loaded = getSoundSettings(storage);
    expect(loaded.master).toBe(0.5);
    expect(loaded.byKind["agent.done"]).toEqual({ soundId: "chime", durationMs: 8000 });
    // Unspecified kind keeps its default.
    expect(loaded.byKind["agent.question"]).toEqual(
      defaultSoundSettings().byKind["agent.question"],
    );
  });

  test("clamps a bad master volume and tolerates corrupt json", () => {
    const storage = fakeStorage();
    storage.map.set("wos.notificationSound", "{not json");
    expect(getSoundSettings(storage)).toEqual(defaultSoundSettings());
    storage.map.set("wos.notificationSound", JSON.stringify({ master: 5 }));
    expect(getSoundSettings(storage).master).toBe(1);
  });

  test("soundSettingForKind falls back to silent", () => {
    expect(soundSettingForKind(defaultSoundSettings(), "unknown.kind")).toEqual({
      soundId: "none",
      durationMs: 0,
    });
  });
});

describe("loop-until-ack controller", () => {
  test("start begins a tracked loop when a cap is set", () => {
    const r = reduceSoundLoop(null, {
      type: "start",
      kind: "agent.question",
      atMs: 1000,
      durationMs: 5000,
    });
    expect(r.decision).toEqual({ play: "agent.question", stop: false });
    expect(r.state).toEqual({
      kind: "agent.question",
      startedAtMs: 1000,
      durationMs: 5000,
    });
  });

  test("start with no cap plays once without tracking", () => {
    const r = reduceSoundLoop(null, {
      type: "start",
      kind: "agent.done",
      atMs: 0,
      durationMs: 0,
    });
    expect(r.decision).toEqual({ play: "agent.done", stop: false });
    expect(r.state).toBeNull();
  });

  test("ack stops an active loop before the cap", () => {
    const state: SoundLoopState = {
      kind: "agent.question",
      startedAtMs: 1000,
      durationMs: 5000,
    };
    const r = reduceSoundLoop(state, { type: "ack", atMs: 2000 });
    expect(r.decision.stop).toBe(true);
    expect(r.state).toBeNull();
  });

  test("tick stops the loop at the cap, not before", () => {
    const state: SoundLoopState = {
      kind: "agent.question",
      startedAtMs: 1000,
      durationMs: 5000,
    };
    const before = reduceSoundLoop(state, { type: "tick", atMs: 3000 });
    expect(before.decision.stop).toBe(false);
    expect(before.state).toBe(state);
    const after = reduceSoundLoop(state, { type: "tick", atMs: 6000 });
    expect(after.decision.stop).toBe(true);
    expect(after.state).toBeNull();
  });

  test("each kind is bounded by its own cap", () => {
    const shortCap = reduceSoundLoop(null, {
      type: "start",
      kind: "a",
      atMs: 0,
      durationMs: 1000,
    }).state!;
    const longCap = reduceSoundLoop(null, {
      type: "start",
      kind: "b",
      atMs: 0,
      durationMs: 10000,
    }).state!;
    expect(reduceSoundLoop(shortCap, { type: "tick", atMs: 1500 }).decision.stop).toBe(true);
    expect(reduceSoundLoop(longCap, { type: "tick", atMs: 1500 }).decision.stop).toBe(false);
  });
});
