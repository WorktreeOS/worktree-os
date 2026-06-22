import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  discoverProjectsFromSessions,
} from "@worktreeos/core/project-discovery";
import { loadProjects } from "@worktreeos/core/project-registry";

let tmpHome: string;
let sessionsDir: string;
let projectsFile: string;
let savedHome: string | undefined;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "wos-discovery-"));
  sessionsDir = join(tmpHome, "sessions");
  projectsFile = join(tmpHome, "projects.json");
  await mkdir(sessionsDir, { recursive: true });
  savedHome = process.env.WOS_HOME;
  process.env.WOS_HOME = tmpHome;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.WOS_HOME;
  else process.env.WOS_HOME = savedHome;
  await rm(tmpHome, { recursive: true, force: true });
});

async function writeSession(name: string, state: unknown) {
  const dir = join(sessionsDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "state.json"), JSON.stringify(state, null, 2));
}

describe("discoverProjectsFromSessions", () => {
  test("registers projects from state.sourcePath", async () => {
    await writeSession("repo-main", {
      initialized: true,
      projectName: "wos-x",
      composeFile: "/x/compose.yaml",
      lastUp: "2026-05-18T00:00:00.000Z",
      worktreeRoot: "/repo/main",
      sourcePath: "/repo/main",
    });
    await writeSession("repo-feature", {
      initialized: true,
      projectName: "wos-y",
      composeFile: "/y/compose.yaml",
      worktreeRoot: "/repo/feature",
      sourcePath: "/repo/main",
    });
    const result = await discoverProjectsFromSessions({
      sessionsDir,
      projectsFilePath: projectsFile,
    });
    expect(result.registered.length).toBe(1);
    const stored = await loadProjects({ filePath: projectsFile });
    expect(stored.length).toBe(1);
    expect(stored[0]!.sourcePath).toBe(resolve("/repo/main"));
  });

  test("falls back to running git -C worktreeRoot when sourcePath is missing", async () => {
    await writeSession("legacy", {
      initialized: true,
      projectName: "p",
      composeFile: "/x/compose.yaml",
      worktreeRoot: "/repo/legacy",
    });
    const runner = async (root: string, args: string[]) => {
      if (root === "/repo/legacy" && args[0] === "worktree") {
        return [
          "worktree /repo/legacy-source",
          "HEAD aaa",
          "branch refs/heads/main",
          "",
          "worktree /repo/legacy",
          "HEAD bbb",
          "branch refs/heads/feature",
          "",
        ].join("\n");
      }
      return "";
    };
    const result = await discoverProjectsFromSessions({
      sessionsDir,
      projectsFilePath: projectsFile,
      gitRunner: runner,
    });
    expect(result.registered.length).toBe(1);
    expect(result.registered[0]!.sourcePath).toBe(resolve("/repo/legacy-source"));
  });

  test("skips sessions without state or non-initialized states", async () => {
    await writeSession("empty-dir", {});
    await writeSession("uninitialized", { initialized: false });
    const result = await discoverProjectsFromSessions({
      sessionsDir,
      projectsFilePath: projectsFile,
    });
    expect(result.registered.length).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(2);
  });

  test("does not duplicate already-registered projects", async () => {
    await writeSession("repo-main", {
      initialized: true,
      projectName: "p",
      composeFile: "/x/compose.yaml",
      sourcePath: "/repo/main",
    });
    // First run registers, second run is a no-op.
    await discoverProjectsFromSessions({
      sessionsDir,
      projectsFilePath: projectsFile,
    });
    const second = await discoverProjectsFromSessions({
      sessionsDir,
      projectsFilePath: projectsFile,
    });
    expect(second.registered.length).toBe(0);
    const stored = await loadProjects({ filePath: projectsFile });
    expect(stored.length).toBe(1);
  });

  test("returns empty result when sessions dir is absent", async () => {
    const missing = join(tmpHome, "no-sessions");
    const result = await discoverProjectsFromSessions({
      sessionsDir: missing,
      projectsFilePath: projectsFile,
    });
    expect(result.registered).toEqual([]);
  });
});
