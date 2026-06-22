import { describe, expect, test } from "bun:test";
import { TerminalModeTracker } from "@worktreeos/daemon/terminal-layer/mode-tracker";

const enc = new TextEncoder();
const feed = (tracker: TerminalModeTracker, text: string) =>
  tracker.feed(enc.encode(text));

describe("TerminalModeTracker", () => {
  test("default state restores to nothing", () => {
    const t = new TerminalModeTracker();
    feed(t, "plain output\r\nmore text");
    expect(t.restoreSequence()).toBe("");
  });

  test("tracks alternate screen, mouse, and bracketed paste", () => {
    const t = new TerminalModeTracker();
    feed(t, "\x1b[?1049h\x1b[?1002h\x1b[?1006h\x1b[?2004h");
    expect(t.restoreSequence()).toBe(
      "\x1b[?1049h\x1b[?1002h\x1b[?1006h\x1b[?2004h",
    );
  });

  test("alternate-screen restore is emitted before other modes", () => {
    const t = new TerminalModeTracker();
    feed(t, "\x1b[?2004h\x1b[?1049h");
    expect(t.restoreSequence()).toBe("\x1b[?1049h\x1b[?2004h");
  });

  test("DECRST clears a previously set mode", () => {
    const t = new TerminalModeTracker();
    feed(t, "\x1b[?1049h\x1b[?1049l");
    expect(t.restoreSequence()).toBe("");
  });

  test("cursor hide (default-on mode) is restored as reset", () => {
    const t = new TerminalModeTracker();
    feed(t, "\x1b[?25l");
    expect(t.restoreSequence()).toBe("\x1b[?25l");
    feed(t, "\x1b[?25h");
    expect(t.restoreSequence()).toBe("");
  });

  test("sequences split across feed boundaries are parsed", () => {
    const t = new TerminalModeTracker();
    feed(t, "\x1b[?10");
    feed(t, "49h");
    expect(t.restoreSequence()).toBe("\x1b[?1049h");
  });

  test("multiple params in one DECSET are applied", () => {
    const t = new TerminalModeTracker();
    feed(t, "\x1b[?1049;2004h");
    expect(t.restoreSequence()).toBe("\x1b[?1049h\x1b[?2004h");
  });

  test("enabling a mouse protocol replaces the previous one", () => {
    const t = new TerminalModeTracker();
    feed(t, "\x1b[?1000h\x1b[?1002h");
    expect(t.restoreSequence()).toBe("\x1b[?1002h");
  });

  test("mode sequences inside OSC payloads are ignored", () => {
    const t = new TerminalModeTracker();
    feed(t, "\x1b]0;title with \x1b[?1049h inside\x07");
    expect(t.restoreSequence()).toBe("");
  });

  test("mode sequences inside DCS payloads are ignored", () => {
    const t = new TerminalModeTracker();
    feed(t, "\x1bPsome\x1b[?1049hpayload\x1b\\");
    expect(t.restoreSequence()).toBe("");
  });

  test("RIS resets all tracked modes", () => {
    const t = new TerminalModeTracker();
    feed(t, "\x1b[?1049h\x1b[?2004h\x1bc");
    expect(t.restoreSequence()).toBe("");
  });

  test("non-private and untracked CSI sequences are ignored", () => {
    const t = new TerminalModeTracker();
    feed(t, "\x1b[1049h\x1b[?12345h\x1b[31m\x1b[2J\x1b[H");
    expect(t.restoreSequence()).toBe("");
  });

  test("oversized CSI parameter runs abort without corrupting state", () => {
    const t = new TerminalModeTracker();
    feed(t, `\x1b[?${"1".repeat(200)}h\x1b[?1049h`);
    expect(t.restoreSequence()).toBe("\x1b[?1049h");
  });
});
