import { test, expect, describe } from "bun:test";
import {
  OUTSIDE_TMUX_WARNING,
  terminalBackendWarning,
} from "./terminal-backend-warning";

describe("terminalBackendWarning", () => {
  test("warns on the default backend", () => {
    expect(terminalBackendWarning("default")).toBe(OUTSIDE_TMUX_WARNING);
  });

  test("is silent on the tmux backend", () => {
    expect(terminalBackendWarning("tmux")).toBeNull();
  });

  test("is silent when the backend is unknown", () => {
    expect(terminalBackendWarning(undefined)).toBeNull();
  });

  test("uses the same literal copy as the CLI surfaces", () => {
    expect(OUTSIDE_TMUX_WARNING).toBe(
      "Running outside tmux/psmux — terminal sessions may be unstable.",
    );
  });
});
