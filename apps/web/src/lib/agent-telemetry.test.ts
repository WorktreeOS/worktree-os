import { describe, expect, test } from "bun:test";
import { hasMeaningfulTelemetry } from "./agent-telemetry";
import type { AgentTelemetry } from "./terminal-protocol";

function telemetry(overrides: Partial<AgentTelemetry> = {}): AgentTelemetry {
  return {
    mainTokens: 0,
    subagentTokens: 0,
    contextUsed: 0,
    contextWindow: 1_000_000,
    updatedAt: "2026-06-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("hasMeaningfulTelemetry", () => {
  test("an all-zero block has no meaningful usage", () => {
    expect(hasMeaningfulTelemetry(telemetry())).toBe(false);
  });

  test("any single non-zero usage field counts as meaningful", () => {
    expect(hasMeaningfulTelemetry(telemetry({ mainTokens: 1 }))).toBe(true);
    expect(hasMeaningfulTelemetry(telemetry({ subagentTokens: 1 }))).toBe(true);
    expect(hasMeaningfulTelemetry(telemetry({ contextUsed: 1 }))).toBe(true);
  });

  test("contextWindow alone does not make a block meaningful", () => {
    expect(hasMeaningfulTelemetry(telemetry({ contextWindow: 1_000_000 }))).toBe(
      false,
    );
  });
});
