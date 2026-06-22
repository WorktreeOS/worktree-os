import { describe, expect, test } from "bun:test";
import {
  applyStepEvent,
  deriveInitDiagnostic,
  formatStepDuration,
  inferEmphasizedChannel,
  selectStepProgress,
  selectWorktreeSurface,
  type InitStepStatus,
} from "../apps/web/src/lib/worktree-view-model";
import type {
  DeploymentStatus,
  OperationMetadata,
  WorktreeDetailResponse,
  WorktreeFailureContext,
} from "../apps/web/src/lib/ui-api";

function detail(opts: {
  status: DeploymentStatus;
  activeOperation?: OperationMetadata;
  failureContext?: WorktreeFailureContext;
}): WorktreeDetailResponse {
  return {
    worktree: {
      path: "/tmp/wt",
      detached: false,
      isSource: false,
      sessionName: "session",
      status: opts.status,
      ...(opts.activeOperation ? { activeOperation: opts.activeOperation } : {}),
    },
    projectId: "p",
    projectName: "p",
    state: opts.status === "not_started" ? null : {
      initialized: true,
      projectName: "p",
      composeFile: "compose.yml",
    },
    services: [],
    appPortHealthchecks: [],
    tunnels: [],
    ...(opts.activeOperation ? { activeOperation: opts.activeOperation } : {}),
    ...(opts.failureContext ? { failureContext: opts.failureContext } : {}),
  };
}

const runningUp: OperationMetadata = {
  operationId: "op",
  kind: "up",
  sessionName: "session",
  status: "running",
  startedAt: "2026-05-20T00:00:00.000Z",
};

const runningServiceStop: OperationMetadata = {
  operationId: "op-stop",
  kind: "service-stop",
  sessionName: "session",
  status: "running",
  startedAt: "2026-05-20T00:00:00.000Z",
};

describe("selectWorktreeSurface", () => {
  test("running worktree opens to overview", () => {
    const s = selectWorktreeSurface({
      detail: detail({ status: "running" }),
      initStep: null,
    });
    expect(s.kind).toBe("overview");
  });

  test("running_partial opens to overview", () => {
    const s = selectWorktreeSurface({
      detail: detail({ status: "running_partial" }),
      initStep: null,
    });
    expect(s.kind).toBe("overview");
  });

  test("stopped opens to overview", () => {
    const s = selectWorktreeSurface({
      detail: detail({ status: "stopped" }),
      initStep: null,
    });
    expect(s.kind).toBe("overview");
  });

  test("unknown opens to overview", () => {
    const s = selectWorktreeSurface({
      detail: detail({ status: "unknown" }),
      initStep: null,
    });
    expect(s.kind).toBe("overview");
  });

  test("not_started without active op shows not-started", () => {
    const s = selectWorktreeSurface({
      detail: detail({ status: "not_started" }),
      initStep: null,
    });
    expect(s.kind).toBe("not-started");
  });

  test("not_started but up in progress shows in-progress", () => {
    const s = selectWorktreeSurface({
      detail: detail({
        status: "not_started",
        activeOperation: runningUp,
      }),
      initStep: null,
    });
    expect(s.kind).toBe("in-progress");
  });

  test("pending shows in-progress", () => {
    const s = selectWorktreeSurface({
      detail: detail({ status: "pending", activeOperation: runningUp }),
      initStep: null,
    });
    expect(s.kind).toBe("in-progress");
  });

  test("checking shows in-progress", () => {
    const s = selectWorktreeSurface({
      detail: detail({ status: "checking", activeOperation: runningUp }),
      initStep: null,
    });
    expect(s.kind).toBe("in-progress");
  });

  test("stopping keeps overview (not in-progress)", () => {
    const s = selectWorktreeSurface({
      detail: detail({
        status: "stopping",
        activeOperation: runningServiceStop,
      }),
      initStep: null,
    });
    expect(s.kind).toBe("overview");
  });

  test("failed status surfaces failure context", () => {
    const s = selectWorktreeSurface({
      detail: detail({
        status: "failed",
        failureContext: {
          message: "boom",
          channel: "init",
          step: "init-script",
        },
      }),
      initStep: null,
    });
    expect(s.kind).toBe("failed");
    if (s.kind === "failed") {
      expect(s.message).toBe("boom");
      expect(s.channel).toBe("init");
      expect(s.step).toBe("init-script");
    }
  });

  test("failed init step surfaces failed even when status not yet 'failed'", () => {
    const failedInit: InitStepStatus = {
      kind: "init-script",
      state: "failed",
    };
    const s = selectWorktreeSurface({
      detail: detail({ status: "stopped" }),
      initStep: failedInit,
    });
    expect(s.kind).toBe("failed");
    if (s.kind === "failed") {
      expect(s.channel).toBe("init");
      expect(s.step).toBe("init-script");
    }
  });

  test("missing failure context leaves failed channel undefined", () => {
    const s = selectWorktreeSurface({
      detail: detail({ status: "failed" }),
      initStep: null,
    });
    expect(s.kind).toBe("failed");
    if (s.kind === "failed") {
      expect(s.channel).toBeUndefined();
      expect(s.step).toBeUndefined();
    }
  });
});

