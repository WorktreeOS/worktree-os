// Pure focus-presence logic for the web client, kept DOM-free so it is
// unit-testable. The reporter (`presence-reporter.tsx`) binds this to the
// browser focus/visibility events and the daemon presence endpoint.

/** Focus state reported to the daemon. */
export type PresenceState = "focused" | "away";

/**
 * Client heartbeat cadence while focused. The daemon TTL (`PRESENCE_TTL_MS`) is
 * sized to ≈2× this plus slack, so a single dropped beat does not flip presence.
 */
export const PRESENCE_HEARTBEAT_MS = 20_000;

/**
 * Strict focus: a client is `focused` only when its window has OS focus AND its
 * document is visible. A visible-but-unfocused window (side-by-side with an
 * editor) counts as `away` — the notification's value is highest exactly when
 * the user is not in the WorktreeOS window.
 */
export function computePresenceState(input: {
  hasFocus: boolean;
  visibility: DocumentVisibilityState;
}): PresenceState {
  return input.hasFocus && input.visibility === "visible" ? "focused" : "away";
}
