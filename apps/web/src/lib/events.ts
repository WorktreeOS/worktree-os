// Mirrors @worktreeos/core/events deployment event shapes that we render in the
// web UI. Hand-maintained to avoid pulling node-only code into the browser
// bundle.

export type LogStream = "stdout" | "stderr";

export type DeploymentStepId =
  | "prepare"
  | "release-ports"
  | "first-run-setup"
  | "init-script"
  | "compose-up"
  | "status"
  | "healthcheck";

export type DeploymentStepState = "running" | "done" | "failed";

export type DeploymentEvent =
  | { type: "step"; id: DeploymentStepId; state: DeploymentStepState; message?: string }
  | { type: "log"; channel: string; stream: LogStream; chunk: string }
  | { type: "retry"; attempt: number; maxAttempts: number; reason: string }
  | { type: "complete"; lastUp: string }
  | { type: "failure"; message: string }
  | { type: "services-discovered"; services: string[]; composeContext: { projectName: string; composeFile: string } }
  | { type: "volume-clone"; phase: "start" | "complete"; path: string; index: number; total: number };
