import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
} from "./helpers/daemon-test-harness.ts";
import { saveProjects } from "@worktreeos/core/project-registry";
import { createUiApiHandler } from "@worktreeos/daemon/ui-api";
import { OperationRegistry } from "@worktreeos/daemon/operation-registry";
import { DaemonSessionRegistry } from "@worktreeos/daemon/daemon-sessions";
import { TunnelRegistry } from "@worktreeos/runtime/tunnel-registry";
import {
  signAuthCookie,
  AUTH_COOKIE_NAME,
} from "@worktreeos/daemon/public-auth";
import type { WorktreeOpenEditorResponse } from "@worktreeos/daemon/ui-protocol";
import type { SessionContext } from "@worktreeos/core/session-context";

const PUBLIC_HOST = "public.example.com";
const PUBLIC_SECRET = "open-editor-secret";

function fakeContext(): SessionContext {
  return {
    worktreeRoot: "/fake/worktree",
    source: { path: "/fake/source", bare: false, detached: false },
    config: {
      cloneVolumes: [],
      hostPorts: { start: 20000, end: 29999 },
      app: { image: null, initScript: [], services: {} },
      deps: {},
      cache: [],
    } as any,
    projectName: "test-proj",
    sessionName: "fake-session",
    sessionRoot: "/tmp/fake-session",
    state: null,
  };
}

let tmpHome: string;
let projectsPath: string;

beforeEach(async () => {
  const raw = await createDaemonTestHome("wos-open-editor-");
  tmpHome = realpathSync(raw);
  projectsPath = resolve(tmpHome, "projects.json");
});

afterEach(async () => {
  await teardownDaemonTestHome(tmpHome);
});

async function setupWorktrees(): Promise<{
  source: string;
  feature: string;
  gitRunner: (root: string, args: string[]) => Promise<string>;
}> {
  const source = join(tmpHome, "repo");
  await mkdir(source, { recursive: true });
  const feature = join(tmpHome, "feature");
  await mkdir(feature, { recursive: true });
  await saveProjects(
    [
      {
        id: "p1",
        displayName: "repo",
        sourcePath: source,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    { filePath: projectsPath },
  );
  const gitRunner = async (_root: string, args: string[]) => {
    if (args[0] === "worktree" && args[1] === "list") {
      return [
        `worktree ${source}`,
        "HEAD aaa",
        "branch refs/heads/main",
        "",
        `worktree ${feature}`,
        "HEAD bbb",
        "branch refs/heads/feature",
        "",
      ].join("\n");
    }
    return "";
  };
  return { source, feature, gitRunner };
}

type SpawnRecord = { command: string; env: NodeJS.ProcessEnv };

function makeHandler(opts: {
  gitRunner: (root: string, args: string[]) => Promise<string>;
  editorCommand?: string;
  spawns?: SpawnRecord[];
  spawnThrows?: boolean;
  publicWebUi?: boolean;
}) {
  return createUiApiHandler({
    registry: new OperationRegistry(),
    sessions: new DaemonSessionRegistry({ starter: () => [] }),
    tunnels: new TunnelRegistry(),
    gitRunner: opts.gitRunner,
    projectsFilePath: projectsPath,
    resolveSession: async () => fakeContext(),
    editorCommandLoader: async () => opts.editorCommand,
    editorSpawn: (command, env) => {
      if (opts.spawnThrows) throw new Error("ENOENT: editor not found");
      opts.spawns?.push({ command, env });
      return { unref: () => {} };
    },
    ...(opts.publicWebUi
      ? {
          tunnelWebUi: {
            enabled: true,
            hostname: PUBLIC_HOST,
            secret: PUBLIC_SECRET,
            terminalEnabled: true,
            whitelistIps: [],
          },
        }
      : {}),
  });
}

describe("UI API: worktree open-editor endpoint", () => {
  test("spawns the configured command with the worktree path in env", async () => {
    const ctx = await setupWorktrees();
    const spawns: SpawnRecord[] = [];
    const handler = makeHandler({
      gitRunner: ctx.gitRunner,
      editorCommand: 'code "$WOS_WORKTREE_PATH"',
      spawns,
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/open-editor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: ctx.feature }),
      }),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as WorktreeOpenEditorResponse;
    expect(body.ok).toBe(true);
    expect(body.worktreePath).toBe(resolve(ctx.feature));
    expect(spawns.length).toBe(1);
    expect(spawns[0]!.command).toBe('code "$WOS_WORKTREE_PATH"');
    expect(spawns[0]!.env.WOS_WORKTREE_PATH).toBe(resolve(ctx.feature));
  });

  test("shell-quotes the {path} token substitution", async () => {
    const ctx = await setupWorktrees();
    const spaced = join(tmpHome, "with space");
    await mkdir(spaced, { recursive: true });
    const gitRunner = async (_root: string, args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return [`worktree ${spaced}`, "HEAD ccc", "branch refs/heads/x", ""].join(
          "\n",
        );
      }
      return "";
    };
    const spawns: SpawnRecord[] = [];
    const handler = makeHandler({
      gitRunner,
      editorCommand: "cursor {path}",
      spawns,
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/open-editor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: spaced }),
      }),
    );
    expect(res!.status).toBe(200);
    expect(spawns.length).toBe(1);
    expect(spawns[0]!.command).toBe(`cursor '${resolve(spaced)}'`);
  });

  test("rejects with no-editor when no command is configured", async () => {
    const ctx = await setupWorktrees();
    const handler = makeHandler({
      gitRunner: ctx.gitRunner,
      editorCommand: undefined,
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/open-editor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: ctx.feature }),
      }),
    );
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toBe("no-editor");
  });

  test("rejects with validation when path is missing", async () => {
    const ctx = await setupWorktrees();
    const handler = makeHandler({
      gitRunner: ctx.gitRunner,
      editorCommand: "code",
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/open-editor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toBe("validation");
  });

  test("surfaces a spawn failure as an error", async () => {
    const ctx = await setupWorktrees();
    const handler = makeHandler({
      gitRunner: ctx.gitRunner,
      editorCommand: "missing-editor",
      spawnThrows: true,
    });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/open-editor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: ctx.feature }),
      }),
    );
    expect(res!.status).toBe(500);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toBe("spawn-failed");
  });

  test("rejects public/remote access with 403", async () => {
    const ctx = await setupWorktrees();
    const spawns: SpawnRecord[] = [];
    const handler = makeHandler({
      gitRunner: ctx.gitRunner,
      editorCommand: "code",
      spawns,
      publicWebUi: true,
    });
    const cookie = `${AUTH_COOKIE_NAME}=${signAuthCookie(PUBLIC_SECRET, Date.now())}`;
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/open-editor", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: PUBLIC_HOST,
          cookie,
        },
        body: JSON.stringify({ path: ctx.feature }),
      }),
    );
    expect(res!.status).toBe(403);
    expect(spawns.length).toBe(0);
  });
});
