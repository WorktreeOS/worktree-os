import type {
  DeploymentEvent,
  DeploymentObserver,
  DeploymentStepId,
  LogChannel,
  LogStream,
} from "@worktreeos/core/events";
import type { DeploymentMode } from "@worktreeos/core/config";
import type { Renderer } from "./renderer";

const STEP_LABELS: Record<DeploymentStepId, string> = {
  prepare: "Prepare",
  "release-ports": "Release previous ports",
  "first-run-setup": "First-run setup",
  "init-script": "Init script",
  "compose-up": "docker compose up",
  status: "Collect service status",
  healthcheck: "App-port healthchecks",
};

/**
 * Resolve the display label for a deployment step. The `compose-up` step starts
 * services; shell mode does not use Docker Compose, so it gets a neutral label
 * instead of "docker compose up".
 */
function stepLabel(id: DeploymentStepId, mode?: DeploymentMode): string {
  if (id === "compose-up" && mode === "shell") return "Start services";
  return STEP_LABELS[id] ?? id;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 100;

export interface DetachedRendererOptions {
  out?: (text: string) => void;
  err?: (text: string) => void;
  /** Force on/off line-clearing spinner output (default: auto via stderr TTY). */
  spinnerEnabled?: boolean;
  spinnerIntervalMs?: number;
  /** When false (default), `start()` schedules a setInterval to advance frames. */
  manualSpinner?: boolean;
  /** Resolved deployment mode; selects backend-appropriate step labels. */
  mode?: DeploymentMode;
}

export interface DetachedRendererTesting {
  /** Advance and emit one spinner frame; returns the frame written. */
  tick(): string | null;
  hasActiveSpinner(): boolean;
}

export interface DetachedRenderer extends Renderer {
  /** Internal helpers exposed for tests. */
  __test: DetachedRendererTesting;
}

export function detachedRenderer(
  opts: DetachedRendererOptions = {},
): DetachedRenderer {
  const out = opts.out ?? ((t: string) => process.stdout.write(t));
  const err = opts.err ?? ((t: string) => process.stderr.write(t));
  const spinnerEnabled =
    opts.spinnerEnabled ??
    (typeof process !== "undefined" && Boolean(process.stderr?.isTTY));
  const intervalMs = opts.spinnerIntervalMs ?? SPINNER_INTERVAL_MS;
  const manualSpinner = opts.manualSpinner === true;

  let spinnerLabel: string | null = null;
  let spinnerFrame = 0;
  let spinnerInterval: ReturnType<typeof setInterval> | null = null;
  let spinnerLineActive = false;

  const clearSpinnerLine = (): void => {
    if (!spinnerEnabled || !spinnerLineActive) return;
    err("\r\x1b[2K");
    spinnerLineActive = false;
  };

  const emitSpinnerFrame = (): string | null => {
    if (!spinnerEnabled || spinnerLabel === null) return null;
    const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!;
    err(`\r\x1b[2K${frame} ${spinnerLabel}`);
    spinnerFrame += 1;
    spinnerLineActive = true;
    return frame;
  };

  const startSpinner = (label: string): void => {
    spinnerLabel = label;
    spinnerFrame = 0;
    if (!spinnerEnabled) return;
    emitSpinnerFrame();
    if (manualSpinner) return;
    if (spinnerInterval) clearInterval(spinnerInterval);
    spinnerInterval = setInterval(() => emitSpinnerFrame(), intervalMs);
    if (typeof spinnerInterval === "object" && spinnerInterval !== null) {
      (spinnerInterval as { unref?: () => void }).unref?.();
    }
  };

  const stopSpinner = (): void => {
    if (spinnerInterval) {
      clearInterval(spinnerInterval);
      spinnerInterval = null;
    }
    clearSpinnerLine();
    spinnerLabel = null;
    spinnerFrame = 0;
  };

  const writeLine = (sink: (text: string) => void, line: string): void => {
    clearSpinnerLine();
    sink(line.endsWith("\n") ? line : `${line}\n`);
  };

  const writeChunk = (
    sink: (text: string) => void,
    chunk: string,
  ): void => {
    if (chunk.length === 0) return;
    clearSpinnerLine();
    sink(chunk);
    if (spinnerLabel !== null) emitSpinnerFrame();
  };

  const observer: DeploymentObserver = {
    emit(event: DeploymentEvent) {
      switch (event.type) {
        case "step":
          handleStepEvent(event);
          return;
        case "retry":
          writeLine(
            err,
            `[retry ${event.attempt}/${event.maxAttempts}] ${event.reason}`,
          );
          return;
        case "log":
          handleLogEvent(event.channel, event.stream, event.chunk);
          return;
        case "volume-clone":
          if (event.phase === "start") {
            writeLine(
              err,
              `[clone ${event.index}/${event.total}] copying ${event.path}...`,
            );
          }
          return;
        case "failure":
          stopSpinner();
          writeLine(err, `[failure] ${event.message}`);
          return;
        case "services-discovered":
        case "complete":
          return;
      }
    },
  };

  function handleStepEvent(
    event: Extract<DeploymentEvent, { type: "step" }>,
  ): void {
    const label = stepLabel(event.id, opts.mode);
    if (event.state === "running") {
      writeLine(err, `▸ ${label}`);
      startSpinner(label);
      return;
    }
    if (event.state === "done") {
      stopSpinner();
      writeLine(err, `✓ ${label}`);
      return;
    }
    if (event.state === "failed") {
      stopSpinner();
      const suffix = event.message ? `: ${event.message}` : "";
      writeLine(err, `✗ ${label}${suffix}`);
    }
  }

  function handleLogEvent(
    channel: LogChannel,
    stream: LogStream,
    chunk: string,
  ): void {
    if (channel === "deployment") {
      // Suppress deployment stdout in detached mode: it carries the raw
      // `docker compose ps --format json` dump and the daemon-side
      // `formatStatus(...)` echo, both of which the CLI prints (or
      // intentionally replaces) explicitly. Keep stderr so real compose
      // errors stay visible.
      if (stream === "stderr") writeChunk(err, chunk);
      return;
    }
    if (channel === "init") {
      writeChunk(stream === "stderr" ? err : out, chunk);
      return;
    }
    // service:* — detached mode normally exits before service logs, but
    // forward what we receive while still alive to keep parity with plain.
    writeChunk(stream === "stderr" ? err : out, chunk);
  }

  return {
    observer,
    stdout: (text) => writeChunk(out, text),
    start() {},
    stop() {
      stopSpinner();
    },
    __test: {
      tick: () => emitSpinnerFrame(),
      hasActiveSpinner: () => spinnerLabel !== null,
    },
  };
}
