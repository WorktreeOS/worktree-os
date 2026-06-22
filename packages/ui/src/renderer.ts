import { nullObserver, type DeploymentEvent, type DeploymentObserver } from "@worktreeos/core/events";

/**
 * Minimal interface for deployment progress renderers. Used by non-interactive
 * paths: `plainRenderer` (for CI/pipe) and `detachedRenderer` (for foreground
 * `wos up`). All renderers are text-only, without a TTY UI.
 */
export interface Renderer {
  observer: DeploymentObserver;
  stdout: (text: string) => void;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}

export function isTty(stream: NodeJS.WriteStream = process.stdout): boolean {
  return Boolean(stream.isTTY);
}

export function plainRenderer(): Renderer {
  const writeStderr = (text: string) => process.stderr.write(text);
  const observer: DeploymentObserver = {
    emit(event: DeploymentEvent) {
      switch (event.type) {
        case "step":
          if (event.state === "running" || event.state === "done" || event.state === "failed") {
            writeStderr(`[step ${event.id}] ${event.state}${event.message ? `: ${event.message}` : ""}\n`);
          }
          break;
        case "log":
          // Plain mode mirrors compose lifecycle and init logs onto the
          // corresponding standard stream so existing scripts keep working.
          if (event.stream === "stderr") writeStderr(event.chunk);
          else process.stdout.write(event.chunk);
          break;
        case "retry":
          writeStderr(`[retry ${event.attempt}/${event.maxAttempts}] ${event.reason}\n`);
          break;
        case "volume-clone":
          if (event.phase === "start") {
            writeStderr(
              `[clone ${event.index}/${event.total}] copying ${event.path}...\n`,
            );
          }
          break;
        case "failure":
          writeStderr(`[failure] ${event.message}\n`);
          break;
        // services-discovered/complete are not printed: final status table is
        // emitted by runUpProgram through stdout()
        case "services-discovered":
        case "complete":
          break;
      }
    },
  };
  return {
    observer,
    stdout: (text) => process.stdout.write(text),
    start() {},
    stop() {},
  };
}

// Re-export the null observer for callers that need a no-op observer.
export { nullObserver };
