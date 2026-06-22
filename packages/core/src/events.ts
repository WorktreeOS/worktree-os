export type DeploymentStepId =
  | "prepare"
  | "release-ports"
  | "first-run-setup"
  | "init-script"
  | "compose-up"
  | "status"
  | "healthcheck";

export type StepState = "pending" | "running" | "done" | "failed";

export type LogChannel = "deployment" | "init" | `service:${string}`;
export type LogStream = "stdout" | "stderr";

export interface ServicesDiscoveredContext {
  projectName: string;
  composeFile: string;
  /**
   * Ordered list of Compose files for this session. Populated by compose
   * mode (`[sanitizedBase, overlay]`); generated mode leaves this undefined
   * and consumers fall back to `composeFile`.
   */
  composeFiles?: string[];
}

export type DeploymentEvent =
  | { type: "step"; id: DeploymentStepId; state: StepState; message?: string }
  | { type: "log"; channel: LogChannel; stream: LogStream; chunk: string }
  | {
      type: "services-discovered";
      services: string[];
      composeContext: ServicesDiscoveredContext;
    }
  | {
      type: "volume-clone";
      phase: "start" | "complete";
      path: string;
      index: number;
      total: number;
    }
  | { type: "retry"; attempt: number; maxAttempts: number; reason: string }
  | {
      /**
       * Transient per-poll progress for the readiness-check phase. High
       * frequency and ephemeral — not a reconcilable snapshot state (unlike
       * `healthcheck.changed`). Surfaces "attempt N/M · last: …" on the UI.
       */
      type: "healthcheck-attempt";
      service: string;
      containerPort: number;
      attempt: number;
      maxAttempts: number;
      url: string;
      status?: number;
      error?: string;
      matched: boolean;
    }
  | { type: "complete"; lastUp: string }
  | { type: "failure"; message: string };

export interface DeploymentObserver {
  emit(event: DeploymentEvent): void;
}

export const nullObserver: DeploymentObserver = { emit() {} };

export function logSink(observer: DeploymentObserver, channel: LogChannel) {
  return {
    onStdout: (chunk: string) => observer.emit({ type: "log", channel, stream: "stdout", chunk }),
    onStderr: (chunk: string) => observer.emit({ type: "log", channel, stream: "stderr", chunk }),
  };
}
