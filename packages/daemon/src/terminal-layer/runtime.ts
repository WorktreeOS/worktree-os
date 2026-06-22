/**
 * Runtime-neutral terminal process port.
 *
 * The terminal layer talks to PTY processes only through the abstractions in
 * this file. The default implementation wraps `Bun.Terminal`, but tests and
 * future runtimes can drop in alternative implementations.
 *
 * The port exposes raw `Uint8Array` output rather than decoded strings so the
 * byte journal can record exact bytes and bound capacity by bytes-on-the-wire.
 * Decoding to UTF-8 happens at the consumer (e.g. the WebSocket framer or the
 * xterm viewport in the browser).
 */

export interface TerminalSpawnOptions {
  /** Absolute path to the shell or program to spawn. */
  shell: string;
  /** Optional arguments. */
  args?: string[];
  /** Process working directory; expected to be an absolute path. */
  cwd: string;
  /** Environment to apply on top of an empty base. */
  env: Record<string, string | undefined>;
  /** Initial PTY columns. */
  cols: number;
  /** Initial PTY rows. */
  rows: number;
}

/** Outcome of a PTY process exit. */
export interface TerminalProcessExit {
  /** Numeric exit code when available. */
  exitCode?: number;
  /** POSIX signal number when the process was killed by a signal. */
  signal?: number;
}

/**
 * A live PTY-backed child process. Implementations MUST:
 * - Deliver `data` callbacks in process-emit order.
 * - Deliver `exit` exactly once across the lifetime of the process.
 * - Tolerate `write`/`resize` after exit by silently no-oping.
 */
export interface TerminalProcess {
  /** Process id when the runtime exposes one. */
  readonly pid?: number;
  readonly cols: number;
  readonly rows: number;
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  /**
   * Request termination of the entire process tree. POSIX implementations
   * SHOULD signal the process group (`-pid`) so grandchildren do not leak.
   */
  kill(signal?: string): void;
  /** Subscribe to raw output bytes. Returns an unsubscribe function. */
  onData(listener: (chunk: Uint8Array) => void): () => void;
  /** Subscribe to the single exit event. Returns an unsubscribe function. */
  onExit(listener: (info: TerminalProcessExit) => void): () => void;
  /** Release runtime resources without sending a signal. */
  dispose(): void;
}

/**
 * Runtime factory. Implementations report availability up front so the daemon
 * can fail terminal session startup with a typed `terminal-unavailable` error
 * before allocating a session id.
 */
export interface TerminalRuntime {
  /** Stable identifier used in diagnostics (e.g. `bun-terminal`). */
  readonly name: string;
  /** True when this runtime can spawn working PTY processes on this host. */
  isAvailable(): boolean;
  /** Spawn a new PTY-backed process. Throws on failure. */
  spawn(opts: TerminalSpawnOptions): TerminalProcess;
}

/** Thrown when a runtime cannot satisfy the terminal port on this host. */
export class TerminalRuntimeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalRuntimeUnavailableError";
  }
}
