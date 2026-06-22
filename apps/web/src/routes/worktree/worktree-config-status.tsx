import { AlertCircle, BookOpen, CheckCircle2, FileText } from "lucide-react";

import { Ic } from "@/components/ui/inline-code";
import { DocumentSection } from "@/routes/worktree/document";
import type { ProjectConfigStatus } from "@/lib/ui-api";

interface WorktreeConfigStatusProps {
  config: ProjectConfigStatus;
}

/**
 * Basename of the effective deploy config file for display (`deploy.yaml` for
 * the source worktree, `deploy.worktree.yaml` for secondary worktrees). Falls
 * back to a generic label when the path is not known yet.
 */
function deployConfigLabel(config: ProjectConfigStatus): string {
  if (config.status === "unknown") return "deploy config";
  const parts = config.path.split("/");
  return parts[parts.length - 1] || "deploy config";
}

/**
 * Render the resolved project deploy config status for the selected worktree.
 * The worktree page mounts this in both `not_started` and overview surfaces so
 * the config availability is always visible.
 */
export function WorktreeConfigStatus({ config }: WorktreeConfigStatusProps) {
  return (
    <DocumentSection
      title="Project config"
      meta={deployConfigLabel(config)}
      data-testid="worktree-config-status"
      data-config-status={config.status}
    >
      <WorktreeConfigStatusBody config={config} />
    </DocumentSection>
  );
}

/**
 * Bare config status content without the surrounding `DocumentSection`, so it
 * can be embedded inside another section (e.g. "Services to deploy").
 */
export function WorktreeConfigStatusBody({ config }: WorktreeConfigStatusProps) {
  return (
    <div data-testid="worktree-config-status" data-config-status={config.status}>
      {config.status === "valid" && (
        <div
          className="flex items-start gap-2 rounded-[8px] border border-[color:var(--hair-2)] bg-[color:var(--chip-bg)] px-3 py-2 text-[13.5px] text-[color:var(--ink-2)]"
          data-testid="worktree-config-valid"
        >
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-[color:var(--good)]" />
          <span className="min-w-0">
            <Ic>{config.path}</Ic>
            <span className="ml-2 text-[12.5px] text-[color:var(--muted-foreground)]">
              mode: {config.mode}
            </span>
          </span>
        </div>
      )}
      {config.status === "missing" && (
        <div
          className="flex flex-col gap-1.5 rounded-[8px] border border-[color:var(--bad-border)] bg-[color:var(--bad-soft)] px-3 py-2.5 text-[13.5px] text-[color:var(--bad)]"
          data-testid="worktree-config-missing"
        >
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0">
              Deploy config is missing at <Ic>{config.path}</Ic>.
            </span>
          </div>
          <p className="m-0 text-[13px] text-[color:var(--ink-2)]">
            {config.message}
          </p>
          <DocsLink />
        </div>
      )}
      {config.status === "invalid" && (
        <div
          className="flex flex-col gap-1.5 rounded-[8px] border border-[color:var(--bad-border)] bg-[color:var(--bad-soft)] px-3 py-2.5 text-[13.5px] text-[color:var(--bad)]"
          data-testid="worktree-config-invalid"
        >
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0">
              <Ic>{config.path}</Ic> failed to parse.
            </span>
          </div>
          <pre className="m-0 max-h-[180px] overflow-auto whitespace-pre-wrap rounded-[6px] bg-[color:var(--surface)] px-2 py-1.5 font-mono text-[12px] text-[color:var(--ink-2)]">
            {config.message}
          </pre>
          <DocsLink />
        </div>
      )}
      {config.status === "unknown" && (
        <div
          className="flex items-start gap-2 rounded-[8px] border border-[color:var(--hair-2)] bg-[color:var(--chip-bg)] px-3 py-2 text-[13.5px] text-[color:var(--ink-2)]"
          data-testid="worktree-config-unknown"
        >
          <FileText className="mt-0.5 size-3.5 shrink-0 text-[color:var(--muted-foreground)]" />
          <span className="min-w-0">
            Could not resolve the source worktree yet.
            {config.message ? (
              <span className="ml-2 text-[12.5px] text-[color:var(--muted-foreground)]">
                {config.message}
              </span>
            ) : null}
          </span>
        </div>
      )}
    </div>
  );
}

function DocsLink() {
  return (
    <a
      href="/docs/deploy-config"
      data-testid="worktree-config-docs-link"
      className="inline-flex w-fit items-center gap-1.5 text-[12.5px] text-[color:var(--ink)] underline"
    >
      <BookOpen className="size-3" />
      Open deploy config docs
    </a>
  );
}
