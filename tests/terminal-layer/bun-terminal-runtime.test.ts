/**
 * Real-PTY tests for the Bun.Terminal-backed terminal runtime.
 *
 * Skipped on platforms where `Bun.Terminal` is unavailable (Windows, older
 * Bun versions). On macOS/Linux these tests exercise the actual native PTY:
 * input/output round-trip, resize ioctl, non-zero exit, signal exit, and
 * process-group cleanup (so grandchildren do not leak past terminate).
 */

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bunTerminalRuntime,
  defaultShell,
  isBunTerminalAvailable,
} from "@worktreeos/daemon/terminal-layer/bun-terminal-runtime";

const AVAILABLE = isBunTerminalAvailable();
const IS_WIN = process.platform === "win32";
// The POSIX real-PTY tests below drive `/bin/sh` and `/tmp`; gate them off
// Windows. Windows ConPTY is exercised by the separate block further down.
const itOrSkip = !AVAILABLE || IS_WIN ? test.skip : test;
const winIt = !AVAILABLE || !IS_WIN ? test.skip : test;

function decoder(): TextDecoder {
  return new TextDecoder("utf-8", { fatal: false });
}

async function collectUntil(
  proc: import("@worktreeos/daemon/terminal-layer/runtime").TerminalProcess,
  match: RegExp,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const dec = decoder();
    let buf = "";
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for ${match}; got: ${JSON.stringify(buf)}`));
    }, timeoutMs);
    const off = proc.onData((bytes) => {
      buf += dec.decode(bytes, { stream: true });
      if (match.test(buf)) {
        clearTimeout(timer);
        off();
        resolve(buf);
      }
    });
  });
}

async function exitInfo(
  proc: import("@worktreeos/daemon/terminal-layer/runtime").TerminalProcess,
  timeoutMs: number,
): Promise<import("@worktreeos/daemon/terminal-layer/runtime").TerminalProcessExit> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("exit timeout")), timeoutMs);
    proc.onExit((info) => {
      clearTimeout(timer);
      resolve(info);
    });
  });
}

describe("BunTerminalProcess (real PTY)", () => {
  itOrSkip("echoes input bytes back as output", async () => {
    const proc = bunTerminalRuntime.spawn({
      shell: "/bin/sh",
      args: ["-c", "cat"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      cols: 80,
      rows: 24,
    });
    const seen = collectUntil(proc, /hello/, 3000);
    proc.write("hello\n");
    const out = await seen;
    expect(out).toContain("hello");
    proc.kill("SIGTERM");
    await exitInfo(proc, 2000);
  });

  itOrSkip("reports non-zero exit code from the shell", async () => {
    const proc = bunTerminalRuntime.spawn({
      shell: "/bin/sh",
      args: ["-c", "exit 7"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      cols: 80,
      rows: 24,
    });
    const info = await exitInfo(proc, 3000);
    expect(info.exitCode).toBe(7);
  });

  itOrSkip("reports signal when the process is killed", async () => {
    const proc = bunTerminalRuntime.spawn({
      shell: "/bin/sh",
      args: ["-c", "sleep 30"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      cols: 80,
      rows: 24,
    });
    // Give the shell time to actually start the sleep before signalling.
    await Bun.sleep(50);
    proc.kill("SIGTERM");
    const info = await exitInfo(proc, 3000);
    // Different POSIX shells encode SIGTERM differently in their exit
    // representation. Accept either the signal field or the conventional
    // 128 + signum exit code.
    const sigOk = info.signal === 15;
    const codeOk = info.exitCode === 143 || info.exitCode === 128 + 15;
    expect(sigOk || codeOk).toBe(true);
  });

  itOrSkip(
    "resize delivers SIGWINCH to the child with the new dimensions",
    async () => {
      // This is the real-world regression: when a TUI runs under the shell,
      // the kernel needs the PTY to be the child's controlling terminal so
      // TIOCSWINSZ → SIGWINCH propagates to the foreground process group.
      // The TIOCSCTTY shim is what makes that work; without it `claude` and
      // similar tools never redraw on browser resize.
      const tmpfile = join(tmpdir(), `wos-winch-${crypto.randomUUID()}.log`);
      try {
        const script = `import os,sys,signal,time
def h(*a):
    try: open(${JSON.stringify(tmpfile)},'a').write(f"WINCH {os.get_terminal_size().columns}x{os.get_terminal_size().lines}\\n")
    except Exception: pass
signal.signal(signal.SIGWINCH, h)
open(${JSON.stringify(tmpfile)},'w').write(f"READY {os.get_terminal_size().columns}x{os.get_terminal_size().lines}\\n")
time.sleep(2)
`;
        const proc = bunTerminalRuntime.spawn({
          shell: "/usr/bin/env",
          args: ["python3", "-c", script],
          cwd: process.cwd(),
          env: { PATH: process.env.PATH ?? "" },
          cols: 80,
          rows: 24,
        });
        proc.onData(() => {});
        // Let python install the signal handler and write READY.
        await new Promise((r) => setTimeout(r, 400));
        proc.resize(120, 40);
        await new Promise((r) => setTimeout(r, 400));
        proc.kill("SIGTERM");
        await exitInfo(proc, 2000);
        const log = await Bun.file(tmpfile).text();
        expect(log).toContain("READY 80x24");
        expect(log).toContain("WINCH 120x40");
      } finally {
        try {
          await Bun.file(tmpfile).unlink?.();
        } catch {
          /* ignore */
        }
      }
    },
  );

  itOrSkip("resize updates cols/rows accessors and does not throw", async () => {
    const proc = bunTerminalRuntime.spawn({
      shell: "/bin/sh",
      args: ["-c", "cat"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      cols: 80,
      rows: 24,
    });
    proc.resize(120, 40);
    expect(proc.cols).toBe(120);
    expect(proc.rows).toBe(40);
    proc.kill("SIGTERM");
    await exitInfo(proc, 2000);
  });

  itOrSkip(
    "process-tree cleanup terminates grandchildren spawned by the shell",
    async () => {
      // Spawn a shell that starts a long-running sleep child, write its pid
      // to a temp file so the test can verify it is no longer alive after
      // kill, then kill the process group.
      const pidFile = await Bun.file(
        `${require("node:os").tmpdir()}/wos-terminal-pty-${crypto.randomUUID()}.pid`,
      ).name;
      const proc = bunTerminalRuntime.spawn({
        shell: "/bin/sh",
        args: ["-c", `sleep 30 & echo $! > ${pidFile}; wait`],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        cols: 80,
        rows: 24,
      });
      // Wait for the pid file to appear.
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if (await Bun.file(pidFile).exists()) break;
        await Bun.sleep(25);
      }
      const childPid = parseInt(
        (await Bun.file(pidFile).text()).trim(),
        10,
      );
      expect(Number.isFinite(childPid)).toBe(true);
      // Kill the shell's process group; the grandchild MUST be reaped too.
      proc.kill("SIGTERM");
      await exitInfo(proc, 3000);
      // Give the kernel a moment to deliver SIGTERM to the grandchild and
      // mark the pid as collected. On macOS the propagation is not strictly
      // synchronous with the parent's exit notification.
      const deadline2 = Date.now() + 1500;
      let alive = true;
      while (Date.now() < deadline2) {
        try {
          process.kill(childPid, 0);
          alive = true;
          await Bun.sleep(50);
        } catch {
          alive = false;
          break;
        }
      }
      expect(alive).toBe(false);
    },
  );
});

describe("BunTerminalProcess (Windows ConPTY)", () => {
  winIt("echoes a command's output through ConPTY", async () => {
    const proc = bunTerminalRuntime.spawn({
      shell: "cmd.exe",
      args: ["/d", "/s", "/c", "echo wos-conpty-ok"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
      cols: 80,
      rows: 24,
    });
    const out = await collectUntil(proc, /wos-conpty-ok/, 5000);
    expect(out).toContain("wos-conpty-ok");
    await exitInfo(proc, 3000);
  });

  winIt("reports a non-zero exit code from cmd.exe", async () => {
    const proc = bunTerminalRuntime.spawn({
      shell: "cmd.exe",
      args: ["/d", "/s", "/c", "exit 7"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
      cols: 80,
      rows: 24,
    });
    const info = await exitInfo(proc, 5000);
    expect(info.exitCode).toBe(7);
  });

  winIt("resize updates cols/rows accessors and does not throw", async () => {
    const proc = bunTerminalRuntime.spawn({
      shell: "cmd.exe",
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
      cols: 80,
      rows: 24,
    });
    proc.resize(120, 40);
    expect(proc.cols).toBe(120);
    expect(proc.rows).toBe(40);
    proc.kill("SIGKILL");
    await exitInfo(proc, 5000);
  });

  winIt(
    "taskkill /T tree cleanup terminates a background child process",
    async () => {
      const shell = process.env.COMSPEC ?? "powershell.exe";
      const usePwsh = /powershell/i.test(shell);
      const pidFile = join(tmpdir(), `wos-win-pty-${crypto.randomUUID()}.pid`);
      // Launch a long-lived grandchild and record its pid, then idle so the
      // PTY tree stays alive until we kill it.
      const ps = `$p = Start-Process -FilePath ping -ArgumentList '-n','60','127.0.0.1' -PassThru -WindowStyle Hidden; Set-Content -LiteralPath '${pidFile}' -Value $p.Id; Start-Sleep -Seconds 30`;
      const proc = bunTerminalRuntime.spawn(
        usePwsh
          ? {
              shell,
              args: ["-NoProfile", "-NonInteractive", "-Command", ps],
              cwd: process.cwd(),
              env: process.env as Record<string, string>,
              cols: 80,
              rows: 24,
            }
          : {
              shell: "powershell.exe",
              args: ["-NoProfile", "-NonInteractive", "-Command", ps],
              cwd: process.cwd(),
              env: process.env as Record<string, string>,
              cols: 80,
              rows: 24,
            },
      );
      proc.onData(() => {});
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (await Bun.file(pidFile).exists()) {
          const txt = (await Bun.file(pidFile).text()).trim();
          if (txt.length > 0) break;
        }
        await Bun.sleep(100);
      }
      const childPid = parseInt((await Bun.file(pidFile).text()).trim(), 10);
      expect(Number.isFinite(childPid)).toBe(true);
      proc.kill("SIGKILL");
      await exitInfo(proc, 5000);
      // taskkill /T must have reaped the ping grandchild.
      const deadline2 = Date.now() + 4000;
      let alive = true;
      while (Date.now() < deadline2) {
        try {
          process.kill(childPid, 0);
          await Bun.sleep(100);
        } catch {
          alive = false;
          break;
        }
      }
      expect(alive).toBe(false);
      try {
        await Bun.file(pidFile).unlink?.();
      } catch {
        /* ignore */
      }
    },
  );
});

describe("defaultShell selection", () => {
  test("honors $SHELL first on every platform", () => {
    expect(defaultShell({ SHELL: "/custom/sh" }, "win32", () => null)).toBe(
      "/custom/sh",
    );
    expect(defaultShell({ SHELL: "/custom/sh" }, "linux", () => null)).toBe(
      "/custom/sh",
    );
  });

  test("Windows chain: pwsh → powershell → COMSPEC → cmd.exe", () => {
    const env = { COMSPEC: "C:\\Windows\\system32\\cmd.exe" } as NodeJS.ProcessEnv;
    // pwsh wins when present.
    expect(
      defaultShell(env, "win32", (n) => (n === "pwsh" ? "C:\\pwsh.exe" : null)),
    ).toBe("C:\\pwsh.exe");
    // falls back to powershell.
    expect(
      defaultShell(env, "win32", (n) =>
        n === "powershell" ? "C:\\powershell.exe" : null,
      ),
    ).toBe("C:\\powershell.exe");
    // then COMSPEC.
    expect(defaultShell(env, "win32", () => null)).toBe(
      "C:\\Windows\\system32\\cmd.exe",
    );
    // then the cmd.exe literal.
    expect(defaultShell({}, "win32", () => null)).toBe("cmd.exe");
  });

  test("POSIX defaults are unchanged", () => {
    expect(defaultShell({}, "darwin", () => null)).toBe("/bin/zsh");
    expect(defaultShell({}, "linux", () => null)).toBe("/bin/bash");
  });
});

describe("isBunTerminalAvailable", () => {
  winIt("is available on Windows when ConPTY + taskkill are present", () => {
    expect(isBunTerminalAvailable()).toBe(true);
  });
});
