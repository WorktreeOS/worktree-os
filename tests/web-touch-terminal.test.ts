import { describe, expect, test } from "bun:test";
import {
  accumulateTouchWheelLines,
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  encodeComposerSubmission,
  encodeQuickAction,
  persistQuickActionsVisible,
  persistTouchOverride,
  QUICK_ACTION_SEQUENCES,
  readStoredQuickActionsVisible,
  readStoredTouchOverride,
  resolveTouchTerminalMode,
  TOUCH_QUICK_ACTIONS_VISIBLE_STORAGE_KEY,
  TOUCH_TERMINAL_NARROW_WIDTH_PX,
  TOUCH_TERMINAL_OVERRIDE_STORAGE_KEY,
  TOUCH_TOOL_PROFILES,
  touchTerminalTool,
  type TouchQuickAction,
} from "../apps/web/src/lib/touch-terminal";

function makeMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => Array.from(data.keys())[index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, String(value));
    },
  };
}

describe("resolveTouchTerminalMode", () => {
  test("desktop fine-pointer wide viewport stays off", () => {
    expect(
      resolveTouchTerminalMode({
        override: "auto",
        coarsePointer: false,
        viewportWidth: 1440,
      }),
    ).toBe(false);
  });

  test("coarse-pointer activates touch mode", () => {
    expect(
      resolveTouchTerminalMode({
        override: "auto",
        coarsePointer: true,
        viewportWidth: 1280,
      }),
    ).toBe(true);
  });

  test("narrow viewport activates touch mode even with fine pointer", () => {
    expect(
      resolveTouchTerminalMode({
        override: "auto",
        coarsePointer: false,
        viewportWidth: TOUCH_TERMINAL_NARROW_WIDTH_PX,
      }),
    ).toBe(true);
  });

  test("force-on wins over fine-pointer wide viewport", () => {
    expect(
      resolveTouchTerminalMode({
        override: "force-on",
        coarsePointer: false,
        viewportWidth: 1920,
      }),
    ).toBe(true);
  });

  test("force-off wins over coarse-pointer", () => {
    expect(
      resolveTouchTerminalMode({
        override: "force-off",
        coarsePointer: true,
        viewportWidth: 800,
      }),
    ).toBe(false);
  });

  test("zero or invalid viewport width does not flip touch on by itself", () => {
    expect(
      resolveTouchTerminalMode({
        override: "auto",
        coarsePointer: false,
        viewportWidth: 0,
      }),
    ).toBe(false);
    expect(
      resolveTouchTerminalMode({
        override: "auto",
        coarsePointer: false,
        viewportWidth: Number.NaN,
      }),
    ).toBe(false);
  });
});

describe("touch override persistence", () => {
  test("readStoredTouchOverride defaults to auto when storage is empty", () => {
    const storage = makeMemoryStorage();
    expect(readStoredTouchOverride(storage)).toBe("auto");
  });

  test("persistTouchOverride writes and clears values", () => {
    const storage = makeMemoryStorage();
    persistTouchOverride("force-on", storage);
    expect(storage.getItem(TOUCH_TERMINAL_OVERRIDE_STORAGE_KEY)).toBe("force-on");
    expect(readStoredTouchOverride(storage)).toBe("force-on");
    persistTouchOverride("auto", storage);
    expect(storage.getItem(TOUCH_TERMINAL_OVERRIDE_STORAGE_KEY)).toBeNull();
    expect(readStoredTouchOverride(storage)).toBe("auto");
  });

  test("readStoredTouchOverride ignores unrecognized values", () => {
    const storage = makeMemoryStorage();
    storage.setItem(TOUCH_TERMINAL_OVERRIDE_STORAGE_KEY, "bogus");
    expect(readStoredTouchOverride(storage)).toBe("auto");
  });
});

describe("quick actions visibility persistence", () => {
  test("defaults to null when unset (caller picks default)", () => {
    const storage = makeMemoryStorage();
    expect(readStoredQuickActionsVisible(storage)).toBeNull();
  });

  test("round-trips boolean values", () => {
    const storage = makeMemoryStorage();
    persistQuickActionsVisible(true, storage);
    expect(storage.getItem(TOUCH_QUICK_ACTIONS_VISIBLE_STORAGE_KEY)).toBe("1");
    expect(readStoredQuickActionsVisible(storage)).toBe(true);
    persistQuickActionsVisible(false, storage);
    expect(storage.getItem(TOUCH_QUICK_ACTIONS_VISIBLE_STORAGE_KEY)).toBe("0");
    expect(readStoredQuickActionsVisible(storage)).toBe(false);
  });
});

