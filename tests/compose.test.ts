import { test, expect, describe } from "bun:test";
import {
  ComposeError,
  composeArgs,
  composeDown,
  composeDownStreamed,
  composeLogsFollowArgs,
  composePs,
  composePsStreamed,
  composeStopService,
  composeUp,
  composeUpService,
  composeUpStreamed,
  type DockerRunner,
  type StreamingDockerRunner,
} from "@worktreeos/compose/compose";

describe("composeArgs", () => {
  test("includes project name and compose file", () => {
    const args = composeArgs(
      { projectName: "wos-repo-abcd", composeFile: "/repo/.wos/compose.yaml" },
      ["up", "-d"],
    );
    expect(args).toEqual([
      "compose",
      "-p",
      "wos-repo-abcd",
      "-f",
      "/repo/.wos/compose.yaml",
      "up",
      "-d",
    ]);
  });
});

describe("compose command runners", () => {
  test("composeDown invokes docker compose down with project args", async () => {
    const calls: string[][] = [];
    const runner: DockerRunner = async (args) => {
      calls.push(args);
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    await composeDown({ projectName: "p", composeFile: "/c.yaml" }, {}, runner);
    expect(calls).toEqual([["compose", "-p", "p", "-f", "/c.yaml", "down"]]);
  });

  test("composeDown appends --remove-orphans when removeOrphans is true", async () => {
    const calls: string[][] = [];
    const runner: DockerRunner = async (args) => {
      calls.push(args);
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    await composeDown(
      { projectName: "p", composeFile: "/c.yaml" },
      { removeOrphans: true },
      runner,
    );
    expect(calls).toEqual([
      ["compose", "-p", "p", "-f", "/c.yaml", "down", "--remove-orphans"],
    ]);
  });

  test("composeDownStreamed appends --remove-orphans when requested", async () => {
    let observed: string[] = [];
    const runner: StreamingDockerRunner = async (args) => {
      observed = args;
      return { exitCode: 0, stderr: "" };
    };
    await composeDownStreamed(
      { projectName: "p", composeFile: "/c.yaml" },
      {},
      runner,
      { removeOrphans: true },
    );
    expect(observed).toEqual([
      "compose",
      "-p",
      "p",
      "-f",
      "/c.yaml",
      "down",
      "--remove-orphans",
    ]);
  });

  test("composeUp invokes docker compose up -d --force-recreate", async () => {
    const calls: string[][] = [];
    const runner: DockerRunner = async (args) => {
      calls.push(args);
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    await composeUp({ projectName: "p", composeFile: "/c.yaml" }, runner);
    expect(calls).toEqual([["compose", "-p", "p", "-f", "/c.yaml", "up", "-d", "--force-recreate"]]);
  });

  test("composePs returns stdout and uses --format json", async () => {
    let observed: string[] = [];
    const runner: DockerRunner = async (args) => {
      observed = args;
      return { stdout: "[]", stderr: "", exitCode: 0 };
    };
    const out = await composePs({ projectName: "p", composeFile: "/c.yaml" }, runner);
    expect(observed).toEqual([
      "compose",
      "-p",
      "p",
      "-f",
      "/c.yaml",
      "ps",
      "--all",
      "--format",
      "json",
    ]);
    expect(out).toBe("[]");
  });

  test("composeStopService runs docker compose stop for a single service", async () => {
    const calls: string[][] = [];
    const runner: DockerRunner = async (args) => {
      calls.push(args);
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    await composeStopService(
      { projectName: "p", composeFile: "/c.yaml" },
      "api",
      runner,
    );
    expect(calls).toEqual([
      ["compose", "-p", "p", "-f", "/c.yaml", "stop", "api"],
    ]);
  });

  test("composeStopService raises ComposeError on non-zero exit", async () => {
    const runner: DockerRunner = async () => ({
      stdout: "",
      stderr: "boom\n",
      exitCode: 1,
    });
    let caught: unknown;
    try {
      await composeStopService(
        { projectName: "p", composeFile: "/c.yaml" },
        "api",
        runner,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ComposeError);
    expect((caught as ComposeError).stderr).toBe("boom\n");
  });

  test("composeUpService removes the old container then runs docker compose up for one service", async () => {
    const calls: string[][] = [];
    const runner: DockerRunner = async (args) => {
      calls.push(args);
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    await composeUpService(
      { projectName: "p", composeFile: "/c.yaml" },
      "api",
      runner,
    );
    expect(calls).toEqual([
      ["compose", "-p", "p", "-f", "/c.yaml", "rm", "-f", "-s", "api"],
      ["compose", "-p", "p", "-f", "/c.yaml", "up", "-d", "api"],
    ]);
  });

  test("composeUpService raises ComposeError when rm fails", async () => {
    const runner: DockerRunner = async () => ({
      stdout: "",
      stderr: "rm boom\n",
      exitCode: 1,
    });
    let caught: unknown;
    try {
      await composeUpService(
        { projectName: "p", composeFile: "/c.yaml" },
        "api",
        runner,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ComposeError);
    expect((caught as ComposeError).message).toContain("docker compose rm");
    expect((caught as ComposeError).stderr).toBe("rm boom\n");
  });

  test("composeUpService raises ComposeError when up fails", async () => {
    let call = 0;
    const runner: DockerRunner = async () => {
      call += 1;
      if (call === 1) return { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "nope\n", exitCode: 1 };
    };
    let caught: unknown;
    try {
      await composeUpService(
        { projectName: "p", composeFile: "/c.yaml" },
        "api",
        runner,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ComposeError);
    expect((caught as ComposeError).message).toContain("docker compose up -d api");
    expect((caught as ComposeError).stderr).toBe("nope\n");
  });

  test("non-zero exit raises ComposeError", async () => {
    const runner: DockerRunner = async () => ({ stdout: "", stderr: "boom", exitCode: 1 });
    await expect(composeUp({ projectName: "p", composeFile: "/c.yaml" }, runner)).rejects.toThrow(
      ComposeError,
    );
  });
});

describe("streaming compose runners", () => {
  test("composeUpStreamed passes --force-recreate arguments", async () => {
    let observed: string[] = [];
    const runner: StreamingDockerRunner = async (args) => {
      observed = args;
      return { exitCode: 0, stderr: "" };
    };
    await composeUpStreamed({ projectName: "p", composeFile: "/c.yaml" }, {}, runner);
    expect(observed).toEqual(["compose", "-p", "p", "-f", "/c.yaml", "up", "-d", "--force-recreate"]);
  });

  test("composeUpStreamed forwards stdout chunks to the sink", async () => {
    const chunks: string[] = [];
    const runner: StreamingDockerRunner = async (_args, sinks) => {
      sinks.onStdout?.("hello ");
      sinks.onStdout?.("world\n");
      return { exitCode: 0, stderr: "" };
    };
    await composeUpStreamed({ projectName: "p", composeFile: "/c.yaml" }, {
      onStdout: (c) => chunks.push(c),
    }, runner);
    expect(chunks).toEqual(["hello ", "world\n"]);
  });

  test("composeDownStreamed forwards stderr chunks to the sink", async () => {
    const errs: string[] = [];
    const runner: StreamingDockerRunner = async (_args, sinks) => {
      sinks.onStderr?.("warn: x\n");
      return { exitCode: 0, stderr: "warn: x\n" };
    };
    await composeDownStreamed({ projectName: "p", composeFile: "/c.yaml" }, {
      onStderr: (c) => errs.push(c),
    }, runner);
    expect(errs).toEqual(["warn: x\n"]);
  });

  test("composeUpStreamed raises ComposeError on non-zero exit with accumulated stderr", async () => {
    const runner: StreamingDockerRunner = async () => ({
      exitCode: 1,
      stderr: "boom\n",
    });
    let caught: unknown;
    try {
      await composeUpStreamed({ projectName: "p", composeFile: "/c.yaml" }, {}, runner);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ComposeError);
    expect((caught as ComposeError).stderr).toBe("boom\n");
  });

  test("composePsStreamed returns accumulated stdout while streaming", async () => {
    const seen: string[] = [];
    const runner: StreamingDockerRunner = async (_args, sinks) => {
      sinks.onStdout?.("[");
      sinks.onStdout?.("]");
      return { exitCode: 0, stderr: "" };
    };
    const out = await composePsStreamed({ projectName: "p", composeFile: "/c.yaml" }, {
      onStdout: (c) => seen.push(c),
    }, runner);
    expect(out).toBe("[]");
    expect(seen).toEqual(["[", "]"]);
  });

  test("composeLogsFollowArgs builds the expected docker compose logs command", () => {
    const args = composeLogsFollowArgs(
      { projectName: "p", composeFile: "/c.yaml" },
      "api",
      200,
    );
    expect(args).toEqual([
      "compose",
      "-p",
      "p",
      "-f",
      "/c.yaml",
      "logs",
      "--follow",
      "--no-color",
      "--tail",
      "200",
      "api",
    ]);
  });
});
