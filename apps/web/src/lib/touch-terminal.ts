/**
 * Pure helpers for the touch-oriented terminal chrome.
 *
 * The web terminal stays desktop-first by default: quick actions and the write
 * composer surface only for coarse-pointer/narrow contexts or when the user
 * explicitly enables them. Everything below is plain logic — no React, no DOM
 * access — so it can be unit-tested with `bun:test`.
 */

export type TouchTerminalOverride = "auto" | "force-on" | "force-off";

export interface ResolveTouchModeOptions {
  override: TouchTerminalOverride;
  coarsePointer: boolean;
  /** Inner-content width of the area hosting the terminal, in CSS pixels. */
  viewportWidth: number;
}

/** Width at or below which we treat the terminal as a touch/tablet layout. */
export const TOUCH_TERMINAL_NARROW_WIDTH_PX = 900;

export const TOUCH_TERMINAL_OVERRIDE_STORAGE_KEY =
  "wos.terminal.touch-override";

export const TOUCH_QUICK_ACTIONS_VISIBLE_STORAGE_KEY =
  "wos.terminal.touch-quick-actions-visible";

/**
 * Decide whether the touch terminal chrome should be rendered.
 *
 * Desktop defaults are preserved: fine-pointer environments wider than the
 * narrow-layout threshold return `false`. A user override always wins so a
 * hybrid laptop user can pin the controls regardless of detection.
 */
export function resolveTouchTerminalMode(opts: ResolveTouchModeOptions): boolean {
  if (opts.override === "force-on") return true;
  if (opts.override === "force-off") return false;
  if (opts.coarsePointer) return true;
  if (
    Number.isFinite(opts.viewportWidth) &&
    opts.viewportWidth > 0 &&
    opts.viewportWidth <= TOUCH_TERMINAL_NARROW_WIDTH_PX
  ) {
    return true;
  }
  return false;
}

