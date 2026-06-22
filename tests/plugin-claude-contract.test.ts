import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  AGENT_ACTIVITY_SUMMARY_MAX,
  AGENT_ACTIVITY_TITLE_MAX,
  type AgentActivityEvent,
  validateAgentActivityEvent,
} from "@worktreeos/core/agent-activity";
import {
  buildHookPayload,
  KNOWN_AGENT_HOOK_EVENTS,
  runAgentHook,
} from "@worktreeos/plugin-claude/src/agent-hook";
import { deliverActivityEvent } from "@worktreeos/plugin-claude/src/send";

const PLUGIN_ROOT = resolve(import.meta.dir, "../packages/plugin-claude");

function expectValid(payload: AgentActivityEvent | null): AgentActivityEvent {
  if (!payload) throw new Error("expected a payload, got null");
  const result = validateAgentActivityEvent(payload);
  if (!result.ok) throw new Error(`schema violation: ${result.error}`);
  return result.event;
}

const BASE_INPUT = {
  session_id: "claude-sess-1",
  cwd: "/work/tree",
};

describe("plugin-claude payload contract", () => {
  test("session-start emits valid session_start", () => {
    const event = expectValid(buildHookPayload("session-start", BASE_INPUT));
    expect(event.agent).toBe("claude");
    expect(event.event).toBe("session_start");
    expect(event.agentSessionId).toBe("claude-sess-1");
    expect(event.cwd).toBe("/work/tree");
  });

  test("session-start forwards transcript binding fields", () => {
    for (const source of ["startup", "clear", "compact"]) {
      const event = expectValid(
        buildHookPayload("session-start", {
          ...BASE_INPUT,
          transcript_path: "/Users/u/.claude/projects/p/sess.jsonl",
          source,
        }),
      );
      expect(event.detail?.transcriptPath).toBe(
        "/Users/u/.claude/projects/p/sess.jsonl",
      );
      expect(event.detail?.source).toBe(source);
    }
  });

  test("session-start without transcript_path still emits", () => {
    const event = expectValid(buildHookPayload("session-start", BASE_INPUT));
    expect(event.event).toBe("session_start");
    expect(event.detail).toBeUndefined();

    const sourceOnly = expectValid(
      buildHookPayload("session-start", { ...BASE_INPUT, source: "resume" }),
    );
    expect(sourceOnly.detail?.source).toBe("resume");
  });

  test("prompt-submit emits prompt_submit with truncated query", () => {
    const event = expectValid(
      buildHookPayload("prompt-submit", { ...BASE_INPUT, prompt: "y".repeat(500) }),
    );
    expect(event.event).toBe("prompt_submit");
    expect(event.severity).toBe("info");
    expect((event.summary ?? "").length).toBeLessThanOrEqual(
      AGENT_ACTIVITY_SUMMARY_MAX,
    );
    expect((event.detail?.query as string).length).toBeLessThanOrEqual(
      AGENT_ACTIVITY_SUMMARY_MAX,
    );
  });

  test("prompt-submit derives a title from the first prompt line", () => {
    const event = expectValid(
      buildHookPayload("prompt-submit", {
        ...BASE_INPUT,
        prompt: "Fix   the login\tbug\nand also do something else",
      }),
    );
    expect(event.title).toBe("Fix the login bug");

    const long = expectValid(
      buildHookPayload("prompt-submit", { ...BASE_INPUT, prompt: "z".repeat(300) }),
    );
    expect((long.title as string).length).toBe(AGENT_ACTIVITY_TITLE_MAX);

    const empty = expectValid(buildHookPayload("prompt-submit", BASE_INPUT));
    expect(empty.title).toBeUndefined();
    expect(empty.summary).toBeUndefined();
  });

  test("stop emits stop and respects stop_hook_active", () => {
    const event = expectValid(buildHookPayload("stop", BASE_INPUT));
    expect(event.event).toBe("stop");

    const suppressed = buildHookPayload("stop", {
      ...BASE_INPUT,
      stop_hook_active: true,
    });
    expect(suppressed).toBeNull();
  });

  test("main-thread stop (no agent_id) emits stop", () => {
    const event = expectValid(buildHookPayload("stop", BASE_INPUT));
    expect(event.event).toBe("stop");
  });

  test("a Stop carrying agent_id is a subagent finishing → heartbeat, not stop", () => {
    const event = expectValid(
      buildHookPayload("stop", { ...BASE_INPUT, agent_id: "agent-7" }),
    );
    expect(event.event).toBe("heartbeat");

    // An empty agent_id is treated as a main-thread stop.
    const mainThread = expectValid(
      buildHookPayload("stop", { ...BASE_INPUT, agent_id: "" }),
    );
    expect(mainThread.event).toBe("stop");
  });

  test("SubagentStop always emits a heartbeat", () => {
    const event = expectValid(buildHookPayload("subagent-stop", BASE_INPUT));
    expect(event.event).toBe("heartbeat");
    expect(event.severity).toBe("info");

    // Still a heartbeat even without an agent_id (the hook is subagent-scoped).
    const withId = expectValid(
      buildHookPayload("subagent-stop", { ...BASE_INPUT, agent_id: "agent-3" }),
    );
    expect(withId.event).toBe("heartbeat");
  });

  test("subagent-stop is a known event keyword", () => {
    expect(KNOWN_AGENT_HOOK_EVENTS).toContain("subagent-stop");
  });

  test("stop sends the latest transcript summary as title", async () => {
    const transcript = `${import.meta.dir}/.tmp-claude-transcript-${process.pid}.jsonl`;
    await Bun.write(
      transcript,
      [
        JSON.stringify({ type: "user", message: "hello" }),
        JSON.stringify({ type: "summary", summary: "Old summary" }),
        JSON.stringify({ type: "summary", summary: "Login bug fix" }),
      ].join("\n") + "\n",
    );
    try {
      const event = expectValid(
        buildHookPayload("stop", { ...BASE_INPUT, transcript_path: transcript }),
      );
      expect(event.event).toBe("stop");
      expect(event.title).toBe("Login bug fix");
    } finally {
      await Bun.file(transcript).delete();
    }
  });

  test("stop omits the title when the transcript is missing or has no summary", async () => {
    const missing = expectValid(
      buildHookPayload("stop", {
        ...BASE_INPUT,
        transcript_path: "/nonexistent/transcript.jsonl",
      }),
    );
    expect(missing.title).toBeUndefined();

    const transcript = `${import.meta.dir}/.tmp-claude-transcript-empty-${process.pid}.jsonl`;
    await Bun.write(transcript, JSON.stringify({ type: "user", message: "hi" }) + "\n");
    try {
      const noSummary = expectValid(
        buildHookPayload("stop", { ...BASE_INPUT, transcript_path: transcript }),
      );
      expect(noSummary.title).toBeUndefined();
    } finally {
      await Bun.file(transcript).delete();
    }
  });

  test("notification emits an idle stop signal", () => {
    const event = expectValid(buildHookPayload("notification", BASE_INPUT));
    expect(event.event).toBe("stop");
    expect(event.severity).toBe("info");
  });

  test("ask-user-question emits needs-attention question_asked", () => {
    const event = expectValid(
      buildHookPayload("ask-user-question", {
        ...BASE_INPUT,
        tool_name: "AskUserQuestion",
        tool_input: { questions: [{ question: "Which database should we use?" }] },
      }),
    );
    expect(event.event).toBe("question_asked");
    expect(event.severity).toBe("needs-attention");
    expect(event.summary).toBe("Which database should we use?");
    expect(event.detail?.toolName).toBe("AskUserQuestion");
  });

  test("ask-user-question falls back to a default question", () => {
    const event = expectValid(
      buildHookPayload("ask-user-question", {
        ...BASE_INPUT,
        tool_name: "AskUserQuestion",
        tool_input: {},
      }),
    );
    expect(event.summary).toBe("Claude is asking a question");
  });

  test("permission-request emits needs-attention with tool preview", () => {
    const event = expectValid(
      buildHookPayload("permission-request", {
        ...BASE_INPUT,
        tool_name: "Bash",
        tool_input: { command: "rm -rf /tmp/x" },
      }),
    );
    expect(event.event).toBe("permission_request");
    expect(event.severity).toBe("needs-attention");
    expect(event.summary).toContain("Bash");
    expect(event.summary).toContain("rm -rf /tmp/x");
    expect(event.detail?.toolName).toBe("Bash");
  });

  test("post-tool-use emits an info heartbeat with no summary", () => {
    const event = expectValid(
      buildHookPayload("post-tool-use", {
        ...BASE_INPUT,
        tool_name: "Bash",
        tool_input: { command: "ls" },
      }),
    );
    expect(event.event).toBe("heartbeat");
    expect(event.severity).toBe("info");
    expect(event.summary).toBeUndefined();
    expect(event.title).toBeUndefined();
  });

  test("terminal session id from env is echoed back", () => {
    const event = expectValid(
      buildHookPayload("session-start", BASE_INPUT, {
        WOS_TERMINAL_SESSION_ID: "term-42",
      }),
    );
    expect(event.terminalSessionId).toBe("term-42");
  });

  test("eventIds are unique across emissions", () => {
    const a = expectValid(buildHookPayload("stop", BASE_INPUT));
    const b = expectValid(buildHookPayload("stop", BASE_INPUT));
    expect(a.eventId).not.toBe(b.eventId);
  });

  test("unknown events emit nothing", () => {
    expect(buildHookPayload("not-a-hook", BASE_INPUT)).toBeNull();
  });
});

