/**
 * `wos agent-hook <event>` — the Claude Code plugin's hook delivery mechanism.
 *
 * Replaces the former Bash hook scripts (`scripts/on-*.sh`). Claude Code runs
 * `wos agent-hook <event>` as the hook command; this reads the hook JSON from
 * stdin, maps it onto an `AgentActivityEvent`, and delivers it to the wos
 * daemon. Cross-platform by relying only on the wos binary — no `bash`/`jq`/
 * `curl`. Fire-and-forget by contract: every path resolves to exit code 0, and
 * a missing daemon/token is a silent no-op so Claude Code is never affected.
 */

import { readFileSync } from "node:fs";

import {
  type AgentActivityEvent,
  truncateActivitySummary,
} from "@worktreeos/core/agent-activity";

import {
  type ActivityAgent,
  buildClaudeActivityEvent,
  titleFromText,
} from "./payload";
import { deliverActivityEvent } from "./send";

/** Kebab-case event keywords accepted on the CLI (one per Claude hook). */
export const KNOWN_AGENT_HOOK_EVENTS = [
  "session-start",
  "prompt-submit",
  "stop",
  "subagent-stop",
  "notification",
  "permission-request",
  "ask-user-question",
  "post-tool-use",
] as const;

export type AgentHookEvent = (typeof KNOWN_AGENT_HOOK_EVENTS)[number];

const KNOWN_EVENTS = new Set<string>(KNOWN_AGENT_HOOK_EVENTS);

type HookInput = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Latest `type:"summary"` entry from a Claude transcript JSONL. Best-effort. */
function transcriptSummary(path: string | undefined): string | undefined {
  if (!path) return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let summary: string | undefined;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as { type?: string; summary?: string };
      if (rec.type === "summary" && typeof rec.summary === "string" && rec.summary.length > 0) {
        summary = rec.summary;
      }
    } catch {
      // skip malformed transcript lines
    }
  }
  return summary;
}

/**
 * Map a hook (`event` keyword + parsed stdin JSON) onto an `AgentActivityEvent`,
 * or `null` when the hook should emit nothing. Exported for contract tests.
 * `env` defaults to `process.env` and supplies `WOS_TERMINAL_SESSION_ID`.
 *
 * `agent` selects the host mapping: `claude` (default — byte-for-byte
 * unchanged) or `codex`, whose hook stdin shape and event semantics differ
 * slightly (see `buildCodexHookPayload`).
 */
export function buildHookPayload(
  event: string,
  input: HookInput,
  env: Record<string, string | undefined> = process.env,
  agent: ActivityAgent = "claude",
): AgentActivityEvent | null {
  if (agent === "codex") return buildCodexHookPayload(event, input, env);
  const agentSessionId = str(input.session_id);
  const cwd = str(input.cwd) ?? process.cwd();
  const base = { env } as const;

  switch (event) {
    case "session-start": {
      const detail: Record<string, unknown> = {};
      const transcriptPath = str(input.transcript_path);
      const source = str(input.source);
      if (transcriptPath) detail.transcriptPath = transcriptPath;
      if (source) detail.source = source;
      return buildClaudeActivityEvent("session_start", agentSessionId, cwd, {
        ...base,
        detail,
      });
    }
    case "prompt-submit": {
      const query = str(input.prompt);
      return buildClaudeActivityEvent("prompt_submit", agentSessionId, cwd, {
        ...base,
        summary: query,
        title: titleFromText(query),
        detail: query ? { query: truncateActivitySummary(query) } : undefined,
      });
    }
    case "stop": {
      if (input.stop_hook_active === true) return null;
      // Claude Code includes `agent_id` only when the hook fires inside a
      // subagent call. A subagent finishing is not the main turn ending — the
      // main agent is still working — so it is liveness, not idle.
      if (str(input.agent_id)) {
        return buildClaudeActivityEvent("heartbeat", agentSessionId, cwd, base);
      }
      const title = titleFromText(transcriptSummary(str(input.transcript_path)));
      return buildClaudeActivityEvent("stop", agentSessionId, cwd, {
        ...base,
        title,
      });
    }
    case "subagent-stop": {
      // A dedicated SubagentStop hook is always subagent-scoped → liveness.
      return buildClaudeActivityEvent("heartbeat", agentSessionId, cwd, base);
    }
    case "notification": {
      // idle_prompt notification → idle signal; the daemon dedups vs Stop.
      return buildClaudeActivityEvent("stop", agentSessionId, cwd, base);
    }
    case "permission-request": {
      const toolName = str(input.tool_name);
      const toolInput = record(input.tool_input);
      const preview =
        str(toolInput.command) ??
        str(toolInput.file_path) ??
        str(toolInput.filePath) ??
        JSON.stringify(toolInput).slice(0, 80);
      let summary = `Wants to run ${toolName ?? "a tool"}`;
      if (preview) summary += `: ${preview}`;
      return buildClaudeActivityEvent("permission_request", agentSessionId, cwd, {
        ...base,
        severity: "needs-attention",
        summary,
        detail: toolName ? { toolName } : undefined,
      });
    }
    case "ask-user-question": {
      const toolInput = record(input.tool_input);
      const questions = toolInput.questions;
      const first = Array.isArray(questions) ? record(questions[0]) : {};
      const question =
        str(first.question) ??
        str(toolInput.question) ??
        "Claude is asking a question";
      return buildClaudeActivityEvent("question_asked", agentSessionId, cwd, {
        ...base,
        severity: "needs-attention",
        summary: question,
        detail: { toolName: "AskUserQuestion" },
      });
    }
    case "post-tool-use": {
      // Liveness heartbeat emitted after every tool call.
      return buildClaudeActivityEvent("heartbeat", agentSessionId, cwd, base);
    }
    default:
      return null;
  }
}

