import { test, expect, describe } from "bun:test";
import { backendStartupWarning } from "../apps/cli/commands/start";

describe("backendStartupWarning", () => {
  test("warns on the default backend with the exact copy", () => {
    expect(backendStartupWarning("default")).toBe(
      "Running outside tmux/psmux — terminal sessions may be unstable.",
    );
  });

  test("is silent on the tmux backend", () => {
    expect(backendStartupWarning("tmux")).toBeNull();
  });
});