describe("encodeQuickAction", () => {
  const cases: Array<[TouchQuickAction, string]> = [
    ["escape", "\x1b"],
    ["tab", "\t"],
    ["enter", "\r"],
    ["arrow-up", "\x1b[A"],
    ["arrow-down", "\x1b[B"],
    ["arrow-right", "\x1b[C"],
    ["arrow-left", "\x1b[D"],
    ["ctrl-c", "\x03"],
    ["ctrl-d", "\x04"],
    ["ctrl-l", "\x0c"],
    ["ctrl-r", "\x12"],
  ];
  for (const [action, expected] of cases) {
    test(`${action} -> expected sequence`, () => {
      expect(encodeQuickAction(action)).toBe(expected);
      expect(QUICK_ACTION_SEQUENCES[action]).toBe(expected);
    });
  }
});

describe("tool-aware touch profiles", () => {
  test("covers every known agent and falls back to shell", () => {
    expect(touchTerminalTool("claude")).toBe("claude");
    expect(touchTerminalTool("codex")).toBe("codex");
    expect(touchTerminalTool("opencode")).toBe("opencode");
    expect(touchTerminalTool("unknown")).toBe("shell");
    expect(touchTerminalTool()).toBe("shell");
  });

  test("every agent exposes interrupt and commands terminated with Enter", () => {
    for (const tool of ["claude", "codex", "opencode"] as const) {
      const profile = TOUCH_TOOL_PROFILES[tool];
      expect(profile.primary[0]?.sequence).toBe("\x1b");
      expect(profile.commands.length).toBeGreaterThan(0);
      for (const command of profile.commands.filter((item) => item.command)) {
        expect(command.sequence.endsWith("\r")).toBe(true);
      }
    }
  });

  test("encodes tool-specific shortcuts exactly", () => {
    expect(TOUCH_TOOL_PROFILES.claude.primary.find((a) => a.id === "plan")?.sequence).toBe("\x1b[Z");
    expect(TOUCH_TOOL_PROFILES.codex.primary.find((a) => a.id === "approvals")?.sequence).toBe("/approvals\r");
    expect(TOUCH_TOOL_PROFILES.opencode.primary.find((a) => a.id === "undo")?.sequence).toBe("/undo\r");
    expect(TOUCH_TOOL_PROFILES.shell.primary.find((a) => a.id === "search")?.sequence).toBe("\x12");
  });
});

describe("encodeComposerSubmission", () => {
  test("insert mode sends text verbatim", () => {
    expect(encodeComposerSubmission("ls", "insert")).toBe("ls");
  });

  test("send mode appends Enter (\\r)", () => {
    expect(encodeComposerSubmission("echo hi", "send")).toBe("echo hi\r");
  });

  test("paste mode wraps with bracketed-paste markers and preserves newlines", () => {
    const text = "line1\nline2\nline3";
    const encoded = encodeComposerSubmission(text, "paste");
    expect(encoded.startsWith(BRACKETED_PASTE_START)).toBe(true);
    expect(encoded.endsWith(BRACKETED_PASTE_END)).toBe(true);
    // The body between the markers preserves the original text including line
    // breaks, so a TUI receiving bracketed paste sees them.
    expect(
      encoded.slice(
        BRACKETED_PASTE_START.length,
        encoded.length - BRACKETED_PASTE_END.length,
      ),
    ).toBe(text);
  });

  test("paste mode handles an empty draft (markers only)", () => {
    expect(encodeComposerSubmission("", "paste")).toBe(
      `${BRACKETED_PASTE_START}${BRACKETED_PASTE_END}`,
    );
  });
});

describe("desktop regression: touch chrome is hidden by default", () => {
  test("fresh desktop install renders with no touch override and resolves to off", () => {
    const storage = makeMemoryStorage();
    const override = readStoredTouchOverride(storage);
    expect(override).toBe("auto");
    expect(
      resolveTouchTerminalMode({
        override,
        coarsePointer: false,
        viewportWidth: 1600,
      }),
    ).toBe(false);
  });
});

describe("accumulateTouchWheelLines", () => {
  test("a drag of one cell height yields one scroll-down notch", () => {
    expect(accumulateTouchWheelLines(17, 17, 0)).toEqual({ lines: 1, carry: 0 });
  });

  test("finger moving down (negative delta) scrolls up", () => {
    expect(accumulateTouchWheelLines(-34, 17, 0)).toEqual({ lines: -2, carry: 0 });
  });

  test("sub-cell drags carry over until they accumulate a whole line", () => {
    const first = accumulateTouchWheelLines(10, 17, 0);
    expect(first.lines).toBe(0);
    expect(first.carry).toBe(10);
    const second = accumulateTouchWheelLines(10, 17, first.carry);
    expect(second.lines).toBe(1);
    expect(second.carry).toBeCloseTo(3);
  });

  test("direction reversal consumes the carried remainder first", () => {
    const { lines, carry } = accumulateTouchWheelLines(-10, 17, 10);
    expect(lines).toBe(0);
    expect(carry).toBe(0);
  });

  test("degenerate cell height never emits notches", () => {
    expect(accumulateTouchWheelLines(100, 0, 5)).toEqual({ lines: 0, carry: 0 });
    expect(accumulateTouchWheelLines(100, Number.NaN, 5)).toEqual({ lines: 0, carry: 0 });
  });
});
