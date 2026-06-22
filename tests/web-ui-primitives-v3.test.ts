import { describe, expect, test } from "bun:test";

/* Smoke tests for the v3 UI primitives.
 *
 * The apps/web codebase has no jsdom/RTL setup, so we don't render the
 * components here — we only verify the modules load and surface the
 * expected public API. This catches accidental rename / export-drop
 * regressions before downstream code paths reference them. */

describe("ui/button (v3)", () => {
  test("exports Button + buttonVariants", async () => {
    const mod = await import("../apps/web/src/components/ui/button");
    expect(typeof mod.Button).toBe("function");
    expect(typeof mod.buttonVariants).toBe("function");
  });
});

describe("ui/icon-button (v3)", () => {
  test("exports IconButton + iconButtonVariants", async () => {
    const mod = await import("../apps/web/src/components/ui/icon-button");
    expect(typeof mod.IconButton).toBe("function");
    expect(typeof mod.iconButtonVariants).toBe("function");
  });
});

describe("ui/split-button (v3)", () => {
  test("exports SplitButton", async () => {
    const mod = await import("../apps/web/src/components/ui/split-button");
    expect(typeof mod.SplitButton).toBe("function");
  });
});

describe("ui/inline-code (v3)", () => {
  test("exports Ic", async () => {
    const mod = await import("../apps/web/src/components/ui/inline-code");
    expect(typeof mod.Ic).toBe("function");
  });
});

describe("ui/command-pill (v3)", () => {
  test("exports CommandPill", async () => {
    const mod = await import("../apps/web/src/components/ui/command-pill");
    expect(typeof mod.CommandPill).toBe("function");
  });
});

describe("ui/todo-banner (v3)", () => {
  test("exports TodoBanner", async () => {
    const mod = await import("../apps/web/src/components/ui/todo-banner");
    expect(typeof mod.TodoBanner).toBe("function");
  });
});

describe("ui/hairline-list (v3)", () => {
  test("exports HairlineList + HairlineRow", async () => {
    const mod = await import("../apps/web/src/components/ui/hairline-list");
    expect(typeof mod.HairlineList).toBe("function");
    expect(typeof mod.HairlineRow).toBe("function");
  });
});

describe("ui/composer (v3)", () => {
  test("exports Composer", async () => {
    const mod = await import("../apps/web/src/components/ui/composer");
    expect(typeof mod.Composer).toBe("function");
  });
});

describe("ui/window-chrome (v3)", () => {
  test("exports WindowChrome", async () => {
    const mod = await import("../apps/web/src/components/ui/window-chrome");
    expect(typeof mod.WindowChrome).toBe("function");
  });
});

describe("ui/rail (v3)", () => {
  test("exports Rail + RailGroup + RailLabel + RailRow + RailFooter", async () => {
    const mod = await import("../apps/web/src/components/ui/rail");
    expect(typeof mod.Rail).toBe("function");
    expect(typeof mod.RailGroup).toBe("function");
    expect(typeof mod.RailLabel).toBe("function");
    expect(typeof mod.RailRow).toBe("function");
    expect(typeof mod.RailFooter).toBe("function");
  });
});

describe("ui/error-block (v3)", () => {
  test("exports ErrorBlock", async () => {
    const mod = await import("../apps/web/src/components/ui/error-block");
    expect(typeof mod.ErrorBlock).toBe("function");
  });
});
