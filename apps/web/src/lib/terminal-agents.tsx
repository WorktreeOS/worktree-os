import type { ComponentType, SVGProps } from "react";

import {
  ClaudeCodeIcon,
  CodexIcon,
  OpenCodeIcon,
  PiIcon,
} from "@/components/icons/agent-icons";
import type { TerminalKnownAgent } from "@/lib/terminal-protocol";
import type { TerminalSessionMetadata } from "@/lib/terminal-protocol";

/* Single source of truth for terminal agent presentation. Consumed by the
 * worktree Terminal tab and by surface-level affordances (e.g. the
 * `Terminals` section on the worktree page). */

export type AgentIcon = ComponentType<SVGProps<SVGSVGElement>>;

export interface AgentPresentation {
  label: string;
  icon: AgentIcon;
  /** Brand accent in hex — drives badge tint, ring, and active rail. */
  brand: string;
  /** When set, the icon is a self-colored (full-color) mark: consumers must
   * render it as-is, without a brand-filled badge or `color` tint. */
  fullColor?: boolean;
}

export const AGENT_PRESENTATION: Record<TerminalKnownAgent, AgentPresentation> = {
  claude: {
    label: "Claude Code",
    icon: ClaudeCodeIcon,
    brand: "#D97757",
  },
  codex: {
    label: "Codex",
    icon: CodexIcon,
    brand: "#19C37D",
    fullColor: true,
  },
  opencode: {
    label: "OpenCode",
    icon: OpenCodeIcon,
    brand: "#F2B147",
  },
  pi: {
    label: "Pi",
    icon: PiIcon,
    brand: "#5B5BD6",
  },
};

export function terminalAgent(
  session: TerminalSessionMetadata,
): AgentPresentation | null {
  const agent = session.activeCommand?.agent;
  return agent ? AGENT_PRESENTATION[agent] : null;
}

export function terminalLabel(
  session: TerminalSessionMetadata,
  fallback: string,
): string {
  // A user-assigned title is intentional and stable, so it wins over the
  // best-effort agent/active-command/shell labels that can change every poll.
  const title = session.title?.trim();
  if (title) return title;
  const agent = session.activeCommand?.agent;
  if (agent) return AGENT_PRESENTATION[agent].label;
  return fallback;
}