/**
 * Map a Codex hook onto an `AgentActivityEvent` tagged `agent: "codex"`.
 *
 * Codex's hook shape is a near-clone of Claude Code's, with three differences
 * encoded here: its `SessionStart` carries `trigger` (not `source`); its `Stop`
 * is always main-turn-scoped (`SubagentStop` is a distinct hook, so there is no
 * `agent_id` sniffing); and every hook stdin carries a `model`, which is
 * stamped onto `detail.model`.
 */
function buildCodexHookPayload(
  event: string,
  input: HookInput,
  env: Record<string, string | undefined>,
): AgentActivityEvent | null {
  const agentSessionId = str(input.session_id);
  const cwd = str(input.cwd) ?? process.cwd();
  const model = str(input.model);
  const base = { env, agent: "codex" as const };
  // Stamp the model carried on every Codex hook onto the event's detail.
  const withModel = (
    detail?: Record<string, unknown>,
  ): Record<string, unknown> | undefined =>
    model ? { ...(detail ?? {}), model } : detail;

  switch (event) {
    case "session-start": {
      const detail: Record<string, unknown> = {};
      const transcriptPath = str(input.transcript_path);
      const source = str(input.trigger);
      if (transcriptPath) detail.transcriptPath = transcriptPath;
      if (source) detail.source = source;
      return buildClaudeActivityEvent("session_start", agentSessionId, cwd, {
        ...base,
        detail: withModel(detail),
      });
    }
    case "prompt-submit": {
      const query = str(input.prompt);
      return buildClaudeActivityEvent("prompt_submit", agentSessionId, cwd, {
        ...base,
        summary: query,
        title: titleFromText(query),
        detail: withModel(
          query ? { query: truncateActivitySummary(query) } : undefined,
        ),
      });
    }
    case "stop": {
      // Codex `Stop` is always main-turn-scoped → a hard idle, no discrimination.
      return buildClaudeActivityEvent("stop", agentSessionId, cwd, {
        ...base,
        detail: withModel(),
      });
    }
    case "subagent-stop":
    case "post-tool-use": {
      // SubagentStop and PostToolUse are liveness, never a main-turn idle.
      return buildClaudeActivityEvent("heartbeat", agentSessionId, cwd, {
        ...base,
        detail: withModel(),
      });
    }
    case "permission-request": {
      const toolName = str(input.tool_name);
      const toolInput = record(input.tool_input);
      const preview =
        str(toolInput.command) ??
        str(toolInput.file_path) ??
        str(toolInput.filePath) ??
        JSON.stringify(toolInput).slice(0, 80);
      let summary = `Wants to run ${toolName ?? "a tool"}`;
      if (preview) summary += `: ${preview}`;
      return buildClaudeActivityEvent("permission_request", agentSessionId, cwd, {
        ...base,
        severity: "needs-attention",
        summary,
        detail: withModel(toolName ? { toolName } : undefined),
      });
    }
    default:
      return null;
  }
}

async function readStdin(): Promise<HookInput> {
  try {
    const text = await Bun.stdin.text();
    if (!text.trim()) return {};
    return record(JSON.parse(text));
  } catch {
    return {};
  }
}

/**
 * Parse the optional `--agent <name>` flag (`--agent codex` or
 * `--agent=codex`) out of the argv tail. Defaults to `claude` when absent or
 * unrecognized, so existing Claude `hooks.json` commands (no flag) are
 * unchanged.
 */
export function parseAgentFlag(argv: string[]): ActivityAgent {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--agent") {
      if (argv[i + 1] === "codex") return "codex";
    } else if (arg === "--agent=codex") {
      return "codex";
    }
  }
  return "claude";
}

/**
 * Entry point for `wos agent-hook <event> [--agent codex]`. `argv` is the
 * arguments after `agent-hook`. Always resolves to exit code 0; unknown events
 * no-op.
 */
export async function runAgentHook(argv: string[]): Promise<number> {
  const event = argv[0];
  if (!event || !KNOWN_EVENTS.has(event)) return 0;
  const agent = parseAgentFlag(argv.slice(1));
  try {
    const input = await readStdin();
    const payload = buildHookPayload(event, input, process.env, agent);
    if (payload) await deliverActivityEvent(payload);
  } catch {
    // a hook failure must never surface to the host agent
  }
  return 0;
}
