import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleTerminalCreate,
  handleTerminalGet,
  handleTerminalList,
  handleTerminalRename,
  handleTerminalTerminate,
  type TerminalApiContext,
} from "@worktreeos/daemon/terminal-layer/api";
import { TerminalSessionManager } from "@worktreeos/daemon/terminal-layer/manager";
import { createFakeTerminalRuntime } from "@worktreeos/daemon/terminal-layer/testing";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "wos-tlayer-api-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function makeCtx(opts: { isPublic?: boolean; available?: boolean } = {}): {
  ctx: TerminalApiContext;
  mgr: TerminalSessionManager;
} {
  const r = createFakeTerminalRuntime();
  if (opts.available === false) r.setAvailable(false);
  const mgr = new TerminalSessionManager({ runtime: r.runtime });
  return {
    ctx: { manager: mgr, isPublicRequest: opts.isPublic === true },
    mgr,
  };
}

describe("terminal-layer API: list", () => {
  test("returns 403 for public requests", async () => {
    const { ctx } = makeCtx({ isPublic: true });
    const res = handleTerminalList(ctx, undefined);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("forbidden");
  });

  test("allows requests when policy marks them non-public (local or opted-in public)", () => {
    const { ctx } = makeCtx({ isPublic: false });
    const res = handleTerminalList(ctx, undefined);
    expect(res.status).toBe(200);
  });

  test("returns 503 when runtime is unavailable", () => {
    const { ctx } = makeCtx({ available: false });
    const res = handleTerminalList(ctx, undefined);
    expect(res.status).toBe(503);
  });

  test("returns the manager's sessions filtered by path", async () => {
    const { ctx, mgr } = makeCtx();
    await mgr.create({ worktreePath: tmp });
    const res = handleTerminalList(ctx, tmp);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: { id: string }[] };
    expect(body.sessions).toHaveLength(1);
  });
});

describe("terminal-layer API: create", () => {
  test("denies public requests", async () => {
    const { ctx } = makeCtx({ isPublic: true });
    const res = await handleTerminalCreate(ctx, { worktreePath: tmp });
    expect(res.status).toBe(403);
  });

  test("rejects body missing worktreePath", async () => {
    const { ctx } = makeCtx();
    const res = await handleTerminalCreate(ctx, { worktreePath: 42 } as any);
    expect(res.status).toBe(400);
  });

  test("creates a session and returns metadata without history", async () => {
    const { ctx } = makeCtx();
    const res = await handleTerminalCreate(ctx, { worktreePath: tmp });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { session: { id: string; status: string } };
    expect(body.session.id).toBeDefined();
    expect(body.session.status).toBe("running");
    // The response MUST NOT carry PTY output history.
    expect((body.session as any).history).toBeUndefined();
  });

  test("returns 400 when cwd escapes worktree", async () => {
    const { ctx } = makeCtx();
    const res = await handleTerminalCreate(ctx, {
      worktreePath: tmp,
      cwd: tmpdir(),
    });
    expect(res.status).toBe(400);
  });
});

describe("terminal-layer API: get / terminate", () => {
  test("get returns 404 for unknown id", () => {
    const { ctx } = makeCtx();
    const res = handleTerminalGet(ctx, "missing");
    expect(res.status).toBe(404);
  });

  test("terminate transitions the session and returns updated metadata", async () => {
    const { ctx, mgr } = makeCtx();
    const meta = await mgr.create({ worktreePath: tmp });
    const res = await handleTerminalTerminate(ctx, meta.id);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { session: { status: string } };
    expect(["terminating", "running", "exited"]).toContain(body.session.status);
  });
});

describe("terminal-layer API: rename", () => {
  test("denies public requests", async () => {
    const { ctx } = makeCtx({ isPublic: true });
    const res = await handleTerminalRename(ctx, "anything", { title: "x" });
    expect(res.status).toBe(403);
  });

  test("sets a title and returns the updated session metadata", async () => {
    const { ctx, mgr } = makeCtx();
    const meta = await mgr.create({ worktreePath: tmp });
    const res = await handleTerminalRename(ctx, meta.id, { title: " api logs " });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { title?: string } };
    expect(body.session.title).toBe("api logs");
  });

  test("clears a title when given null", async () => {
    const { ctx, mgr } = makeCtx();
    const meta = await mgr.create({ worktreePath: tmp });
    await handleTerminalRename(ctx, meta.id, { title: "named" });
    const res = await handleTerminalRename(ctx, meta.id, { title: null });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { title?: string } };
    expect(body.session.title).toBeUndefined();
  });

  test("returns 404 for an unknown session id", async () => {
    const { ctx } = makeCtx();
    const res = await handleTerminalRename(ctx, "missing", { title: "x" });
    expect(res.status).toBe(404);
  });

  test("returns 400 for a non-string, non-null title", async () => {
    const { ctx, mgr } = makeCtx();
    const meta = await mgr.create({ worktreePath: tmp });
    const res = await handleTerminalRename(ctx, meta.id, { title: 42 } as never);
    expect(res.status).toBe(400);
  });

  test("returns 400 for a control-character title", async () => {
    const { ctx, mgr } = makeCtx();
    const meta = await mgr.create({ worktreePath: tmp });
    const res = await handleTerminalRename(ctx, meta.id, {
      title: "bad\u0007title",
    });
    expect(res.status).toBe(400);
  });
});
