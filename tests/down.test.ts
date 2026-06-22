import { test, expect, describe, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runDown } from "../apps/cli/commands/down";
import { type DockerRunner, type DockerResult } from "@worktreeos/compose/compose";
import { type GitRunner } from "@worktreeos/core/git";
import { readState, stateFilePath, writeState, type WosState } from "@worktreeos/core/state";

const ORIGINAL_WOS_HOME = process.env.WOS_HOME;
let WOS_HOME_FOR_TESTS: string;
beforeAll(async () => {
  WOS_HOME_FOR_TESTS = await mkdtemp(resolve(tmpdir(), "wos-down-home-"));
  process.env.WOS_HOME = WOS_HOME_FOR_TESTS;
});
afterAll(async () => {
  if (ORIGINAL_WOS_HOME === undefined) delete process.env.WOS_HOME;
  else process.env.WOS_HOME = ORIGINAL_WOS_HOME;
  if (WOS_HOME_FOR_TESTS) {
    await rm(WOS_HOME_FOR_TESTS, { recursive: true, force: true });
  }
});

interface CapturedStreams {
  stdout: string;
  stderr: string;
  restore(): void;
}

function captureStdio(): CapturedStreams {
  let stdout = "";
  let stderr = "";
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;
  return {
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    restore() {
      process.stdout.write = origOut as typeof process.stdout.write;
      process.stderr.write = origErr as typeof process.stderr.write;
    },
  };
}

const tempDirs: string[] = [];
async function makeWorkspace(): Promise<{ root: string; gitDir: string }> {
  const root = await mkdtemp(resolve(tmpdir(), "wos-down-"));
  const gitDir = resolve(root, ".git");
  await mkdir(gitDir, { recursive: true });
  tempDirs.push(root);
  return { root, gitDir };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

function makeGitRunner(worktreeRoot: string, gitDir: string): GitRunner {
  return async (args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return `${worktreeRoot}\n`;
    if (args[0] === "rev-parse" && args[1] === "--git-dir") return `${gitDir}\n`;
    return "";
  };
}

describe("runDown", () => {
  test("invokes docker compose down --remove-orphans for the stored project", async () => {
    const ws = await makeWorkspace();
    const statePath = stateFilePath(ws.root);
    const composeFile = resolve(ws.root, ".wos/compose.yaml");
    const initial: WosState = {
      initialized: true,
      projectName: "wos-test-aaaa",
      composeFile,
      portAssignments: { api: { "3000": 30000 } },
      lastUp: "2026-05-12T12:00:00.000Z",
    };
    await writeState(statePath, initial);

    const calls: string[][] = [];
    const composeRunner: DockerRunner = async (args) => {
      calls.push(args);
      return { stdout: "", stderr: "", exitCode: 0 } as DockerResult;
    };

    const cap = captureStdio();
    let code: number;
    try {
      code = await runDown([], {
        gitRunner: makeGitRunner(ws.root, ws.gitDir),
        composeRunner,
      });
    } finally {
      cap.restore();
    }

    expect(code).toBe(0);
    expect(calls).toEqual([
      [
        "compose",
        "-p",
        "wos-test-aaaa",
        "-f",
        composeFile,
        "down",
        "--remove-orphans",
      ],
    ]);

    const after = await readState(statePath);
    expect(after).toEqual(initial);
  });

  test("reports no deployment and skips docker when state is missing", async () => {
    const ws = await makeWorkspace();
    let dockerCalls = 0;
    const composeRunner: DockerRunner = async () => {
      dockerCalls += 1;
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    const cap = captureStdio();
    let code: number;
    try {
      code = await runDown([], {
        gitRunner: makeGitRunner(ws.root, ws.gitDir),
        composeRunner,
      });
    } finally {
      cap.restore();
    }

    expect(code).toBe(0);
    expect(dockerCalls).toBe(0);
    expect(cap.stdout).toBe(
      "no wos deployment has been initialized for the current worktree\n",
    );
    expect(cap.stderr).toBe("");
  });

  test("reports no deployment and skips docker when state is uninitialized", async () => {
    const ws = await makeWorkspace();
    const statePath = stateFilePath(ws.root);
    await writeState(statePath, {
      initialized: false,
      projectName: "wos-test-aaaa",
      composeFile: resolve(ws.root, ".wos/compose.yaml"),
    });

    let dockerCalls = 0;
    const composeRunner: DockerRunner = async () => {
      dockerCalls += 1;
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    const cap = captureStdio();
    let code: number;
    try {
      code = await runDown([], {
        gitRunner: makeGitRunner(ws.root, ws.gitDir),
        composeRunner,
      });
    } finally {
      cap.restore();
    }

    expect(code).toBe(0);
    expect(dockerCalls).toBe(0);
    expect(cap.stdout).toBe(
      "no wos deployment has been initialized for the current worktree\n",
    );
  });

  test("returns failure and preserves state when docker compose fails", async () => {
    const ws = await makeWorkspace();
    const statePath = stateFilePath(ws.root);
    const composeFile = resolve(ws.root, ".wos/compose.yaml");
    const initial: WosState = {
      initialized: true,
      projectName: "wos-test-bbbb",
      composeFile,
      portAssignments: { api: { "3000": 30000 } },
      lastUp: "2026-05-12T12:00:00.000Z",
    };
    await writeState(statePath, initial);

    const composeRunner: DockerRunner = async () => ({
      stdout: "",
      stderr: "boom\n",
      exitCode: 1,
    });

    const cap = captureStdio();
    let code: number;
    try {
      code = await runDown([], {
        gitRunner: makeGitRunner(ws.root, ws.gitDir),
        composeRunner,
      });
    } finally {
      cap.restore();
    }

    expect(code).toBe(1);
    expect(cap.stderr).toContain("wos down failed:");
    expect(cap.stderr).toContain("docker compose down failed: boom");

    const after = await readState(statePath);
    expect(after).toEqual(initial);
  });
});