describe("plugin-claude delivery", () => {
  test("delivers the event to the daemon when url + token are present", async () => {
    const received: unknown[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method === "POST" && new URL(req.url).pathname === "/ui/v1/agent-events") {
          received.push(await req.json());
          return new Response(null, { status: 200 });
        }
        return new Response(null, { status: 404 });
      },
    });
    try {
      const event = expectValid(buildHookPayload("session-start", BASE_INPUT));
      await deliverActivityEvent(event, {
        WOS_DAEMON_URL: `http://127.0.0.1:${server.port}`,
        WOS_AGENT_TOKEN: "tok-1",
      });
      expect(received.length).toBe(1);
      expect((received[0] as AgentActivityEvent).event).toBe("session_start");
    } finally {
      server.stop(true);
    }
  });

  test("no token / no url performs no network call", async () => {
    let called = false;
    const server = Bun.serve({
      port: 0,
      fetch() {
        called = true;
        return new Response(null, { status: 200 });
      },
    });
    try {
      const event = expectValid(buildHookPayload("post-tool-use", BASE_INPUT));
      // URL present, token absent → skip.
      await deliverActivityEvent(event, {
        WOS_DAEMON_URL: `http://127.0.0.1:${server.port}`,
        WOS_HOME: "/nonexistent-wos-home",
      });
      // Nothing present at all → skip.
      await deliverActivityEvent(event, { WOS_HOME: "/nonexistent-wos-home" });
      expect(called).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("runAgentHook exits 0 for known and unknown events without a daemon", async () => {
    const env = { ...process.env };
    delete env.WOS_DAEMON_URL;
    delete env.WOS_AGENT_TOKEN;
    // The handler reads its own process env; with no daemon configured it must
    // still resolve to 0 and perform no observable side effect.
    expect(await runAgentHook(["post-tool-use"])).toBe(0);
    expect(await runAgentHook(["not-a-hook"])).toBe(0);
    expect(await runAgentHook([])).toBe(0);
  });
});

describe("plugin-claude manifest contract", () => {
  test("content changes require a plugin.json version bump", async () => {
    const { computeContentHash } = await import(
      "@worktreeos/plugin-claude/content-hash"
    );
    const manifest = await Bun.file(
      resolve(PLUGIN_ROOT, "content-manifest.json"),
    ).json();
    const { version } = await Bun.file(
      resolve(PLUGIN_ROOT, ".claude-plugin/plugin.json"),
    ).json();
    expect(manifest.version).toBe(version);
    // On mismatch: bump the version, then run `bun scripts/update-plugin-manifest.ts`.
    expect(await computeContentHash()).toBe(manifest.hash);
  });

  test("every hooks.json command invokes wos agent-hook with a known event", async () => {
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
      const match = /^wos agent-hook (\S+)$/.exec(command);
      expect(match).not.toBeNull();
      expect(known.has(match![1]!)).toBe(true);
    }
  });

  test("SessionStart fires on clear and compact sources", async () => {
    // The daemon's transcript rebind/reset depends on a session_start event for
    // /clear and /compact; a matcher restricted to startup|resume suppresses
    // those sources and freezes telemetry. A payload-mapping test cannot catch
    // this because it bypasses hook invocation entirely.
    const manifest = await Bun.file(
      resolve(PLUGIN_ROOT, "hooks/hooks.json"),
    ).json();
    const sessionStart = (
      manifest.hooks as Record<string, Array<{ matcher?: string }>>
    ).SessionStart;
    expect(Array.isArray(sessionStart)).toBe(true);
    const admits = (source: string): boolean =>
      sessionStart.some((entry) => {
        const matcher = entry.matcher;
        // Absent or "*" matcher fires on every source.
        if (matcher === undefined || matcher === "*") return true;
        return new RegExp(matcher).test(source);
      });
    expect(admits("clear")).toBe(true);
    expect(admits("compact")).toBe(true);
  });

  test("the plugin ships no executable hook scripts", async () => {
    const { readdirSync } = await import("node:fs");
    const entries = readdirSync(PLUGIN_ROOT);
    expect(entries).not.toContain("scripts");
  });
});
