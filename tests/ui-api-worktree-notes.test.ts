import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
} from "./helpers/daemon-test-harness.ts";
import {
  loadProjects,
  saveProjects,
  setWorktreeDisplayName,
} from "@worktreeos/core/project-registry";
import { createUiApiHandler } from "@worktreeos/daemon/ui-api";
import { OperationRegistry } from "@worktreeos/daemon/operation-registry";
import { DaemonSessionRegistry } from "@worktreeos/daemon/daemon-sessions";
import { TunnelRegistry } from "@worktreeos/runtime/tunnel-registry";
import type {
  ProjectListResponse,
  WorktreeDetailResponse,
  WorktreeNoteResponse,
} from "@worktreeos/daemon/ui-protocol";
import type { SessionContext } from "@worktreeos/core/session-context";

const TEST_PROJECT = "test-proj";

function fakeContext(overrides: Partial<SessionContext> = {}): SessionContext {
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
    projectName: TEST_PROJECT,
    sessionName: "fake-session",
    sessionRoot: "/tmp/fake-session",
    state: null,
    ...overrides,
  };
}

let tmpHome: string;
let projectsPath: string;

beforeEach(async () => {
  const raw = await createDaemonTestHome("wos-note-");
  tmpHome = realpathSync(raw);
  projectsPath = resolve(tmpHome, "projects.json");
});

afterEach(async () => {
  await teardownDaemonTestHome(tmpHome);
});

function makeHandler(opts: {
  gitRunner: (root: string, args: string[]) => Promise<string>;
}) {
  return createUiApiHandler({
    registry: new OperationRegistry(),
    sessions: new DaemonSessionRegistry({ starter: () => [] }),
    tunnels: new TunnelRegistry(),
    gitRunner: opts.gitRunner,
    projectsFilePath: projectsPath,
    resolveSession: async () => fakeContext(),
  });
}

async function setupProjectWithWorktrees(): Promise<{
  projectId: string;
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
  return { projectId: "p1", source, feature, gitRunner };
}

describe("UI API: worktree note endpoint", () => {
  test("set note persists to projects.json and returns it on the summary", async () => {
    const ctx = await setupProjectWithWorktrees();
    const handler = makeHandler({ gitRunner: ctx.gitRunner });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/note", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: ctx.feature,
          note: "  QA is testing checkout here  ",
        }),
      }),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as WorktreeNoteResponse;
    expect(body.projectId).toBe(ctx.projectId);
    expect(body.worktree.note).toBe("QA is testing checkout here");
    expect(body.worktree.path).toBe(resolve(ctx.feature));

    const stored = await loadProjects({ filePath: projectsPath });
    expect(stored[0]!.worktreeNotes).toEqual({
      [resolve(ctx.feature)]: "QA is testing checkout here",
    });
  });

  test("empty note clears the stored note and omits it from the summary", async () => {
    const ctx = await setupProjectWithWorktrees();
    const handler = makeHandler({ gitRunner: ctx.gitRunner });
    // First set a note.
    await handler(
      new Request("http://x/ui/v1/worktrees/note", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: ctx.feature, note: "keep around" }),
      }),
    );
    // Then clear it with an empty note.
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/note", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: ctx.feature, note: "   " }),
      }),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as WorktreeNoteResponse;
    expect(body.worktree.note).toBeUndefined();

    const stored = await loadProjects({ filePath: projectsPath });
    expect(stored[0]!.worktreeNotes).toBeUndefined();
  });

  test("note is independent of display name", async () => {
    const ctx = await setupProjectWithWorktrees();
    await setWorktreeDisplayName(ctx.projectId, ctx.feature, "Checkout", {
      filePath: projectsPath,
    });
    const handler = makeHandler({ gitRunner: ctx.gitRunner });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/note", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: ctx.feature, note: "do not delete" }),
      }),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as WorktreeNoteResponse;
    expect(body.worktree.displayName).toBe("Checkout");
    expect(body.worktree.note).toBe("do not delete");

    const stored = await loadProjects({ filePath: projectsPath });
    expect(stored[0]!.worktreeDisplayNames).toEqual({
      [resolve(ctx.feature)]: "Checkout",
    });
    expect(stored[0]!.worktreeNotes).toEqual({
      [resolve(ctx.feature)]: "do not delete",
    });
  });

  test("project list and detail carry the persisted note", async () => {
    const ctx = await setupProjectWithWorktrees();
    const handler = makeHandler({ gitRunner: ctx.gitRunner });
    await handler(
      new Request("http://x/ui/v1/worktrees/note", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: ctx.feature, note: "demo on Friday" }),
      }),
    );

    const listRes = await handler(new Request("http://x/ui/v1/projects"));
    const list = (await listRes!.json()) as ProjectListResponse;
    const featureSummary = list.projects[0]!.worktrees.find(
      (w) => w.path === resolve(ctx.feature),
    );
    expect(featureSummary?.note).toBe("demo on Friday");
    const mainSummary = list.projects[0]!.worktrees.find(
      (w) => w.path === resolve(ctx.source),
    );
    expect(mainSummary?.note).toBeUndefined();

    const detailRes = await handler(
      new Request(
        `http://x/ui/v1/worktrees?path=${encodeURIComponent(ctx.feature)}`,
      ),
    );
    const detail = (await detailRes!.json()) as WorktreeDetailResponse;
    expect(detail.worktree.note).toBe("demo on Friday");
  });
});
