/**
 * Single-instance guard for the desktop app.
 *
 * A properly packaged macOS `.app` is already single-instance via LaunchServices
 * (a second launch re-activates the running app). This lock is defense-in-depth
 * for `electrobun dev` and edge cases: it prevents a second process from also
 * *hosting* a daemon. The daemon singleton (`daemon.json`) would already make a
 * second instance adopt rather than double-host, so the worst case without this
 * is two windows — not data corruption.
 *
 * Pure decision (`isAnotherInstanceRunning`) is unit-tested; `acquireInstanceLock`
 * performs the filesystem effects.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";

/**
 * True when a *different*, still-alive process holds the lock. A stale lock
 * (dead pid) or our own pid is not a conflict.
 */
export function isAnotherInstanceRunning(
  existingPid: number | null,
  selfPid: number,
  isAlive: (pid: number) => boolean,
): boolean {
  if (existingPid === null) return false;
  if (existingPid === selfPid) return false;
  return isAlive(existingPid);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 probes existence without killing
    return true;
  } catch {
    return false;
  }
}

function readLockPid(lockPath: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Try to claim the single-instance lock. Returns false when another live
 * instance holds it (the caller should quit); otherwise writes our pid, removes
 * the lock on exit, and returns true.
 */
export function acquireInstanceLock(
  lockPath: string,
  selfPid: number = process.pid,
): boolean {
  if (isAnotherInstanceRunning(readLockPid(lockPath), selfPid, pidAlive)) {
    return false;
  }
  try {
    writeFileSync(lockPath, String(selfPid), "utf8");
  } catch {
    // If we cannot write the lock, do not block launch.
    return true;
  }
  const release = () => {
    try {
      if (readLockPid(lockPath) === selfPid) rmSync(lockPath, { force: true });
    } catch {
      /* best-effort */
    }
  };
  process.on("exit", release);
  return true;
}
