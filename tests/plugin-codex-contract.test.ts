import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import {
  type AgentActivityEvent,
  validateAgentActivityEvent,
} from "@worktreeos/core/agent-activity";
import {
  buildHookPayload,
  KNOWN_AGENT_HOOK_EVENTS,
  parseAgentFlag,
} from "@worktreeos/plugin-claude/src/agent-hook";

const PLUGIN_ROOT = resolve(import.meta.dir, "../packages/plugin-codex");

function expectValid(payload: AgentActivityEvent | null): AgentActivityEvent {
  if (!payload) throw new Error("expected a payload, got null");
  const result = validateAgentActivityEvent(payload);
  if (!result.ok) throw new Error(`schema violation: ${result.error}`);
  return result.event;
}

const BASE_INPUT = {
  session_id: "codex-sess-1",
  cwd: "/work/tree",
  model: "gpt-5-codex",
};

function codex(event: string, input: Record<string, unknown> = BASE_INPUT) {
  return buildHookPayload(event, input, process.env, "codex");
}

describe("plugin-codex manifest contract", () => {
  test("every hooks.json command is `wos agent-hook <event> --agent codex`", async () => {
    const manifest = await Bun.file(
      resolve(PLUGIN_ROOT, "hooks/hooks.json"),
    ).json();
    const known = new Set<string>(KNOWN_AGENT_HOOK_EVENTS);
    const commands: string[] = [];
    for (const entries of Object.values(
      manifest.hooks as Record<
        string,
        Array<{ hooks: Array<{ type: string; command: string }> }>
      >,
    )) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          expect(hook.type).toBe("command");
          commands.push(hook.command);
        }
      }
    }
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      const match = /^wos agent-hook (\S+) --agent codex$/.exec(command);
      expect(match).not.toBeNull();
      expect(known.has(match![1]!)).toBe(true);
    }
  });

  test("the manifest declares name `wos` and a semver version", async () => {
    const manifest = await Bun.file(
      resolve(PLUGIN_ROOT, ".codex-plugin/plugin.json"),
    ).json();
    expect(manifest.name).toBe("wos");
    expect(/^\d+\.\d+\.\d+/.test(manifest.version)).toBe(true);
  });

  test("the plugin ships no executable hook scripts", () => {
    expect(readdirSync(PLUGIN_ROOT)).not.toContain("scripts");
  });
});

describe("parseAgentFlag", () => {
  test("defaults to claude with no flag", () => {
    expect(parseAgentFlag([])).toBe("claude");
    expect(parseAgentFlag(["--other"])).toBe("claude");
  });
  test("parses --agent codex and --agent=codex", () => {
    expect(parseAgentFlag(["--agent", "codex"])).toBe("codex");
    expect(parseAgentFlag(["--agent=codex"])).toBe("codex");
  });
  test("an unrecognized agent value falls back to claude", () => {
    expect(parseAgentFlag(["--agent", "gemini"])).toBe("claude");
  });
});

describe("plugin-codex payload mapping", () => {
  test("session-start binds the rollout and carries source + model", () => {
    const event = expectValid(
      codex("session-start", {
        ...BASE_INPUT,
        transcript_path: "/Users/u/.codex/sessions/2026/06/19/rollout-x.jsonl",
        trigger: "startup",
      }),
    );
    expect(event.agent).toBe("codex");
    expect(event.event).toBe("session_start");
    expect(event.agentSessionId).toBe("codex-sess-1");
    expect(event.detail?.transcriptPath).toBe(
      "/Users/u/.codex/sessions/2026/06/19/rollout-x.jsonl",
    );
    expect(event.detail?.source).toBe("startup");
    expect(event.detail?.model).toBe("gpt-5-codex");
  });

  test("eventId uses the codex `cx-` prefix", () => {
    const event = expectValid(codex("stop"));
    expect(event.eventId.startsWith("cx-")).toBe(true);
  });

  test("prompt-submit emits prompt_submit with summary/title and model", () => {
    const event = expectValid(
      codex("prompt-submit", { ...BASE_INPUT, prompt: "Fix the bug\nmore" }),
    );
    expect(event.event).toBe("prompt_submit");
    expect(event.title).toBe("Fix the bug");
    expect(event.detail?.model).toBe("gpt-5-codex");
  });

  test("stop maps to stop (no agent_id discrimination)", () => {
    const event = expectValid(codex("stop", { ...BASE_INPUT, agent_id: "a7" }));
    expect(event.event).toBe("stop");
  });

  test("subagent-stop and post-tool-use map to heartbeat", () => {
    expect(expectValid(codex("subagent-stop")).event).toBe("heartbeat");
    expect(expectValid(codex("post-tool-use")).event).toBe("heartbeat");
  });

  test("permission-request maps to needs-attention permission_request", () => {
    const event = expectValid(
      codex("permission-request", {
        ...BASE_INPUT,
        tool_name: "Bash",
        tool_input: { command: "rm -rf /tmp/x" },
      }),
    );
    expect(event.event).toBe("permission_request");
    expect(event.severity).toBe("needs-attention");
    expect(event.summary).toContain("Bash");
    expect(event.detail?.toolName).toBe("Bash");
    expect(event.detail?.model).toBe("gpt-5-codex");
  });

  test("model is carried on every event when present", () => {
    for (const ev of ["stop", "subagent-stop", "post-tool-use"]) {
      expect(expectValid(codex(ev)).detail?.model).toBe("gpt-5-codex");
    }
  });

  test("omits detail.model when the hook carries no model", () => {
    const event = expectValid(
      codex("stop", { session_id: "s", cwd: "/work" }),
    );
    expect(event.detail).toBeUndefined();
  });

  test("regression: no `--agent` flag still yields agent claude", () => {
    const event = expectValid(buildHookPayload("session-start", BASE_INPUT));
    expect(event.agent).toBe("claude");
    expect(event.eventId.startsWith("cc-")).toBe(true);
  });
});
