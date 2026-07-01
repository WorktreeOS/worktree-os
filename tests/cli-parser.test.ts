import { test, expect, describe, afterEach } from "bun:test";
import { resolve } from "node:path";
import {
  main,
  parseGlobalArgs,
  parseWorktreeRemoveArgs,
} from "../apps/cli/cli";

describe("parseGlobalArgs", () => {
  test("returns no command and empty rest for empty argv", () => {
    const out = parseGlobalArgs([]);
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    expect(out.command).toBeUndefined();
    expect(out.rest).toEqual([]);
    expect(out.global.cwd).toBeUndefined();
  });

  test("parses bare command without --cwd", () => {
    const out = parseGlobalArgs(["status"]);
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    expect(out.command).toBe("status");
    expect(out.rest).toEqual([]);
    expect(out.global.cwd).toBeUndefined();
  });

  test("preserves rest arguments verbatim for the command", () => {
    const out = parseGlobalArgs(["up", "-d", "--force"]);
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    expect(out.command).toBe("up");
    expect(out.rest).toEqual(["-d", "--force"]);
  });

  test("--cwd resolves value to an absolute path", () => {
    const out = parseGlobalArgs(["--cwd", "some/relative", "status"]);
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    expect(out.command).toBe("status");
    expect(out.global.cwd).toBe(resolve("some/relative"));
  });

  test("--cwd=value form resolves to an absolute path", () => {
    const out = parseGlobalArgs(["--cwd=/tmp/foo", "status"]);
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    expect(out.global.cwd).toBe(resolve("/tmp/foo"));
    expect(out.command).toBe("status");
  });

  test("--cwd value is passed through to command rest unchanged", () => {
    const out = parseGlobalArgs(["--cwd", "/tmp/wt", "wait", "--timeout", "30s"]);
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    expect(out.global.cwd).toBe(resolve("/tmp/wt"));
    expect(out.command).toBe("wait");
    expect(out.rest).toEqual(["--timeout", "30s"]);
  });

  test("--cwd without value fails parsing", () => {
    const out = parseGlobalArgs(["--cwd"]);
    expect("error" in out).toBe(true);
  });

  test("--cwd followed by another command name fails parsing", () => {
    const out = parseGlobalArgs(["--cwd", "status"]);
    expect("error" in out).toBe(true);
  });

  test("--cwd= with empty value fails parsing", () => {
    const out = parseGlobalArgs(["--cwd="]);
    expect("error" in out).toBe(true);
  });
});

