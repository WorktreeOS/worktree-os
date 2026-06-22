import { test, expect, describe } from "bun:test";
import { StepTimingTracker } from "@worktreeos/runtime/step-timing";
import type { DeploymentStepId } from "@worktreeos/core/events";

const ORDER: readonly DeploymentStepId[] = [
  "prepare",
  "release-ports",
  "first-run-setup",
  "init-script",
  "compose-up",
  "status",
  "healthcheck",
];

const LABELS: Record<DeploymentStepId, string> = {
  prepare: "Prepare",
  "release-ports": "Release ports",
  "first-run-setup": "First-run setup",
  "init-script": "Init",
  "compose-up": "Compose up",
  status: "Status",
  healthcheck: "Healthcheck",
};

function makeTracker(times: number[]) {
  let i = 0;
  return new StepTimingTracker({
    order: ORDER,
    labels: LABELS,
    now: () => times[Math.min(i++, times.length - 1)]!,
  });
}

describe("StepTimingTracker", () => {
  test("returns null for duplicate state and records start once", () => {
    const t = makeTracker([100, 100]);
    const first = t.apply("prepare", "running");
    const second = t.apply("prepare", "running");
    expect(first?.kind).toBe("start");
    expect(second).toBeNull();
  });

  test("records duration on done transition", () => {
    const t = makeTracker([1000, 2500]);
    t.apply("prepare", "running");
    const trans = t.apply("prepare", "done");
    expect(trans?.kind).toBe("done");
    expect(trans?.step.durationMs).toBe(1500);
    expect(trans?.step.state).toBe("done");
  });

  test("records duration and failure message on failed transition", () => {
    const t = makeTracker([1000, 4000]);
    t.apply("init-script", "running");
    const trans = t.apply("init-script", "failed", "exit 1");
    expect(trans?.kind).toBe("fail");
    expect(trans?.step.durationMs).toBe(3000);
    expect(trans?.step.failureMessage).toBe("exit 1");
  });

  test("activeStep tracks the latest running step and clears on terminal state", () => {
    const t = makeTracker([0, 10, 20, 30]);
    expect(t.activeStep()).toBeNull();
    t.apply("prepare", "running");
    expect(t.activeStep()?.id).toBe("prepare");
    t.apply("prepare", "done");
    expect(t.activeStep()).toBeNull();
    t.apply("compose-up", "running");
    expect(t.activeStep()?.id).toBe("compose-up");
  });

  test("elapsedMs uses provided 'atMs' when running and finishedAt when done", () => {
    const t = makeTracker([100, 300]);
    t.apply("prepare", "running");
    expect(t.elapsedMs("prepare", 250)).toBe(150);
    t.apply("prepare", "done");
    expect(t.elapsedMs("prepare", 9999)).toBe(200);
  });

  test("ranSteps returns started steps in declaration order", () => {
    const t = makeTracker([100, 200, 300, 400, 500, 600]);
    t.apply("compose-up", "running");
    t.apply("compose-up", "done");
    t.apply("prepare", "running");
    t.apply("prepare", "done");
    const ran = t.ranSteps().map((s) => s.id);
    expect(ran).toEqual(["prepare", "compose-up"]);
  });
});
