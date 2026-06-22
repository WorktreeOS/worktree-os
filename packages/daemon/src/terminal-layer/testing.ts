/**
 * Test doubles for the terminal layer. These fakes are intentionally simple
 * and synchronous so actor, protocol, and integration tests can drive PTY
 * lifecycle without spawning real subprocesses.
 *
 * The fakes are colocated under `src/` (rather than `tests/`) so they can be
 * imported from any test in the workspace through the same module-resolution
 * path used by other daemon code.
 */

import type {
  TerminalProcess,
  TerminalProcessExit,
  TerminalRuntime,
  TerminalSpawnOptions,
} from "./runtime";

export interface FakeTerminalProcessHandle {
  readonly process: TerminalProcess;
  readonly spawn: TerminalSpawnOptions;
  /** Emit a raw byte chunk as if the PTY had produced it. */
  emit(chunk: string | Uint8Array): void;
  /** Trigger the single process-exit notification. Subsequent calls are no-ops. */
  exit(info?: TerminalProcessExit): void;
  /** Inspect inputs written by the actor. */
  readonly writes: Array<Uint8Array>;
  /** Inspect resize requests applied by the actor. */
  readonly resizes: Array<{ cols: number; rows: number }>;
  /** Inspect signals delivered through `kill`. */
  readonly kills: Array<string | undefined>;
  /** True after `dispose()` has been called. */
  disposed: boolean;
}

const encoder = new TextEncoder();

function toBytes(chunk: string | Uint8Array): Uint8Array {
  return typeof chunk === "string" ? encoder.encode(chunk) : chunk;
}

/**
 * Build a fake `TerminalProcess` plus an external handle that lets tests
 * drive PTY-side behavior (output, exit) and inspect actor-side calls.
 */
export function createFakeTerminalProcess(
  spawn: TerminalSpawnOptions,
  opts: { pid?: number } = {},
): FakeTerminalProcessHandle {
  const dataListeners = new Set<(chunk: Uint8Array) => void>();
  const exitListeners = new Set<(info: TerminalProcessExit) => void>();
  const writes: Uint8Array[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  const kills: Array<string | undefined> = [];
  let exited = false;
  let cols = spawn.cols;
  let rows = spawn.rows;
  let exitInfo: TerminalProcessExit | null = null;
  const handle: FakeTerminalProcessHandle = {
    spawn,
    writes,
    resizes,
    kills,
    disposed: false,
    process: {
      pid: opts.pid,
      get cols() {
        return cols;
      },
      get rows() {
        return rows;
      },
      write(data) {
        if (exited) return;
        writes.push(toBytes(data));
      },
      resize(c, r) {
        if (exited) return;
        cols = c;
        rows = r;
        resizes.push({ cols: c, rows: r });
      },
      kill(signal) {
        kills.push(signal);
      },
      onData(listener) {
        if (exited) return () => {};
        dataListeners.add(listener);
        return () => dataListeners.delete(listener);
      },
      onExit(listener) {
        if (exited && exitInfo) {
          const info = exitInfo;
          queueMicrotask(() => listener(info));
          return () => {};
        }
        exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      },
      dispose() {
        handle.disposed = true;
        dataListeners.clear();
        exitListeners.clear();
      },
    },
    emit(chunk) {
      if (exited) return;
      const bytes = toBytes(chunk);
      for (const l of dataListeners) {
        try {
          l(bytes);
        } catch {
          /* swallow listener errors */
        }
      }
    },
    exit(info = {}) {
      if (exited) return;
      exited = true;
      exitInfo = info;
      const listeners = Array.from(exitListeners);
      exitListeners.clear();
      dataListeners.clear();
      for (const l of listeners) {
        try {
          l(info);
        } catch {
          /* swallow */
        }
      }
    },
  };
  return handle;
}

export interface FakeTerminalRuntimeHandle {
  readonly runtime: TerminalRuntime;
  /** Every process spawned through the runtime, in spawn order. */
  readonly spawned: FakeTerminalProcessHandle[];
  /** Toggle runtime availability for negative-path tests. */
  setAvailable(available: boolean): void;
  /** Throw on the next `spawn` call. The error is cleared after use. */
  failNextSpawn(error: Error): void;
}

/**
 * Build a fake runtime that records every spawn and exposes the resulting
 * fake processes for tests to drive.
 */
export function createFakeTerminalRuntime(opts: {
  name?: string;
} = {}): FakeTerminalRuntimeHandle {
  const spawned: FakeTerminalProcessHandle[] = [];
  let available = true;
  let nextSpawnError: Error | null = null;
  const runtime: TerminalRuntime = {
    name: opts.name ?? "fake",
    isAvailable() {
      return available;
    },
    spawn(s) {
      if (nextSpawnError) {
        const err = nextSpawnError;
        nextSpawnError = null;
        throw err;
      }
      const handle = createFakeTerminalProcess(s, { pid: 1000 + spawned.length });
      spawned.push(handle);
      return handle.process;
    },
  };
  return {
    runtime,
    spawned,
    setAvailable(v) {
      available = v;
    },
    failNextSpawn(err) {
      nextSpawnError = err;
    },
  };
}
