import { describe, test, expect } from "bun:test";

import { canForwardTerminalInput } from "./terminal-output-gate";

describe("canForwardTerminalInput", () => {
  test("forwards live input from an attached controller", () => {
    expect(
      canForwardTerminalInput({
        disposed: false,
        replaying: false,
        inputEnabled: true,
      }),
    ).toBe(true);
  });

  test("suppresses replies while replaying historical scrollback", () => {
    // Regression: a Device Attributes query (`ESC[c` / `ESC[>c`) in the
    // replayed journal must not be answered — the asking program is gone, so
    // the reply would echo at the idle shell prompt as garbage like
    // `1;2c0;276;0c`.
    expect(
      canForwardTerminalInput({
        disposed: false,
        replaying: true,
        inputEnabled: true,
      }),
    ).toBe(false);
  });

  test("stays silent for a read-only spectator", () => {
    expect(
      canForwardTerminalInput({
        disposed: false,
        replaying: false,
        inputEnabled: false,
      }),
    ).toBe(false);
  });

  test("never forwards after disposal", () => {
    expect(
      canForwardTerminalInput({
        disposed: true,
        replaying: false,
        inputEnabled: true,
      }),
    ).toBe(false);
  });
});
