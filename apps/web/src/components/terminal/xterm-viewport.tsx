/**
 * xterm.js viewport wrapper for the terminal layer.
 *
 * The wrapper owns:
 * - The xterm Terminal instance and its `fit` addon.
 * - The host element resize observation.
 * - Disposal of the terminal, addons, observers, and input subscription on
 *   unmount.
 *
 * It exposes a small imperative handle so the parent can write PTY bytes,
 * read measured dimensions, and reset the viewport during replay gaps —
 * without ever flowing raw output through React component state.
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import "@xterm/xterm/css/xterm.css";
import {
  TERMINAL_CURSOR_BLINK_DEFAULT,
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_SCROLLBACK_DEFAULT,
  accumulateTouchWheelLines,
} from "@/lib/touch-terminal";
import {
  KITTY_SHIFT_ENTER,
  createKittyKeyboardState,
} from "@/lib/kitty-keyboard";
import { canForwardTerminalInput } from "@/lib/terminal-output-gate";

const TERMINAL_FONT_FAMILY =
  '"SFMono-Regular", ui-monospace, Menlo, Consolas, "Liberation Mono", monospace';

// Warp-подобная тёмная палитра. xterm.js рендерит в sRGB через <canvas>,
// поэтому полной P3-сочности Warp не достичь, но визуально становится сильно
// ближе, чем дефолтная палитра xterm.js.
/**
 * Dispatch `notches` synthetic line-wheel events at the centre of the
 * terminal element. xterm registers its wheel listener on the root `.xterm`
 * element and wheel events bubble, so dispatching there reaches it, and
 * xterm applies its native, mode-correct behavior: local scrollback in the
 * normal buffer, arrow keys in an alt-screen pager, or a mouse-wheel report
 * when the foreground program tracks the mouse.
 */
function dispatchWheelNotches(
  host: HTMLElement,
  direction: "up" | "down",
  notches: number,
): void {
  const target = host.querySelector(".xterm") as HTMLElement | null;
  if (!target) return;
  const rect = target.getBoundingClientRect();
  // Aim the synthetic pointer at the viewport centre so a mouse-tracking
  // app scrolls the pane under it rather than a corner cell.
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;
  const deltaY = direction === "up" ? -1 : 1;
  for (let i = 0; i < notches; i++) {
    target.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY,
        deltaMode: WheelEvent.DOM_DELTA_LINE,
        clientX,
        clientY,
        bubbles: true,
        cancelable: true,
      }),
    );
  }
}

const TERMINAL_THEME = {
  background: "#000000",
  foreground: "#E6E6E6",
  cursor: "#FFFFFF",
  cursorAccent: "#000000",
  selectionBackground: "#3A4452",
  selectionForeground: "#FFFFFF",

  black: "#000000",
  red: "#E95678",
  green: "#29D398",
  yellow: "#FAB795",
  blue: "#26BBD9",
  magenta: "#EE64AC",
  cyan: "#59E1E3",
  white: "#E6E6E6",

  brightBlack: "#5C6370",
  brightRed: "#EC6A88",
  brightGreen: "#3FDAA4",
  brightYellow: "#FBC3A7",
  brightBlue: "#3FC4DE",
  brightMagenta: "#F075B5",
  brightCyan: "#6BE4E6",
  brightWhite: "#FFFFFF",
} as const;

