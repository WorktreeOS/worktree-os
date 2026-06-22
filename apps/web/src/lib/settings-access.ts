import type { PublicAuthState } from "./public-auth-state";

/**
 * Whether the sidebar Settings affordance should be hidden for the current
 * auth session. Public sessions never see Settings even when authenticated;
 * the API itself rejects them server-side regardless of frontend hiding.
 */
export function shouldHideSettingsNav(state: PublicAuthState): boolean {
  return state.kind === "ready" && state.requiresAuth;
}

/**
 * Whether the Settings route should render an unavailable view instead of the
 * editable form. Public sessions always see the unavailable view; mirrors
 * `shouldHideSettingsNav` so the two decisions cannot drift.
 */
export function shouldRenderSettingsUnavailable(state: PublicAuthState): boolean {
  return state.kind === "ready" && state.requiresAuth;
}
