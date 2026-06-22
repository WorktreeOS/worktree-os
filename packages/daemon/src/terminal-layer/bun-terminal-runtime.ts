/**
 * `Bun.Terminal` adapter for the terminal-layer runtime port.
 *
 * The adapter:
 * - Reports availability based on the Bun version, platform, and presence of
 *   `Bun.Terminal` so callers can fail with a typed terminal-unavailable error
 *   before allocating a session id.
 * - Delivers raw PTY output bytes as `Uint8Array` chunks without decoding.
 * - Signals the entire process group on `kill` so grandchildren of the shell
 *   (e.g. `sleep`, a TUI editor) cannot leak past session teardown.
 * - Drains buffered output for a short window after process exit before
 *   firing `onExit` exactly once.
 */

import { spawnSync } from "node:child_process";
import {
  TerminalRuntimeUnavailableError,
  type TerminalProcess,
  type TerminalProcessExit,
  type TerminalRuntime,
  type TerminalSpawnOptions,
} from "./runtime";

const EXIT_DRAIN_TIMEOUT_MS = 200;

/**
 * Grace window between the graceful close request and the forced tree kill on
 * Windows. Console children rarely honor a graceful `taskkill /T`, so the force
 * pass is what actually guarantees no leaked grandchildren — but it runs only
 * after giving the tree a chance to exit on its own.
 */
const WINDOWS_KILL_GRACE_MS = 2000;

function bunWhich(name: string): string | null {
  const which = (globalThis as { Bun?: { which?: (n: string) => string | null } }).Bun?.which;
  try {
    return which?.(name) ?? null;
  } catch {
    return null;
  }
}

/** Windows has no `taskkill`-free way to reap a console process tree. */
function hasTaskkill(): boolean {
  return bunWhich("taskkill") !== null;
}

/**
 * Terminate a Windows process tree rooted at `pid`. `taskkill /T` walks the
 * child tree from the parent pid (so it must run while the root is still
 * alive — Windows does not reparent orphaned children); `/F` forces the kill.
 */
function killProcessTreeWindows(pid: number, force: boolean): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const args = ["/PID", String(pid), "/T"];
  if (force) args.push("/F");
  try {
    spawnSync("taskkill", args, { stdio: "ignore", timeout: 5000, windowsHide: true });
  } catch {
    /* best-effort — availability is gated by isBunTerminalAvailable() */
  }
}

/**
 * `Bun.spawn({ terminal })` connects the child's stdio to the PTY slave but
 * does NOT call `ioctl(TIOCSCTTY)` to make the slave the controlling terminal
 * of the new session. Without a controlling terminal the kernel cannot route
 * `SIGWINCH` (raised by `TIOCSWINSZ` on the master) to the foreground process
 * group, so TUI grandchildren (e.g. `claude` running under `zsh`) never see
 * resize events. Job control inside the shell also degrades because
 * `tcsetpgrp` has nothing to anchor to.
 *
 * We work around this by prepending a tiny Python shim that performs the
 * `TIOCSCTTY` ioctl from inside the child (after Bun's `setsid()`) and then
 * `execvp`s the real shell. Python 3 ships by default on macOS 12+ (Xcode
 * CLT) and is universally present on Linux distros that run Bun.
 */
const TIOCSCTTY_PYTHON_SHIM = `
import os, sys
try:
    import fcntl, termios
    fcntl.ioctl(sys.stdin.fileno(), termios.TIOCSCTTY, 0)
except Exception:
    pass
os.execvp(sys.argv[1], sys.argv[1:])
`;

let cachedPythonPath: string | null | undefined;
function pythonPath(): string | null {
  if (cachedPythonPath !== undefined) return cachedPythonPath;
  // Prefer the system python3 explicitly; `Bun.which` searches PATH.
  const candidates = ["python3", "python"];
  for (const candidate of candidates) {
    try {
      const resolved = (globalThis as { Bun?: { which?: (name: string) => string | null } }).Bun?.which?.(candidate);
      if (resolved) {
        cachedPythonPath = resolved;
        return resolved;
      }
    } catch {
      /* keep searching */
    }
  }
  cachedPythonPath = null;
  return null;
}

