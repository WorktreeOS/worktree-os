/**
 * Shared visual-viewport helpers.
 *
 * `useVisualViewportHeight` tracks `window.visualViewport.height` so surfaces
 * (modals, the touch terminal) can react to the on-screen keyboard, which by
 * default shrinks only the visual viewport. `computeTerminalKeyboardHeight` is
 * the pure decision for the terminal: it has no DOM access so it can be
 * unit-tested with `bun:test`.
 */

import { useEffect, useState } from "react";

export function useVisualViewportHeight(enabled: boolean): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return;
    const update = () => setHeight(vv.height);
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [enabled]);
  return height;
}

/**
 * Minimum gap (px) between the terminal's natural height and the
 * keyboard-reduced visible height before we treat the keyboard as "up" and
 * clamp. Set well below a phone keyboard (~250-330px) but above the noise from
 * the URL bar collapsing/expanding and sub-pixel rounding, so the terminal does
 * not refit on incidental visual-viewport jitter.
 */
export const TERMINAL_KEYBOARD_MIN_DELTA_PX = 100;

export interface TerminalKeyboardHeightInput {
  /**
   * Visible height (px) available to the terminal container from its top down
   * to the top of the on-screen keyboard, derived from the visual viewport.
   * `null` when the visual viewport is unknown/unsupported.
   */
  visualViewportHeight: number | null;
  /** The terminal container's natural full height (px) with no keyboard. */
  availableHeight: number;
  /** True on coarse-pointer (touch) devices that raise an on-screen keyboard. */
  coarsePointer: boolean;
  /** True when this attachment controls the PTY (typing directly). */
  isController: boolean;
}

/**
 * Decide the height to clamp the terminal view to so the foreground program's
 * bottom-anchored input line stays above the on-screen keyboard. Returns the
 * height to apply, or `null` when no clamp should be applied (restore full
 * height). Clamps only for a coarse-pointer controller, and only when the
 * visible area is meaningfully shorter than the container's natural height.
 */
export function computeTerminalKeyboardHeight({
  visualViewportHeight,
  availableHeight,
  coarsePointer,
  isController,
}: TerminalKeyboardHeightInput): number | null {
  if (!coarsePointer || !isController) return null;
  if (visualViewportHeight == null) return null;
  if (!(availableHeight > 0)) return null;
  if (availableHeight - visualViewportHeight < TERMINAL_KEYBOARD_MIN_DELTA_PX) {
    return null;
  }
  return visualViewportHeight;
}
