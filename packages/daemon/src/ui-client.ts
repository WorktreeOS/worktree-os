import {
  splitEnvelopeStream,
  splitSessionLogStream,
  type SessionLogEnvelope,
  type StreamEnvelope,
} from "./daemon-protocol";
import type {
  DaemonRestartResponse,
  DaemonStopResponse,
  DiffResponse,
  ProjectAddRequest,
  ProjectAddResponse,
  ProjectListResponse,
  ReviewDiffResponse,
  UiHealthResponse,
  WorktreeCommitMessageRequest,
  WorktreeCommitMessageResponse,
  WorktreeDetailResponse,
  WorktreeDownRequest,
  WorktreeDownResponse,
  WorktreeExecRequest,
  WorktreeExecResponse,
  WorktreeGitBranchRequest,
  WorktreeGitBranchResponse,
  WorktreeGitCommitRequest,
  WorktreeGitCommitResponse,
  WorktreeGitFetchRequest,
  WorktreeGitFetchResponse,
  WorktreeGitPushRequest,
  WorktreeGitPushResponse,
  WorktreeGitStageRequest,
  WorktreeGitStageResponse,
  WorktreeRemoveRequest,
  WorktreeRemoveResponse,
  WorktreeUpRequest,
  WorktreeUpResponse,
} from "./ui-protocol";

export interface UiClientOptions {
  /** Base URL for HTTP requests (e.g. http://127.0.0.1:4949). */
  baseUrl?: string;
  /** Override fetch (tests). */
  fetch?: typeof fetch;
}

export class UiApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
  }
}

export class UiSessionBusyError extends UiApiError {}

function buildRequest(
  baseUrl: string | undefined,
  path: string,
  init: RequestInit = {},
): { url: string; init: RequestInit } {
  if (baseUrl) {
    return { url: `${baseUrl.replace(/\/+$/, "")}${path}`, init };
  }
  throw new Error("UiClient requires baseUrl");
}

async function jsonOk<T>(res: Response): Promise<T> {
  if (res.status === 409) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    throw new UiSessionBusyError("session is busy", 409, body);
  }
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const message =
      (body as { message?: string })?.message ?? `request failed (${res.status})`;
    throw new UiApiError(message, res.status, body);
  }
  return (await res.json()) as T;
}

