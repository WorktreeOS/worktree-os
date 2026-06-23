import { describe, expect, test } from "bun:test";
import {
  deriveAgentPluginOffer,
  offerFromSession,
  shouldRenderOffer,
} from "./agent-plugin-banner";
import type {
  TerminalActiveCommand,
  TerminalKnownAgent,
  TerminalSessionMetadata,
  TerminalSessionStatus,
} from "./terminal-protocol";

function activeCommand(
  partial: Partial<TerminalActiveCommand> = {},
): TerminalActiveCommand {
  return { pid: 1, command: "claude", args: "", ...partial };
}

function session(
  status: TerminalSessionStatus,
  activeCmd?: TerminalActiveCommand,
): TerminalSessionMetadata {
  return {
    id: "s1",
    worktreePath: "/repo/wt",
    status,
    shell: "/bin/zsh",
    cwd: "/repo/wt",
    cols: 80,
    rows: 24,
    createdAt: "2026-06-13T00:00:00.000Z",
    activeCommand: activeCmd,
  };
}

describe("deriveAgentPluginOffer", () => {
  test("claude missing offers Install", () => {
    expect(
      deriveAgentPluginOffer(
        activeCommand({ agent: "claude", pluginInstalled: false }),
      ),
    ).toEqual({ agent: "claude", kind: "install", stateKey: "claude:missing" });
  });

  test("claude outdated offers Update", () => {
    expect(
      deriveAgentPluginOffer(
        activeCommand({
          agent: "claude",
          pluginInstalled: true,
          pluginOutdated: true,
        }),
      ),
    ).toEqual({ agent: "claude", kind: "update", stateKey: "claude:outdated" });
  });

  test("claude installed & current offers Reinstall", () => {
    expect(
      deriveAgentPluginOffer(
        activeCommand({
          agent: "claude",
          pluginInstalled: true,
          pluginOutdated: false,
        }),
      ),
    ).toEqual({
      agent: "claude",
      kind: "reinstall",
      stateKey: "claude:current",
    });
  });

  test("opencode missing offers Install", () => {
    expect(
      deriveAgentPluginOffer(
        activeCommand({ agent: "opencode", pluginInstalled: false }),
      ),
    ).toEqual({
      agent: "opencode",
      kind: "install",
      stateKey: "opencode:missing",
    });
  });

  test("opencode installed offers nothing (reinstall is claude-only)", () => {
    expect(
      deriveAgentPluginOffer(
        activeCommand({ agent: "opencode", pluginInstalled: true }),
      ),
    ).toBeNull();
  });

  test("codex missing offers Install", () => {
    expect(
      deriveAgentPluginOffer(
        activeCommand({
          agent: "codex" as TerminalKnownAgent,
          pluginInstalled: false,
        }),
      ),
    ).toEqual({ agent: "codex", kind: "install", stateKey: "codex:missing" });
  });

  test("codex installed & current offers nothing (no reinstall affordance)", () => {
    expect(
      deriveAgentPluginOffer(
        activeCommand({
          agent: "codex" as TerminalKnownAgent,
          pluginInstalled: true,
        }),
      ),
    ).toBeNull();
  });

  test("codex outdated offers Update", () => {
    expect(
      deriveAgentPluginOffer(
        activeCommand({
          agent: "codex" as TerminalKnownAgent,
          pluginInstalled: true,
          pluginOutdated: true,
        }),
      ),
    ).toEqual({ agent: "codex", kind: "update", stateKey: "codex:outdated" });
  });

  test("pi missing offers Install", () => {
    expect(
      deriveAgentPluginOffer(
        activeCommand({
          agent: "pi" as TerminalKnownAgent,
          pluginInstalled: false,
        }),
      ),
    ).toEqual({ agent: "pi", kind: "install", stateKey: "pi:missing" });
  });

  test("pi installed offers nothing and never an update variant", () => {
    // pi has no marketplace/version CLI: installed → no update / reinstall, and
    // an `pluginOutdated` flag (which pi never sets) must not change that.
    expect(
      deriveAgentPluginOffer(
        activeCommand({
          agent: "pi" as TerminalKnownAgent,
          pluginInstalled: true,
        }),
      ),
    ).toBeNull();
    expect(
      deriveAgentPluginOffer(
        activeCommand({
          agent: "pi" as TerminalKnownAgent,
          pluginInstalled: true,
          pluginOutdated: true,
        }),
      ),
    ).toBeNull();
  });

  test("no detected agent — no offer", () => {
    expect(deriveAgentPluginOffer(activeCommand())).toBeNull();
    expect(deriveAgentPluginOffer(undefined)).toBeNull();
  });

  test("uncomputed flags (pluginInstalled undefined) — no offer", () => {
    expect(
      deriveAgentPluginOffer(activeCommand({ agent: "claude" })),
    ).toBeNull();
  });
});

describe("offerFromSession", () => {
  test("derives an offer for a running session's active command", () => {
    expect(
      offerFromSession(
        session("running", activeCommand({ agent: "claude", pluginInstalled: false })),
      ),
    ).toEqual({ agent: "claude", kind: "install", stateKey: "claude:missing" });
  });

  test("no offer for a non-running session even with a detected agent", () => {
    expect(
      offerFromSession(
        session("exited", activeCommand({ agent: "claude", pluginInstalled: false })),
      ),
    ).toBeNull();
  });

  test("no offer for a null session", () => {
    expect(offerFromSession(null)).toBeNull();
  });
});

describe("shouldRenderOffer", () => {
  const offer = {
    agent: "claude" as const,
    kind: "install" as const,
    stateKey: "claude:missing",
  };

  test("renders when nothing is dismissed", () => {
    expect(shouldRenderOffer(offer, null)).toBe(true);
  });

  test("hidden while the dismissed state holds", () => {
    expect(shouldRenderOffer(offer, "claude:missing")).toBe(false);
  });

  test("re-shows once the detected state changes", () => {
    // Dismissed `claude:missing`, but the agent is now outdated.
    const outdated = {
      agent: "claude" as const,
      kind: "update" as const,
      stateKey: "claude:outdated",
    };
    expect(shouldRenderOffer(outdated, "claude:missing")).toBe(true);
  });

  test("never renders a null offer", () => {
    expect(shouldRenderOffer(null, null)).toBe(false);
  });
});
