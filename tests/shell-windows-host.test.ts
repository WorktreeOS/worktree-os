/**
 * Windows shell-mode host behavior.
 *
 * The pure `windowsBatchBody` shape test runs everywhere. The real-spawn tests
 * exercise `cmd.exe` through the batch runner and so are gated to a native
 * Windows host — `process.env.SystemRoot` is absent under a Git Bash/MSYS-
 * launched runner, where `cmd.exe` cannot initialize, so those tests skip there
 * and run on `windows-latest` CI (and any native PowerShell/cmd invocation).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildScriptInvocation,
  defaultShellProcessHost,
  windowsBatchBody,
} from "@worktreeos/runtime/shell";

const IS_WIN = process.platform === "win32";
const NATIVE_WIN = IS_WIN && typeof process.env.SystemRoot === "string";
const winHost = NATIVE_WIN ? test : test.skip;

describe("windowsBatchBody (pure)", () => {
  test("wraps each command in setlocal/endlocal with stop-on-failure", () => {
    const body = windowsBatchBody(["echo one", "echo two"]);
    const lines = body.split("\r\n");
    expect(lines[0]).toBe("@echo off");
    // Two commands, each fenced by setlocal … endlocal with an errorlevel gate.
    expect(lines).toEqual([
      "@echo off",
      "setlocal",
      "echo one",
      "if errorlevel 1 exit /b %errorlevel%",
      "endlocal",
      "setlocal",
      "echo two",
      "if errorlevel 1 exit /b %errorlevel%",
      "endlocal",
      "",
    ]);
    // CRLF line endings for cmd.
    expect(body.includes("\r\n")).toBe(true);
  });

  test("POSIX invocation joins with && subshells", () => {
    if (IS_WIN) return; // POSIX shape only meaningful off Windows
    const { command } = buildScriptInvocation({
      script: ["a", "b"],
      runnerPath: "",
    });
    expect(command).toEqual(["sh", "-lc", "(a) && (b)"]);
  });
});

describe("Windows shell host (real cmd.exe)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wos-winshell-"));
  });
  afterEach(async () => {
    for (let i = 0; ; i += 1) {
      try {
        await rm(dir, { recursive: true, force: true });
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (i >= 10 || (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM")) return;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });

  async function runScript(script: string[]): Promise<{ stdout: string; pid: number }> {
    const runnerPath = join(dir, "runner.cmd");
    const stdoutPath = join(dir, "out.log");
    const stderrPath = join(dir, "err.log");
    const { command } = buildScriptInvocation({ script, runnerPath });
    const handle = defaultShellProcessHost.spawn({
      command,
      cwd: dir,
      env: process.env as Record<string, string>,
      stdoutPath,
      stderrPath,
    });
    // Short-lived: poll liveness until the runner exits, then read the log.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && defaultShellProcessHost.isAlive(handle.pid)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const stdout = await readFile(stdoutPath, "utf8").catch(() => "");
    return { stdout, pid: handle.pid };
  }

  winHost("runs commands in order", async () => {
    const { stdout } = await runScript(["echo first", "echo second"]);
    const a = stdout.indexOf("first");
    const b = stdout.indexOf("second");
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
  });

  winHost("a cd in one command does not leak into the next", async () => {
    // Second command prints the cwd; it must be the spawn dir, not C:\Windows.
    const { stdout } = await runScript(["cd /d C:\\Windows", "cd"]);
    expect(stdout.toLowerCase()).not.toContain("c:\\windows");
    expect(stdout.toLowerCase()).toContain(dir.toLowerCase());
  });

  winHost("handles quoted arguments with spaces", async () => {
    const { stdout } = await runScript([`echo "hello there"`]);
    expect(stdout).toContain("hello there");
  });

  winHost("stops on the first failing command", async () => {
    const { stdout } = await runScript(["exit /b 5", "echo SHOULD_NOT_APPEAR"]);
    expect(stdout).not.toContain("SHOULD_NOT_APPEAR");
  });

  winHost("kill terminates a long-lived process and its child tree", async () => {
    const runnerPath = join(dir, "svc.cmd");
    const { command } = buildScriptInvocation({
      // ping idles ~30s; the runner stays alive until killed.
      script: ["ping -n 30 127.0.0.1"],
      runnerPath,
    });
    const handle = defaultShellProcessHost.spawn({
      command,
      cwd: dir,
      env: process.env as Record<string, string>,
      stdoutPath: join(dir, "svc.out"),
      stderrPath: join(dir, "svc.err"),
    });
    // Let it actually start the ping child.
    await new Promise((r) => setTimeout(r, 500));
    expect(defaultShellProcessHost.isAlive(handle.pid)).toBe(true);
    defaultShellProcessHost.kill({ pid: handle.pid }, "SIGKILL");
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && defaultShellProcessHost.isAlive(handle.pid)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(defaultShellProcessHost.isAlive(handle.pid)).toBe(false);
  });
});
