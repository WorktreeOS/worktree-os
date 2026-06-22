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
  WorktreeRenameResponse,
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
  const raw = await createDaemonTestHome("wos-display-");
  // Use the realpath form so that `normalizeSourcePath` (which calls
  // `realpathSync`) round-trips identically across macOS's `/var` →
  // `/private/var` symlink.
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

describe("UI API: worktree display names on list/detail", () => {
  test("project list includes persisted worktree displayName", async () => {
    const ctx = await setupProjectWithWorktrees();
    await setWorktreeDisplayName(ctx.projectId, ctx.feature, "Checkout redesign", {
      filePath: projectsPath,
    });
    const handler = makeHandler({ gitRunner: ctx.gitRunner });
    const res = await handler(new Request("http://x/ui/v1/projects"));
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as ProjectListResponse;
    const feature = body.projects[0]!.worktrees.find(
      (w) => w.path === resolve(ctx.feature),
    );
    expect(feature?.displayName).toBe("Checkout redesign");
    const main = body.projects[0]!.worktrees.find(
      (w) => w.path === resolve(ctx.source),
    );
    expect(main?.displayName).toBeUndefined();
  });

  test("worktree detail includes persisted displayName", async () => {
    const ctx = await setupProjectWithWorktrees();
    await setWorktreeDisplayName(ctx.projectId, ctx.feature, "My Feature", {
      filePath: projectsPath,
    });
    const handler = makeHandler({ gitRunner: ctx.gitRunner });
    const res = await handler(
      new Request(
        `http://x/ui/v1/worktrees?path=${encodeURIComponent(ctx.feature)}`,
      ),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.worktree.displayName).toBe("My Feature");
    expect(body.worktree.sessionName.length).toBeGreaterThan(0);
  });

  test("worktree detail omits displayName when none persisted", async () => {
    const ctx = await setupProjectWithWorktrees();
    const handler = makeHandler({ gitRunner: ctx.gitRunner });
    const res = await handler(
      new Request(
        `http://x/ui/v1/worktrees?path=${encodeURIComponent(ctx.feature)}`,
      ),
    );
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.worktree.displayName).toBeUndefined();
    expect(body.worktree.branch).toBe("feature");
  });
});

describe("UI API: worktree rename endpoint", () => {
  test("rename persists displayName and returns updated summary", async () => {
    const ctx = await setupProjectWithWorktrees();
    const handler = makeHandler({ gitRunner: ctx.gitRunner });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/name", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: ctx.feature,
          displayName: "  Checkout redesign  ",
        }),
      }),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as WorktreeRenameResponse;
    expect(body.projectId).toBe(ctx.projectId);
    expect(body.worktree.displayName).toBe("Checkout redesign");
    expect(body.worktree.path).toBe(resolve(ctx.feature));

    const stored = await loadProjects({ filePath: projectsPath });
    expect(stored[0]!.worktreeDisplayNames).toEqual({
      [resolve(ctx.feature)]: "Checkout redesign",
    });
  });

  test("rename rejects invalid displayName", async () => {
    const ctx = await setupProjectWithWorktrees();
    const handler = makeHandler({ gitRunner: ctx.gitRunner });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/name", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: ctx.feature, displayName: "  " }),
      }),
    );
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toBe("validation");
    const stored = await loadProjects({ filePath: projectsPath });
    expect(stored[0]!.worktreeDisplayNames).toBeUndefined();
  });

  test("rename rejects worktree that is not owned by any project", async () => {
    const stray = join(tmpHome, "stray");
    await mkdir(stray, { recursive: true });
    const gitRunner = async () => `worktree ${stray}\n\n`;
    const handler = makeHandler({ gitRunner });
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/name", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: stray, displayName: "Lost" }),
      }),
    );
    expect(res!.status).toBe(404);
  });
});
