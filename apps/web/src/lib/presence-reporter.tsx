import { useEffect, useState } from "react";
import { useUiApi } from "./api-context";
import {
  computePresenceState,
  PRESENCE_HEARTBEAT_MS,
  type PresenceState,
} from "./presence";

/** A per-page-load client id, stable for the lifetime of the tab/PWA window. */
function generateClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `c-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/**
 * Report this window's focus state to the daemon so the notification engine can
 * gate delivery on real presence. Mounted once in the shell. Reports strict
 * focus (`document.hasFocus() && visibilityState === "visible"`) on every
 * focus / blur / visibility transition, heartbeats `focused` while focused so a
 * crashed tab expires, and beacons `away` on page hide / unload (where a regular
 * fetch would be cancelled). The daemon TTL is the backstop for a lost beacon.
 */
export function usePresenceReporter(): void {
  const api = useUiApi();
  const [clientId] = useState(generateClientId);

  useEffect(() => {
    if (typeof document === "undefined") return;

    let lastSent: PresenceState | null = null;

    const compute = (): PresenceState =>
      computePresenceState({
        hasFocus: document.hasFocus(),
        visibility: document.visibilityState,
      });

    // Report the live state via fetch, but only when it actually changed.
    const syncLive = () => {
      const state = compute();
      if (state === lastSent) return;
      lastSent = state;
      void api.postPresence(clientId, state);
    };

    // Beacon `away` where the page may be dying and fetch is unreliable.
    const beaconAway = () => {
      lastSent = "away";
      api.sendPresenceBeacon(clientId, "away");
    };

    const onFocus = () => syncLive();
    const onBlur = () => syncLive();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") beaconAway();
      else syncLive();
    };
    const onPageHide = () => beaconAway();

    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);

    // Register the initial state so a tab that loads already-focused counts.
    syncLive();

    const heartbeat = setInterval(() => {
      if (compute() === "focused") void api.postPresence(clientId, "focused");
    }, PRESENCE_HEARTBEAT_MS);

    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      clearInterval(heartbeat);
    };
  }, [api, clientId]);
}
