import { describe, expect, test } from "bun:test";
import {
  sessionsForWorktree,
  type SessionsByPath,
} from "../apps/web/src/lib/sidebar-terminals";
import type {
  TerminalKnownAgent,
  TerminalSessionMetadata,
} from "../apps/web/src/lib/terminal-protocol";

function session(
  id: string,
  worktreePath: string,
  agent?: TerminalKnownAgent,
): TerminalSessionMetadata {
  return {
    id,
    worktreePath,
    status: "running",
    shell: "zsh",
    cwd: worktreePath,
    cols: 80,
    rows: 24,
    createdAt: "2026-01-01T00:00:00.000Z",
    activeCommand: agent
      ? { pid: 1, command: agent, args: "", agent }
      : { pid: 1, command: "bun", args: "dev" },
  };
}

function sessionsMap(
  entries: Array<[string, TerminalSessionMetadata[]]>,
): SessionsByPath {
  return new Map(entries);
}

describe("sessionsForWorktree", () => {
  const map = sessionsMap([
    ["/acme/main", [session("s1", "/acme/main", "claude"), session("s2", "/acme/main")]],
    ["/ml/exp", [session("s3", "/ml/exp", "codex")]],
  ]);

  test("returns the live sessions for a worktree path in order", () => {
    expect(sessionsForWorktree(map, "/acme/main").map((s) => s.id)).toEqual([
      "s1",
      "s2",
    ]);
  });

  test("returns every kind of session — agents and plain shells alike", () => {
    expect(sessionsForWorktree(map, "/ml/exp").map((s) => s.id)).toEqual(["s3"]);
  });

  test("returns an empty list for a path with no live sessions", () => {
    expect(sessionsForWorktree(map, "/missing")).toEqual([]);
    expect(sessionsForWorktree(new Map(), "/acme/main")).toEqual([]);
  });
});
