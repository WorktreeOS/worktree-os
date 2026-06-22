import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { IconButton } from "@/components/ui/icon-button";
import { Ic } from "@/components/ui/inline-code";
import { DocumentSection } from "@/routes/worktree/document";
import type { LogChannel, WorktreeDetailResponse } from "@/lib/ui-api";
import {
  deriveInitDiagnostic,
  type InitStepStatus,
} from "@/lib/worktree-view-model";

function branchLabel(detail: WorktreeDetailResponse): string {
  return detail.worktree.branch ?? detail.worktree.path.split("/").pop() ?? "";
}

function PathChip({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-1.5 max-w-full">
      <Ic>
        <span
          className="truncate inline-block max-w-[58ch] align-bottom"
          title={path}
        >
          {path}
        </span>
      </Ic>
      <IconButton
        size="xs"
        aria-label="Copy path"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(path);
            setCopied(true);
            setTimeout(() => setCopied(false), 1100);
          } catch {
            /* ignore */
          }
        }}
      >
        {copied ? <Check /> : <Copy />}
      </IconButton>
    </span>
  );
}

function InitLine({
  initStep,
  onOpenLogs,
}: {
  initStep: InitStepStatus | null;
  onOpenLogs: () => void;
}) {
  if (!initStep) return null;
  const diag = deriveInitDiagnostic(initStep);
  const stepName =
    initStep.kind === "first-run-setup" ? "Environment setup" : "init-script";
  let prefix: string;
  if (diag.kind === "running") prefix = `${stepName} — running`;
  else if (diag.kind === "succeeded") prefix = `${stepName} completed`;
  else if (diag.kind === "failed") prefix = `${stepName} — failed`;
  else prefix = stepName;

  return (
    <p className="text-[13.5px] text-[color:var(--muted-foreground)]">
      {prefix}
      {" · "}
      <button
        type="button"
        onClick={onOpenLogs}
        data-testid="open-init-logs"
        data-init-state={diag.kind}
        className="cursor-pointer"
        aria-label="Open init log"
      >
        <Ic>init.log</Ic>
      </button>
    </p>
  );
}

/**
 * Compact, structured "Environment" section (branch + path, plus the optional
 * init.log status line) shared between the overview and not-started surfaces so
 * the two stay visually identical.
 */
function EnvironmentSection({
  detail,
  initStep = null,
  onOpenLogs,
}: {
  detail: WorktreeDetailResponse;
  initStep?: InitStepStatus | null;
  onOpenLogs?: (channel: LogChannel) => void;
}) {
  const branch = branchLabel(detail);
  return (
    <DocumentSection title="Environment">
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-5 gap-y-1.5 text-[13.5px]">
        <span className="text-[color:var(--muted-foreground)]">Branch</span>
        <span className="min-w-0">
          <Ic>{branch}</Ic>
        </span>
        <span className="text-[color:var(--muted-foreground)]">Path</span>
        <span className="min-w-0">
          <PathChip path={detail.worktree.path} />
        </span>
      </div>
      {initStep ? (
        <div className="mt-2.5">
          <InitLine
            initStep={initStep}
            onOpenLogs={() => onOpenLogs?.("init")}
          />
        </div>
      ) : null}
    </DocumentSection>
  );
}

export { EnvironmentSection, PathChip };
