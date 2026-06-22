import { test, expect, describe } from "bun:test";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  SetupError,
  copyVolume,
  firstRunSetup,
  forceRemoveCloneVolumes,
  runContainerInit,
  type CacheRunner,
  type CacheSaver,
  type InitRunner,
} from "@worktreeos/runtime/setup";
import { cloneVolume, type CacheEntryConfig } from "@worktreeos/core/config";
import type { DockerRunner, StreamingDockerRunner } from "@worktreeos/compose/compose";
import { INIT_SERVICE_NAME } from "@worktreeos/compose/generated-compose";
import type { DeploymentEvent, DeploymentObserver } from "@worktreeos/core/events";

async function makeTmp(): Promise<string> {
  return await mkdtemp(resolve(tmpdir(), "wos-setup-"));
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("copyVolume", () => {
  test("copies a file from source to destination", async () => {
    const root = await makeTmp();
    try {
      const src = resolve(root, "src");
      const dst = resolve(root, "dst");
      await mkdir(src);
      await mkdir(dst);
      await writeFile(resolve(src, ".env.local"), "FOO=bar");
      await copyVolume(src, dst, cloneVolume(".env.local"));
      expect(await Bun.file(resolve(dst, ".env.local")).text()).toBe("FOO=bar");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("copies a directory recursively", async () => {
    const root = await makeTmp();
    try {
      const src = resolve(root, "src");
      const dst = resolve(root, "dst");
      await mkdir(resolve(src, ".data", "inner"), { recursive: true });
      await mkdir(dst);
      await writeFile(resolve(src, ".data", "a.txt"), "a");
      await writeFile(resolve(src, ".data", "inner", "b.txt"), "b");
      await copyVolume(src, dst, cloneVolume(".data"));
      expect(await Bun.file(resolve(dst, ".data", "a.txt")).text()).toBe("a");
      expect(await Bun.file(resolve(dst, ".data", "inner", "b.txt")).text()).toBe("b");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails when source is missing", async () => {
    const root = await makeTmp();
    try {
      const src = resolve(root, "src");
      const dst = resolve(root, "dst");
      await mkdir(src);
      await mkdir(dst);
      await expect(copyVolume(src, dst, cloneVolume(".data"))).rejects.toThrow(SetupError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("skips when destination already exists and preserves its content", async () => {
    const root = await makeTmp();
    try {
      const src = resolve(root, "src");
      const dst = resolve(root, "dst");
      await mkdir(src);
      await mkdir(dst);
      await writeFile(resolve(src, "x"), "1");
      await writeFile(resolve(dst, "x"), "2");
      const result = await copyVolume(src, dst, cloneVolume("x"));
      expect(result).toEqual({ status: "skipped", reason: "destination-exists" });
      expect(await Bun.file(resolve(dst, "x")).text()).toBe("2");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("no-ops when source equals destination", async () => {
    const root = await makeTmp();
    try {
      await writeFile(resolve(root, "x"), "v");
      await copyVolume(root, root, cloneVolume("x"));
      expect(await Bun.file(resolve(root, "x")).text()).toBe("v");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("forceRemoveCloneVolumes", () => {
  test("removes a file destination", async () => {
    const root = await makeTmp();
    try {
      await writeFile(resolve(root, ".env.local"), "X=1");
      await forceRemoveCloneVolumes(root, [cloneVolume(".env.local")]);
      expect(await pathExists(resolve(root, ".env.local"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes a directory destination recursively", async () => {
    const root = await makeTmp();
    try {
      await mkdir(resolve(root, ".data", "inner"), { recursive: true });
      await writeFile(resolve(root, ".data", "a.txt"), "a");
      await writeFile(resolve(root, ".data", "inner", "b.txt"), "b");
      await forceRemoveCloneVolumes(root, [cloneVolume(".data")]);
      expect(await pathExists(resolve(root, ".data"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("treats missing destinations as a no-op", async () => {
    const root = await makeTmp();
    try {
      await forceRemoveCloneVolumes(root, [cloneVolume(".missing"), cloneVolume("also-missing/dir")]);
      expect(await pathExists(root)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes multiple configured destinations", async () => {
    const root = await makeTmp();
    try {
      await writeFile(resolve(root, ".env.local"), "x");
      await mkdir(resolve(root, ".data"));
      await writeFile(resolve(root, ".data", "f"), "y");
      await forceRemoveCloneVolumes(root, [cloneVolume(".env.local"), cloneVolume(".data")]);
      expect(await pathExists(resolve(root, ".env.local"))).toBe(false);
      expect(await pathExists(resolve(root, ".data"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("allows entries that resolve outside the current worktree", async () => {
    const root = await makeTmp();
    try {
      await forceRemoveCloneVolumes(root, [cloneVolume("../escape")]);
      expect(await pathExists(root)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects entries that resolve to the worktree root itself", async () => {
    const root = await makeTmp();
    try {
      await expect(forceRemoveCloneVolumes(root, [cloneVolume(".")])).rejects.toThrow(
        SetupError,
      );
      expect(await pathExists(root)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("runContainerInit", () => {
  test("invokes docker compose run --rm with joined commands and entrypoint sh", async () => {
    let observed: string[] = [];
    const runner: DockerRunner = async (args) => {
      observed = args;
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    await runContainerInit({
      composeContext: { projectName: "p", composeFile: "/c.yaml" },
      commands: ["bun install", "bun run db:migrate"],
      runner,
    });
    expect(observed).toEqual([
      "compose",
      "-p",
      "p",
      "-f",
      "/c.yaml",
      "run",
      "--rm",
      "--entrypoint",
      "sh",
      INIT_SERVICE_NAME,
      "-lc",
      "(bun install) && (bun run db:migrate)",
    ]);
  });

  test("wraps a single command in its own subshell", async () => {
    let observed: string[] = [];
    const runner: DockerRunner = async (args) => {
      observed = args;
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    await runContainerInit({
      composeContext: { projectName: "p", composeFile: "/c.yaml" },
      commands: ["bun install"],
      runner,
    });
    expect(observed[observed.length - 1]).toBe("(bun install)");
  });

  test("isolates cd between commands so cwd does not leak", async () => {
    let observed: string[] = [];
    const runner: DockerRunner = async (args) => {
      observed = args;
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    await runContainerInit({
      composeContext: { projectName: "p", composeFile: "/c.yaml" },
      commands: ["cd packages/api && yarn", "cd packages/app && yarn"],
      runner,
    });
    expect(observed[observed.length - 1]).toBe(
      "(cd packages/api && yarn) && (cd packages/app && yarn)",
    );
  });

  test("skips invocation when commands are empty", async () => {
    let called = false;
    const runner: DockerRunner = async () => {
      called = true;
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    await runContainerInit({
      composeContext: { projectName: "p", composeFile: "/c.yaml" },
      commands: [],
      runner,
    });
    expect(called).toBe(false);
  });

  test("preserves configured command order", async () => {
    let observed: string[] = [];
    const runner: DockerRunner = async (args) => {
      observed = args;
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    await runContainerInit({
      composeContext: { projectName: "p", composeFile: "/c.yaml" },
      commands: ["one", "two", "three"],
      runner,
    });
    expect(observed[observed.length - 1]).toBe("(one) && (two) && (three)");
  });

  test("raises SetupError on non-zero exit", async () => {
    const runner: DockerRunner = async () => ({ stdout: "", stderr: "boom", exitCode: 7 });
    await expect(
      runContainerInit({
        composeContext: { projectName: "p", composeFile: "/c.yaml" },
        commands: ["bun install"],
        runner,
      }),
    ).rejects.toThrow(SetupError);
  });

  test("streams stdout into the init log channel when observer is provided", async () => {
    const events: DeploymentEvent[] = [];
    const observer: DeploymentObserver = { emit: (e) => events.push(e) };
    const bufferedRunner: DockerRunner = async () => {
      throw new Error("buffered runner must not be used when streaming is wired");
    };
    const streamingRunner: StreamingDockerRunner = async (_args, sinks) => {
      sinks.onStdout?.("installing deps...\n");
      sinks.onStdout?.("done\n");
      return { exitCode: 0, stderr: "" };
    };
    await runContainerInit({
      composeContext: { projectName: "p", composeFile: "/c.yaml" },
      commands: ["bun install"],
      runner: bufferedRunner,
      streamingRunner,
      observer,
    });
    const logs = events.filter(
      (e) => e.type === "log" && e.channel === "init" && e.stream === "stdout",
    );
    expect(logs.length).toBe(2);
    expect(logs[0]).toMatchObject({
      type: "log",
      channel: "init",
      stream: "stdout",
      chunk: "installing deps...\n",
    });
  });

  test("streams stderr into the init log channel when observer is provided", async () => {
    const events: DeploymentEvent[] = [];
    const observer: DeploymentObserver = { emit: (e) => events.push(e) };
    const streamingRunner: StreamingDockerRunner = async (_args, sinks) => {
      sinks.onStderr?.("warn: something\n");
      return { exitCode: 0, stderr: "warn: something\n" };
    };
    await runContainerInit({
      composeContext: { projectName: "p", composeFile: "/c.yaml" },
      commands: ["bun install"],
      runner: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      streamingRunner,
      observer,
    });
    const stderrLogs = events.filter(
      (e) => e.type === "log" && e.channel === "init" && e.stream === "stderr",
    );
    expect(stderrLogs.length).toBe(1);
    expect(stderrLogs[0]).toMatchObject({
      type: "log",
      channel: "init",
      stream: "stderr",
      chunk: "warn: something\n",
    });
  });

  test("failed init under streaming surfaces SetupError so worktree stays uninitialized", async () => {
    const events: DeploymentEvent[] = [];
    const observer: DeploymentObserver = { emit: (e) => events.push(e) };
    const streamingRunner: StreamingDockerRunner = async (_args, sinks) => {
      sinks.onStdout?.("starting...\n");
      sinks.onStderr?.("fatal: nope\n");
      return { exitCode: 2, stderr: "fatal: nope\n" };
    };
    await expect(
      runContainerInit({
        composeContext: { projectName: "p", composeFile: "/c.yaml" },
        commands: ["bun install"],
        runner: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        streamingRunner,
        observer,
      }),
    ).rejects.toThrow(SetupError);
    const initLogs = events.filter((e) => e.type === "log" && e.channel === "init");
    expect(initLogs.length).toBe(2);
  });
});

describe("firstRunSetup", () => {
  test("copies clone volumes then runs container init", async () => {
    const root = await makeTmp();
    try {
      const src = resolve(root, "src");
      const dst = resolve(root, "dst");
      await mkdir(src);
      await mkdir(dst);
      await writeFile(resolve(src, ".env.local"), "X=1");
      const seen: string[][] = [];
      const runInit: InitRunner = async (commands) => {
        seen.push(commands);
      };
      await firstRunSetup({
        sourceRoot: src,
        currentRoot: dst,
        cloneVolumes: [cloneVolume(".env.local")],
        initScript: ["one", "two"],
        runInit,
      });
      expect(await pathExists(resolve(dst, ".env.local"))).toBe(true);
      expect(seen).toEqual([["one", "two"]]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not run container init when a copy fails", async () => {
    const root = await makeTmp();
    try {
      const src = resolve(root, "src");
      const dst = resolve(root, "dst");
      await mkdir(src);
      await mkdir(dst);
      const runInit: InitRunner = async () => {
        throw new Error("must not be called");
      };
      await expect(
        firstRunSetup({
          sourceRoot: src,
          currentRoot: dst,
          cloneVolumes: [cloneVolume(".missing")],
          initScript: ["one"],
          runInit,
        }),
      ).rejects.toThrow(SetupError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("skips container init when init script is empty", async () => {
    const root = await makeTmp();
    try {
      const src = resolve(root, "src");
      const dst = resolve(root, "dst");
      await mkdir(src);
      await mkdir(dst);
      let called = false;
      const runInit: InitRunner = async () => {
        called = true;
      };
      await firstRunSetup({
        sourceRoot: src,
        currentRoot: dst,
        cloneVolumes: [],
        initScript: [],
        runInit,
      });
      expect(called).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("emits paired volume-clone start/complete events for each volume", async () => {
    const root = await makeTmp();
    try {
      const src = resolve(root, "src");
      const dst = resolve(root, "dst");
      await mkdir(src);
      await mkdir(dst);
      await writeFile(resolve(src, ".env.local"), "X=1");
      await mkdir(resolve(src, ".data"));
      await writeFile(resolve(src, ".data", "f"), "y");
      const events: DeploymentEvent[] = [];
      const observer: DeploymentObserver = { emit: (e) => events.push(e) };
      const runInit: InitRunner = async () => {};
      await firstRunSetup({
        sourceRoot: src,
        currentRoot: dst,
        cloneVolumes: [cloneVolume(".env.local"), cloneVolume(".data")],
        initScript: [],
        runInit,
        observer,
      });
      const volumeEvents = events.filter((e) => e.type === "volume-clone");
      expect(volumeEvents).toEqual([
        { type: "volume-clone", phase: "start", path: ".env.local", index: 1, total: 2 },
        { type: "volume-clone", phase: "complete", path: ".env.local", index: 1, total: 2 },
        { type: "volume-clone", phase: "start", path: ".data", index: 2, total: 2 },
        { type: "volume-clone", phase: "complete", path: ".data", index: 2, total: 2 },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("emits a stderr warning and continues when a clone volume already exists in the worktree", async () => {
    const root = await makeTmp();
    try {
      const src = resolve(root, "src");
      const dst = resolve(root, "dst");
      await mkdir(src);
      await mkdir(dst);
      await writeFile(resolve(src, ".env.local"), "X=1");
      await writeFile(resolve(dst, ".env.local"), "OLD=keep");
      const events: DeploymentEvent[] = [];
      const observer: DeploymentObserver = { emit: (e) => events.push(e) };
      let initCalls = 0;
      const runInit: InitRunner = async () => {
        initCalls += 1;
      };
      await firstRunSetup({
        sourceRoot: src,
        currentRoot: dst,
        cloneVolumes: [cloneVolume(".env.local")],
        initScript: ["one"],
        runInit,
        observer,
      });
      expect(await Bun.file(resolve(dst, ".env.local")).text()).toBe("OLD=keep");
      const warnings = events.filter(
        (e) =>
          e.type === "log" &&
          e.channel === "deployment" &&
          e.stream === "stderr" &&
          e.chunk.includes("[warn]") &&
          e.chunk.includes(".env.local"),
      );
      expect(warnings.length).toBe(1);
      expect(initCalls).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("restores cache entries after clone_volumes and before init script", async () => {
    const root = await makeTmp();
    try {
      const src = resolve(root, "src");
      const dst = resolve(root, "dst");
      await mkdir(src);
      await mkdir(dst);
      await writeFile(resolve(src, ".env.local"), "X=1");
      const cacheEntry: CacheEntryConfig = {
        key: { kind: "literal", literal: "v1" },
        paths: ["node_modules"],
      };
      const order: string[] = [];
      const restoreCache: CacheRunner = async (entry) => {
        expect(entry).toEqual(cacheEntry);
        order.push("restore");
        return { status: "miss" };
      };
      const runInit: InitRunner = async () => {
        order.push("init");
      };
      const saveCache: CacheSaver = async () => {
        order.push("save");
      };
      await firstRunSetup({
        sourceRoot: src,
        currentRoot: dst,
        cloneVolumes: [cloneVolume(".env.local")],
        initScript: ["bun install"],
        cacheEntries: [cacheEntry],
        restoreCache,
        saveCache,
        runInit,
      });
      expect(order).toEqual(["restore", "init", "save"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not save cache entries when init script fails", async () => {
    const root = await makeTmp();
    try {
      const src = resolve(root, "src");
      const dst = resolve(root, "dst");
      await mkdir(src);
      await mkdir(dst);
      const cacheEntry: CacheEntryConfig = {
        key: { kind: "literal", literal: "v1" },
        paths: ["node_modules"],
      };
      let saved = 0;
      const restoreCache: CacheRunner = async () => ({ status: "miss" });
      const saveCache: CacheSaver = async () => {
        saved += 1;
      };
      const runInit: InitRunner = async () => {
        throw new SetupError("init exploded");
      };
      await expect(
        firstRunSetup({
          sourceRoot: src,
          currentRoot: dst,
          cloneVolumes: [],
          initScript: ["bun install"],
          cacheEntries: [cacheEntry],
          restoreCache,
          saveCache,
          runInit,
        }),
      ).rejects.toThrow(SetupError);
      expect(saved).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("saves cache entries only after init script succeeds", async () => {
    const root = await makeTmp();
    try {
      const src = resolve(root, "src");
      const dst = resolve(root, "dst");
      await mkdir(src);
      await mkdir(dst);
      const cacheEntries: CacheEntryConfig[] = [
        { key: { kind: "literal", literal: "a" }, paths: ["node_modules"] },
        { key: { kind: "literal", literal: "b" }, paths: ["vendor"] },
      ];
      const saved: CacheEntryConfig[] = [];
      const restoreCache: CacheRunner = async () => ({ status: "hit" });
      const saveCache: CacheSaver = async (entry) => {
        saved.push(entry);
      };
      const runInit: InitRunner = async () => {};
      await firstRunSetup({
        sourceRoot: src,
        currentRoot: dst,
        cloneVolumes: [],
        initScript: ["bun install"],
        cacheEntries,
        restoreCache,
        saveCache,
        runInit,
      });
      expect(saved).toEqual(cacheEntries);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("restores and saves wildcard cache entries around init script", async () => {
    const root = await makeTmp();
    try {
      const src = resolve(root, "src");
      const dst = resolve(root, "dst");
      await mkdir(src);
      await mkdir(dst);
      const cacheEntry: CacheEntryConfig = {
        key: { kind: "literal", literal: "mono-v1" },
        paths: ["packages/*/node_modules"],
      };
      const restoredEntries: CacheEntryConfig[] = [];
      const savedEntries: CacheEntryConfig[] = [];
      const order: string[] = [];
      const restoreCache: CacheRunner = async (entry) => {
        restoredEntries.push(entry);
        order.push("restore");
        return { status: "miss" };
      };
      const saveCache: CacheSaver = async (entry) => {
        savedEntries.push(entry);
        order.push("save");
      };
      const runInit: InitRunner = async () => {
        order.push("init");
      };
      await firstRunSetup({
        sourceRoot: src,
        currentRoot: dst,
        cloneVolumes: [],
        initScript: ["bun install"],
        cacheEntries: [cacheEntry],
        restoreCache,
        saveCache,
        runInit,
      });
      expect(order).toEqual(["restore", "init", "save"]);
      expect(restoredEntries).toEqual([cacheEntry]);
      expect(savedEntries).toEqual([cacheEntry]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("skips cache restore and save when no entries are configured", async () => {
    const root = await makeTmp();
    try {
      const src = resolve(root, "src");
      const dst = resolve(root, "dst");
      await mkdir(src);
      await mkdir(dst);
      let restored = 0;
      let saved = 0;
      const restoreCache: CacheRunner = async () => {
        restored += 1;
        return { status: "miss" };
      };
      const saveCache: CacheSaver = async () => {
        saved += 1;
      };
      await firstRunSetup({
        sourceRoot: src,
        currentRoot: dst,
        cloneVolumes: [],
        initScript: [],
        cacheEntries: [],
        restoreCache,
        saveCache,
        runInit: async () => {},
      });
      expect(restored).toBe(0);
      expect(saved).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("emits volume-clone complete even when copy fails so spinners stop", async () => {
    const root = await makeTmp();
    try {
      const src = resolve(root, "src");
      const dst = resolve(root, "dst");
      await mkdir(src);
      await mkdir(dst);
      const events: DeploymentEvent[] = [];
      const observer: DeploymentObserver = { emit: (e) => events.push(e) };
      const runInit: InitRunner = async () => {};
      await expect(
        firstRunSetup({
          sourceRoot: src,
          currentRoot: dst,
          cloneVolumes: [cloneVolume(".missing")],
          initScript: [],
          runInit,
          observer,
        }),
      ).rejects.toThrow(SetupError);
      const volumeEvents = events.filter((e) => e.type === "volume-clone");
      expect(volumeEvents).toEqual([
        { type: "volume-clone", phase: "start", path: ".missing", index: 1, total: 1 },
        { type: "volume-clone", phase: "complete", path: ".missing", index: 1, total: 1 },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("copies mapped entry to renamed destination", async () => {
    const root = await makeTmp();
    try {
      const src = resolve(root, "src");
      const dst = resolve(root, "dst");
      await mkdir(src);
      await mkdir(dst);
      await writeFile(resolve(src, ".env.local"), "SECRET=42");
      const runInit: InitRunner = async () => {};
      await firstRunSetup({
        sourceRoot: src,
        currentRoot: dst,
        cloneVolumes: [cloneVolume(".env.local", ".env")],
        initScript: [],
        runInit,
      });
      expect(await Bun.file(resolve(dst, ".env")).text()).toBe("SECRET=42");
      expect(await pathExists(resolve(dst, ".env.local"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("copies from absolute source path", async () => {
    const root = await makeTmp();
    try {
      const absSource = resolve(root, "abs-src");
      const dst = resolve(root, "dst");
      await mkdir(absSource);
      await mkdir(dst);
      await writeFile(resolve(absSource, "shared.key"), "key-data");
      const entry = cloneVolume(resolve(absSource, "shared.key"), "shared.key");
      const runInit: InitRunner = async () => {};
      await firstRunSetup({
        sourceRoot: resolve(root, "unused-src"),
        currentRoot: dst,
        cloneVolumes: [entry],
        initScript: [],
        runInit,
      });
      expect(await Bun.file(resolve(dst, "shared.key")).text()).toBe("key-data");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("copies to absolute destination path outside current worktree", async () => {
    const root = await makeTmp();
    try {
      const src = resolve(root, "src");
      const dst = resolve(root, "dst");
      const outside = resolve(root, "outside");
      await mkdir(src);
      await mkdir(dst);
      await writeFile(resolve(src, "config.yaml"), "setting: 1");
      const absDest = resolve(outside, "config.yaml");
      const entry = cloneVolume("config.yaml", absDest);
      const runInit: InitRunner = async () => {};
      await firstRunSetup({
        sourceRoot: src,
        currentRoot: dst,
        cloneVolumes: [entry],
        initScript: [],
        runInit,
      });
      expect(await Bun.file(absDest).text()).toBe("setting: 1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("emits display text for mapped clone-volume entries", async () => {
    const root = await makeTmp();
    try {
      const src = resolve(root, "src");
      const dst = resolve(root, "dst");
      await mkdir(src);
      await mkdir(dst);
      await writeFile(resolve(src, ".env.local"), "X=1");
      const events: DeploymentEvent[] = [];
      const observer: DeploymentObserver = { emit: (e) => events.push(e) };
      const runInit: InitRunner = async () => {};
      await firstRunSetup({
        sourceRoot: src,
        currentRoot: dst,
        cloneVolumes: [cloneVolume(".env.local", ".env")],
        initScript: [],
        runInit,
        observer,
      });
      const volumeEvents = events.filter((e) => e.type === "volume-clone");
      expect(volumeEvents).toEqual([
        { type: "volume-clone", phase: "start", path: ".env.local:.env", index: 1, total: 1 },
        { type: "volume-clone", phase: "complete", path: ".env.local:.env", index: 1, total: 1 },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("emits display text in warning for mapped entry that already exists", async () => {
    const root = await makeTmp();
    try {
      const src = resolve(root, "src");
      const dst = resolve(root, "dst");
      await mkdir(src);
      await mkdir(dst);
      await writeFile(resolve(src, ".env.local"), "NEW=1");
      await writeFile(resolve(dst, ".env"), "OLD=keep");
      const events: DeploymentEvent[] = [];
      const observer: DeploymentObserver = { emit: (e) => events.push(e) };
      const runInit: InitRunner = async () => {};
      await firstRunSetup({
        sourceRoot: src,
        currentRoot: dst,
        cloneVolumes: [cloneVolume(".env.local", ".env")],
        initScript: [],
        runInit,
        observer,
      });
      expect(await Bun.file(resolve(dst, ".env")).text()).toBe("OLD=keep");
      const warnings = events.filter(
        (e) =>
          e.type === "log" &&
          e.channel === "deployment" &&
          e.stream === "stderr" &&
          e.chunk.includes("[warn]") &&
          e.chunk.includes(".env.local:.env"),
      );
      expect(warnings.length).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("forceRemoveCloneVolumes with mapped entries", () => {
  test("removes mapped destination before copy", async () => {
    const root = await makeTmp();
    try {
      await writeFile(resolve(root, ".env"), "old-value");
      await forceRemoveCloneVolumes(root, [cloneVolume(".env.local", ".env")]);
      expect(await pathExists(resolve(root, ".env"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes absolute destination outside worktree", async () => {
    const root = await makeTmp();
    try {
      const outside = resolve(root, "outside");
      await mkdir(outside);
      const absDest = resolve(outside, "config.yaml");
      await writeFile(absDest, "old");
      await forceRemoveCloneVolumes(root, [cloneVolume("config.yaml", absDest)]);
      expect(await pathExists(absDest)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects destination that resolves to filesystem root", async () => {
    const root = await makeTmp();
    try {
      await expect(
        forceRemoveCloneVolumes(root, [cloneVolume("src", "/")]),
      ).rejects.toThrow(SetupError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects destination that resolves to current worktree root", async () => {
    const root = await makeTmp();
    try {
      await expect(
        forceRemoveCloneVolumes(root, [cloneVolume("src", root)]),
      ).rejects.toThrow(SetupError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
