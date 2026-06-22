import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
} from "./helpers/daemon-test-harness.ts";
import { registerProjectBySourcePath } from "@worktreeos/core/project-registry";
import type {
  StatusCatalogResponse,
  StatusCreateResponse,
  StatusUpdateResponse,
  StatusDeleteResponse,
  WorktreeStatusResponse,
  WorktreeCommentAddResponse,
  WorktreeCommentsResponse,
} from "@worktreeos/daemon/ui-protocol";

let tmpHome: string;

beforeEach(async () => {
  tmpHome = await createDaemonTestHome("wos-ui-board-");
});

afterEach(async () => {
  await teardownDaemonTestHome(tmpHome, null);
});

async function buildHandler(repo?: string) {
  const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
  const { OperationRegistry } = await import(
    "@worktreeos/daemon/operation-registry"
  );
  const { DaemonSessionRegistry } = await import(
    "@worktreeos/daemon/daemon-sessions"
  );
  const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
  const { GitError } = await import("@worktreeos/core/git");
  return createUiApiHandler({
    registry: new OperationRegistry(),
    sessions: new DaemonSessionRegistry({ starter: () => [] }),
    tunnels: new TunnelRegistry(),
    gitRunner: async (_root, args) => {
      if (repo && args[0] === "worktree" && args[1] === "list") {
        return `worktree ${repo}\nHEAD aaa\nbranch refs/heads/main\n\n`;
      }
      if (args[0] === "worktree" && args[1] === "list") {
        throw new GitError("git: not a git repository");
      }
      return "";
    },
    projectsFilePath: resolve(tmpHome, "projects.json"),
    resolveSession: async () => ({}) as never,
  });
}

