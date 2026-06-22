import type { ChannelRegistry } from "./log-buffer";
import type { LogStream } from "@worktreeos/core/events";
import {
  wosPrefix,
  formatDuration,
  type LogSeverity,
} from "./log-format";
import type { StepRuntime, StepTransition } from "@worktreeos/runtime/step-timing";

const DEPLOYMENT: "deployment" = "deployment";
const INIT: "init" = "init";

/** Append a single labeled wos lifecycle line to the deployment channel. */
export function appendWosLine(
  registry: ChannelRegistry,
  severity: LogSeverity,
  text: string,
): void {
  const stream: LogStream =
    severity === "error" || severity === "warn" ? "stderr" : "stdout";
  const line = `${wosPrefix(severity)} ${text}\n`;
  registry.append(DEPLOYMENT, stream, line);
}

/** Record a step lifecycle transition into the deployment channel. */
export function recordStepTransition(
  registry: ChannelRegistry,
  transition: StepTransition,
): void {
  const { step, kind } = transition;
  if (kind === "start") {
    appendWosLine(registry, "info", `→ ${step.label} started`);
    return;
  }
  const dur = formatDuration(step.durationMs ?? 0);
  if (kind === "done") {
    appendWosLine(registry, "success", `✓ ${step.label} done (${dur})`);
    return;
  }
  const msg = step.failureMessage ? `: ${step.failureMessage}` : "";
  appendWosLine(registry, "error", `✗ ${step.label} failed (${dur})${msg}`);
}

/**
 * Stateful mirror for the init channel into the deployment channel. The
 * deployment copy is line-oriented: a labeled "[init]"/"[init err]" line is
 * emitted only when a complete line is available, so partial chunks across
 * multiple calls produce a single labeled line, not duplicates.
 */
export class InitMirror {
  private partial: { stdout: string; stderr: string } = { stdout: "", stderr: "" };

  apply(registry: ChannelRegistry, stream: LogStream, chunk: string): void {
    if (chunk.length === 0) return;
    registry.append(INIT, stream, chunk);
    const prefix = stream === "stderr" ? "[init err]" : "[init]";
    let buffered = this.partial[stream] + chunk;
    this.partial[stream] = "";
    let start = 0;
    for (let i = 0; i < buffered.length; i += 1) {
      if (buffered.charCodeAt(i) === 10 /* \n */) {
        const line = buffered.slice(start, i);
        registry.append(DEPLOYMENT, stream, `${prefix} ${line}\n`);
        start = i + 1;
      }
    }
    if (start < buffered.length) {
      this.partial[stream] = buffered.slice(start);
    }
  }

  /** Flush any pending partial lines into deployment. Useful at stream end. */
  flush(registry: ChannelRegistry): void {
    for (const stream of ["stdout", "stderr"] as const) {
      const pending = this.partial[stream];
      if (pending.length === 0) continue;
      const prefix = stream === "stderr" ? "[init err]" : "[init]";
      registry.append(DEPLOYMENT, stream, `${prefix} ${pending}\n`);
      this.partial[stream] = "";
    }
  }
}

/** Convenience wrapper for callers that don't keep their own state. */
export function mirrorInitLog(
  registry: ChannelRegistry,
  stream: LogStream,
  chunk: string,
  state?: InitMirror,
): void {
  (state ?? new InitMirror()).apply(registry, stream, chunk);
}

/** Compose final timing summary lines for steps that ran. */
export function buildTimingSummary(steps: StepRuntime[]): string[] {
  if (steps.length === 0) return [];
  const lines: string[] = ["[deploy] timing summary:"];
  for (const s of steps) {
    const dur = formatDuration(s.durationMs ?? 0);
    const tag =
      s.state === "failed"
        ? "fail"
        : s.state === "done"
          ? "ok"
          : "running";
    lines.push(`[deploy]   ${s.label} — ${dur} (${tag})`);
  }
  return lines;
}

/** Append the timing summary block to the deployment channel. */
export function appendTimingSummary(
  registry: ChannelRegistry,
  steps: StepRuntime[],
): void {
  const lines = buildTimingSummary(steps);
  if (lines.length === 0) return;
  registry.append(DEPLOYMENT, "stdout", lines.join("\n") + "\n");
}

/** Format a retry event line. */
export function retryLine(attempt: number, maxAttempts: number, reason: string): string {
  return `${wosPrefix("warn")} retry ${attempt}/${maxAttempts} — ${reason}\n`;
}

/** Format a failure event line. */
export function failureLine(message: string): string {
  return `${wosPrefix("error")} ✗ ${message}\n`;
}

/** Format a deployment-complete line. */
export function completeLine(lastUp: string): string {
  return `${wosPrefix("success")} ✓ deployment complete @ ${lastUp}\n`;
}
