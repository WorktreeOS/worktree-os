/**
 * WorktreeOS OpenCode plugin.
 *
 * Subscribes to OpenCode events and reports agent activity to the wos daemon
 * as AgentActivityEvent payloads (see packages/core/src/agent-activity.ts).
 * Delivery is fire-and-forget; subagent sessions (those with a parentID) are
 * filtered out.
 *
 * Structural types below mirror the parts of `@opencode-ai/plugin` /
 * `@opencode-ai/sdk` this plugin touches, so the package carries no external
 * dependency. The plugin is loaded by adding it to `opencode.json`:
 *   { "plugin": ["@worktreeos/plugin-opencode"] }
 */

import type { AgentActivityEvent } from "@worktreeos/core/agent-activity";
import { buildActivityEvent } from "./payload";
import { sendActivityEvent } from "./send";

interface OpencodeSessionClient {
  session: {
    get(args: {
      path: { id: string };
    }): Promise<{ data?: { parentID?: string } }>;
  };
}

interface OpencodeEvent {
  type: string;
  properties?: Record<string, unknown>;
}

interface PluginInput {
  client: OpencodeSessionClient;
  directory?: string;
}

export interface WosHooksDeps {
  client: OpencodeSessionClient;
  directory: string;
  /** Delivery override (tests). Defaults to the fire-and-forget sender. */
  send?: (event: AgentActivityEvent) => void;
}

function permissionSummary(properties: Record<string, unknown>): string {
  const toolName = typeof properties.type === "string" ? properties.type : "a tool";
  const metadata = (properties.metadata ?? {}) as Record<string, unknown>;
  const preview =
    typeof metadata.command === "string"
      ? metadata.command
      : typeof metadata.file_path === "string"
        ? metadata.file_path
        : typeof metadata.filePath === "string"
          ? metadata.filePath
          : JSON.stringify(metadata).slice(0, 80);
  return preview ? `Wants to run ${toolName}: ${preview}` : `Wants to run ${toolName}`;
}

/** Build the hook handlers. Exported separately so tests can inject deps. */
export function createWosHooks(deps: WosHooksDeps) {
  const send = deps.send ?? sendActivityEvent;
  const cwd = deps.directory;
  const subagentCache = new Map<string, boolean>();

  async function isSubagentSession(sessionId?: string): Promise<boolean> {
    if (!sessionId) return false;
    const cached = subagentCache.get(sessionId);
    if (cached !== undefined) return cached;
    try {
      const session = await deps.client.session.get({ path: { id: sessionId } });
      const result = !!session.data?.parentID;
      subagentCache.set(sessionId, result);
      return result;
    } catch {
      // If the lookup fails, report anyway — best-effort by contract.
      return false;
    }
  }

  async function report(
    sessionId: string | undefined,
    kind: string,
    options?: Parameters<typeof buildActivityEvent>[3],
  ): Promise<void> {
    if (await isSubagentSession(sessionId)) return;
    send(buildActivityEvent(kind, sessionId, cwd, options));
  }

  return {
    event: async ({ event }: { event: OpencodeEvent }) => {
      const props = event.properties ?? {};
      switch (event.type) {
        case "session.created": {
          const info = (props.info ?? {}) as { id?: string; parentID?: string };
          if (info.parentID) return;
          if (info.id) subagentCache.set(info.id, false);
          await report(info.id, "session_start");
          return;
        }
        case "session.idle": {
          await report(props.sessionID as string | undefined, "stop");
          return;
        }
        case "permission.updated":
        case "permission.asked": {
          await report(
            props.sessionID as string | undefined,
            "permission_request",
            {
              severity: "needs-attention",
              summary: permissionSummary(props),
              detail: {
                toolName: typeof props.type === "string" ? props.type : undefined,
              },
            },
          );
          return;
        }
        case "permission.replied": {
          if (props.response === "reject") return;
          await report(
            props.sessionID as string | undefined,
            "permission_replied",
          );
          return;
        }
        default:
          return;
      }
    },

    // Fires once per new user message (message.updated fires repeatedly).
    "chat.message": async (
      input: { sessionID?: string },
      output: { parts?: Array<{ type?: string; text?: string }> },
    ) => {
      const query = (output.parts ?? [])
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text)
        .join(" ")
        .trim();
      if (!query) return;
      await report(input.sessionID, "prompt_submit", {
        summary: query,
        detail: { query },
      });
    },

    // Detects the built-in question tool before it executes.
    "tool.execute.before": async (input: { tool?: string; sessionID?: string }) => {
      if (input.tool !== "question") return;
      await report(input.sessionID, "question_asked", {
        severity: "needs-attention",
        summary: "OpenCode is asking a question",
        detail: { toolName: input.tool },
      });
    },
  };
}

/** Plugin entry point loaded by OpenCode. */
export const WosPlugin = async ({ client, directory }: PluginInput) => {
  return createWosHooks({ client, directory: directory ?? "" });
};
