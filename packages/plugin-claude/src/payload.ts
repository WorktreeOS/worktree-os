import {
  AGENT_ACTIVITY_PROTOCOL_VERSION,
  AGENT_ACTIVITY_TITLE_MAX,
  type AgentActivityEvent,
  type AgentActivitySeverity,
  truncateActivitySummary,
} from "@worktreeos/core/agent-activity";

let counter = 0;

/** Agent families that share this hook delivery path. */
export type ActivityAgent = "claude" | "codex";

/** eventId prefix per agent, so codex events never collide with claude's. */
const EVENT_ID_PREFIX: Record<ActivityAgent, string> = {
  claude: "cc",
  codex: "cx",
};

export interface ClaudeEventOptions {
  severity?: AgentActivitySeverity;
  summary?: string;
  title?: string;
  detail?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  /** Agent family this event is tagged with; defaults to `claude`. */
  agent?: ActivityAgent;
}

/** Build one AgentActivityEvent for the Claude Code / Codex adapter. */
export function buildClaudeActivityEvent(
  kind: string,
  agentSessionId: string | undefined,
  cwd: string,
  options: ClaudeEventOptions = {},
): AgentActivityEvent {
  const env = options.env ?? process.env;
  const agent = options.agent ?? "claude";
  counter += 1;
  const event: AgentActivityEvent = {
    v: AGENT_ACTIVITY_PROTOCOL_VERSION,
    eventId: `${EVENT_ID_PREFIX[agent]}-${Date.now()}-${process.pid}-${counter}`,
    agent,
    event: kind,
    agentSessionId:
      agentSessionId && agentSessionId.length > 0 ? agentSessionId : "unknown",
    cwd,
    at: new Date().toISOString(),
    severity: options.severity ?? "info",
  };
  const terminalSessionId = env.WOS_TERMINAL_SESSION_ID;
  if (terminalSessionId) event.terminalSessionId = terminalSessionId;
  if (options.summary) event.summary = truncateActivitySummary(options.summary);
  if (options.title) event.title = truncateTitle(options.title);
  if (options.detail && Object.keys(options.detail).length > 0) {
    event.detail = options.detail;
  }
  return event;
}

/**
 * Derive a session title from free text: first line, whitespace collapsed,
 * truncated to the title limit. Empty input yields `undefined` (the field is
 * then omitted from the payload).
 */
export function titleFromText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const line = (text.split("\n", 1)[0] ?? "").replace(/\s+/g, " ").trim();
  if (line.length === 0) return undefined;
  return truncateTitle(line);
}

function truncateTitle(text: string): string {
  return text.length > AGENT_ACTIVITY_TITLE_MAX
    ? text.slice(0, AGENT_ACTIVITY_TITLE_MAX)
    : text;
}