export interface XtermViewportHandle {
  /**
   * Write PTY bytes into the viewport. Pass `replay: true` for bytes coming
   * from the server's journal replay so the emulator's auto-replies to any
   * Device Attributes / DSR queries embedded in that historical scrollback are
   * not forwarded back to the (idle) PTY.
   */
  write(data: string, replay?: boolean): void;
  writeln(data: string): void;
  reset(): void;
  focus(): void;
  measure(): { cols: number; rows: number } | null;
  /** Force a re-fit of both axes (used by the refresh control). */
  refit(): void;
  /** Scroll the local scrollback by `amount` lines (normal buffer). */
  scrollLines(amount: number): void;
  /** Scroll the local scrollback by `pageCount` pages (normal buffer). */
  scrollPages(pageCount: number): void;
  /** Jump the local scrollback to the top (normal buffer). */
  scrollToTop(): void;
  /** Jump the local scrollback to the bottom / live output. */
  scrollToBottom(): void;
  /** True when the alternate screen buffer is active (full-screen TUIs). */
  isAltBuffer(): boolean;
  /**
   * Scroll by dispatching synthetic wheel notches on the terminal element so
   * xterm applies its native, mode-correct behavior: local scrollback in the
   * normal buffer, arrow keys in an alt-screen pager, or a mouse-wheel report
   * when the foreground program tracks the mouse. Used for the alternate
   * buffer, where there is no scrollback to move directly.
   */
  scrollWheel(direction: "up" | "down"): void;
}

export interface XtermViewportProps {
  /** True while the controller may type into the viewport. */
  inputEnabled: boolean;
  /** Called whenever the user types (controllers only). */
  onInput?: (data: string) => void;
  /** Called when the viewport dimensions change. */
  onResize?: (cols: number, rows: number) => void;
  /** Called when scroll position or buffer type changes. */
  onScrollStateChange?: (state: {
    atBottom: boolean;
    altBuffer: boolean;
  }) => void;
  /** When set, the viewport is dimmed to indicate an exited session. */
  exited?: boolean;
  /** Terminal font size in CSS pixels. */
  fontSize?: number;
  /** xterm scrollback buffer depth. */
  scrollback?: number;
  /** Whether the cursor blinks. */
  cursorBlink?: boolean;
  /** Optional `data-testid` for test harnessing. */
  testId?: string;
}

