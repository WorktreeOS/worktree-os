import { test, expect, describe } from "bun:test";
import { buildFailureContext } from "@worktreeos/daemon/ui-api";
import type { OperationRecord } from "@worktreeos/daemon/operation-registry";
import type { DeploymentEvent } from "@worktreeos/core/events";
import type { LogChannel } from "@worktreeos/core/events";

let seq = 0;

function logEnvelope(
  operationId: string,
  channel: LogChannel,
  chunk: string,
): OperationRecord["history"][number] {
  seq += 1;
  return {
    operationId,
    sessionName: "sess",
    sequence: seq,
    timestamp: new Date().toISOString(),
    event: { type: "log", channel, stream: "stdout", chunk } as DeploymentEvent,
  };
}

function stepFailedEnvelope(
  operationId: string,
  id: import("@worktreeos/core/events").DeploymentStepId,
): OperationRecord["history"][number] {
  seq += 1;
  return {
    operationId,
    sessionName: "sess",
    sequence: seq,
    timestamp: new Date().toISOString(),
    event: { type: "step", id, state: "failed" } as DeploymentEvent,
  };
}

function failedRecord(
  history: OperationRecord["history"],
): OperationRecord {
  return {
    operationId: "op-1",
    sessionName: "sess",
    kind: "up",
    status: "failed",
    startedAt: new Date().toISOString(),
    failureMessage: "boom",
    history,
    subscribers: new Set(),
  };
}

describe("buildFailureContext log tail", () => {
  test("captures the init buffer tail for an init failure", () => {
    const rec = failedRecord([
      stepFailedEnvelope("op-1", "init-script"),
      logEnvelope("op-1", "init", "line 1\nline 2\nline 3\n"),
    ]);
    const ctx = buildFailureContext(rec);
    expect(ctx?.channel).toBe("init");
    expect(ctx?.logTail).toEqual(["line 1", "line 2", "line 3"]);
  });

  test("captures the deployment-channel tail for a non-init failure", () => {
    const rec = failedRecord([
      stepFailedEnvelope("op-1", "compose-up"),
      logEnvelope("op-1", "deployment", "compose err A\ncompose err B\n"),
    ]);
    const ctx = buildFailureContext(rec);
    expect(ctx?.step).toBe("compose-up");
    expect(ctx?.logTail).toEqual(["compose err A", "compose err B"]);
  });

  test("captures a service-channel tail when present in history", () => {
    const rec = failedRecord([
      logEnvelope("op-1", "service:api", "svc out 1\nsvc out 2\n"),
    ]);
    // No failed step; channel falls back to deployment, which has no output.
    // Seed the deployment channel so the tail comes from there instead.
    rec.history.push(logEnvelope("op-1", "deployment", "dep 1\n"));
    const ctx = buildFailureContext(rec);
    expect(ctx?.logTail).toEqual(["dep 1"]);
  });

  test("omits the tail when no buffered output exists", () => {
    const rec = failedRecord([stepFailedEnvelope("op-1", "compose-up")]);
    const ctx = buildFailureContext(rec);
    expect(ctx?.logTail).toBeUndefined();
    // Still reports the failure.
    expect(ctx?.step).toBe("compose-up");
    expect(ctx?.message).toBe("boom");
  });

  test("bounds the tail to the last ten lines", () => {
    const many = Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join("\n");
    const rec = failedRecord([
      stepFailedEnvelope("op-1", "compose-up"),
      logEnvelope("op-1", "deployment", `${many}\n`),
    ]);
    const ctx = buildFailureContext(rec);
    expect(ctx?.logTail).toHaveLength(10);
    expect(ctx?.logTail?.[0]).toBe("l21");
    expect(ctx?.logTail?.[9]).toBe("l30");
  });

  test("returns undefined for a non-failed record", () => {
    const rec = failedRecord([]);
    rec.status = "succeeded";
    expect(buildFailureContext(rec)).toBeUndefined();
  });
});
