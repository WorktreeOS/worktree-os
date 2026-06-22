/**
 * Detection-driven logic for the Terminal panel's agent-plugin offer.
 *
 * The offer is derived purely from the focused terminal session's detected
 * agent and the per-session plugin flags the daemon already computes
 * (`pluginInstalled` / `pluginOutdated`). Keeping the derivation here — free of
 * React and DOM — lets it be unit-tested directly, the way `sidebar-scope`
 * extracts its grouping logic out of the rail component.
 */

import type {
  TerminalActiveCommand,
  TerminalSessionMetadata,
} from "./terminal-protocol";

/** Kind of offer surfaced for the focused agent. */
export type AgentPluginBannerKind = "install" | "update" | "reinstall";

/** Agents that ship a wos plugin. */
export type AgentPluginBannerAgent = "claude" | "opencode" | "codex";

export interface AgentPluginBannerOffer {
  agent: AgentPluginBannerAgent;
  kind: AgentPluginBannerKind;
  /**
   * `<agent>:<state>` key (state ∈ `missing` | `outdated` | `current`) used to
   * scope dismissal: a dismissed offer reappears only when this key changes.
   */
  stateKey: string;
}

/**
 * Derive the install / update / reinstall offer for a detected agent from its
 * active-command plugin flags. Returns null when no offer applies:
 * - the command has no wos-plugin agent (no agent),
 * - the flags have not been computed yet (`pluginInstalled` undefined),
 * - an opencode plugin that is installed (and thus current — opencode has no
 *   versioned registry to repair, so there is nothing to reinstall),
 * - or a codex plugin that is installed and current (codex offers no reinstall
 *   affordance; only an install-when-missing / update-when-outdated).
 */
export function deriveAgentPluginOffer(
  activeCommand: TerminalActiveCommand | undefined,
): AgentPluginBannerOffer | null {
  const agent = activeCommand?.agent;
  if (agent !== "claude" && agent !== "opencode" && agent !== "codex") {
    return null;
  }

  const installed = activeCommand?.pluginInstalled;
  if (installed === undefined) return null;

  if (!installed) {
    return { agent, kind: "install", stateKey: `${agent}:missing` };
  }

  // Installed. Only claude carries a version to repair via reinstall.
  if (agent === "claude") {
    if (activeCommand?.pluginOutdated === true) {
      return { agent, kind: "update", stateKey: "claude:outdated" };
    }
    return { agent, kind: "reinstall", stateKey: "claude:current" };
  }

  // Codex offers an update when an outdated version is known, otherwise nothing.
  if (agent === "codex") {
    if (activeCommand?.pluginOutdated === true) {
      return { agent, kind: "update", stateKey: "codex:outdated" };
    }
    return null;
  }

  // opencode installed & current — nothing to offer.
  return null;
}

/**
 * Offer for a focused terminal session. Only a running session carries a live
 * active command worth acting on; exited / terminating sessions yield no offer.
 */
export function offerFromSession(
  session: TerminalSessionMetadata | null | undefined,
): AgentPluginBannerOffer | null {
  if (!session || session.status !== "running") return null;
  return deriveAgentPluginOffer(session.activeCommand);
}

/**
 * Whether the offer should render given the currently dismissed state key.
 * A dismissed offer stays hidden while its `<agent>:<state>` holds and
 * reappears once the detected state changes.
 */
export function shouldRenderOffer(
  offer: AgentPluginBannerOffer | null,
  dismissedKey: string | null,
): boolean {
  if (!offer) return false;
  return dismissedKey !== offer.stateKey;
}

const DISMISS_STORAGE_KEY = "wos-agent-plugins-banner-dismissed-state";

/** Read the state-scoped dismissal, or null when none / storage is blocked. */
export function readDismissedPluginState(): string | null {
  try {
    return sessionStorage.getItem(DISMISS_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Persist the dismissed `<agent>:<state>` key for this browser session. */
export function persistDismissedPluginState(stateKey: string): void {
  try {
    sessionStorage.setItem(DISMISS_STORAGE_KEY, stateKey);
  } catch {
    // storage unavailable — dismissal still applies for this mounted view
  }
}
