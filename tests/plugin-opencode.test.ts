import { describe, expect, test } from "bun:test";

import {
  type AgentActivityEvent,
  validateAgentActivityEvent,
} from "@worktreeos/core/agent-activity";
import { createWosHooks } from "@worktreeos/plugin-opencode";
import { buildActivityEvent } from "@worktreeos/plugin-opencode/payload";

function fakeClient(parentIds: Record<string, string | undefined> = {}) {
  let lookups = 0;
  return {
    lookups: () => lookups,
    client: {
      session: {
        async get({ path }: { path: { id: string } }) {
          lookups += 1;
          return { data: { parentID: parentIds[path.id] } };
        },
      },
    },
  };
}

function harness(parentIds: Record<string, string | undefined> = {}) {
  const sent: AgentActivityEvent[] = [];
  const fake = fakeClient(parentIds);
  const hooks = createWosHooks({
    client: fake.client,
    directory: "/work/tree",
    send: (event) => sent.push(event),
  });
  return { hooks, sent, lookups: fake.lookups };
}

describe("buildActivityEvent", () => {
  test("produces schema-valid payloads", () => {
    const event = buildActivityEvent("prompt_submit", "s1", "/work/tree", {
      summary: "do things",
      detail: { query: "do things" },
    });
    const result = validateAgentActivityEvent(event);
    expect(result.ok).toBe(true);
  });

  test("echoes terminal session id from env and truncates summary", () => {
    const event = buildActivityEvent("stop", "s1", "/work/tree", {
      summary: "z".repeat(400),
      env: { WOS_TERMINAL_SESSION_ID: "term-9" },
    });
    expect(event.terminalSessionId).toBe("term-9");
    expect(event.summary?.length).toBe(200);
  });

  test("eventIds are unique", () => {
    const a = buildActivityEvent("stop", "s1", "/w");
    const b = buildActivityEvent("stop", "s1", "/w");
    expect(a.eventId).not.toBe(b.eventId);
  });
});

describe("createWosHooks", () => {
  test("session.idle reports stop", async () => {
    const { hooks, sent } = harness();
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s1" } },
    });
    expect(sent.length).toBe(1);
    expect(sent[0]!.event).toBe("stop");
    expect(sent[0]!.agent).toBe("opencode");
  });

  test("question tool reports needs-attention question_asked", async () => {
    const { hooks, sent } = harness();
    await hooks["tool.execute.before"]({ tool: "question", sessionID: "s1" });
    expect(sent.length).toBe(1);
    expect(sent[0]!.event).toBe("question_asked");
    expect(sent[0]!.severity).toBe("needs-attention");
  });

  test("other tools before-execute are ignored", async () => {
    const { hooks, sent } = harness();
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s1" });
    expect(sent.length).toBe(0);
  });

  test("chat.message reports prompt_submit with text parts only", async () => {
    const { hooks, sent } = harness();
    await hooks["chat.message"](
      { sessionID: "s1" },
      {
        parts: [
          { type: "text", text: "fix" },
          { type: "tool_use" },
          { type: "text", text: "the bug" },
        ],
      },
    );
    expect(sent.length).toBe(1);
    expect(sent[0]!.event).toBe("prompt_submit");
    expect(sent[0]!.detail?.query).toBe("fix the bug");
  });

  test("subagent sessions are suppressed with cached lookups", async () => {
    const { hooks, sent, lookups } = harness({ sub: "parent-1" });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "sub" } },
    });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "sub" } },
    });
    expect(sent.length).toBe(0);
    expect(lookups()).toBe(1);
  });

  test("session.created with parentID is suppressed", async () => {
    const { hooks, sent } = harness();
    await hooks.event({
      event: {
        type: "session.created",
        properties: { info: { id: "sub", parentID: "p" } },
      },
    });
    expect(sent.length).toBe(0);
  });

  test("permission.replied with reject is ignored, accept reports", async () => {
    const { hooks, sent } = harness();
    await hooks.event({
      event: {
        type: "permission.replied",
        properties: { sessionID: "s1", response: "reject" },
      },
    });
    expect(sent.length).toBe(0);
    await hooks.event({
      event: {
        type: "permission.replied",
        properties: { sessionID: "s1", response: "always" },
      },
    });
    expect(sent.length).toBe(1);
    expect(sent[0]!.event).toBe("permission_replied");
  });

  test("permission.asked reports needs-attention with summary", async () => {
    const { hooks, sent } = harness();
    await hooks.event({
      event: {
        type: "permission.asked",
        properties: {
          sessionID: "s1",
          type: "bash",
          metadata: { command: "rm -rf /tmp/x" },
        },
      },
    });
    expect(sent.length).toBe(1);
    expect(sent[0]!.event).toBe("permission_request");
    expect(sent[0]!.summary).toContain("rm -rf /tmp/x");
  });

  test("all reported payloads pass schema validation", async () => {
    const { hooks, sent } = harness();
    await hooks.event({
      event: { type: "session.created", properties: { info: { id: "s1" } } },
    });
    await hooks["chat.message"](
      { sessionID: "s1" },
      { parts: [{ type: "text", text: "go" }] },
    );
    await hooks["tool.execute.before"]({ tool: "question", sessionID: "s1" });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s1" } },
    });
    expect(sent.length).toBe(4);
    for (const event of sent) {
      expect(validateAgentActivityEvent(event).ok).toBe(true);
    }
  });
});