describe("main() command dispatch", () => {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);

  function captureStdio() {
    stdoutChunks.length = 0;
    stderrChunks.length = 0;
    process.stdout.write = ((chunk: any) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as any;
    process.stderr.write = ((chunk: any) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as any;
  }

  afterEach(() => {
    process.stdout.write = originalStdout as any;
    process.stderr.write = originalStderr as any;
  });

  test("help prints usage and returns 0", async () => {
    captureStdio();
    const code = await main(["help"]);
    expect(code).toBe(0);
    expect(stdoutChunks.join("")).toContain("wos [--cwd <path>] <command>");
    expect(stdoutChunks.join("")).toContain("wait");
  });

  test("bare wos starts the daemon (not usage, not the wizard)", async () => {
    captureStdio();
    let startArgs: string[] | undefined;
    let initCalled = false;
    const code = await main([], {
      runStart: async (argv) => {
        startArgs = argv;
        return 0;
      },
      runInit: async () => {
        initCalled = true;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(startArgs).toEqual([]);
    expect(initCalled).toBe(false);
    expect(stdoutChunks.join("")).not.toContain("wos [--cwd <path>] <command>");
  });

  test("init is a known command and routes to non-interactive setup", async () => {
    captureStdio();
    let called = false;
    const code = await main(["init", "--yes"], {
      runInit: async (argv) => {
        called = true;
        expect(argv).toEqual(["--yes"]);
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(called).toBe(true);
  });

  test("commands run without a pre-existing config (no gate)", async () => {
    captureStdio();
    // `start` is the only command with an injectable seam; the point is that
    // main() no longer short-circuits with a "no configuration found" gate.
    let started = false;
    const code = await main(["start"], {
      runStart: async () => {
        started = true;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(started).toBe(true);
    expect(stderrChunks.join("")).not.toContain("no configuration found");
  });

  test("usage documents the init command", async () => {
    captureStdio();
    const code = await main(["help"]);
    expect(code).toBe(0);
    expect(stdoutChunks.join("")).toContain("init");
  });

  test("unknown command returns 2", async () => {
    captureStdio();
    const code = await main(["bogus"]);
    expect(code).toBe(2);
    expect(stderrChunks.join("")).toContain("unknown command: bogus");
  });

  test("missing --cwd value returns 2 and does not dispatch", async () => {
    captureStdio();
    const code = await main(["--cwd"]);
    expect(code).toBe(2);
    expect(stderrChunks.join("")).toContain("--cwd requires a path argument");
  });

  test("exec without a service returns 2 and prints usage without daemon contact", async () => {
    captureStdio();
    const code = await main(["exec"]);
    expect(code).toBe(2);
    expect(stderrChunks.join("")).toContain("wos exec <service>");
  });

  test("worktree without subcommand prints usage and returns 0", async () => {
    captureStdio();
    const code = await main(["worktree"]);
    expect(code).toBe(0);
    expect(stdoutChunks.join("")).toContain("wos worktree <subcommand>");
    expect(stdoutChunks.join("")).toContain("remove [--force]");
  });

  test("worktree unknown subcommand returns 2", async () => {
    captureStdio();
    const code = await main(["worktree", "bogus"]);
    expect(code).toBe(2);
    expect(stderrChunks.join("")).toContain("unknown subcommand: bogus");
  });

  test("worktree remove with unknown flag returns 2", async () => {
    captureStdio();
    const code = await main(["worktree", "remove", "--bogus"]);
    expect(code).toBe(2);
    expect(stderrChunks.join("")).toContain("unknown argument: --bogus");
  });

  test("help text lists top-level start, stop, restart commands", async () => {
    captureStdio();
    const code = await main(["help"]);
    expect(code).toBe(0);
    const usage = stdoutChunks.join("");
    expect(usage).toContain("start");
    expect(usage).toContain("start --foreground");
    expect(usage).toContain("stop");
    expect(usage).toContain("restart");
  });

  test("daemon is no longer a documented top-level command", async () => {
    captureStdio();
    const code = await main(["daemon"]);
    expect(code).toBe(2);
    expect(stderrChunks.join("")).toContain("unknown command: daemon");
  });

  test("--cwd refuses 'start' as the path argument", async () => {
    captureStdio();
    const code = await main(["--cwd", "start"]);
    expect(code).toBe(2);
    expect(stderrChunks.join("")).toContain("--cwd requires a path argument");
  });

  test("--cwd refuses 'restart' as the path argument", async () => {
    captureStdio();
    const code = await main(["--cwd", "restart"]);
    expect(code).toBe(2);
    expect(stderrChunks.join("")).toContain("--cwd requires a path argument");
  });
});

describe("parseUpArgs", () => {
  test("parses comma-separated services", async () => {
    const { parseUpArgs } = await import("../apps/cli/commands/up");
    const out = parseUpArgs(["app,api"]);
    expect(out.services).toEqual(["app", "api"]);
    expect(out.target).toBeUndefined();
  });

  test("parses --target", async () => {
    const { parseUpArgs } = await import("../apps/cli/commands/up");
    const out = parseUpArgs(["--target", "app"]);
    expect(out.target).toBe("app");
    expect(out.services).toBeUndefined();
  });

  test("parses --target=value form", async () => {
    const { parseUpArgs } = await import("../apps/cli/commands/up");
    const out = parseUpArgs(["--target=app"]);
    expect(out.target).toBe("app");
  });

  test("rejects mixing --target with explicit services", async () => {
    const { parseUpArgs, UpArgsError } = await import("../apps/cli/commands/up");
    expect(() => parseUpArgs(["--target", "app", "api"])).toThrow(UpArgsError);
  });

  test("rejects unknown option", async () => {
    const { parseUpArgs, UpArgsError } = await import("../apps/cli/commands/up");
    expect(() => parseUpArgs(["--bogus"])).toThrow(UpArgsError);
  });

  test("rejects --target without value", async () => {
    const { parseUpArgs, UpArgsError } = await import("../apps/cli/commands/up");
    expect(() => parseUpArgs(["--target"])).toThrow(UpArgsError);
  });

  test("preserves force, detached, and noTunnel flags", async () => {
    const { parseUpArgs } = await import("../apps/cli/commands/up");
    const out = parseUpArgs(["--force", "-d", "--no-tunnel"]);
    expect(out.force).toBe(true);
    expect(out.detached).toBe(true);
    expect(out.noTunnel).toBe(true);
  });

  test("parses repeated --arg KEY=VALUE flags", async () => {
    const { parseUpArgs } = await import("../apps/cli/commands/up");
    const out = parseUpArgs([
      "--arg",
      "API_URL=https://empl-stage.test-wa.ru",
      "--arg",
      "FEATURE_FLAG=on",
    ]);
    expect(out.arguments).toEqual({
      API_URL: "https://empl-stage.test-wa.ru",
      FEATURE_FLAG: "on",
    });
  });

  test("parses --arg=KEY=VALUE form", async () => {
    const { parseUpArgs } = await import("../apps/cli/commands/up");
    const out = parseUpArgs(["--arg=API_URL=https://empl-stage.test-wa.ru"]);
    expect(out.arguments).toEqual({
      API_URL: "https://empl-stage.test-wa.ru",
    });
  });

  test("preserves --arg alongside -d, --force, --target", async () => {
    const { parseUpArgs } = await import("../apps/cli/commands/up");
    const out = parseUpArgs([
      "-d",
      "--force",
      "--target",
      "lk-zup",
      "--arg",
      "API_URL=https://empl-stage.test-wa.ru",
    ]);
    expect(out.detached).toBe(true);
    expect(out.force).toBe(true);
    expect(out.target).toBe("lk-zup");
    expect(out.arguments).toEqual({
      API_URL: "https://empl-stage.test-wa.ru",
    });
  });

  test("preserves --arg alongside positional services", async () => {
    const { parseUpArgs } = await import("../apps/cli/commands/up");
    const out = parseUpArgs([
      "api,web",
      "--arg",
      "API_URL=https://empl-stage.test-wa.ru",
    ]);
    expect(out.services).toEqual(["api", "web"]);
    expect(out.arguments).toEqual({
      API_URL: "https://empl-stage.test-wa.ru",
    });
  });

  test("rejects --arg without value", async () => {
    const { parseUpArgs, UpArgsError } = await import("../apps/cli/commands/up");
    expect(() => parseUpArgs(["--arg"])).toThrow(UpArgsError);
  });

  test("rejects --arg without KEY=VALUE form", async () => {
    const { parseUpArgs, UpArgsError } = await import("../apps/cli/commands/up");
    expect(() => parseUpArgs(["--arg", "API_URL"])).toThrow(UpArgsError);
  });

  test("rejects --arg with empty key", async () => {
    const { parseUpArgs, UpArgsError } = await import("../apps/cli/commands/up");
    expect(() => parseUpArgs(["--arg", "=value"])).toThrow(UpArgsError);
  });

  test("rejects duplicate --arg key", async () => {
    const { parseUpArgs, UpArgsError } = await import("../apps/cli/commands/up");
    expect(() =>
      parseUpArgs([
        "--arg",
        "API_URL=a",
        "--arg",
        "API_URL=b",
      ]),
    ).toThrow(UpArgsError);
  });

  test("arguments is undefined when no --arg flag is passed", async () => {
    const { parseUpArgs } = await import("../apps/cli/commands/up");
    const out = parseUpArgs(["--force"]);
    expect(out.arguments).toBeUndefined();
  });
});

describe("parseWorktreeRemoveArgs", () => {
  test("returns force=false by default", () => {
    const out = parseWorktreeRemoveArgs([]);
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    expect(out.force).toBe(false);
  });

  test("recognizes --force flag", () => {
    const out = parseWorktreeRemoveArgs(["--force"]);
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    expect(out.force).toBe(true);
  });

  test("rejects unknown arguments", () => {
    const out = parseWorktreeRemoveArgs(["--bogus"]);
    expect("error" in out).toBe(true);
  });
});
