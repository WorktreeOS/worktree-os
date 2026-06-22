import { describe, expect, test } from "bun:test";
import {
  AGENT_TELEMETRY_CONTEXT_WINDOW,
  contextWindowForModel,
} from "@worktreeos/core/agent-activity";

describe("contextWindowForModel", () => {
  test("claude models report the flat 1M window", () => {
    expect(contextWindowForModel("claude-opus-4-8")).toBe(1_048_576);
    expect(contextWindowForModel("claude-opus-4-8")).toBe(
      AGENT_TELEMETRY_CONTEXT_WINDOW,
    );
  });

  test("a known Codex/GPT model reports its own window", () => {
    expect(contextWindowForModel("gpt-5-codex")).toBe(400_000);
    expect(contextWindowForModel("gpt-5")).toBe(400_000);
    expect(contextWindowForModel("gpt-4.1")).toBe(1_047_576);
  });

  test("an unknown or absent model uses the safe default", () => {
    expect(contextWindowForModel("totally-unknown-model")).toBe(
      AGENT_TELEMETRY_CONTEXT_WINDOW,
    );
    expect(contextWindowForModel(undefined)).toBe(AGENT_TELEMETRY_CONTEXT_WINDOW);
    expect(contextWindowForModel("")).toBe(AGENT_TELEMETRY_CONTEXT_WINDOW);
  });
});
