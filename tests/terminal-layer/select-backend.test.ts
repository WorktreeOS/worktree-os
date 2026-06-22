import { describe, expect, test } from "bun:test";
import { selectTerminalBackend } from "@worktreeos/daemon/terminal-layer/select-backend";
import { createFakeTerminalRuntime } from "@worktreeos/daemon/terminal-layer/testing";

describe("selectTerminalBackend", () => {
  test("returns the default adapter when backendId is \"default\"", async () => {
    const r = createFakeTerminalRuntime();
    const backend = await selectTerminalBackend({
      backendId: "default",
      runtime: r.runtime,
    });
    expect(backend.id).toBe("default");
    expect(backend.label).toBe("Default");
  });

  test("returns the tmux adapter when backendId is \"tmux\"", async () => {
    const r = createFakeTerminalRuntime();
    const backend = await selectTerminalBackend({
      backendId: "tmux",
      runtime: r.runtime,
    });
    expect(backend.id).toBe("tmux");
    expect(backend.label).toBe("tmux");
  });
});
