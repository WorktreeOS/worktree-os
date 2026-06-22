import { test, expect, describe } from "bun:test";
import { ChannelRegistry } from "@worktreeos/ui/log-buffer";
import {
  appendWosLine,
  appendTimingSummary,
  buildTimingSummary,
  completeLine,
  failureLine,
  InitMirror,
  mirrorInitLog,
  recordStepTransition,
  retryLine,
} from "@worktreeos/ui/deployment-log";
import type { StepRuntime } from "@worktreeos/runtime/step-timing";

function makeRegistry() {
  return new ChannelRegistry(100, [
    { id: "deployment", label: "deployment" },
    { id: "init", label: "init" },
  ]);
}

describe("appendWosLine", () => {
  test("info/success go to stdout, warn/error go to stderr with labeled prefix", () => {
    const reg = makeRegistry();
    appendWosLine(reg, "info", "starting");
    appendWosLine(reg, "success", "ok");
    appendWosLine(reg, "warn", "careful");
    appendWosLine(reg, "error", "broken");
    const lines = reg.snapshot("deployment");
    expect(lines.map((l) => ({ stream: l.stream, text: l.text }))).toEqual([
      { stream: "stdout", text: "[deploy] starting" },
      { stream: "stdout", text: "[ok] ok" },
      { stream: "stderr", text: "[warn] careful" },
      { stream: "stderr", text: "[fail] broken" },
    ]);
  });
});

describe("recordStepTransition", () => {
  const baseStep: StepRuntime = {
    id: "prepare",
    label: "Prepare",
    state: "running",
    startedAt: 0,
  };

  test("start emits a → line", () => {
    const reg = makeRegistry();
    recordStepTransition(reg, { kind: "start", step: { ...baseStep } });
    expect(reg.snapshot("deployment")[0]!.text).toBe("[deploy] → Prepare started");
  });

  test("done emits a ✓ line with duration", () => {
    const reg = makeRegistry();
    recordStepTransition(reg, {
      kind: "done",
      step: { ...baseStep, state: "done", durationMs: 1500 },
    });
    expect(reg.snapshot("deployment")[0]!.text).toBe("[ok] ✓ Prepare done (1.5s)");
  });

  test("fail emits ✗ with duration and failure message", () => {
    const reg = makeRegistry();
    recordStepTransition(reg, {
      kind: "fail",
      step: {
        ...baseStep,
        state: "failed",
        durationMs: 2000,
        failureMessage: "exit 1",
      },
    });
    const line = reg.snapshot("deployment")[0]!;
    expect(line.stream).toBe("stderr");
    expect(line.text).toBe("[fail] ✗ Prepare failed (2s): exit 1");
  });
});

describe("mirrorInitLog", () => {
  test("appends raw chunk to init and labeled lines to deployment", () => {
    const reg = makeRegistry();
    mirrorInitLog(reg, "stdout", "hello\nworld\n");
    expect(reg.snapshot("init").map((l) => l.text)).toEqual(["hello", "world"]);
    expect(reg.snapshot("deployment").map((l) => l.text)).toEqual([
      "[init] hello",
      "[init] world",
    ]);
  });

  test("stderr chunks use [init err] prefix and stderr stream in deployment", () => {
    const reg = makeRegistry();
    mirrorInitLog(reg, "stderr", "boom\n");
    const dep = reg.snapshot("deployment");
    expect(dep[0]).toEqual({ stream: "stderr", text: "[init err] boom" });
  });

  test("empty chunks are ignored", () => {
    const reg = makeRegistry();
    mirrorInitLog(reg, "stdout", "");
    expect(reg.snapshot("init")).toEqual([]);
    expect(reg.snapshot("deployment")).toEqual([]);
  });

  test("InitMirror preserves partial trailing line across calls (no duplicates)", () => {
    const reg = makeRegistry();
    const mirror = new InitMirror();
    mirror.apply(reg, "stdout", "part");
    mirror.apply(reg, "stdout", "ial\n");
    expect(reg.snapshot("init").map((l) => l.text)).toEqual(["partial"]);
    expect(reg.snapshot("deployment").map((l) => l.text)).toEqual(["[init] partial"]);
  });

  test("InitMirror.flush emits the pending partial line", () => {
    const reg = makeRegistry();
    const mirror = new InitMirror();
    mirror.apply(reg, "stdout", "no-newline");
    expect(reg.snapshot("deployment")).toEqual([]);
    mirror.flush(reg);
    expect(reg.snapshot("deployment").map((l) => l.text)).toEqual(["[init] no-newline"]);
  });

  test("InitMirror separates stdout and stderr partial lines", () => {
    const reg = makeRegistry();
    const mirror = new InitMirror();
    mirror.apply(reg, "stdout", "out");
    mirror.apply(reg, "stderr", "err\n");
    mirror.apply(reg, "stdout", "put\n");
    expect(reg.snapshot("deployment").map((l) => ({ stream: l.stream, text: l.text }))).toEqual([
      { stream: "stderr", text: "[init err] err" },
      { stream: "stdout", text: "[init] output" },
    ]);
  });

  test("mirroring does not grow buffers past capacity", () => {
    const reg = new ChannelRegistry(3, [
      { id: "deployment", label: "deployment" },
      { id: "init", label: "init" },
    ]);
    for (let i = 0; i < 20; i += 1) mirrorInitLog(reg, "stdout", `line-${i}\n`);
    expect(reg.snapshot("init").length).toBeLessThanOrEqual(3);
    expect(reg.snapshot("deployment").length).toBeLessThanOrEqual(3);
  });
});

describe("retry/failure/complete lines", () => {
  test("retryLine uses warn prefix and includes attempt counters", () => {
    expect(retryLine(2, 3, "port busy")).toBe("[warn] retry 2/3 — port busy\n");
  });

  test("failureLine uses fail prefix", () => {
    expect(failureLine("everything")).toBe("[fail] ✗ everything\n");
  });

  test("completeLine uses ok prefix and timestamp", () => {
    expect(completeLine("2026-01-01T00:00:00Z")).toBe(
      "[ok] ✓ deployment complete @ 2026-01-01T00:00:00Z\n",
    );
  });
});

describe("buildTimingSummary / appendTimingSummary", () => {
  const steps: StepRuntime[] = [
    {
      id: "prepare",
      label: "Prepare",
      state: "done",
      startedAt: 0,
      finishedAt: 1500,
      durationMs: 1500,
    },
    {
      id: "compose-up",
      label: "Compose",
      state: "done",
      startedAt: 2000,
      finishedAt: 5500,
      durationMs: 3500,
    },
  ];

  test("buildTimingSummary returns one header + one line per step", () => {
    expect(buildTimingSummary(steps)).toEqual([
      "[deploy] timing summary:",
      "[deploy]   Prepare — 1.5s (ok)",
      "[deploy]   Compose — 3.5s (ok)",
    ]);
  });

  test("buildTimingSummary returns empty when no steps ran", () => {
    expect(buildTimingSummary([])).toEqual([]);
  });

  test("appendTimingSummary writes a single multi-line entry to deployment", () => {
    const reg = makeRegistry();
    appendTimingSummary(reg, steps);
    const lines = reg.snapshot("deployment").map((l) => l.text);
    expect(lines).toEqual([
      "[deploy] timing summary:",
      "[deploy]   Prepare — 1.5s (ok)",
      "[deploy]   Compose — 3.5s (ok)",
    ]);
  });
});
