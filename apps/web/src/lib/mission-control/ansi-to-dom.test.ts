import { describe, expect, test } from "bun:test";
import { renderSgrLineToHtml, renderSnapshotToHtml } from "./ansi-to-dom";

describe("renderSgrLineToHtml", () => {
  test("plain text is emitted without a span", () => {
    expect(renderSgrLineToHtml("hello world")).toBe("hello world");
  });

  test("HTML-escapes special characters", () => {
    expect(renderSgrLineToHtml("a <b> & c")).toBe("a &lt;b&gt; &amp; c");
  });

  test("a basic colour run becomes a styled span and resets", () => {
    const html = renderSgrLineToHtml("\x1b[31mred\x1b[0mplain");
    expect(html).toContain("color:#E95678");
    expect(html).toContain(">red<");
    // After reset, the trailing text carries no style.
    expect(html.endsWith("plain")).toBe(true);
  });

  test("bold + underline emit weight and decoration", () => {
    const html = renderSgrLineToHtml("\x1b[1;4mX");
    expect(html).toContain("font-weight:600");
    expect(html).toContain("text-decoration:underline");
  });

  test("reverse swaps foreground and background defaults", () => {
    const html = renderSgrLineToHtml("\x1b[7mX");
    expect(html).toContain("color:#000000");
    expect(html).toContain("background-color:#E6E6E6");
  });

  test("256-colour foreground resolves through the cube", () => {
    // 196 → cube (5,0,0) → pure red #ff0000.
    expect(renderSgrLineToHtml("\x1b[38;5;196mX")).toContain("color:#ff0000");
  });

  test("256-colour grayscale ramp", () => {
    // 232 → level 8 → #080808.
    expect(renderSgrLineToHtml("\x1b[38;5;232mX")).toContain("color:#080808");
  });

  test("truecolour foreground resolves to hex", () => {
    expect(renderSgrLineToHtml("\x1b[38;2;10;20;30mX")).toContain(
      "color:#0a141e",
    );
  });

  test("bright colour uses the bright palette slot", () => {
    expect(renderSgrLineToHtml("\x1b[91mX")).toContain("color:#EC6A88");
  });

  test("non-SGR CSI sequences are ignored, not interpreted", () => {
    // ESC[2J (erase display) and ESC[H (cursor home) must not appear or break.
    const html = renderSgrLineToHtml("\x1b[2J\x1b[Hkept");
    expect(html).toBe("kept");
  });

  test("a lone ESC is skipped", () => {
    expect(renderSgrLineToHtml("a\x1bb")).toBe("ab");
  });
});

describe("renderSnapshotToHtml", () => {
  test("joins rows with newlines and renders each independently", () => {
    const html = renderSnapshotToHtml(["\x1b[31mred", "plain", ""]);
    const rows = html.split("\n");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("color:#E95678");
    expect(rows[1]).toBe("plain");
    expect(rows[2]).toBe("");
  });

  test("SGR state does not bleed across rows", () => {
    // Row 0 opens red without resetting; row 1 must start fresh (no colour).
    const html = renderSnapshotToHtml(["\x1b[31mred", "next"]);
    const rows = html.split("\n");
    expect(rows[1]).toBe("next");
  });
});
