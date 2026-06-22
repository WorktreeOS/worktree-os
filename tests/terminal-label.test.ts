import { describe, expect, test } from "bun:test";
import { terminalLabel } from "../apps/web/src/lib/terminal-agents";
import type {
  TerminalKnownAgent,
  TerminalSessionMetadata,
} from "../apps/web/src/lib/terminal-protocol";

function session(
  overrides: Partial<TerminalSessionMetadata> = {},
): TerminalSessionMetadata {
  return {
    id: "t1",
    worktreePath: "/wt",
    status: "running",
    shell: "zsh",
    cwd: "/wt",
    cols: 80,
    rows: 24,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function withAgent(agent: TerminalKnownAgent): Partial<TerminalSessionMetadata> {
  return {
    activeCommand: {
      pid: 2,
      command: `/usr/bin/${agent}`,
      args: agent,
      agent,
    },
  };
}

describe("terminalLabel precedence", () => {
  test("a custom title wins over agent and fallback", () => {
    expect(
      terminalLabel(session({ title: "api logs", ...withAgent("claude") }), "branch"),
    ).toBe("api logs");
  });

  test("a whitespace-only title is ignored", () => {
    expect(terminalLabel(session({ title: "   ", ...withAgent("codex") }), "branch")).toBe(
      "Codex",
    );
  });

  test("without a title, a recognized agent label is used", () => {
    expect(terminalLabel(session(withAgent("claude")), "branch")).toBe(
      "Claude Code",
    );
  });

  test("without a title or agent, the fallback is used", () => {
    expect(terminalLabel(session(), "branch")).toBe("branch");
  });
});