describe("UI API: status catalog", () => {
  test("GET seeds presets", async () => {
    const handler = await buildHandler();
    const res = await handler(new Request("http://x/ui/v1/statuses"));
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as StatusCatalogResponse;
    expect(body.statuses.map((s) => s.id)).toEqual([
      "to-dev",
      "develop",
      "review",
      "to-merge",
      "merged",
    ]);
  });

  test("create, update, delete a status", async () => {
    const handler = await buildHandler();

    const created = await handler(
      new Request("http://x/ui/v1/statuses", {
        method: "POST",
        body: JSON.stringify({ name: "blocked", color: "#EF4444" }),
      }),
    );
    expect(created!.status).toBe(200);
    const createdBody = (await created!.json()) as StatusCreateResponse;
    const id = createdBody.status.id;
    expect(createdBody.status.color).toBe("#ef4444");

    const updated = await handler(
      new Request(`http://x/ui/v1/statuses/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "blocked!", order: 0 }),
      }),
    );
    expect(updated!.status).toBe(200);
    const updatedBody = (await updated!.json()) as StatusUpdateResponse;
    expect(updatedBody.status.name).toBe("blocked!");
    expect(updatedBody.statuses[0]!.id).toBe(id);

    const deleted = await handler(
      new Request(`http://x/ui/v1/statuses/${id}`, { method: "DELETE" }),
    );
    expect(deleted!.status).toBe(200);
    const deletedBody = (await deleted!.json()) as StatusDeleteResponse;
    expect(deletedBody.statuses.some((s) => s.id === id)).toBe(false);
  });

  test("create rejects invalid color", async () => {
    const handler = await buildHandler();
    const res = await handler(
      new Request("http://x/ui/v1/statuses", {
        method: "POST",
        body: JSON.stringify({ name: "x", color: "purple" }),
      }),
    );
    expect(res!.status).toBe(400);
  });

  test("update unknown id returns 404", async () => {
    const handler = await buildHandler();
    const res = await handler(
      new Request("http://x/ui/v1/statuses/nope", {
        method: "PATCH",
        body: JSON.stringify({ name: "x" }),
      }),
    );
    expect(res!.status).toBe(404);
  });
});

describe("UI API: worktree workflow status", () => {
  test("assign, reject unknown status, and clear", async () => {
    const handler = await buildHandler();
    const wt = resolve(tmpHome, "wt-a");

    const assigned = await handler(
      new Request("http://x/ui/v1/worktrees/status", {
        method: "PATCH",
        body: JSON.stringify({ path: wt, statusId: "review" }),
      }),
    );
    expect(assigned!.status).toBe(200);
    const assignedBody = (await assigned!.json()) as WorktreeStatusResponse;
    expect(assignedBody.statusId).toBe("review");
    expect(typeof assignedBody.order).toBe("number");

    const unknown = await handler(
      new Request("http://x/ui/v1/worktrees/status", {
        method: "PATCH",
        body: JSON.stringify({ path: wt, statusId: "ghost" }),
      }),
    );
    expect(unknown!.status).toBe(400);

    const cleared = await handler(
      new Request("http://x/ui/v1/worktrees/status", {
        method: "PATCH",
        body: JSON.stringify({ path: wt, statusId: null }),
      }),
    );
    expect(cleared!.status).toBe(200);
    const clearedBody = (await cleared!.json()) as WorktreeStatusResponse;
    expect(clearedBody.statusId).toBeNull();
  });

  test("appends order at the column tail when order is omitted", async () => {
    const handler = await buildHandler();
    const a = resolve(tmpHome, "wt-a");
    const b = resolve(tmpHome, "wt-b");
    const first = (await (
      await handler(
        new Request("http://x/ui/v1/worktrees/status", {
          method: "PATCH",
          body: JSON.stringify({ path: a, statusId: "develop" }),
        }),
      )
    )!.json()) as WorktreeStatusResponse;
    const second = (await (
      await handler(
        new Request("http://x/ui/v1/worktrees/status", {
          method: "PATCH",
          body: JSON.stringify({ path: b, statusId: "develop" }),
        }),
      )
    )!.json()) as WorktreeStatusResponse;
    expect(second.order!).toBeGreaterThan(first.order!);
  });
});

describe("UI API: worktree comments", () => {
  test("add, list, and delete comments for a registered worktree", async () => {
    const repo = realpathSync(
      await mkdir(join(tmpHome, "repo"), { recursive: true }).then(
        () => join(tmpHome, "repo"),
      ),
    );
    await registerProjectBySourcePath(repo, {
      filePath: resolve(tmpHome, "projects.json"),
    });
    const handler = await buildHandler(repo);

    const added = await handler(
      new Request("http://x/ui/v1/worktrees/comments", {
        method: "POST",
        body: JSON.stringify({ path: repo, text: "first comment" }),
      }),
    );
    expect(added!.status).toBe(200);
    const addedBody = (await added!.json()) as WorktreeCommentAddResponse;
    expect(addedBody.comment.text).toBe("first comment");
    const commentId = addedBody.comment.id;

    const listed = await handler(
      new Request(
        `http://x/ui/v1/worktrees/comments?path=${encodeURIComponent(repo)}`,
      ),
    );
    expect(listed!.status).toBe(200);
    const listedBody = (await listed!.json()) as WorktreeCommentsResponse;
    expect(listedBody.comments.map((c) => c.text)).toEqual(["first comment"]);

    const deleted = await handler(
      new Request("http://x/ui/v1/worktrees/comments", {
        method: "DELETE",
        body: JSON.stringify({ path: repo, commentId }),
      }),
    );
    expect(deleted!.status).toBe(200);
    const deletedBody = (await deleted!.json()) as WorktreeCommentsResponse;
    expect(deletedBody.comments).toEqual([]);
  });

  test("rejects empty comment text", async () => {
    const repo = realpathSync(
      await mkdir(join(tmpHome, "repo"), { recursive: true }).then(
        () => join(tmpHome, "repo"),
      ),
    );
    await registerProjectBySourcePath(repo, {
      filePath: resolve(tmpHome, "projects.json"),
    });
    const handler = await buildHandler(repo);
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/comments", {
        method: "POST",
        body: JSON.stringify({ path: repo, text: "   " }),
      }),
    );
    expect(res!.status).toBe(400);
  });
});
