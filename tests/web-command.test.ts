import { test, expect, describe, beforeEach } from "bun:test";
import { parseWebArgs, runWeb } from "../apps/cli/commands/web";
import type { DaemonBootstrap } from "@worktreeos/daemon/daemon-bootstrap";

let stdout: string[];
let stderr: string[];

const fakeBootstrap = (baseUrl = "http://127.0.0.1:4949"): DaemonBootstrap =>
  ({
    ensureRunning: async () => ({ baseUrl, health: { ok: true, version: "1" } }),
  }) as unknown as DaemonBootstrap;

beforeEach(() => {
  stdout = [];
  stderr = [];
});

describe("parseWebArgs", () => {
  test("defaults to open=true", () => {
    expect(parseWebArgs([])).toEqual({ open: true });
  });

  test("--no-open disables launcher", () => {
    expect(parseWebArgs(["--no-open"])).toEqual({ open: false });
  });

  test("--help returns help signal", () => {
    expect(parseWebArgs(["--help"])).toEqual({ error: "help" });
  });

  test("rejects unknown flags", () => {
    expect(parseWebArgs(["--bogus"])).toEqual({ error: "unknown argument: --bogus" });
  });
});

describe("runWeb", () => {
  test("prints URL and calls launcher for a healthy daemon", async () => {
    let launched: string | null = null;
    const code = await runWeb([], {
      bootstrap: fakeBootstrap(),
      launcher: async (url) => {
        launched = url;
        return { ok: true };
      },
      stdoutWrite: (s) => stdout.push(s),
      stderrWrite: (s) => stderr.push(s),
    });
    expect(code).toBe(0);
    expect(stdout.join("")).toBe("http://127.0.0.1:4949\n");
    expect(launched).toBe("http://127.0.0.1:4949");
    expect(stderr).toEqual([]);
  });

  test("--no-open prints URL but does not call launcher", async () => {
    let launched = false;
    const code = await runWeb(["--no-open"], {
      bootstrap: fakeBootstrap(),
      launcher: async () => {
        launched = true;
        return { ok: true };
      },
      stdoutWrite: (s) => stdout.push(s),
      stderrWrite: (s) => stderr.push(s),
    });
    expect(code).toBe(0);
    expect(stdout.join("")).toBe("http://127.0.0.1:4949\n");
    expect(launched).toBe(false);
  });

  test("prints HTTPS URL when the daemon reports https://", async () => {
    let launched: string | null = null;
    const code = await runWeb([], {
      bootstrap: fakeBootstrap("https://127.0.0.1:4949"),
      launcher: async (url) => {
        launched = url;
        return { ok: true };
      },
      stdoutWrite: (s) => stdout.push(s),
      stderrWrite: (s) => stderr.push(s),
    });
    expect(code).toBe(0);
    expect(stdout.join("")).toBe("https://127.0.0.1:4949\n");
    expect(launched).toBe("https://127.0.0.1:4949");
  });

  test("exits 0 with warning when launcher fails", async () => {
    const code = await runWeb([], {
      bootstrap: fakeBootstrap(),
      launcher: async () => ({ ok: false, message: "command not found" }),
      stdoutWrite: (s) => stdout.push(s),
      stderrWrite: (s) => stderr.push(s),
    });
    expect(code).toBe(0);
    expect(stdout.join("")).toBe("http://127.0.0.1:4949\n");
    expect(stderr.join("")).toContain("could not open browser");
    expect(stderr.join("")).toContain("command not found");
  });

  test("exits 2 on unknown argument", async () => {
    const code = await runWeb(["--bogus"], {
      bootstrap: fakeBootstrap(),
      stdoutWrite: (s) => stdout.push(s),
      stderrWrite: (s) => stderr.push(s),
    });
    expect(code).toBe(2);
    expect(stderr.join("")).toContain("unknown argument: --bogus");
    expect(stderr.join("")).toContain("wos web");
  });

  test("exits 0 on --help and prints usage", async () => {
    const code = await runWeb(["--help"], {
      bootstrap: fakeBootstrap(),
      stdoutWrite: (s) => stdout.push(s),
      stderrWrite: (s) => stderr.push(s),
    });
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("wos web");
    expect(stdout.join("")).toContain("--no-open");
  });

  test("exits 1 when ensureDaemon throws", async () => {
    const failing = {
      ensureRunning: async () => {
        throw new Error("nope");
      },
    } as unknown as DaemonBootstrap;
    const code = await runWeb([], {
      bootstrap: failing,
      stdoutWrite: (s) => stdout.push(s),
      stderrWrite: (s) => stderr.push(s),
    });
    expect(code).toBe(1);
    expect(stderr.join("")).toContain("nope");
  });
});
