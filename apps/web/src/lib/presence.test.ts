import { test, expect, describe } from "bun:test";
import { computePresenceState } from "./presence";

describe("computePresenceState", () => {
  test("focused only when the window has focus AND the document is visible", () => {
    expect(
      computePresenceState({ hasFocus: true, visibility: "visible" }),
    ).toBe("focused");
  });

  test("visible but unfocused is away (side-by-side with an editor)", () => {
    expect(
      computePresenceState({ hasFocus: false, visibility: "visible" }),
    ).toBe("away");
  });

  test("focused-but-hidden is away (minimized / backgrounded)", () => {
    expect(
      computePresenceState({ hasFocus: true, visibility: "hidden" }),
    ).toBe("away");
  });

  test("neither focused nor visible is away", () => {
    expect(
      computePresenceState({ hasFocus: false, visibility: "hidden" }),
    ).toBe("away");
  });
});
