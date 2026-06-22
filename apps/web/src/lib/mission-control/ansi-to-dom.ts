/**
 * Lightweight SGR → DOM renderer for the Mission Control wall.
 *
 * Terminal screen snapshots arrive as flat rows carrying SGR color/attribute
 * escapes only (tmux's `capture-pane -e` has already resolved cursor-addressing
 * and the alternate-screen buffer into plain lines). This module converts those
 * runs into styled HTML spans — it deliberately does NOT implement a terminal
 * emulator: any non-SGR CSI sequence is skipped, never interpreted.
 *
 * Pure and synchronous so it is unit-testable and cheap to run per frame.
 */

/** 16-colour ANSI palette, matched to the Focus overlay's xterm theme so a
 * pane reads the same on the wall as it does when attached. */
const ANSI_16 = [
  "#000000", "#E95678", "#29D398", "#FAB795",
  "#26BBD9", "#EE64AC", "#59E1E3", "#E6E6E6",
  "#5C6370", "#EC6A88", "#3FDAA4", "#FBC3A7",
  "#3FC4DE", "#F075B5", "#6BE4E6", "#FFFFFF",
] as const;

const DEFAULT_FG = "#E6E6E6";
const DEFAULT_BG = "#000000";

interface SgrState {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  reverse: boolean;
}

function freshState(): SgrState {
  return {
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    reverse: false,
  };
}

function escapeHtml(text: string): string {
  let out = "";
  for (const ch of text) {
    if (ch === "&") out += "&amp;";
    else if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else out += ch;
  }
  return out;
}

/** Resolve a 256-colour palette index to a hex string. */
function xterm256(index: number): string {
  if (index < 16) return ANSI_16[index] ?? DEFAULT_FG;
  if (index >= 16 && index <= 231) {
    const n = index - 16;
    const r = Math.floor(n / 36);
    const g = Math.floor((n % 36) / 6);
    const b = n % 6;
    const step = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return rgbHex(step(r), step(g), step(b));
  }
  // 232..255 grayscale ramp.
  const level = 8 + (index - 232) * 10;
  return rgbHex(level, level, level);
}

function rgbHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, v));
  const hex = (v: number) => clamp(v).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * Apply one SGR parameter sequence (the numbers between `ESC[` and `m`) to the
 * running state. Handles standard attributes, 16/bright colours, and the
 * extended `38;5;n` / `48;5;n` (256) and `38;2;r;g;b` / `48;2;r;g;b` (truecolor)
 * forms. Unknown codes are ignored.
 */
function applySgr(state: SgrState, params: number[]): void {
  for (let i = 0; i < params.length; i += 1) {
    const code = params[i]!;
    if (code === 0) {
      Object.assign(state, freshState());
    } else if (code === 1) state.bold = true;
    else if (code === 2) state.dim = true;
    else if (code === 3) state.italic = true;
    else if (code === 4) state.underline = true;
    else if (code === 7) state.reverse = true;
    else if (code === 22) {
      state.bold = false;
      state.dim = false;
    } else if (code === 23) state.italic = false;
    else if (code === 24) state.underline = false;
    else if (code === 27) state.reverse = false;
    else if (code >= 30 && code <= 37) state.fg = ANSI_16[code - 30]!;
    else if (code === 39) state.fg = null;
    else if (code >= 40 && code <= 47) state.bg = ANSI_16[code - 40]!;
    else if (code === 49) state.bg = null;
    else if (code >= 90 && code <= 97) state.fg = ANSI_16[code - 90 + 8]!;
    else if (code >= 100 && code <= 107) state.bg = ANSI_16[code - 100 + 8]!;
    else if (code === 38 || code === 48) {
      const mode = params[i + 1];
      if (mode === 5) {
        const idx = params[i + 2] ?? 0;
        const color = xterm256(idx);
        if (code === 38) state.fg = color;
        else state.bg = color;
        i += 2;
      } else if (mode === 2) {
        const r = params[i + 2] ?? 0;
        const g = params[i + 3] ?? 0;
        const b = params[i + 4] ?? 0;
        const color = rgbHex(r, g, b);
        if (code === 38) state.fg = color;
        else state.bg = color;
        i += 4;
      }
    }
  }
}

/** Build the inline `style` for the current run, or "" when nothing is set. */
function styleFor(state: SgrState): string {
  let fg = state.fg;
  let bg = state.bg;
  if (state.reverse) {
    const swapFg = bg ?? DEFAULT_BG;
    const swapBg = fg ?? DEFAULT_FG;
    fg = swapFg;
    bg = swapBg;
  }
  const props: string[] = [];
  if (fg) props.push(`color:${fg}`);
  if (bg) props.push(`background-color:${bg}`);
  if (state.bold) props.push("font-weight:600");
  if (state.dim) props.push("opacity:0.7");
  if (state.italic) props.push("font-style:italic");
  if (state.underline) props.push("text-decoration:underline");
  return props.join(";");
}

/**
 * Render a single snapshot row (which may contain SGR escapes) to safe HTML.
 * SGR state starts fresh per line — terminal screen rows are independent and
 * `capture-pane` does not reliably carry attributes across the row boundary.
 */
export function renderSgrLineToHtml(line: string): string {
  const state = freshState();
  let html = "";
  let pendingText = "";
  let openStyle: string | null = null;

  const flush = () => {
    if (pendingText.length === 0) return;
    const style = styleFor(state);
    if (style.length > 0) {
      html += `<span style="${style}">${escapeHtml(pendingText)}</span>`;
    } else {
      html += escapeHtml(pendingText);
    }
    pendingText = "";
    openStyle = style;
  };

  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === "\x1b" && line[i + 1] === "[") {
      // CSI: ESC [ <params> <final>. Only `m` (SGR) mutates style; every other
      // final byte is a non-SGR control we skip without interpreting.
      let j = i + 2;
      let paramStr = "";
      while (j < line.length) {
        const c = line[j]!;
        if (c >= "0" && c <= "9") {
          paramStr += c;
          j += 1;
        } else if (c === ";") {
          paramStr += c;
          j += 1;
        } else {
          break;
        }
      }
      const final = line[j];
      if (final === "m") {
        // A style change ends the current run.
        const styleBefore = styleFor(state);
        if (openStyle !== null && styleBefore !== openStyle && pendingText.length > 0) {
          flush();
        }
        const params =
          paramStr.length === 0
            ? [0]
            : paramStr.split(";").map((p) => (p === "" ? 0 : Number(p)));
        // Flush text accumulated under the old style before mutating.
        flush();
        applySgr(state, params);
      }
      // Advance past the final byte (or to end if malformed).
      i = final === undefined ? line.length : j + 1;
      continue;
    }
    if (ch === "\x1b") {
      // Lone ESC or non-CSI escape — skip the ESC and let the next char flow.
      i += 1;
      continue;
    }
    pendingText += ch;
    i += 1;
  }
  flush();
  return html;
}

/**
 * Render a whole screen snapshot to HTML, one row per `\n`-separated segment.
 * The consuming element uses `white-space: pre` so blank rows and column
 * alignment are preserved.
 */
export function renderSnapshotToHtml(lines: string[]): string {
  return lines.map(renderSgrLineToHtml).join("\n");
}
