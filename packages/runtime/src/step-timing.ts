import type { DeploymentStepId, StepState } from "@worktreeos/core/events";

export interface StepRuntime {
  id: DeploymentStepId;
  label: string;
  state: StepState;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  failureMessage?: string;
}

export interface StepTransition {
  step: StepRuntime;
  /** "start" when entering running, "done"/"fail" on terminal transition. */
  kind: "start" | "done" | "fail";
}

export interface StepTimingConfig {
  order: readonly DeploymentStepId[];
  labels: Readonly<Record<DeploymentStepId, string>>;
  /** Defaults to `() => Date.now()`. Injected for tests. */
  now?: () => number;
}

export class StepTimingTracker {
  private readonly steps = new Map<DeploymentStepId, StepRuntime>();
  private readonly order: readonly DeploymentStepId[];
  private readonly labels: Readonly<Record<DeploymentStepId, string>>;
  private readonly now: () => number;
  private active: DeploymentStepId | null = null;

  constructor(cfg: StepTimingConfig) {
    this.order = cfg.order;
    this.labels = cfg.labels;
    this.now = cfg.now ?? (() => Date.now());
    for (const id of cfg.order) {
      this.steps.set(id, { id, label: this.labels[id]!, state: "pending" });
    }
  }

  /**
   * Apply a step state transition. Returns the resulting runtime + transition
   * kind if the change produced a lifecycle event (start/done/fail). Returns
   * `null` for a no-op (e.g. duplicate state).
   */
  apply(id: DeploymentStepId, state: StepState, message?: string): StepTransition | null {
    const step = this.ensure(id);
    if (step.state === state) return null;
    if (state === "running") {
      step.state = "running";
      step.startedAt = this.now();
      step.finishedAt = undefined;
      step.durationMs = undefined;
      step.failureMessage = undefined;
      this.active = id;
      return { step, kind: "start" };
    }
    if (state === "done" || state === "failed") {
      const finishedAt = this.now();
      step.state = state;
      step.finishedAt = finishedAt;
      if (step.startedAt !== undefined) {
        step.durationMs = Math.max(0, finishedAt - step.startedAt);
      } else {
        step.durationMs = 0;
      }
      if (state === "failed") step.failureMessage = message;
      if (this.active === id) this.active = null;
      return { step, kind: state === "done" ? "done" : "fail" };
    }
    step.state = "pending";
    return null;
  }

  get(id: DeploymentStepId): StepRuntime {
    return this.ensure(id);
  }

  activeStep(): StepRuntime | null {
    if (!this.active) return null;
    return this.steps.get(this.active) ?? null;
  }

  elapsedMs(id: DeploymentStepId, atMs?: number): number {
    const step = this.steps.get(id);
    if (!step || step.startedAt === undefined) return 0;
    const end = step.finishedAt ?? atMs ?? this.now();
    return Math.max(0, end - step.startedAt);
  }

  /** Steps that actually ran (started at least once), in declaration order. */
  ranSteps(): StepRuntime[] {
    const out: StepRuntime[] = [];
    for (const id of this.order) {
      const step = this.steps.get(id)!;
      if (step.startedAt !== undefined) out.push(step);
    }
    return out;
  }

  private ensure(id: DeploymentStepId): StepRuntime {
    let s = this.steps.get(id);
    if (!s) {
      s = { id, label: this.labels[id] ?? id, state: "pending" };
      this.steps.set(id, s);
    }
    return s;
  }
}
