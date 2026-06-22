/**
 * Session → pane view-model for the Mission Control wall. Pure derivation: maps
 * a terminal session's lifecycle + derived `agentActivity` into the pane state,
 * the single amber awaiting-input accent (+ question summary), agent identity
 * (via `terminal-agents` — never a raw process string), and the dot+word the
 * pane shows for every other state.
 */

import {
  terminalAgent,
  terminalLabel,
  type AgentPresentation,
} from "../terminal-agents";
import type { TerminalSessionMetadata } from "../terminal-protocol";
import type { StatusDotVariant } from "@/components/ui/status-dot";

export type PaneState =
  | "awaiting-input"
  | "working"
  | "running"
  | "idle"
  | "exited";

export interface PaneModel {
  id: string;
  worktreePath: string;
  session: TerminalSessionMetadata;
  /** Agent presentation (Claude/Codex/OpenCode) or null for a plain shell. */
  agent: AgentPresentation | null;
  /** Display label: user title, else agent label, else shell. */
  label: string;
  state: PaneState;
  /** True exactly when the agent is awaiting input — drives the amber accent. */
  awaitingInput: boolean;
  /** Captured question summary when awaiting input; otherwise null. */
  question: string | null;
  /** Unseen agent output since last viewed. */
  unread: boolean;
  /** Quiet status word for the dot+word presentation. */
  statusWord: string;
  /** Leading status-dot variant (awaiting-input uses the amber `partial`). */
  dotVariant: StatusDotVariant;
}

const COMPLETED = new Set(["exited", "failed", "disposed"]);

export function derivePaneState(session: TerminalSessionMetadata): PaneState {
  if (COMPLETED.has(session.status)) return "exited";
  const activity = session.agentActivity;
  if (activity?.state === "awaiting-input") return "awaiting-input";
  if (activity?.state === "working") return "working";
  if (activity?.state === "idle") return "idle";
  return "running";
}

function statusWordFor(state: PaneState): string {
  switch (state) {
    case "awaiting-input":
      return "awaiting input";
    case "working":
      return "working";
    case "running":
      return "running";
    case "idle":
      return "idle";
    case "exited":
      return "exited";
  }
}

function dotVariantFor(state: PaneState): StatusDotVariant {
  switch (state) {
    case "awaiting-input":
      return "partial"; // amber accent
    case "working":
    case "running":
      return "run";
    case "idle":
      return "idle";
    case "exited":
      return "stopped";
  }
}

export function toPaneModel(
  session: TerminalSessionMetadata,
  fallbackLabel: string,
): PaneModel {
  const state = derivePaneState(session);
  const awaitingInput = state === "awaiting-input";
  return {
    id: session.id,
    worktreePath: session.worktreePath,
    session,
    agent: terminalAgent(session),
    label: terminalLabel(session, fallbackLabel),
    state,
    awaitingInput,
    question: awaitingInput
      ? (session.agentActivity?.question?.summary ?? null)
      : null,
    unread: Boolean(session.unreadSince),
    statusWord: statusWordFor(state),
    dotVariant: dotVariantFor(state),
  };
}
