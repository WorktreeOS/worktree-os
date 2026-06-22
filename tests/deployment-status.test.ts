import { test, expect, describe } from "bun:test";
import {
  classifyDeploymentStatus,
  serviceSummaryEqual,
  summarizeServices,
} from "@worktreeos/core/deployment-status";

describe("classifyDeploymentStatus", () => {
  test("not initialized → not_started with empty summary", () => {
    const res = classifyDeploymentStatus({
      initialized: false,
      collection: { kind: "not_initialized" },
    });
    expect(res.status).toBe("not_started");
    expect(res.summary).toEqual({
      total: 0,
      running: 0,
      stopped: 0,
      failed: 0,
      checking: 0,
    });
  });

  test("uninitialized + active up running → pending (first-launch override)", () => {
    const res = classifyDeploymentStatus({
      initialized: false,
      activeOperation: { kind: "up", status: "running" },
      collection: { kind: "not_initialized" },
    });
    expect(res.status).toBe("pending");
    expect(res.summary).toEqual({
      total: 0,
      running: 0,
      stopped: 0,
      failed: 0,
      checking: 0,
    });
  });

  test("uninitialized + queued up does not override → not_started", () => {
    const res = classifyDeploymentStatus({
      initialized: false,
      activeOperation: { kind: "up", status: "queued" },
      collection: { kind: "not_initialized" },
    });
    expect(res.status).toBe("not_started");
  });

  test("uninitialized without active op stays not_started", () => {
    const res = classifyDeploymentStatus({
      initialized: false,
      activeOperation: null,
      collection: { kind: "not_initialized" },
    });
    expect(res.status).toBe("not_started");
  });

  test("uninitialized + active down does not flip to pending", () => {
    const res = classifyDeploymentStatus({
      initialized: false,
      activeOperation: { kind: "down", status: "running" },
      collection: { kind: "not_initialized" },
    });
    expect(res.status).toBe("not_started");
  });

  test("uninitialized + last up failed → failed (init script crash)", () => {
    const res = classifyDeploymentStatus({
      initialized: false,
      activeOperation: null,
      latestOperation: { status: "failed" },
      collection: { kind: "not_initialized" },
    });
    expect(res.status).toBe("failed");
    expect(res.summary).toEqual({
      total: 0,
      running: 0,
      stopped: 0,
      failed: 0,
      checking: 0,
    });
  });

  test("uninitialized + last up succeeded keeps not_started", () => {
    const res = classifyDeploymentStatus({
      initialized: false,
      latestOperation: { status: "succeeded" },
      collection: { kind: "not_initialized" },
    });
    expect(res.status).toBe("not_started");
  });

  test("uninitialized + persisted up-failure marker → failed (survives daemon restart)", () => {
    const res = classifyDeploymentStatus({
      initialized: false,
      activeOperation: null,
      latestOperation: null,
      hasPersistedUpFailure: true,
      collection: { kind: "not_initialized" },
    });
    expect(res.status).toBe("failed");
  });

  test("active up overrides a persisted failure marker → pending", () => {
    const res = classifyDeploymentStatus({
      initialized: false,
      activeOperation: { kind: "up", status: "running" },
      hasPersistedUpFailure: true,
      collection: { kind: "not_initialized" },
    });
    expect(res.status).toBe("pending");
  });

  test("active down → stopping with collection summary", () => {
    const res = classifyDeploymentStatus({
      initialized: true,
      activeOperation: { kind: "down", status: "running" },
      collection: {
        kind: "ok",
        services: [{ state: "running" }, { state: "running" }],
      },
    });
    expect(res.status).toBe("stopping");
    expect(res.summary).toEqual({
      total: 2,
      running: 2,
      stopped: 0,
      failed: 0,
      checking: 0,
    });
  });

  test("active service-stop → stopping", () => {
    const res = classifyDeploymentStatus({
      initialized: true,
      activeOperation: { kind: "service-stop", status: "running" },
      collection: {
        kind: "ok",
        services: [{ state: "running" }],
      },
    });
    expect(res.status).toBe("stopping");
  });

  test("active service-restart stays pending (not stopping)", () => {
    const res = classifyDeploymentStatus({
      initialized: true,
      activeOperation: { kind: "service-restart", status: "running" },
      collection: {
        kind: "ok",
        services: [{ state: "running" }],
      },
    });
    expect(res.status).toBe("pending");
  });

  test("active up without healthcheck phase → pending", () => {
    const res = classifyDeploymentStatus({
      initialized: true,
      activeOperation: { kind: "up", status: "running" },
      collection: { kind: "uncollected" },
    });
    expect(res.status).toBe("pending");
  });

  test("active up during healthcheck phase → checking", () => {
    const res = classifyDeploymentStatus({
      initialized: true,
      activeOperation: { kind: "up", status: "running" },
      isHealthcheckPhase: true,
      collection: {
        kind: "ok",
        services: [{ state: "running" }],
        healthchecks: [{ state: "waiting" }],
      },
    });
    expect(res.status).toBe("checking");
    expect(res.summary).toEqual({
      total: 1,
      running: 1,
      stopped: 0,
      failed: 0,
      checking: 0,
    });
  });

  test("all services running, no healthchecks → running", () => {
    const res = classifyDeploymentStatus({
      initialized: true,
      collection: {
        kind: "ok",
        services: [{ state: "running" }, { state: "running" }],
      },
    });
    expect(res.status).toBe("running");
    expect(res.summary?.running).toBe(2);
    expect(res.summary?.total).toBe(2);
  });

  test("partial running (one stopped) → running_partial", () => {
    const res = classifyDeploymentStatus({
      initialized: true,
      collection: {
        kind: "ok",
        services: [{ state: "running" }, { state: "stopped" }],
      },
    });
    expect(res.status).toBe("running_partial");
    expect(res.summary?.running).toBe(1);
    expect(res.summary?.total).toBe(2);
  });

  test("all running but one healthcheck failed → running_partial", () => {
    const res = classifyDeploymentStatus({
      initialized: true,
      collection: {
        kind: "ok",
        services: [{ state: "running" }, { state: "running" }],
        healthchecks: [{ state: "healthy" }, { state: "failed" }],
      },
    });
    expect(res.status).toBe("running_partial");
  });

  test("all running but healthcheck waiting outside up-phase → running_partial", () => {
    const res = classifyDeploymentStatus({
      initialized: true,
      collection: {
        kind: "ok",
        services: [{ state: "running" }],
        healthchecks: [{ state: "waiting" }],
      },
    });
    expect(res.status).toBe("running_partial");
  });

  test("service in failure state with no running → failed", () => {
    const res = classifyDeploymentStatus({
      initialized: true,
      collection: {
        kind: "ok",
        services: [{ state: "exited" }],
      },
    });
    expect(res.status).toBe("failed");
    expect(res.summary?.failed).toBe(1);
  });

  test("service failed but another running → running_partial", () => {
    const res = classifyDeploymentStatus({
      initialized: true,
      collection: {
        kind: "ok",
        services: [{ state: "running" }, { state: "exited" }],
      },
    });
    expect(res.status).toBe("running_partial");
  });

  test("services list empty after collection → stopped", () => {
    const res = classifyDeploymentStatus({
      initialized: true,
      collection: { kind: "no_services" },
    });
    expect(res.status).toBe("stopped");
    expect(res.summary?.total).toBe(0);
  });

  test("uncollected state → unknown without summary", () => {
    const res = classifyDeploymentStatus({
      initialized: true,
      collection: { kind: "uncollected" },
    });
    expect(res.status).toBe("unknown");
    expect(res.summary).toBeUndefined();
  });

  test("disabled/failed-allowed healthchecks do not degrade running", () => {
    const res = classifyDeploymentStatus({
      initialized: true,
      collection: {
        kind: "ok",
        services: [{ state: "running" }],
        healthchecks: [{ state: "disabled" }, { state: "failed-allowed" }],
      },
    });
    expect(res.status).toBe("running");
  });
});