export const XtermViewport = forwardRef<XtermViewportHandle, XtermViewportProps>(
  function XtermViewport(
    {
      inputEnabled,
      onInput,
      onResize,
      onScrollStateChange,
      exited,
      fontSize = TERMINAL_FONT_SIZE_DEFAULT,
      scrollback = TERMINAL_SCROLLBACK_DEFAULT,
      cursorBlink = TERMINAL_CURSOR_BLINK_DEFAULT,
      testId,
    },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const termRef = useRef<Terminal | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    // Assigned inside the mount layout effect so external callers (imperative
    // handle, the prop-apply effect) can force a both-axes re-fit that bypasses
    // the axis-pending optimization used by the debounced resize observer.
    const refitRef = useRef<(() => void) | null>(null);
    // Number of replay `write()` chunks still being parsed by xterm. While
    // positive, the `onData` / `respond` pipelines drop outbound bytes so the
    // emulator's auto-replies to queries in the replayed scrollback never reach
    // the PTY. xterm parses asynchronously, so a chunk stays "in flight" until
    // its write callback fires; a counter handles overlapping replay chunks.
    const replayingDepthRef = useRef(0);
    const [ready, setReady] = useState(false);

    // The `useLayoutEffect` below registers xterm's `onData` and ResizeObserver
    // callbacks ONCE on mount (deps: `[]`). Those closures must always read
    // the latest `inputEnabled`/`onInput`/`onResize`, otherwise input typed
    // AFTER the controller flag flips to true (which is the common case —
    // the controller is granted only when `hello-ack` arrives) would be
    // silently dropped because the closure captured the initial `false`.
    const inputEnabledRef = useRef(inputEnabled);
    const onInputRef = useRef(onInput);
    const onResizeRef = useRef(onResize);
    const onScrollStateChangeRef = useRef(onScrollStateChange);
    useEffect(() => {
      inputEnabledRef.current = inputEnabled;
    }, [inputEnabled]);
    useEffect(() => {
      onInputRef.current = onInput;
    }, [onInput]);
    useEffect(() => {
      onResizeRef.current = onResize;
    }, [onResize]);
    useEffect(() => {
      onScrollStateChangeRef.current = onScrollStateChange;
    }, [onScrollStateChange]);

    useImperativeHandle(
      ref,
      () => ({
        write(data: string, replay?: boolean) {
          const term = termRef.current;
          if (!term) return;
          if (replay) {
            replayingDepthRef.current += 1;
            term.write(data, () => {
              if (replayingDepthRef.current > 0) replayingDepthRef.current -= 1;
            });
          } else {
            term.write(data);
          }
        },
        writeln(data: string) {
          termRef.current?.writeln(data);
        },
        reset() {
          termRef.current?.reset();
        },
        focus() {
          termRef.current?.focus();
        },
        measure() {
          const term = termRef.current;
          if (!term) return null;
          return { cols: term.cols, rows: term.rows };
        },
        refit() {
          refitRef.current?.();
        },
        scrollLines(amount: number) {
          termRef.current?.scrollLines(amount);
        },
        scrollPages(pageCount: number) {
          termRef.current?.scrollPages(pageCount);
        },
        scrollToTop() {
          termRef.current?.scrollToTop();
        },
        scrollToBottom() {
          termRef.current?.scrollToBottom();
        },
        isAltBuffer() {
          return termRef.current?.buffer.active.type === "alternate";
        },
        scrollWheel(direction: "up" | "down") {
          const term = termRef.current;
          const host = hostRef.current;
          if (!term || !host) return;
          // Mouse-tracking apps consume one wheel report per event (~3 lines
          // each), so ~rows/3 notches scroll about a screenful there; a plain
          // pager scrolls one line per notch.
          const notches = Math.max(3, Math.round(term.rows / 3));
          dispatchWheelNotches(host, direction, notches);
        },
      }),
      [],
    );

    useLayoutEffect(() => {
      const host = hostRef.current;
      if (!host) return undefined;
      // React StrictMode dev-mode mounts effects, tears them down, and
      // remounts on the same DOM node. xterm.js does not survive a rapid
      // mount→dispose→mount cycle cleanly — a queued RAF in its Viewport
      // can run after `dispose()` and read `dimensions` on undefined
      // internal state. We protect ourselves with a `disposed` guard for
      // every async callback we own AND defer the actual `term.dispose()`
      // to the next macrotask so xterm's in-flight render work settles
      // before we tear it down.
      let disposed = false;
      const term = new Terminal({
        fontSize,
        fontFamily: TERMINAL_FONT_FAMILY,
        cursorBlink,
        theme: TERMINAL_THEME,
        // Запрещаем xterm.js корректировать цвета под контраст — иначе
        // ASCII-арт (например, поросёнок Claude Code) теряет насыщенность.
        minimumContrastRatio: 1,
        scrollback,
        allowProposedApi: true,
        // The tmux backend runs with `mouse on`, so xterm forwards every drag
        // to the foreground app and disables its native selection. On macOS the
        // force-selection modifier (Option+drag) only works when this flag is
        // set; with it on, Option+drag makes a native selection that Cmd+C
        // copies. Linux/Windows use Shift+drag and are unaffected.
        macOptionClickForcesSelection: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      // xterm's built-in width tables are frozen at Unicode 6. Modern TUIs
      // (Claude Code's ⏵/⏺/✻ glyphs, emoji) and tmux compute cell widths
      // with current wcwidth tables; the mismatch makes the emulator's
      // cursor drift one cell per affected glyph, so partial repaints land
      // shifted and duplicate UI fragments accumulate over a long session.
      // Unicode 11 tables keep xterm's idea of width in line with the apps'.
      const unicode11 = new Unicode11Addon();
      term.loadAddon(unicode11);
      term.unicode.activeVersion = "11";
      // OSC 52 clipboard integration: lets terminal apps (tmux, vim, agent
      // CLIs) write to / read from the system clipboard through the emulator.
      term.loadAddon(new ClipboardAddon());
      term.open(host);
      // GPU-accelerated renderer. The WebGL addon must load after `open()`.
      // If the browser cannot create a context (or loses it later), dispose
      // the addon so xterm falls back to the DOM renderer.
      let webgl: WebglAddon | null = null;
      try {
        webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl?.dispose();
          webgl = null;
        });
        term.loadAddon(webgl);
      } catch {
        webgl?.dispose();
        webgl = null;
      }
      termRef.current = term;
      fitRef.current = fit;
      setReady(true);

      // Keep touch scroll inside the terminal: contain overscroll so reaching
      // the top/bottom of the scrollback does not bounce the surrounding page,
      // and allow vertical panning of the scrollback.
      const xtermViewport = host.querySelector(
        ".xterm-viewport",
      ) as HTMLElement | null;
      if (xtermViewport) {
        xtermViewport.style.overscrollBehavior = "contain";
        xtermViewport.style.touchAction = "pan-y";
      }

      const emitScrollState = () => {
        if (disposed) return;
        const buffer = term.buffer.active;
        onScrollStateChangeRef.current?.({
          atBottom: buffer.viewportY >= buffer.baseY,
          altBuffer: buffer.type === "alternate",
        });
      };
      const scrollSub = term.onScroll(() => emitScrollState());
      const bufferSub = term.buffer.onBufferChange(() => emitScrollState());
      emitScrollState();

      // Touch-drag scrolling for the alternate screen buffer. xterm.js
      // ignores touch entirely while the foreground program tracks the mouse
      // (e.g. tmux with `mouse on`), and its native touch handling has no
      // scrollback to move in the alt buffer — either way a finger drag does
      // nothing. Translate vertical drags into synthetic line-wheel notches
      // (one per cell height of travel) so xterm emits the mode-correct
      // sequence, exactly like the scroll-control buttons. The normal buffer
      // is left to xterm's native touch scrollback handling.
      let touchLastY: number | null = null;
      let touchCarryPx = 0;
      const onTouchStart = (e: TouchEvent) => {
        if (disposed || term.buffer.active.type !== "alternate") {
          touchLastY = null;
          return;
        }
        touchLastY = e.touches[0]?.clientY ?? null;
        touchCarryPx = 0;
      };
      const onTouchMove = (e: TouchEvent) => {
        if (disposed || touchLastY === null) return;
        if (term.buffer.active.type !== "alternate") {
          touchLastY = null;
          return;
        }
        const y = e.touches[0]?.clientY;
        if (y === undefined) return;
        const cellHeightPx = host.clientHeight / Math.max(1, term.rows);
        const { lines, carry } = accumulateTouchWheelLines(
          touchLastY - y,
          cellHeightPx,
          touchCarryPx,
        );
        touchLastY = y;
        touchCarryPx = carry;
        if (lines !== 0) {
          dispatchWheelNotches(host, lines < 0 ? "up" : "down", Math.abs(lines));
        }
        // The gesture is consumed here; stop the browser from also panning
        // the (empty) DOM scrollback or the surrounding page.
        if (e.cancelable) e.preventDefault();
      };
      const onTouchEnd = () => {
        touchLastY = null;
        touchCarryPx = 0;
      };
      host.addEventListener("touchstart", onTouchStart, { passive: true });
      host.addEventListener("touchmove", onTouchMove, { passive: false });
      host.addEventListener("touchend", onTouchEnd, { passive: true });
      host.addEventListener("touchcancel", onTouchEnd, { passive: true });

      let fitTimer: number | null = null;
      // Axis-pending flags: when only the width of the host changes (typical
      // for a horizontal browser drag in a complex layout), the surrounding
      // page can still reflow vertically by a pixel or two, which makes
      // `fit.proposeDimensions()` propose a slightly different row count. We
      // would then resize rows, xterm would append/drop a row, and the TUI
      // app would redraw its bottom-anchored prompt at the new row — but
      // xterm leaves the old row's content in place, producing the
      // "ghost prompt" the user reported. Tracking which axis actually
      // changed lets us update only that axis and leave the other alone.
      let pending = { width: true, height: true };
      const safeFit = () => {
        if (disposed) return;
        const apply = pending;
        pending = { width: false, height: false };
        try {
          const dims = fit.proposeDimensions();
          if (!dims || dims.cols <= 0 || dims.rows <= 0) return;
          const nextCols = apply.width ? dims.cols : term.cols;
          const nextRows = apply.height ? dims.rows : term.rows;
          if (nextCols === term.cols && nextRows === term.rows) return;
          term.resize(nextCols, nextRows);
          onResizeRef.current?.(term.cols, term.rows);
        } catch {
          /* ignore */
        }
      };
      const scheduleFit = (changes: { width: boolean; height: boolean }) => {
        if (disposed) return;
        pending = {
          width: pending.width || changes.width,
          height: pending.height || changes.height,
        };
        if (fitTimer !== null) window.clearTimeout(fitTimer);
        // 150 ms gives the browser time to settle layout reflow that often
        // continues for a frame or two after a drag stops, especially on
        // pages with sidebars and dynamic chrome.
        fitTimer = window.setTimeout(() => {
          fitTimer = null;
          safeFit();
        }, 150);
      };

      // Force an immediate both-axes re-fit. Exposed via the imperative handle
      // and used after font-size changes so the PTY picks up the new cols/rows.
      refitRef.current = () => {
        if (disposed) return;
        pending = { width: true, height: true };
        safeFit();
      };

      let last = { w: -1, h: -1 };
      const ro = new ResizeObserver((entries) => {
        if (disposed) return;
        const entry = entries[0];
        if (!entry) return;
        const w = entry.contentRect.width;
        const h = entry.contentRect.height;
        const widthChanged = Math.abs(w - last.w) > 0.5;
        const heightChanged = Math.abs(h - last.h) > 0.5;
        if (!widthChanged && !heightChanged) return;
        last = { w, h };
        scheduleFit({ width: widthChanged, height: heightChanged });
      });
      ro.observe(host);
      const onWindowResize = () =>
        scheduleFit({ width: true, height: true });
      window.addEventListener("resize", onWindowResize);
      // Run the very first fit synchronously, before any consumer can read
      // `measure()`. Without this the term reports its default 80x24 to
      // anyone who queries before the debounced fit fires, and a
      // freshly-attached WebSocket session would pin the PTY to 80x24 only
      // to flip again 150 ms later. We still schedule a debounced follow-up
      // so any layout that settles after this frame is picked up too.
      pending = { width: true, height: true };
      safeFit();
      scheduleFit({ width: true, height: true });

      const inputSub = term.onData((data) => {
        if (
          !canForwardTerminalInput({
            disposed,
            replaying: replayingDepthRef.current > 0,
            inputEnabled: inputEnabledRef.current,
          })
        ) {
          return;
        }
        onInputRef.current?.(data);
      });

      // Kitty keyboard protocol (CSI-u) — just enough of it to carry Shift+Enter
      // to agent CLIs. A legacy byte stream cannot tell Enter from Shift+Enter:
      // both collapse to `\r`. When a foreground program enables the protocol we
      // answer its capability query and track the disambiguate flag; the custom
      // key handler below then encodes Shift+Enter as a CSI-u sequence. When no
      // program enables it, nothing changes and Enter stays `\r` (no regression).
      const kitty = createKittyKeyboardState();
      // Read a CSI parameter, falling back when it is absent or the default 0.
      const paramAt = (
        params: (number | number[])[],
        index: number,
        fallback: number,
      ) => {
        const value = params[index];
        return typeof value === "number" && value > 0 ? value : fallback;
      };
      // Protocol replies travel on the controller's input channel; a read-only
      // spectator must stay silent so two viewports never double-answer a query,
      // and replayed scrollback must not be answered at all (see the gate).
      const respond = (data: string) => {
        if (
          !canForwardTerminalInput({
            disposed,
            replaying: replayingDepthRef.current > 0,
            inputEnabled: inputEnabledRef.current,
          })
        ) {
          return;
        }
        onInputRef.current?.(data);
      };
      const kittySubs = [
        // CSI ? u — report current flags so the program learns we support it.
        term.parser.registerCsiHandler({ prefix: "?", final: "u" }, () => {
          respond(`\x1b[?${kitty.flags()}u`);
          return true;
        }),
        // CSI > flags u — push flags (program enters / enables the protocol).
        term.parser.registerCsiHandler({ prefix: ">", final: "u" }, (params) => {
          kitty.push(paramAt(params, 0, 0));
          return true;
        }),
        // CSI < count u — pop entries (program exits / disables).
        term.parser.registerCsiHandler({ prefix: "<", final: "u" }, (params) => {
          kitty.pop(paramAt(params, 0, 1));
          return true;
        }),
        // CSI = flags ; mode u — set/modify the current flags in place.
        term.parser.registerCsiHandler({ prefix: "=", final: "u" }, (params) => {
          kitty.set(paramAt(params, 0, 0), paramAt(params, 1, 1));
          return true;
        }),
      ];

      // Encode Shift+Enter as CSI-u while the disambiguate flag is active.
      // Returning false suppresses xterm's default `\r`; the sequence is sent on
      // the same input channel as ordinary keystrokes. Outside the protocol the
      // handler returns true and Enter behaves exactly as before.
      term.attachCustomKeyEventHandler((event) => {
        if (
          event.type === "keydown" &&
          event.key === "Enter" &&
          event.shiftKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.metaKey &&
          inputEnabledRef.current &&
          kitty.disambiguates()
        ) {
          event.preventDefault();
          onInputRef.current?.(KITTY_SHIFT_ENTER);
          return false;
        }
        return true;
      });

      return () => {
        disposed = true;
        if (fitTimer !== null) window.clearTimeout(fitTimer);
        ro.disconnect();
        window.removeEventListener("resize", onWindowResize);
        host.removeEventListener("touchstart", onTouchStart);
        host.removeEventListener("touchmove", onTouchMove);
        host.removeEventListener("touchend", onTouchEnd);
        host.removeEventListener("touchcancel", onTouchEnd);
        try {
          inputSub.dispose();
          scrollSub.dispose();
          bufferSub.dispose();
          for (const sub of kittySubs) sub.dispose();
        } catch {
          /* ignore */
        }
        termRef.current = null;
        fitRef.current = null;
        refitRef.current = null;
        setReady(false);
        // Detach the terminal DOM immediately so a fast remount on the same
        // host (StrictMode) does not see stale xterm nodes. Then defer the
        // actual `term.dispose()` to the next macrotask to let xterm's
        // queued render work complete safely.
        try {
          host.replaceChildren();
        } catch {
          /* ignore */
        }
        window.setTimeout(() => {
          try {
            term.dispose();
          } catch {
            /* ignore */
          }
        }, 0);
      };
      // The viewport instance lifetime is bound to the host element; input
      // wiring and onResize are read from refs/closures so we intentionally
      // do not re-mount when those callback identities change.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
      const term = termRef.current;
      if (!term) return;
      term.options.disableStdin = !inputEnabled || exited === true;
    }, [inputEnabled, exited, ready]);

    // Apply live display-preference changes. A font-size change alters the cell
    // size, so the cols/rows change too — re-fit so the PTY (for controllers)
    // picks up the new dimensions. Scrollback and cursor blink apply in place.
    useEffect(() => {
      const term = termRef.current;
      if (!term) return undefined;
      const fontChanged = term.options.fontSize !== fontSize;
      if (fontChanged) term.options.fontSize = fontSize;
      if (term.options.scrollback !== scrollback) {
        term.options.scrollback = scrollback;
      }
      if (term.options.cursorBlink !== cursorBlink) {
        term.options.cursorBlink = cursorBlink;
      }
      if (fontChanged) {
        // Cell metrics refresh on the next render after a font change, so defer
        // the re-fit to let FitAddon read the new cell size rather than a stale
        // one.
        const id = window.setTimeout(() => refitRef.current?.(), 0);
        return () => window.clearTimeout(id);
      }
      return undefined;
    }, [fontSize, scrollback, cursorBlink, ready]);

    return (
      <div className="relative h-full w-full">
        <div
          ref={hostRef}
          data-testid={testId}
          data-exited={exited ? "true" : "false"}
          className={
            exited
              ? "absolute inset-0 overflow-hidden opacity-70"
              : "absolute inset-0 overflow-hidden"
          }
        />
      </div>
    );
  },
);
