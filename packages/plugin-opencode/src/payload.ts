import {
  AGENT_ACTIVITY_PROTOCOL_VERSION,
  type AgentActivityEvent,
  type AgentActivitySeverity,
  truncateActivitySummary,
} from "@worktreeos/core/agent-activity";

let counter = 0;

/** Build one AgentActivityEvent for the opencode adapter. */
export function buildActivityEvent(
  kind: string,
  agentSessionId: string | undefined,
  cwd: string,
  options: {
    severity?: AgentActivitySeverity;
    summary?: string;
    detail?: Record<string, unknown>;
    env?: Record<string, string | undefined>;
  } = {},
): AgentActivityEvent {
  const env = options.env ?? process.env;
  counter += 1;
  const event: AgentActivityEvent = {
    v: AGENT_ACTIVITY_PROTOCOL_VERSION,
    eventId: `oc-${Date.now()}-${process.pid}-${counter}`,
    agent: "opencode",
    event: kind,
    agentSessionId: agentSessionId ?? "unknown",
    cwd,
    at: new Date().toISOString(),
    severity: options.severity ?? "info",
  };
  const terminalSessionId = env.WOS_TERMINAL_SESSION_ID;
  if (terminalSessionId) event.terminalSessionId = terminalSessionId;
  if (options.summary) {
    event.summary = truncateActivitySummary(options.summary);
  }
  if (options.detail) event.detail = options.detail;
  return event;
}