describe("summarizeServices", () => {
  test("counts running/stopped/failed/checking buckets", () => {
    const s = summarizeServices([
      { state: "running" },
      { state: "exited" },
      { state: "starting" },
      { state: "paused" },
    ]);
    expect(s).toEqual({
      total: 4,
      running: 1,
      stopped: 0,
      failed: 1,
      checking: 2,
    });
  });
});

describe("serviceSummaryEqual", () => {
  test("returns true for matching summaries", () => {
    expect(
      serviceSummaryEqual(
        { total: 3, running: 2, stopped: 1, failed: 0, checking: 0 },
        { total: 3, running: 2, stopped: 1, failed: 0, checking: 0 },
      ),
    ).toBe(true);
  });
  test("returns false when fields differ", () => {
    expect(
      serviceSummaryEqual(
        { total: 3, running: 2, stopped: 1, failed: 0, checking: 0 },
        { total: 3, running: 3, stopped: 0, failed: 0, checking: 0 },
      ),
    ).toBe(false);
  });
  test("handles undefined", () => {
    expect(serviceSummaryEqual(undefined, undefined)).toBe(true);
    expect(
      serviceSummaryEqual(undefined, {
        total: 0,
        running: 0,
        stopped: 0,
        failed: 0,
        checking: 0,
      }),
    ).toBe(false);
  });
});