export function readStoredTouchOverride(
  storage?: Pick<Storage, "getItem"> | null,
): TouchTerminalOverride {
  const store =
    storage ??
    (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return "auto";
  try {
    const raw = store.getItem(TOUCH_TERMINAL_OVERRIDE_STORAGE_KEY);
    if (raw === "force-on" || raw === "force-off") return raw;
    return "auto";
  } catch {
    return "auto";
  }
}

export function persistTouchOverride(
  override: TouchTerminalOverride,
  storage?: Pick<Storage, "setItem" | "removeItem"> | null,
): void {
  const store =
    storage ??
    (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return;
  try {
    if (override === "auto") {
      store.removeItem(TOUCH_TERMINAL_OVERRIDE_STORAGE_KEY);
    } else {
      store.setItem(TOUCH_TERMINAL_OVERRIDE_STORAGE_KEY, override);
    }
  } catch {
    /* storage unavailable */
  }
}

export function readStoredQuickActionsVisible(
  storage?: Pick<Storage, "getItem"> | null,
): boolean | null {
  const store =
    storage ??
    (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return null;
  try {
    const raw = store.getItem(TOUCH_QUICK_ACTIONS_VISIBLE_STORAGE_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return null;
  } catch {
    return null;
  }
}

export function persistQuickActionsVisible(
  visible: boolean,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  const store =
    storage ??
    (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return;
  try {
    store.setItem(TOUCH_QUICK_ACTIONS_VISIBLE_STORAGE_KEY, visible ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
}

/* ---------- Terminal display preferences ----------
 *
 * Global, presentation-only preferences applied to every terminal viewport in
 * the session and persisted client-side under the `wos.terminal.*` convention.
 * No daemon config or UI API is involved. */

export const TERMINAL_FONT_SIZE_STORAGE_KEY = "wos.terminal.fontSize";
export const TERMINAL_SCROLLBACK_STORAGE_KEY = "wos.terminal.scrollback";
export const TERMINAL_CURSOR_BLINK_STORAGE_KEY = "wos.terminal.cursorBlink";

export const TERMINAL_FONT_SIZE_DEFAULT = 13;
export const TERMINAL_FONT_SIZE_MIN = 9;
export const TERMINAL_FONT_SIZE_MAX = 22;

export const TERMINAL_SCROLLBACK_DEFAULT = 5000;
export const TERMINAL_SCROLLBACK_MIN = 100;
export const TERMINAL_SCROLLBACK_MAX = 100000;

export const TERMINAL_CURSOR_BLINK_DEFAULT = true;

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function clampFontSize(value: number): number {
  return clampInt(value, TERMINAL_FONT_SIZE_MIN, TERMINAL_FONT_SIZE_MAX);
}

export function clampScrollback(value: number): number {
  return clampInt(value, TERMINAL_SCROLLBACK_MIN, TERMINAL_SCROLLBACK_MAX);
}

function readNumberPref(
  key: string,
  fallback: number,
  clamp: (n: number) => number,
  storage?: Pick<Storage, "getItem"> | null,
): number {
  const store =
    storage ??
    (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return fallback;
  try {
    const raw = store.getItem(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return clamp(n);
  } catch {
    return fallback;
  }
}

function persistNumberPref(
  key: string,
  value: number,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  const store =
    storage ??
    (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return;
  try {
    store.setItem(key, String(Math.round(value)));
  } catch {
    /* storage unavailable */
  }
}

export function readStoredFontSize(
  storage?: Pick<Storage, "getItem"> | null,
): number {
  return readNumberPref(
    TERMINAL_FONT_SIZE_STORAGE_KEY,
    TERMINAL_FONT_SIZE_DEFAULT,
    clampFontSize,
    storage,
  );
}

export function persistFontSize(
  value: number,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  persistNumberPref(TERMINAL_FONT_SIZE_STORAGE_KEY, clampFontSize(value), storage);
}

export function readStoredScrollback(
  storage?: Pick<Storage, "getItem"> | null,
): number {
  return readNumberPref(
    TERMINAL_SCROLLBACK_STORAGE_KEY,
    TERMINAL_SCROLLBACK_DEFAULT,
    clampScrollback,
    storage,
  );
}

export function persistScrollback(
  value: number,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  persistNumberPref(
    TERMINAL_SCROLLBACK_STORAGE_KEY,
    clampScrollback(value),
    storage,
  );
}

export function readStoredCursorBlink(
  storage?: Pick<Storage, "getItem"> | null,
): boolean {
  const store =
    storage ??
    (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return TERMINAL_CURSOR_BLINK_DEFAULT;
  try {
    const raw = store.getItem(TERMINAL_CURSOR_BLINK_STORAGE_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return TERMINAL_CURSOR_BLINK_DEFAULT;
  } catch {
    return TERMINAL_CURSOR_BLINK_DEFAULT;
  }
}

export function persistCursorBlink(
  value: boolean,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  const store =
    storage ??
    (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return;
  try {
    store.setItem(TERMINAL_CURSOR_BLINK_STORAGE_KEY, value ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
}

export interface TerminalDims {
  cols: number;
  rows: number;
}

export interface RedrawNudge {
  /** Temporary off-size that differs from the current size by one row. */
  off: TerminalDims;
  /** Measured size to restore after the off-size has taken effect. */
  restore: TerminalDims;
}

/**
 * Compute the resize nudge used to force a foreground repaint.
 *
 * Identical-size resizes are deduplicated by both the client connection and the
 * daemon actor, so a "resize to current size" is a no-op. To trigger a real
 * `SIGWINCH` we shrink the row count by one — or grow it by one when only a
 * single row is available, since the daemon rejects non-positive dimensions —
 * and then restore the measured size.
 */
export function computeRedrawNudge(dims: TerminalDims): RedrawNudge {
  const offRows = dims.rows > 1 ? dims.rows - 1 : dims.rows + 1;
  return {
    off: { cols: dims.cols, rows: offRows },
    restore: { cols: dims.cols, rows: dims.rows },
  };
}

/* ---------- Terminal scroll controls ---------- */

export type ScrollDirection = "up" | "down" | "top" | "bottom";

/**
 * How a scroll-control tap should be applied.
 *
 * - `scroll`: move the local xterm scrollback (normal buffer only); no server
 *   round-trip and works for viewers.
 * - `wheel`: synthesize a wheel gesture on the terminal so xterm emits the
 *   mode-correct sequence for the alternate screen buffer — a mouse-wheel
 *   report when the foreground program tracks the mouse, or arrow keys for a
 *   plain pager. The program owns its own scrolling there.
 */
export type ScrollIntent =
  | { kind: "scroll"; action: "pages"; amount: number }
  | { kind: "scroll"; action: "top" | "bottom" }
  | { kind: "wheel"; direction: "up" | "down" };

/**
 * Resolve a scroll direction into a concrete action.
 *
 * In the alternate screen buffer (full-screen TUIs like editors, pagers, agent
 * CLIs) there is no scrollback to move, so scrolling is delegated to the
 * program via a synthesized wheel gesture (see `ScrollIntent`). In the normal
 * buffer we move the local scrollback.
 */
export function resolveScrollIntent(
  direction: ScrollDirection,
  altBuffer: boolean,
): ScrollIntent {
  if (altBuffer) {
    return {
      kind: "wheel",
      direction: direction === "up" || direction === "top" ? "up" : "down",
    };
  }
  switch (direction) {
    case "up":
      return { kind: "scroll", action: "pages", amount: -1 };
    case "down":
      return { kind: "scroll", action: "pages", amount: 1 };
    case "top":
      return { kind: "scroll", action: "top" };
    case "bottom":
      return { kind: "scroll", action: "bottom" };
  }
}

/**
 * Accumulate a vertical touch-drag delta into whole wheel notches.
 *
 * xterm.js ignores touch entirely while the foreground program tracks the
 * mouse (e.g. tmux with `mouse on`), and in the alternate buffer its native
 * touch handling has no scrollback to move — so the viewport synthesizes one
 * line-wheel notch per cell height of finger travel instead. Fractional
 * remainders carry over between move events so slow drags still scroll.
 *
 * Positive `deltaPx` (finger moving up) yields positive `lines` (scroll
 * down), matching native touch-scroll direction.
 */
export function accumulateTouchWheelLines(
  deltaPx: number,
  cellHeightPx: number,
  carryPx: number,
): { lines: number; carry: number } {
  if (!Number.isFinite(cellHeightPx) || cellHeightPx <= 0) {
    return { lines: 0, carry: 0 };
  }
  const total = deltaPx + carryPx;
  const lines = Math.trunc(total / cellHeightPx);
  return { lines, carry: total - lines * cellHeightPx };
}

/** Quick-action identifiers exposed by the touch panel. */
export type TouchQuickAction =
  | "escape"
  | "tab"
  | "enter"
  | "arrow-up"
  | "arrow-down"
  | "arrow-left"
  | "arrow-right"
  | "ctrl-c"
  | "ctrl-d"
  | "ctrl-l"
  | "ctrl-r";

/**
 * Map quick-action identifiers to the PTY input byte sequence we send through
 * `TerminalConnection.sendInput`. These match what xterm.js would normally
 * forward from a real keypress in a terminal application.
 */
export const QUICK_ACTION_SEQUENCES: Record<TouchQuickAction, string> = {
  escape: "",
  tab: "\t",
  enter: "\r",
  "arrow-up": "[A",
  "arrow-down": "[B",
  "arrow-right": "[C",
  "arrow-left": "[D",
  "ctrl-c": "",
  "ctrl-d": "",
  "ctrl-l": "\x0c",
  "ctrl-r": "\x12",
};

export function encodeQuickAction(action: TouchQuickAction): string {
  return QUICK_ACTION_SEQUENCES[action];
}

/* ---------- Tool-aware touch dock ---------- */

export type TouchTerminalTool = "claude" | "codex" | "opencode" | "shell";

export interface TouchToolAction {
  id: string;
  label: string;
  /** Optional secondary keyboard hint rendered inside the action. */
  hint?: string;
  /** Exact bytes sent to the PTY. */
  sequence: string;
  command?: boolean;
  danger?: boolean;
}

export interface TouchToolCommand extends TouchToolAction {
  description: string;
}

export interface TouchToolProfile {
  label: string;
  placeholder: string;
  primary: readonly TouchToolAction[];
  commands: readonly TouchToolCommand[];
}

const enterCommand = (command: string): string => `${command}\r`;

/**
 * Mobile shortcuts for every agent the daemon can currently identify, plus a
 * conservative shell fallback. Commands are bytes rather than UI callbacks so
 * the same controller gate handles every action.
 */
export const TOUCH_TOOL_PROFILES: Record<TouchTerminalTool, TouchToolProfile> = {
  claude: {
    label: "Claude Code",
    placeholder: "Message Claude...",
    primary: [
      { id: "stop", label: "Stop", hint: "Esc", sequence: "\x1b", danger: true },
      { id: "clear", label: "/clear", sequence: enterCommand("/clear"), command: true },
      { id: "compact", label: "/compact", sequence: enterCommand("/compact"), command: true },
      { id: "plan", label: "Plan", hint: "Shift Tab", sequence: "\x1b[Z" },
    ],
    commands: [
      { id: "model", label: "/model", description: "Switch model", sequence: enterCommand("/model"), command: true },
      { id: "agents", label: "/agents", description: "Manage subagents", sequence: enterCommand("/agents"), command: true },
      { id: "resume", label: "/resume", description: "Resume a past session", sequence: enterCommand("/resume"), command: true },
      { id: "rewind", label: "Esc Esc", description: "Rewind to a previous message", sequence: "\x1b\x1b" },
    ],
  },
  codex: {
    label: "Codex",
    placeholder: "Message Codex...",
    primary: [
      { id: "stop", label: "Stop", hint: "Esc", sequence: "\x1b", danger: true },
      { id: "new", label: "/new", sequence: enterCommand("/new"), command: true },
      { id: "compact", label: "/compact", sequence: enterCommand("/compact"), command: true },
      { id: "approvals", label: "Approvals", sequence: enterCommand("/approvals") },
    ],
    commands: [
      { id: "model", label: "/model", description: "Switch model", sequence: enterCommand("/model"), command: true },
      { id: "diff", label: "/diff", description: "Show working-tree diff", sequence: enterCommand("/diff"), command: true },
      { id: "status", label: "/status", description: "Token and session status", sequence: enterCommand("/status"), command: true },
    ],
  },
  opencode: {
    label: "OpenCode",
    placeholder: "Message OpenCode...",
    primary: [
      { id: "stop", label: "Stop", hint: "Esc", sequence: "\x1b", danger: true },
      { id: "new", label: "/new", sequence: enterCommand("/new"), command: true },
      { id: "undo", label: "/undo", sequence: enterCommand("/undo"), command: true },
      { id: "share", label: "/share", sequence: enterCommand("/share"), command: true },
    ],
    commands: [
      { id: "redo", label: "/redo", description: "Reapply the last change", sequence: enterCommand("/redo"), command: true },
      { id: "models", label: "/models", description: "Switch model", sequence: enterCommand("/models"), command: true },
      { id: "compact", label: "/compact", description: "Summarize the session", sequence: enterCommand("/compact"), command: true },
    ],
  },
  shell: {
    label: "Shell",
    placeholder: "Run command...",
    primary: [
      { id: "interrupt", label: "^C", sequence: "\x03" },
      { id: "clear", label: "^L", hint: "clear", sequence: "\x0c" },
      { id: "search", label: "^R", hint: "search", sequence: "\x12" },
      { id: "tab", label: "Tab", sequence: "\t" },
    ],
    commands: [
      { id: "line-start", label: "^A", description: "Jump to line start", sequence: "\x01" },
      { id: "line-end", label: "^E", description: "Jump to line end", sequence: "\x05" },
      { id: "git-status", label: "git status", description: "Show working-tree status", sequence: enterCommand("git status") },
      { id: "git-diff", label: "git diff", description: "Show unstaged changes", sequence: enterCommand("git diff") },
      { id: "bun-test", label: "bun test", description: "Run the test suite", sequence: enterCommand("bun test") },
    ],
  },
};

export function touchTerminalTool(agent?: string): TouchTerminalTool {
  if (agent === "claude" || agent === "codex" || agent === "opencode") {
    return agent;
  }
  return "shell";
}

/** Composer send modes — the user explicitly picks how a draft is submitted. */
export type ComposerSendMode = "insert" | "send" | "paste";

export const BRACKETED_PASTE_START = "[200~";
export const BRACKETED_PASTE_END = "[201~";

/**
 * Encode composer text for submission.
 *
 * - `insert`: send as typed, no Enter appended.
 * - `send`: send followed by `\r` so a shell or agent prompt commits the line.
 * - `paste`: wrap with bracketed-paste markers so the receiving program treats
 *   the multi-line block atomically and preserves line breaks.
 */
export function encodeComposerSubmission(
  text: string,
  mode: ComposerSendMode,
): string {
  switch (mode) {
    case "insert":
      return text;
    case "send":
      return `${text}\r`;
    case "paste":
      return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;
  }
}
