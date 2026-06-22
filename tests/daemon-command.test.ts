import { test, expect, describe } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  parseStartArgs,
  runStartForeground,
  runStartBackground,
  runStop,
  runRestart,
  runStart,
} from "../apps/cli/commands/start";
import { DEFAULT_WEB_HOST, DEFAULT_WEB_PORT } from "@worktreeos/core/global-config";

describe("parseStartArgs", () => {
  test("no args returns background mode", () => {
    expect(parseStartArgs([])).toEqual({ mode: "background" });
  });

  test("--foreground returns foreground mode", () => {
    expect(parseStartArgs(["--foreground"])).toEqual({ mode: "foreground" });
  });

  test("unknown args return unknown mode", () => {
    expect(parseStartArgs(["restart"])).toEqual({ mode: "unknown" });
    expect(parseStartArgs(["--foreground", "extra"])).toEqual({ mode: "unknown" });
    expect(parseStartArgs(["--bogus"])).toEqual({ mode: "unknown" });
  });
});

describe("runStart with unknown args", () => {
  test("returns 2 and prints usage hint", async () => {
    const chunks: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((s: string) => {
      chunks.push(s);
      return true;
    }) as any;
    try {
      const code = await runStart(["bogus"]);
      expect(code).toBe(2);
      expect(chunks.join("")).toContain("wos start");
      expect(chunks.join("")).toContain("--foreground");
    } finally {
      process.stderr.write = origWrite;
    }
  });
});

describe("runStartForeground reads global config", () => {
  test("passes default port 4949 when config file is absent", async () => {
    const home = await mkdtemp(join(tmpdir(), "wos-fg-cfg-"));
    const origHome = process.env.WOS_HOME;
    process.env.WOS_HOME = home;
    let captured: any;
    try {
      await runStartForeground({
        startDaemonFn: (async (o: any) => {
          captured = o;
          return { webUrl: "http://127.0.0.1:0", stop: async () => {} } as any;
        }) as any,
      });
    } finally {
      if (origHome === undefined) delete process.env.WOS_HOME;
      else process.env.WOS_HOME = origHome;
    }
    expect(captured.web).toEqual({ port: DEFAULT_WEB_PORT, host: DEFAULT_WEB_HOST });
  });

  test("passes overridden port from ~/.wos/config.json", async () => {
    const home = await mkdtemp(join(tmpdir(), "wos-fg-cfg-"));
    await writeFile(resolve(home, "config.json"), JSON.stringify({ web: { port: 5757 } }));
    const origHome = process.env.WOS_HOME;
    process.env.WOS_HOME = home;
    let captured: any;
    try {
      await runStartForeground({
        startDaemonFn: (async (o: any) => {
          captured = o;
          return { webUrl: "http://127.0.0.1:0", stop: async () => {} } as any;
        }) as any,
      });
    } finally {
      if (origHome === undefined) delete process.env.WOS_HOME;
      else process.env.WOS_HOME = origHome;
    }
    expect(captured.web).toEqual({ port: 5757, host: DEFAULT_WEB_HOST });
  });

  test("passes overridden web.host from ~/.wos/config.json", async () => {
    const home = await mkdtemp(join(tmpdir(), "wos-fg-cfg-"));
    await writeFile(
      resolve(home, "config.json"),
      JSON.stringify({ web: { host: "192.168.1.18" } }),
    );
    const origHome = process.env.WOS_HOME;
    process.env.WOS_HOME = home;
    let captured: any;
    try {
      await runStartForeground({
        startDaemonFn: (async (o: any) => {
          captured = o;
          return { webUrl: "http://127.0.0.1:0", stop: async () => {} } as any;
        }) as any,
      });
    } finally {
      if (origHome === undefined) delete process.env.WOS_HOME;
      else process.env.WOS_HOME = origHome;
    }
    expect(captured.web).toEqual({ port: DEFAULT_WEB_PORT, host: "192.168.1.18" });
  });
});

describe("daemon lifecycle commands are worktree-independent", () => {
  test("runStartBackground does not require a git worktree", async () => {
    const home = await mkdtemp(join(tmpdir(), "wos-start-wt-"));
    const chunks: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((s: string) => {
      chunks.push(s);
      return true;
    }) as any;
    try {
      const code = await runStartBackground({
        metadataPath: resolve(home, "daemon.json"),
        startupTimeoutMs: 300,
        healthTimeoutMs: 100,
        spawn: () => ({ exited: Promise.resolve(0), pid: 1 }),
      });
      const output = chunks.join("");
      expect(output).not.toContain("not inside a git worktree");
      expect(output).not.toContain("deploy config");
      expect(code).toBe(1);
      expect(output).toContain("wos start failed");
    } finally {
      process.stderr.write = origWrite;
    }
  });

  test("runStop does not require a git worktree and exits 0 when nothing runs", async () => {
    const home = await mkdtemp(join(tmpdir(), "wos-stop-wt-"));
    const chunks: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((s: string) => {
      chunks.push(s);
      return true;
    }) as any;
    try {
      const code = await runStop({
        metadataPath: resolve(home, "daemon.json"),
        healthTimeoutMs: 100,
      });
      const output = chunks.join("");
      expect(output).not.toContain("not inside a git worktree");
      expect(output).not.toContain("deploy config");
      expect(code).toBe(0);
      expect(output).toContain("no daemon was running");
    } finally {
      process.stderr.write = origWrite;
    }
  });

  test("runRestart does not require a git worktree", async () => {
    const home = await mkdtemp(join(tmpdir(), "wos-restart-wt-"));
    const chunks: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((s: string) => {
      chunks.push(s);
      return true;
    }) as any;
    try {
      const code = await runRestart({
        metadataPath: resolve(home, "daemon.json"),
        startupTimeoutMs: 300,
        healthTimeoutMs: 100,
        spawn: () => ({ exited: Promise.resolve(0), pid: 1 }),
      });
      const output = chunks.join("");
      expect(output).toContain("restarting");
      expect(output).not.toContain("not inside a git worktree");
      expect(output).not.toContain("deploy config");
      expect(code).toBe(1);
    } finally {
      process.stderr.write = origWrite;
    }
  });
});
