import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { useUnifiedEvents } from "./events-context";
import {
  getSoundSettings,
  reduceSoundLoop,
  soundSettingForKind,
  soundSrc,
  type SoundLoopState,
} from "./notification-sound";

// Imperative audio state is module-level so the Settings "Test" button and the
// live bridge share the same unlock + single-active-loop behavior.
let audioUnlocked = false;
let activeAudio: HTMLAudioElement | null = null;

/** Mark the audio context as unlocked (a user gesture happened). */
export function markAudioUnlocked(): void {
  audioUnlocked = true;
}

export function isAudioUnlocked(): boolean {
  return audioUnlocked;
}

function stopActiveAudio(): void {
  if (activeAudio) {
    activeAudio.pause();
    activeAudio = null;
  }
}

function startAudio(src: string, loop: boolean, volume: number): void {
  stopActiveAudio();
  const audio = new Audio(src);
  audio.loop = loop;
  audio.volume = Math.max(0, Math.min(1, volume));
  activeAudio = audio;
  void audio.play().catch(() => {
    // Locked or failed playback degrades silently.
  });
}

/** Preview a sound (also unlocks audio). Used by the Settings "Test" control. */
export function previewSound(soundId: string, volume = 1): void {
  markAudioUnlocked();
  const src = soundSrc(soundId);
  if (!src) return;
  startAudio(src, false, volume);
}

/**
 * The worktree currently foregrounded: document visible AND routed to a
 * worktree `?path=`. Returns the path, or null when not foregrounded there.
 */
function foregroundedWorktreePath(
  pathname: string,
  search: string,
): string | null {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    return null;
  }
  if (pathname !== "/worktree") return null;
  return new URLSearchParams(search).get("path");
}

/**
 * Play a per-kind sound when a `notification.raised` arrives while the tab is
 * open. The sound loops until acknowledged (window focus, document visible, or a
 * gesture) or the kind's duration cap elapses. Degrades silently when audio is
 * locked or the affected worktree is already foregrounded.
 */
export function useNotificationSound(): void {
  const events = useUnifiedEvents();
  const location = useLocation();
  const loopRef = useRef<SoundLoopState | null>(null);
  const tickRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTick = () => {
    if (tickRef.current) {
      clearTimeout(tickRef.current);
      tickRef.current = null;
    }
  };

  // Unlock audio on the first user gesture.
  useEffect(() => {
    if (audioUnlocked) return;
    const onGesture = () => markAudioUnlocked();
    window.addEventListener("pointerdown", onGesture, { once: true });
    window.addEventListener("keydown", onGesture, { once: true });
    return () => {
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
    };
  }, []);

  // Acknowledge on focus / visibility-restore: stop any active loop.
  useEffect(() => {
    const ack = () => {
      const { state, decision } = reduceSoundLoop(loopRef.current, {
        type: "ack",
        atMs: Date.now(),
      });
      loopRef.current = state;
      if (decision.stop) {
        stopActiveAudio();
        clearTick();
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") ack();
    };
    window.addEventListener("focus", ack);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", ack);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const unsubscribe = events.subscribe((env) => {
      if (env.event.type !== "notification.raised") return;
      const notification = env.event.notification;
      if (!audioUnlocked) return; // locked: degrade silently

      const foreground = foregroundedWorktreePath(
        location.pathname,
        location.search,
      );
      if (
        foreground &&
        notification.worktreePath &&
        foreground === notification.worktreePath
      ) {
        return; // user is already watching this worktree
      }

      const settings = getSoundSettings(
        typeof localStorage !== "undefined" ? localStorage : null,
      );
      const setting = soundSettingForKind(settings, notification.kind);
      const src = soundSrc(setting.soundId);
      if (!src) return; // silent selection

      const { state, decision } = reduceSoundLoop(loopRef.current, {
        type: "start",
        kind: notification.kind,
        atMs: Date.now(),
        durationMs: setting.durationMs,
      });
      loopRef.current = state;
      if (!decision.play) return;

      startAudio(src, setting.durationMs > 0, settings.master);
      clearTick();
      if (setting.durationMs > 0) {
        tickRef.current = setTimeout(() => {
          const r = reduceSoundLoop(loopRef.current, {
            type: "tick",
            atMs: Date.now(),
          });
          loopRef.current = r.state;
          if (r.decision.stop) {
            stopActiveAudio();
            clearTick();
          }
        }, setting.durationMs);
      }
    });
    return () => {
      unsubscribe();
      clearTick();
      stopActiveAudio();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, location.pathname, location.search]);
}
