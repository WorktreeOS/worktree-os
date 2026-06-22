/**
 * UI API request handlers for the terminal layer.
 *
 * The handlers are exposed at `/ui/v1/terminal-layer/*` so they can be wired
 * alongside the legacy `/ui/v1/terminals/*` routes during the migration. Once
 * the old routes are removed, the prefix collapses to `/ui/v1/terminals/*`.
 *
 * Access policy: terminal endpoints are local-only by default. Callers pass
 * an `isPublicRequest` flag computed from the daemon's public terminal policy
 * — true when a public/tunnel request must be denied (default), false when the
 * request is local OR is public-authenticated and explicitly opted-in via
 * `tunnel.webUi.terminalEnabled`. When true, every route returns 403.
 */

import {
  TerminalSessionManager,
  TerminalSessionManagerError,
} from "./manager";

export interface TerminalApiContext {
  manager: TerminalSessionManager;
  /**
   * True when the caller's public terminal policy says this request must be
   * denied. ui-api.ts sets this to `false` for local requests AND for public
   * requests that pass the authenticated-and-opted-in gate, so api.ts can
   * treat both equivalently.
   */
  isPublicRequest: boolean;
}

export interface TerminalCreateBody {
  worktreePath: unknown;
  cols?: unknown;
  rows?: unknown;
  shell?: unknown;
  cwd?: unknown;
}

export interface TerminalRenameBody {
  /** New title, or `null` / empty-after-trim to clear it. */
  title: unknown;
}

const JSON_HEADERS = { "content-type": "application/json" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function err(status: number, code: string, message: string): Response {
  return json(status, { error: code, message });
}

function forbidden(): Response {
  return err(
    403,
    "forbidden",
    "terminal access is restricted to trusted local clients",
  );
}

function unavailable(reason: string): Response {
  return err(503, "terminal-unavailable", reason);
}

/** GET /terminal-layer/sessions?path=… */
export function handleTerminalList(
  ctx: TerminalApiContext,
  pathArg: string | undefined,
): Response {
  if (ctx.isPublicRequest) return forbidden();
  if (!ctx.manager.isAvailable()) {
    return unavailable(
      `terminal runtime ${ctx.manager.runtimeName()} is not available`,
    );
  }
  return json(200, { sessions: ctx.manager.list(pathArg) });
}

/** GET /terminal-layer/sessions/:id */
export function handleTerminalGet(
  ctx: TerminalApiContext,
  id: string,
): Response {
  if (ctx.isPublicRequest) return forbidden();
  if (!ctx.manager.isAvailable()) {
    return unavailable(
      `terminal runtime ${ctx.manager.runtimeName()} is not available`,
    );
  }
  const meta = ctx.manager.get(id);
  if (!meta) return err(404, "not-found", `terminal session ${id} not found`);
  return json(200, { session: meta });
}

/** POST /terminal-layer/sessions */
export async function handleTerminalCreate(
  ctx: TerminalApiContext,
  body: TerminalCreateBody | null,
): Promise<Response> {
  if (ctx.isPublicRequest) return forbidden();
  if (!ctx.manager.isAvailable()) {
    return unavailable(
      `terminal runtime ${ctx.manager.runtimeName()} is not available`,
    );
  }
  if (!body || typeof body.worktreePath !== "string" || body.worktreePath.length === 0) {
    return err(400, "validation", "worktreePath is required");
  }
  try {
    const meta = await ctx.manager.create({
      worktreePath: body.worktreePath,
      ...(typeof body.cols === "number" ? { cols: body.cols } : {}),
      ...(typeof body.rows === "number" ? { rows: body.rows } : {}),
      ...(typeof body.shell === "string" ? { shell: body.shell } : {}),
      ...(typeof body.cwd === "string" ? { cwd: body.cwd } : {}),
    });
    return json(201, { session: meta });
  } catch (e) {
    if (e instanceof TerminalSessionManagerError) {
      if (e.code === "terminal-unavailable") return unavailable(e.message);
      if (e.code === "cwd-invalid") return err(400, "validation", e.message);
      if (e.code === "not-found") return err(404, "not-found", e.message);
      return err(500, "server-error", e.message);
    }
    return err(500, "server-error", (e as Error).message);
  }
}

/** POST /terminal-layer/sessions/:id/terminate */
export async function handleTerminalTerminate(
  ctx: TerminalApiContext,
  id: string,
  signal?: string,
): Promise<Response> {
  if (ctx.isPublicRequest) return forbidden();
  if (!ctx.manager.isAvailable()) {
    return unavailable(
      `terminal runtime ${ctx.manager.runtimeName()} is not available`,
    );
  }
  try {
    await ctx.manager.terminate(id, signal);
    const meta = ctx.manager.get(id);
    if (!meta) return err(404, "not-found", `terminal session ${id} not found`);
    return json(202, { session: meta });
  } catch (e) {
    if (e instanceof TerminalSessionManagerError && e.code === "not-found") {
      return err(404, "not-found", e.message);
    }
    return err(500, "server-error", (e as Error).message);
  }
}

/** PATCH /terminal-layer/sessions/:id — set or clear the session title. */
export async function handleTerminalRename(
  ctx: TerminalApiContext,
  id: string,
  body: TerminalRenameBody | null,
): Promise<Response> {
  if (ctx.isPublicRequest) return forbidden();
  if (!ctx.manager.isAvailable()) {
    return unavailable(
      `terminal runtime ${ctx.manager.runtimeName()} is not available`,
    );
  }
  if (!body || (typeof body.title !== "string" && body.title !== null)) {
    return err(400, "validation", "title must be a string or null");
  }
  try {
    const meta = await ctx.manager.rename(id, body.title);
    return json(200, { session: meta });
  } catch (e) {
    if (e instanceof TerminalSessionManagerError) {
      if (e.code === "not-found") return err(404, "not-found", e.message);
      if (e.code === "validation") return err(400, "validation", e.message);
      if (e.code === "terminal-unavailable") return unavailable(e.message);
      return err(500, "server-error", e.message);
    }
    return err(500, "server-error", (e as Error).message);
  }
}

/** Convenience helper that returns the right 403 when a terminal route is denied. */
export function buildTerminalForbiddenResponse(): Response {
  return forbidden();
}
