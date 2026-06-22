import type { AuthSessionResponse } from "./ui-api";

export type PublicAuthState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      authenticated: boolean;
      requiresAuth: boolean;
    };

export type PublicAuthGateDecision = "loading" | "login" | "app" | "error";

/**
 * Pure decision for what the UI should render given the current auth state.
 * - `loading`: initial fetch in flight.
 * - `error`: failed to determine session state; UI may fall back to login.
 * - `login`: public host that requires authentication and the user is signed
 *   out — render the login view.
 * - `app`: render the normal dashboard (local loopback OR authenticated).
 */
export function gateDecision(state: PublicAuthState): PublicAuthGateDecision {
  if (state.kind === "loading") return "loading";
  if (state.kind === "error") return "error";
  if (state.requiresAuth && !state.authenticated) return "login";
  return "app";
}

export function readyFromSession(
  session: AuthSessionResponse,
): Extract<PublicAuthState, { kind: "ready" }> {
  return {
    kind: "ready",
    authenticated: !!session.authenticated,
    requiresAuth: !!session.requiresAuth,
  };
}

/** Apply an `unauthorized` signal (e.g. from a 401 response) to current state. */
export function applyUnauthorized(state: PublicAuthState): PublicAuthState {
  if (state.kind !== "ready") return state;
  // If the server has not signalled `requiresAuth`, a 401 is unexpected and we
  // don't try to enter the login flow (would force loopback users into login).
  if (!state.requiresAuth) return state;
  return { kind: "ready", authenticated: false, requiresAuth: true };
}