export function createUiClient(opts: UiClientOptions = {}) {
  const baseUrl = opts.baseUrl;
  const doFetch = opts.fetch ?? fetch;

  async function request(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const { url, init: ri } = buildRequest(baseUrl, path, init);
    return doFetch(url, ri);
  }

  return {
    async health(): Promise<UiHealthResponse> {
      return jsonOk(await request("/ui/v1/health"));
    },

    async daemonStop(): Promise<DaemonStopResponse> {
      const res = await request("/ui/v1/daemon/stop", { method: "POST" });
      return jsonOk(res);
    },

    async daemonRestart(): Promise<DaemonRestartResponse> {
      const res = await request("/ui/v1/daemon/restart", { method: "POST" });
      return jsonOk(res);
    },

    async submitDown(req: WorktreeDownRequest): Promise<WorktreeDownResponse> {
      const res = await request("/ui/v1/worktrees/down", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
      return jsonOk(res);
    },

    async listProjects(): Promise<ProjectListResponse> {
      return jsonOk(await request("/ui/v1/projects"));
    },

    async addProject(req: ProjectAddRequest): Promise<ProjectAddResponse> {
      const res = await request("/ui/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
      return jsonOk(res);
    },

    async getWorktreeDetail(path: string): Promise<WorktreeDetailResponse> {
      const res = await request(
        `/ui/v1/worktrees?path=${encodeURIComponent(path)}`,
      );
      return jsonOk(res);
    },

    async submitUp(req: WorktreeUpRequest): Promise<WorktreeUpResponse> {
      const res = await request("/ui/v1/worktrees/up", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
      return jsonOk(res);
    },

    async submitExec(req: WorktreeExecRequest): Promise<WorktreeExecResponse> {
      const res = await request("/ui/v1/worktrees/exec", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
      return jsonOk(res);
    },

    async submitWorktreeRemove(
      req: WorktreeRemoveRequest,
    ): Promise<WorktreeRemoveResponse> {
      const res = await request("/ui/v1/worktrees/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
      return jsonOk(res);
    },

    async getOperation(operationId: string) {
      const res = await request(`/ui/v1/operations/${encodeURIComponent(operationId)}`);
      return jsonOk(res);
    },

    async *streamOperationEvents(
      operationId: string,
      streamOpts: { signal?: AbortSignal } = {},
    ): AsyncGenerator<StreamEnvelope, void, void> {
      const res = await request(
        `/ui/v1/operations/${encodeURIComponent(operationId)}/events`,
        { signal: streamOpts.signal },
      );
      if (!res.ok || !res.body) {
        throw new UiApiError(`event stream failed (${res.status})`, res.status);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { envelopes, rest } = splitEnvelopeStream(buffer);
          buffer = rest;
          for (const env of envelopes) yield env;
        }
        buffer += decoder.decode();
        const { envelopes } = splitEnvelopeStream(buffer);
        for (const env of envelopes) yield env;
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* already released */
        }
      }
    },

    async *streamWorktreeLogs(
      sessionName: string,
      streamOpts: { signal?: AbortSignal } = {},
    ): AsyncGenerator<SessionLogEnvelope, void, void> {
      const res = await request(
        `/ui/v1/worktrees/logs?session=${encodeURIComponent(sessionName)}`,
        { signal: streamOpts.signal },
      );
      if (!res.ok || !res.body) {
        throw new UiApiError(`log stream failed (${res.status})`, res.status);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          let chunk;
          try {
            chunk = await reader.read();
          } catch {
            break;
          }
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const { envelopes, rest } = splitSessionLogStream(buffer);
          buffer = rest;
          for (const env of envelopes) yield env;
        }
        buffer += decoder.decode();
        const { envelopes } = splitSessionLogStream(buffer);
        for (const env of envelopes) yield env;
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* already released */
        }
      }
    },

    async getStagedDiff(path: string): Promise<DiffResponse> {
      const res = await request(
        `/ui/v1/worktrees/diff/staged?path=${encodeURIComponent(path)}`,
      );
      return jsonOk(res);
    },

    async getUnstagedDiff(path: string): Promise<DiffResponse> {
      const res = await request(
        `/ui/v1/worktrees/diff/unstaged?path=${encodeURIComponent(path)}`,
      );
      return jsonOk(res);
    },

    async getReviewDiff(path: string): Promise<ReviewDiffResponse> {
      const res = await request(
        `/ui/v1/worktrees/diff/review?path=${encodeURIComponent(path)}`,
      );
      return jsonOk(res);
    },

    async gitStage(
      req: WorktreeGitStageRequest,
    ): Promise<WorktreeGitStageResponse> {
      const res = await request("/ui/v1/worktrees/git/stage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
      return jsonOk(res);
    },

    async gitUnstage(
      req: WorktreeGitStageRequest,
    ): Promise<WorktreeGitStageResponse> {
      const res = await request("/ui/v1/worktrees/git/unstage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
      return jsonOk(res);
    },

    async gitCommit(
      req: WorktreeGitCommitRequest,
    ): Promise<WorktreeGitCommitResponse> {
      const res = await request("/ui/v1/worktrees/git/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
      return jsonOk(res);
    },

    async gitBranch(
      req: WorktreeGitBranchRequest,
    ): Promise<WorktreeGitBranchResponse> {
      const res = await request("/ui/v1/worktrees/git/branch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
      return jsonOk(res);
    },

    async gitFetch(
      req: WorktreeGitFetchRequest,
    ): Promise<WorktreeGitFetchResponse> {
      const res = await request("/ui/v1/worktrees/git/fetch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
      return jsonOk(res);
    },

    async gitPush(
      req: WorktreeGitPushRequest,
    ): Promise<WorktreeGitPushResponse> {
      const res = await request("/ui/v1/worktrees/git/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
      return jsonOk(res);
    },

    async gitCommitMessage(
      req: WorktreeCommitMessageRequest,
    ): Promise<WorktreeCommitMessageResponse> {
      const res = await request("/ui/v1/worktrees/git/commit-message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
      return jsonOk(res);
    },
  };
}

export type UiClient = ReturnType<typeof createUiClient>;
