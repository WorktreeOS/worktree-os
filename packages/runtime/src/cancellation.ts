/**
 * Sentinel error thrown when a deployment operation is interrupted by an
 * explicit stop request. The daemon distinguishes this from a genuine
 * deployment failure: a cancelled `up` must not persist a failure marker and
 * must not surface the scary "failed" diagnostic, because a full teardown
 * (`down`) follows immediately to stop whatever already started.
 */
export class DeploymentCancelledError extends Error {
  constructor(message = "deployment stopped by user") {
    super(message);
    this.name = "DeploymentCancelledError";
  }
}

/** Throw `DeploymentCancelledError` when the signal has been aborted. */
export function throwIfDeploymentCancelled(
  signal: AbortSignal | undefined,
): void {
  if (signal?.aborted) throw new DeploymentCancelledError();
}
