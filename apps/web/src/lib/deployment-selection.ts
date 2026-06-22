/**
 * Selection payload submitted by the Web UI deployment modal. Each field is
 * optional: the daemon treats missing fields as defaults (all services, no
 * runtime arguments).
 */
export type DeploymentActionSelection = {
  services?: string[];
  target?: string;
  arguments?: Record<string, string>;
};

export type DeploymentSelectMode = "all" | "target" | "custom";

export interface BuildDeploymentSelectionInput {
  hasGenerated: boolean;
  selectMode: DeploymentSelectMode;
  selectedTarget: string;
  selectedServices: ReadonlySet<string>;
  argumentNames: ReadonlyArray<string>;
  argumentValues: Readonly<Record<string, string>>;
}

/**
 * Build the submitted selection payload from modal state. Blank argument
 * values are omitted so the server can apply template defaults. Compose-mode
 * worktrees (no generated deployment options) submit an empty payload.
 */
export function buildDeploymentSelection(
  input: BuildDeploymentSelectionInput,
): DeploymentActionSelection {
  const out: DeploymentActionSelection = {};
  if (!input.hasGenerated) return out;
  if (input.selectMode === "target" && input.selectedTarget) {
    out.target = input.selectedTarget;
  } else if (input.selectMode === "custom" && input.selectedServices.size > 0) {
    out.services = [...input.selectedServices];
  }
  if (input.argumentNames.length > 0) {
    const submitted: Record<string, string> = {};
    for (const name of input.argumentNames) {
      const value = input.argumentValues[name];
      if (typeof value === "string" && value.length > 0) {
        submitted[name] = value;
      }
    }
    if (Object.keys(submitted).length > 0) out.arguments = submitted;
  }
  return out;
}
