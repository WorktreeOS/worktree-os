import { test, expect, describe } from "bun:test";
import {
  followableServices,
  serviceChannel,
  startServiceFollowers,
  stopServiceFollowers,
  type ProcessHandle,
  type SpawnFn,
} from "@worktreeos/runtime/service-logs";
import type { DeploymentEvent, DeploymentObserver } from "@worktreeos/core/events";
import { INIT_SERVICE_NAME } from "@worktreeos/compose/generated-compose";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

function fakeSpawn(stdout: string[] = [], stderr: string[] = []): {
  spawn: SpawnFn;
  calls: string[][];
  kills: number;
} {
  const calls: string[][] = [];
  let kills = 0;
  const exitResolvers: ((v: number) => void)[] = [];
  const spawn: SpawnFn = (args) => {
    calls.push(args);
    let resolveExit: (v: number) => void = () => {};
    const exited = new Promise<number>((r) => (resolveExit = r));
    exitResolvers.push(resolveExit);
    const handle: ProcessHandle = {
      stdout: streamOf(stdout),
      stderr: streamOf(stderr),
      exited,
      kill: () => {
        kills += 1;
        resolveExit(0);
      },
    };
    // For finite stream tests, exit on its own.
    queueMicrotask(() => resolveExit(0));
    return handle;
  };
  return { spawn, calls, get kills() { return kills; } };
}

function recorder(): { events: DeploymentEvent[]; observer: DeploymentObserver } {
  const events: DeploymentEvent[] = [];
  return { events, observer: { emit: (e) => events.push(e) } };
}

describe("followableServices", () => {
  test("excludes the internal init service", () => {
    expect(followableServices(["api", INIT_SERVICE_NAME, "db"])).toEqual(["api", "db"]);
  });
});

describe("startServiceFollowers", () => {
  test("spawns a follower per service with the expected compose logs args", () => {
    const { spawn, calls } = fakeSpawn();
    const { observer } = recorder();
    const followers = startServiceFollowers({
      ctx: { projectName: "p", composeFile: "/c.yaml" },
      services: ["api", INIT_SERVICE_NAME, "db"],
      observer,
      spawn,
      tail: 50,
    });
    expect(followers.map((f) => f.service)).toEqual(["api", "db"]);
    expect(calls.length).toBe(2);
    expect(calls[0]).toEqual([
      "compose",
      "-p",
      "p",
      "-f",
      "/c.yaml",
      "logs",
      "--follow",
      "--no-color",
      "--tail",
      "50",
      "api",
    ]);
    expect(calls[1]?.[calls[1]!.length - 1]).toBe("db");
  });

  test("each follower channel receives its service's chunks", async () => {
    const { spawn } = fakeSpawn(["api-line\n"], []);
    const { events, observer } = recorder();
    const followers = startServiceFollowers({
      ctx: { projectName: "p", composeFile: "/c.yaml" },
      services: ["api"],
      observer,
      spawn,
    });
    await Promise.all(followers.map((f) => f.done));
    const logs = events.filter((e) => e.type === "log");
    expect(logs.length).toBe(1);
    expect(logs[0]).toMatchObject({
      type: "log",
      channel: serviceChannel("api"),
      stream: "stdout",
      chunk: "api-line\n",
    });
  });

  test("stopServiceFollowers kills processes and resolves", async () => {
    const calls: string[][] = [];
    const kills: number[] = [];
    const spawn: SpawnFn = (args) => {
      calls.push(args);
      let resolveExit: (v: number) => void = () => {};
      const exited = new Promise<number>((r) => (resolveExit = r));
      let stdoutController: ReadableStreamDefaultController<Uint8Array> | null = null;
      let stderrController: ReadableStreamDefaultController<Uint8Array> | null = null;
      const stdout = new ReadableStream<Uint8Array>({
        start(controller) {
          stdoutController = controller;
        },
      });
      const stderr = new ReadableStream<Uint8Array>({
        start(controller) {
          stderrController = controller;
        },
      });
      return {
        stdout,
        stderr,
        exited,
        kill: () => {
          kills.push(1);
          stdoutController?.close();
          stderrController?.close();
          resolveExit(0);
        },
      };
    };
    const { observer } = recorder();
    const followers = startServiceFollowers({
      ctx: { projectName: "p", composeFile: "/c.yaml" },
      services: ["api", "db"],
      observer,
      spawn,
    });
    await stopServiceFollowers(followers);
    expect(kills.length).toBe(2);
  });
});