const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGPIPE: 13,
  SIGTERM: 15,
  SIGSTOP: 17,
  SIGCONT: 19,
};

function signalToNumber(name: string | null | undefined): number | undefined {
  if (!name) return undefined;
  return SIGNAL_NUMBERS[name];
}

interface BunTerminalOptions {
  cols?: number;
  rows?: number;
  name?: string;
  data?: (terminal: BunTerminalInstance, data: Uint8Array) => void;
  exit?: (
    terminal: BunTerminalInstance,
    exitCode: number,
    signal: string | null,
  ) => void;
}

interface BunTerminalInstance {
  readonly closed: boolean;
  write(data: string | Uint8Array): number;
  resize(cols: number, rows: number): void;
  ref(): void;
  unref(): void;
  close(): void;
}

interface BunSubprocess {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  kill(signal?: number | string): void;
}

interface BunNamespace {
  Terminal?: new (opts: BunTerminalOptions) => BunTerminalInstance;
  spawn: (
    cmd: string[],
    opts: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      terminal?: BunTerminalInstance | BunTerminalOptions;
      detached?: boolean;
    },
  ) => BunSubprocess;
}

function bunNs(): BunNamespace {
  const bun = (globalThis as { Bun?: BunNamespace }).Bun;
  if (!bun) throw new TerminalRuntimeUnavailableError("Bun namespace is not available");
  return bun;
}

