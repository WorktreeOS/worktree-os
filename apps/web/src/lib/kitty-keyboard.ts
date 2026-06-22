/**
 * Minimal Kitty keyboard protocol state tracking for the xterm viewport.
 *
 * A classic VT100/ANSI byte stream cannot encode a modifier on Enter: both
 * Enter and Shift+Enter collapse to the single byte `\r`. The Kitty keyboard
 * protocol ("progressive enhancement", a.k.a. CSI-u) solves this — when a
 * foreground program enables it, the terminal reports modified keys as
 * `CSI <code> ; <modifier> u` sequences instead of the legacy bytes.
 *
 * xterm.js does not implement the protocol, so we track just enough of it to
 * answer the capability query and know when the disambiguate flag is active,
 * then encode Shift+Enter ourselves. We deliberately only handle Shift+Enter —
 * the one ambiguous key the product needs (agent CLIs use it for "newline
 * without submit"). Everything else keeps xterm's default encoding.
 *
 * Protocol sequences handled (all end with the final byte `u`):
 * - `CSI ? u`            query current flags  → reply `CSI ? <flags> u`
 * - `CSI > <flags> u`    push flags onto the stack (program enters)
 * - `CSI < <count> u`    pop `count` entries (program exits)
 * - `CSI = <flags> ; <mode> u`  set/modify the current flags in place
 */

/** Lowest progressive-enhancement flag: "disambiguate escape codes". */
export const KITTY_FLAG_DISAMBIGUATE = 1;

/**
 * CSI-u sequence for Shift+Enter: key code 13 (Enter), modifier 2
 * (1 + shift bit). Sent only while the disambiguate flag is active.
 */
export const KITTY_SHIFT_ENTER = "\x1b[13;2u";

/** Mode argument of the `CSI = flags ; mode u` set form. */
const SET_MODE_REPLACE = 1; // set flags to the given value (default)
const SET_MODE_OR = 2; // turn on the given bits
const SET_MODE_CLEAR = 3; // turn off the given bits

export interface KittyKeyboardState {
  /** Current flags: top of the push stack, or the main flags if empty. */
  flags(): number;
  /** True when the disambiguate flag is active and Shift+Enter must be encoded. */
  disambiguates(): boolean;
  /** Handle `CSI > flags u` — push flags (default 0). */
  push(flags: number): void;
  /** Handle `CSI < count u` — pop `count` entries (default 1). */
  pop(count: number): void;
  /** Handle `CSI = flags ; mode u` — set/modify current flags (mode default 1). */
  set(flags: number, mode: number): void;
  /** Restore the initial empty state. */
  reset(): void;
}

/**
 * Create a fresh tracker. The stack models nested programs (e.g. an agent CLI
 * that spawns a pager): each push saves the previous flags, each pop restores
 * them, so the disambiguate state follows the foreground program correctly.
 */
export function createKittyKeyboardState(): KittyKeyboardState {
  const stack: number[] = [];
  let main = 0;

  const flags = () =>
    stack.length > 0 ? (stack[stack.length - 1] as number) : main;

  const apply = (flags: number, value: number, mode: number): number => {
    switch (mode) {
      case SET_MODE_OR:
        return flags | value;
      case SET_MODE_CLEAR:
        return flags & ~value;
      case SET_MODE_REPLACE:
      default:
        return value;
    }
  };

  return {
    flags,
    disambiguates: () => (flags() & KITTY_FLAG_DISAMBIGUATE) !== 0,
    push(value: number) {
      stack.push(value);
    },
    pop(count: number) {
      for (let i = 0; i < count && stack.length > 0; i++) stack.pop();
    },
    set(value: number, mode: number) {
      if (stack.length > 0) {
        stack[stack.length - 1] = apply(
          stack[stack.length - 1] as number,
          value,
          mode,
        );
      } else {
        main = apply(main, value, mode);
      }
    },
    reset() {
      stack.length = 0;
      main = 0;
    },
  };
}