describe("deriveInitDiagnostic", () => {
  test("null → idle", () => {
    expect(deriveInitDiagnostic(null)).toEqual({ kind: "idle" });
  });
  test("running step preserved", () => {
    expect(
      deriveInitDiagnostic({ kind: "first-run-setup", state: "running" }),
    ).toEqual({ kind: "running", step: "first-run-setup" });
  });
  test("done step collapses to succeeded", () => {
    expect(
      deriveInitDiagnostic({ kind: "init-script", state: "done" }),
    ).toEqual({ kind: "succeeded", step: "init-script" });
  });
  test("failed step reports failed", () => {
    expect(
      deriveInitDiagnostic({ kind: "init-script", state: "failed" }),
    ).toEqual({ kind: "failed", step: "init-script" });
  });
});

describe("applyStepEvent / selectStepProgress", () => {
  test("unknown steps default to pending", () => {
    const progress = selectStepProgress(new Map());
    expect(progress.every((p) => p.state === "pending")).toBe(true);
  });

  test("applying step events updates listed entries", () => {
    let state = new Map();
    state = applyStepEvent(state, "prepare", "done");
    state = applyStepEvent(state, "first-run-setup", "running");
    const progress = selectStepProgress(state);
    expect(progress.find((p) => p.id === "prepare")?.state).toBe("done");
    expect(progress.find((p) => p.id === "first-run-setup")?.state).toBe(
      "running",
    );
    expect(progress.find((p) => p.id === "compose-up")?.state).toBe("pending");
  });

  test("step progress order follows DEPLOYMENT_STEP_ORDER", () => {
    const progress = selectStepProgress(new Map());
    expect(progress.map((p) => p.id)).toEqual([
      "prepare",
      "release-ports",
      "first-run-setup",
      "init-script",
      "compose-up",
      "status",
      "healthcheck",
    ]);
  });

  test("records startedAt on running and completedAt on done", () => {
    let state = new Map();
    state = applyStepEvent(
      state,
      "prepare",
      "running",
      "2026-05-20T00:00:01.000Z",
    );
    state = applyStepEvent(
      state,
      "prepare",
      "done",
      "2026-05-20T00:00:04.000Z",
    );
    const entry = selectStepProgress(state).find((p) => p.id === "prepare");
    expect(entry?.startedAt).toBe("2026-05-20T00:00:01.000Z");
    expect(entry?.completedAt).toBe("2026-05-20T00:00:04.000Z");
  });

  test("running step has startedAt but no completedAt", () => {
    let state = new Map();
    state = applyStepEvent(
      state,
      "compose-up",
      "running",
      "2026-05-20T00:00:01.000Z",
    );
    const entry = selectStepProgress(state).find((p) => p.id === "compose-up");
    expect(entry?.startedAt).toBe("2026-05-20T00:00:01.000Z");
    expect(entry?.completedAt).toBeUndefined();
  });

  test("records completedAt on failed", () => {
    let state = new Map();
    state = applyStepEvent(
      state,
      "healthcheck",
      "running",
      "2026-05-20T00:00:01.000Z",
    );
    state = applyStepEvent(
      state,
      "healthcheck",
      "failed",
      "2026-05-20T00:00:10.000Z",
    );
    const entry = selectStepProgress(state).find(
      (p) => p.id === "healthcheck",
    );
    expect(entry?.startedAt).toBe("2026-05-20T00:00:01.000Z");
    expect(entry?.completedAt).toBe("2026-05-20T00:00:10.000Z");
  });

  test("step seen only in a terminal state has no startedAt", () => {
    let state = new Map();
    state = applyStepEvent(
      state,
      "status",
      "done",
      "2026-05-20T00:00:04.000Z",
    );
    const entry = selectStepProgress(state).find((p) => p.id === "status");
    expect(entry?.startedAt).toBeUndefined();
    expect(entry?.completedAt).toBe("2026-05-20T00:00:04.000Z");
  });
});

describe("formatStepDuration", () => {
  test("whole seconds under a minute", () => {
    expect(formatStepDuration(3000)).toBe("3s");
    expect(formatStepDuration(0)).toBe("0s");
    expect(formatStepDuration(59_999)).toBe("59s");
  });

  test("minutes past 60s with zero-padded seconds", () => {
    expect(formatStepDuration(60_000)).toBe("1m00s");
    expect(formatStepDuration(82_000)).toBe("1m22s");
    expect(formatStepDuration(125_000)).toBe("2m05s");
  });

  test("clamps negative input to 0s", () => {
    expect(formatStepDuration(-500)).toBe("0s");
  });

  test("duration computes from start/complete timestamps", () => {
    let state = new Map();
    state = applyStepEvent(
      state,
      "prepare",
      "running",
      "2026-05-20T00:00:01.000Z",
    );
    state = applyStepEvent(
      state,
      "prepare",
      "done",
      "2026-05-20T00:00:04.000Z",
    );
    const entry = selectStepProgress(state).find((p) => p.id === "prepare")!;
    const ms =
      new Date(entry.completedAt!).getTime() -
      new Date(entry.startedAt!).getTime();
    expect(formatStepDuration(ms)).toBe("3s");
  });
});

describe("inferEmphasizedChannel", () => {
  test("failed with explicit channel returns it", () => {
    const channel = inferEmphasizedChannel(
      { kind: "failed", channel: "service:web" },
      null,
    );
    expect(channel).toBe("service:web");
  });

  test("failed without channel + failed init step falls back to init", () => {
    const channel = inferEmphasizedChannel(
      { kind: "failed" },
      { kind: "init-script", state: "failed" },
    );
    expect(channel).toBe("init");
  });

  test("overview never emphasizes a channel", () => {
    const channel = inferEmphasizedChannel({ kind: "overview" }, null);
    expect(channel).toBeNull();
  });
});