class BunTerminalProcess implements TerminalProcess {
  readonly pid: number;
  private currentCols: number;
  private currentRows: number;
  private readonly terminal: BunTerminalInstance;
  private readonly proc: BunSubprocess;
  private readonly dataListeners = new Set<(chunk: Uint8Array) => void>();
  private readonly exitListeners = new Set<(info: TerminalProcessExit) => void>();
  private terminalClosed = false;
  private streamClosed = false;
  private processExited = false;
  private exited = false;
  private exitInfo: TerminalProcessExit | null = null;
  private exitTimer: ReturnType<typeof setTimeout> | null = null;
  private winKillTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: TerminalSpawnOptions) {
    this.currentCols = opts.cols;
    this.currentRows = opts.rows;

    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.env)) {
      if (typeof v === "string") childEnv[k] = v;
    }
    if (!childEnv.TERM) childEnv.TERM = "xterm-256color";

    const bun = bunNs();
    if (typeof bun.Terminal !== "function") {
      throw new TerminalRuntimeUnavailableError("Bun.Terminal is not available in this runtime");
    }

    this.terminal = new bun.Terminal({
      cols: opts.cols,
      rows: opts.rows,
      name: childEnv.TERM,
      data: (_t, bytes) => {
        this.handleData(bytes);
      },
      exit: () => {
        this.handleStreamClose();
      },
    });

    // Prepend the TIOCSCTTY shim when Python 3 is available so the child
    // inherits a real controlling terminal. Without it `SIGWINCH` delivery
    // and shell job control are broken — see the comment on
    // `TIOCSCTTY_PYTHON_SHIM` above. Windows ConPTY delivers resize natively
    // and has no controlling-terminal ioctl, so the shim is skipped there.
    const py = process.platform === "win32" ? null : pythonPath();
    const cmd = py
      ? [py, "-c", TIOCSCTTY_PYTHON_SHIM, opts.shell, ...(opts.args ?? [])]
      : [opts.shell, ...(opts.args ?? [])];

    let proc: BunSubprocess;
    try {
      proc = bun.spawn(cmd, {
        cwd: opts.cwd,
        env: childEnv,
        terminal: this.terminal,
        // `detached: true` makes the shim its own session/process group
        // leader (via `setsid`). The shim then attaches the PTY slave as the
        // session's controlling terminal before `execvp`-ing the real shell,
        // so the shell inherits both the session and the ctty in one step.
        // On Windows there is no setsid; the ConPTY child stays a normal child
        // so `taskkill /T` can walk its tree at teardown.
        ...(process.platform === "win32" ? {} : { detached: true }),
      });
    } catch (e) {
      try {
        this.terminal.close();
      } catch {
        /* ignore */
      }
      this.terminalClosed = true;
      throw e;
    }
    this.proc = proc;
    this.pid = proc.pid;

    void proc.exited
      .then(() => this.handleProcessExit())
      .catch(() => this.handleProcessExit());
  }

  get cols(): number {
    return this.currentCols;
  }

  get rows(): number {
    return this.currentRows;
  }

  private handleData(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    // Hand a copy to each listener — Bun.Terminal reuses its internal buffer.
    const copy = new Uint8Array(bytes);
    for (const l of this.dataListeners) {
      try {
        l(copy);
      } catch {
        /* swallow listener errors */
      }
    }
  }

  private handleStreamClose(): void {
    if (this.streamClosed) return;
    this.streamClosed = true;
    if (this.processExited && !this.exited && this.exitInfo) {
      this.finalizeExit(this.exitInfo);
    }
  }

  private handleProcessExit(): void {
    if (this.processExited) return;
    this.processExited = true;
    const code = typeof this.proc.exitCode === "number" ? this.proc.exitCode : 0;
    const signalNum = signalToNumber(this.proc.signalCode);
    const info: TerminalProcessExit = {
      exitCode: code,
      ...(typeof signalNum === "number" ? { signal: signalNum } : {}),
    };
    this.exitInfo = info;
    if (this.streamClosed) {
      this.finalizeExit(info);
      return;
    }
    this.exitTimer = setTimeout(() => {
      this.exitTimer = null;
      this.finalizeExit(info);
    }, EXIT_DRAIN_TIMEOUT_MS);
  }

  private finalizeExit(info: TerminalProcessExit): void {
    if (this.exited) return;
    this.exited = true;
    this.exitInfo = info;
    if (this.exitTimer) {
      clearTimeout(this.exitTimer);
      this.exitTimer = null;
    }
    if (this.winKillTimer) {
      clearTimeout(this.winKillTimer);
      this.winKillTimer = null;
    }
    if (!this.terminalClosed) {
      this.terminalClosed = true;
      try {
        this.terminal.close();
      } catch {
        /* ignore */
      }
    }
    const listeners = Array.from(this.exitListeners);
    this.exitListeners.clear();
    this.dataListeners.clear();
    for (const l of listeners) {
      try {
        l(info);
      } catch {
        /* swallow */
      }
    }
  }

  write(data: string | Uint8Array): void {
    if (this.exited || this.terminalClosed) return;
    try {
      this.terminal.write(data);
    } catch {
      /* swallow — exit listener will reconcile state if the PTY is gone */
    }
  }

  resize(cols: number, rows: number): void {
    if (this.exited || this.terminalClosed) return;
    this.currentCols = cols;
    this.currentRows = rows;
    try {
      this.terminal.resize(cols, rows);
    } catch {
      /* swallow */
    }
    // With the TIOCSCTTY shim in place, the kernel routes SIGWINCH from
    // TIOCSWINSZ to the foreground process group of the shell's session
    // automatically. No manual signalling is required.
  }

  kill(signal?: string): void {
    const sig = signal ?? "SIGHUP";
    if (process.platform === "win32") {
      this.killWindows(sig);
      return;
    }
    if (this.pid > 0) {
      try {
        process.kill(-this.pid, sig as NodeJS.Signals);
        return;
      } catch {
        /* fall through to per-process signal */
      }
    }
    try {
      this.proc.kill(sig);
    } catch {
      /* swallow */
    }
  }

  /**
   * Windows process-tree teardown. There is no negative-pid process-group
   * signal, so cleanup walks the tree with `taskkill /T`. A `SIGKILL` forces
   * the whole tree immediately; any other (graceful) signal requests a close
   * first and force-kills survivors after `WINDOWS_KILL_GRACE_MS`. The walk
   * targets the live root pid because Windows does not reparent orphans.
   */
  private killWindows(sig: string): void {
    if (this.pid <= 0) {
      try {
        this.proc.kill();
      } catch {
        /* swallow */
      }
      return;
    }
    if (sig === "SIGKILL") {
      killProcessTreeWindows(this.pid, true);
      return;
    }
    killProcessTreeWindows(this.pid, false);
    if (this.winKillTimer) clearTimeout(this.winKillTimer);
    this.winKillTimer = setTimeout(() => {
      this.winKillTimer = null;
      if (!this.exited) killProcessTreeWindows(this.pid, true);
    }, WINDOWS_KILL_GRACE_MS);
    (this.winKillTimer as { unref?: () => void }).unref?.();
  }

  onData(listener: (chunk: Uint8Array) => void): () => void {
    if (this.exited) return () => {};
    this.dataListeners.add(listener);
    return () => {
      this.dataListeners.delete(listener);
    };
  }

  onExit(listener: (info: TerminalProcessExit) => void): () => void {
    if (this.exited && this.exitInfo) {
      const info = this.exitInfo;
      queueMicrotask(() => listener(info));
      return () => {};
    }
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  dispose(): void {
    this.dataListeners.clear();
    this.exitListeners.clear();
    if (this.exitTimer) {
      clearTimeout(this.exitTimer);
      this.exitTimer = null;
    }
    if (this.winKillTimer) {
      clearTimeout(this.winKillTimer);
      this.winKillTimer = null;
    }
    if (!this.terminalClosed) {
      this.terminalClosed = true;
      try {
        this.terminal.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Detect whether `Bun.Terminal` can provide the cleanup semantics we need.
 *
 * On darwin/linux `Bun.spawn({ terminal })` plus process-group signalling give
 * child-free teardown. On Windows the same PTY is available through ConPTY, but
 * cleanup needs `taskkill` to walk the process tree (Windows has no negative-pid
 * group signal) — so the runtime disables itself there rather than silently
 * leaking grandchildren, as the pty-runtime spec requires.
 */
export function isBunTerminalAvailable(): boolean {
  const bun = (globalThis as { Bun?: { Terminal?: unknown } }).Bun;
  if (!bun || typeof bun.Terminal !== "function") return false;
  const platform = process.platform;
  if (platform === "darwin" || platform === "linux") return true;
  if (platform === "win32") return hasTaskkill();
  return false;
}

/**
 * Default shell selection. Honors `$SHELL` first on every platform (Git
 * Bash/MSYS users set it on Windows). Otherwise: a sensible POSIX shell on
 * darwin/linux, and on Windows the modern interactive default chain
 * `pwsh` → `powershell.exe` → `%COMSPEC%` → `cmd.exe`.
 *
 * `platform` and `which` are injectable so the full Windows fallback chain can
 * be unit-tested off a Windows host.
 */
export function defaultShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  which: (name: string) => string | null = bunWhich,
): string {
  const fromEnv = env.SHELL;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  if (platform === "win32") {
    const pwsh = which("pwsh");
    if (pwsh) return pwsh;
    const powershell = which("powershell");
    if (powershell) return powershell;
    const comspec = env.COMSPEC;
    if (typeof comspec === "string" && comspec.length > 0) return comspec;
    return "cmd.exe";
  }
  if (platform === "darwin") return "/bin/zsh";
  return "/bin/bash";
}

/** Concrete Bun.Terminal-backed runtime. */
export const bunTerminalRuntime: TerminalRuntime = {
  name: "bun-terminal",
  isAvailable() {
    return isBunTerminalAvailable();
  },
  spawn(opts) {
    if (!isBunTerminalAvailable()) {
      throw new TerminalRuntimeUnavailableError(
        "terminal runtime is not available: Bun.Terminal is missing or platform is unsupported",
      );
    }
    return new BunTerminalProcess(opts);
  },
};
