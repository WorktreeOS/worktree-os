/**
 * Tracks DEC private modes (DECSET/DECRST) observed in a terminal output
 * stream so a client that attached after the byte journal dropped early
 * output can be brought back to the correct terminal state.
 *
 * The journal gap problem: mode-setting sequences (alternate screen, mouse
 * tracking, bracketed paste, cursor visibility) are emitted once, typically
 * at program startup, and land in the oldest journal chunks. Once those
 * chunks are evicted, a freshly attached client replays only the tail and
 * renders a full-screen TUI into the normal buffer with wrong input modes.
 * This tracker watches every output byte, remembers the current value of a
 * small whitelist of modes, and synthesizes a restore prefix for gapped
 * replays.
 *
 * The parser is a minimal byte-level state machine: it follows CSI sequences
 * to catch `ESC [ ? Pm h/l`, skips OSC/DCS string payloads so replayed
 * content can never spoof a mode change, and resets on RIS (`ESC c`).
 */

/** Modes the tracker cares about. Everything else is ignored. */
const TRACKED_MODES = new Set([
  1, // DECCKM — application cursor keys
  25, // DECTCEM — cursor visibility (default ON)
  47, // legacy alternate screen
  1000, // mouse click tracking
  1002, // mouse button-drag tracking
  1003, // mouse any-motion tracking
  1004, // focus reporting
  1005, // UTF-8 mouse encoding
  1006, // SGR mouse encoding
  1015, // urxvt mouse encoding
  1047, // alternate screen (no cursor save)
  1049, // alternate screen + save/restore cursor
  2004, // bracketed paste
]);

/** Modes that are ON in a freshly reset terminal. */
const DEFAULT_ON = new Set([25]);

/** Enabling one mouse-tracking protocol replaces the others. */
const MOUSE_TRACKING_MODES = [1000, 1002, 1003];

/** Alternate-screen modes are restored first so later modes apply inside. */
const ALT_SCREEN_MODES = [47, 1047, 1049];

const ESC = 0x1b;
const BEL = 0x07;
const MAX_CSI_BUFFER = 64;

type ParserState = "ground" | "esc" | "csi" | "string" | "string-esc";

export class TerminalModeTracker {
  /** Current value for tracked modes that differ from an empty map's default. */
  private readonly modes = new Map<number, boolean>();
  private state: ParserState = "ground";
  private csiBuffer = "";

  /** Consume a raw output chunk. Safe to call with sequences split anywhere. */
  feed(bytes: Uint8Array): void {
    for (const byte of bytes) {
      switch (this.state) {
        case "ground":
          if (byte === ESC) this.state = "esc";
          break;
        case "esc":
          if (byte === 0x5b /* [ */) {
            this.state = "csi";
            this.csiBuffer = "";
          } else if (byte === 0x5d /* ] OSC */ || byte === 0x50 /* P DCS */) {
            this.state = "string";
          } else if (byte === 0x63 /* c RIS */) {
            this.modes.clear();
            this.state = "ground";
          } else if (byte !== ESC) {
            this.state = "ground";
          }
          break;
        case "csi":
          if (byte >= 0x40 && byte <= 0x7e) {
            this.finishCsi(byte);
            this.state = "ground";
          } else if (byte === ESC) {
            this.state = "esc";
          } else if (
            byte >= 0x20 &&
            byte <= 0x3f &&
            this.csiBuffer.length < MAX_CSI_BUFFER
          ) {
            this.csiBuffer += String.fromCharCode(byte);
          } else {
            // Overflow or control byte mid-sequence — abort to ground.
            this.state = "ground";
          }
          break;
        case "string":
          if (byte === BEL) this.state = "ground";
          else if (byte === ESC) this.state = "string-esc";
          break;
        case "string-esc":
          // ESC \ (ST) terminates the string; any other escape aborts it.
          this.state = "ground";
          break;
      }
    }
  }

  private finishCsi(finalByte: number): void {
    const enable = finalByte === 0x68; /* h */
    if (!enable && finalByte !== 0x6c /* l */) return;
    if (!this.csiBuffer.startsWith("?")) return;
    for (const raw of this.csiBuffer.slice(1).split(";")) {
      if (!/^\d+$/.test(raw)) continue;
      const mode = Number(raw);
      if (!TRACKED_MODES.has(mode)) continue;
      if (enable && MOUSE_TRACKING_MODES.includes(mode)) {
        for (const other of MOUSE_TRACKING_MODES) {
          if (other !== mode) this.modes.set(other, false);
        }
      }
      this.modes.set(mode, enable);
    }
  }

  /**
   * Escape sequence that brings a freshly reset terminal to the tracked
   * state. Empty string when every tracked mode is at its default.
   */
  restoreSequence(): string {
    const parts: string[] = [];
    const emit = (mode: number) => {
      const value = this.modes.get(mode) ?? DEFAULT_ON.has(mode);
      if (value === DEFAULT_ON.has(mode)) return;
      parts.push(`\x1b[?${mode}${value ? "h" : "l"}`);
    };
    for (const mode of ALT_SCREEN_MODES) emit(mode);
    const rest = [...TRACKED_MODES]
      .filter((m) => !ALT_SCREEN_MODES.includes(m))
      .sort((a, b) => a - b);
    for (const mode of rest) emit(mode);
    return parts.join("");
  }
}
