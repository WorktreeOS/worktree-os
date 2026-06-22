import { describe, expect, test } from "bun:test";
import {
  evaluateNotification,
  getNotifyOnDeployFailure,
  setNotifyOnDeployFailure,
  NOTIFY_ON_DEPLOY_FAILURE_KEY,
  type EvaluateContext,
} from "../apps/web/src/lib/deploy-notifications";
import type { UnifiedEventEnvelope } from "../apps/web/src/lib/unified-events";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i) => Array.from(map.keys())[i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
  } as Storage;
}

function deployFailed(
  overrides: Partial<{ sessionName: string; worktreePath: string; message: string }> = {},
): UnifiedEventEnvelope {
  const sessionName = overrides.sessionName ?? "feature-x";
  return {
    id: 1,
    timestamp: "2026-05-30T00:00:00Z",
    type: "deployment.failed",
    sessionName,
    ...(overrides.worktreePath !== undefined
      ? { worktreePath: overrides.worktreePath }
      : {}),
    event: {
      type: "deployment.failed",
      sessionName,
      operationId: "op-1",
      message: overrides.message ?? "compose-up failed",
    },
  };
}

function healthcheckChanged(
  overrides: Partial<{
    sessionName: string;
    service: string;
    previous: string;
    state: string;
    message: string;
  }> = {},
): UnifiedEventEnvelope {
  const sessionName = overrides.sessionName ?? "feature-x";
  return {
    id: 2,
    timestamp: "2026-05-30T00:00:00Z",
    type: "healthcheck.changed",
    sessionName,
    event: {
      type: "healthcheck.changed",
      sessionName,
      service: overrides.service ?? "web",
      containerPort: 3000,
      previous: (overrides.previous ?? "healthy") as never,
      state: (overrides.state ?? "failed") as never,
      ...(overrides.message !== undefined ? { message: overrides.message } : {}),
    },
  } as UnifiedEventEnvelope;
}

const enabledGranted: EvaluateContext = {
  enabled: true,
  permission: "granted",
};

describe("deploy notifications store", () => {
  test("defaults to off and round-trips through storage", () => {
    const storage = memoryStorage();
    expect(getNotifyOnDeployFailure(storage)).toBe(false);
    setNotifyOnDeployFailure(storage, true);
    expect(storage.getItem(NOTIFY_ON_DEPLOY_FAILURE_KEY)).toBe("1");
    expect(getNotifyOnDeployFailure(storage)).toBe(true);
    setNotifyOnDeployFailure(storage, false);
    expect(getNotifyOnDeployFailure(storage)).toBe(false);
  });

  test("missing storage is treated as off", () => {
    expect(getNotifyOnDeployFailure(null)).toBe(false);
  });
});

describe("evaluateNotification gating", () => {
  test("fires for deployment.failed when enabled and granted", () => {
    const plan = evaluateNotification(deployFailed(), enabledGranted);
    expect(plan).not.toBeNull();
    expect(plan!.title).toContain("feature-x");
    expect(plan!.body).toBe("compose-up failed");
    expect(plan!.path).toBe("/worktree?path=feature-x");
  });

  test("uses worktreePath for routing when present", () => {
    const plan = evaluateNotification(
      deployFailed({ worktreePath: "/tmp/wt with space" }),
      enabledGranted,
    );
    expect(plan!.path).toBe(
      "/worktree?path=" + encodeURIComponent("/tmp/wt with space"),
    );
  });

  test("does not fire when opt-in disabled", () => {
    expect(
      evaluateNotification(deployFailed(), {
        ...enabledGranted,
        enabled: false,
      }),
    ).toBeNull();
  });

  test("does not fire when permission denied", () => {
    expect(
      evaluateNotification(deployFailed(), {
        ...enabledGranted,
        permission: "denied",
      }),
    ).toBeNull();
    expect(
      evaluateNotification(deployFailed(), {
        ...enabledGranted,
        permission: "default",
      }),
    ).toBeNull();
  });

  test("suppresses when worktree is foregrounded by path", () => {
    expect(
      evaluateNotification(deployFailed({ worktreePath: "/tmp/wt" }), {
        ...enabledGranted,
        foregroundedWorktreePath: "/tmp/wt",
      }),
    ).toBeNull();
  });

  test("suppresses when worktree is foregrounded by session", () => {
    expect(
      evaluateNotification(deployFailed({ sessionName: "feature-x" }), {
        ...enabledGranted,
        foregroundedSessionName: "feature-x",
      }),
    ).toBeNull();
  });

  test("still fires when a different worktree is foregrounded", () => {
    expect(
      evaluateNotification(deployFailed({ sessionName: "feature-x" }), {
        ...enabledGranted,
        foregroundedSessionName: "other",
      }),
    ).not.toBeNull();
  });
});

describe("evaluateNotification healthcheck transitions", () => {
  test("fires on transition into failed", () => {
    const plan = evaluateNotification(
      healthcheckChanged({ previous: "healthy", state: "failed", service: "api" }),
      enabledGranted,
    );
    expect(plan).not.toBeNull();
    expect(plan!.title).toContain("feature-x");
    expect(plan!.body).toContain("api");
  });

  test("does not fire when already failed (no transition)", () => {
    expect(
      evaluateNotification(
        healthcheckChanged({ previous: "failed", state: "failed" }),
        enabledGranted,
      ),
    ).toBeNull();
  });

  test("does not fire for recovery into healthy", () => {
    expect(
      evaluateNotification(
        healthcheckChanged({ previous: "failed", state: "healthy" }),
        enabledGranted,
      ),
    ).toBeNull();
  });

  test("does not fire for failed-allowed", () => {
    expect(
      evaluateNotification(
        healthcheckChanged({ previous: "healthy", state: "failed-allowed" }),
        enabledGranted,
      ),
    ).toBeNull();
  });
});

describe("evaluateNotification ignores unrelated events", () => {
  test("ignores deployment.completed", () => {
    const env: UnifiedEventEnvelope = {
      id: 3,
      timestamp: "2026-05-30T00:00:00Z",
      type: "deployment.completed",
      sessionName: "feature-x",
      event: {
        type: "deployment.completed",
        sessionName: "feature-x",
        operationId: "op-1",
        lastUp: "2026-05-30T00:00:00Z",
      },
    };
    expect(evaluateNotification(env, enabledGranted)).toBeNull();
  });
});
