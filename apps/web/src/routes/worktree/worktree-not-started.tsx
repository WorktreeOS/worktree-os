import type React from "react";
import { useMemo, useState } from "react";
import { Loader2, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Ic } from "@/components/ui/inline-code";
import { TodoBanner } from "@/components/ui/todo-banner";
import { DocumentSection } from "@/routes/worktree/document";
import { EnvironmentSection } from "@/routes/worktree/environment-section";
import { WorktreeConfigStatusBody } from "@/routes/worktree/worktree-config-status";
import type { WorktreeDetailResponse } from "@/lib/ui-api";
import {
  buildDeploymentSelection,
  type DeploymentActionSelection,
} from "@/lib/deployment-selection";

type WorktreeNotStartedProps = {
  onStartSubmit: (
    force: boolean,
    selection: DeploymentActionSelection,
  ) => Promise<void> | void;
  launching: boolean;
  canStart: boolean;
  detail: WorktreeDetailResponse;
};

function branchOrDir(detail: WorktreeDetailResponse): string {
  return detail.worktree.branch ?? detail.worktree.path.split("/").pop() ?? "";
}

/** Approximate duration label for the launch preview: `~40s`, `~2m`, `~2m 5s`. */
function formatApproxDuration(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `~${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `~${minutes}m ${seconds}s` : `~${minutes}m`;
}

/** Cap on ports listed inline before eliding to `+N`. */
const MAX_PREVIEW_PORTS = 4;

/**
 * One quiet prose line summarizing what a deploy would do: service count,
 * configured ports, and last-run duration. Each segment is shown only when it
 * has data; renders nothing when no segments are present.
 */
function LaunchPreviewLine({
  preview,
}: {
  preview: WorktreeDetailResponse["launchPreview"];
}) {
  if (!preview) return null;

  const segments: React.ReactNode[] = [];

  if (preview.serviceCount > 0) {
    segments.push(
      <span key="count">
        will start {preview.serviceCount}{" "}
        {preview.serviceCount === 1 ? "service" : "services"}
      </span>,
    );
  }

  if (preview.ports.length > 0) {
    const shown = preview.ports.slice(0, MAX_PREVIEW_PORTS);
    const extra = preview.ports.length - shown.length;
    segments.push(
      <span key="ports">
        ports{" "}
        {shown.map((port, i) => (
          <span key={port}>
            {i > 0 ? ", " : ""}
            <Ic>{port}</Ic>
          </span>
        ))}
        {extra > 0 ? ` +${extra}` : ""}
      </span>,
    );
  }

  const duration = formatApproxDuration(preview.lastRunDurationMs);
  if (duration) {
    segments.push(<span key="duration">{duration} last run</span>);
  }

  if (segments.length === 0) return null;

  return (
    <p
      className="text-[12.5px] text-[color:var(--ink-2)] m-0"
      data-testid="launch-preview"
    >
      {segments.map((segment, i) => (
        <span key={i}>
          {i > 0 ? <span className="mx-1.5">·</span> : null}
          {segment}
        </span>
      ))}
    </p>
  );
}

export function WorktreeNotStarted({
  onStartSubmit,
  launching,
  canStart,
  detail,
}: WorktreeNotStartedProps) {
  const branch = branchOrDir(detail);
  const opts = detail.deploymentOptions;

  /* Catalog of selectable services. Generated-compose mode exposes
   * appServices + deps; compose mode has no options and submits an empty
   * selection. */
  const appServices = useMemo(
    () => (opts ? [...opts.appServices].sort() : []),
    [opts],
  );
  /* Dependencies (postgres / redis / …) are managed by WorktreeOS automatically
   * and are not user-selectable on launch. */
  const allServices = appServices;

  /* Default: every available service selected. */
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(allServices),
  );
  const [force, setForce] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function toggleService(name: string, next: boolean): void {
    setSelected((prev) => {
      const out = new Set(prev);
      if (next) out.add(name);
      else out.delete(name);
      return out;
    });
  }

  function toggleAll(group: string[], next: boolean): void {
    setSelected((prev) => {
      const out = new Set(prev);
      for (const name of group) {
        if (next) out.add(name);
        else out.delete(name);
      }
      return out;
    });
  }

  const allChecked = allServices.length > 0
    && allServices.every((name) => selected.has(name));
  const noneChecked = selected.size === 0;
  const configBlocksStart =
    detail.projectConfig.status === "missing"
    || detail.projectConfig.status === "invalid";
  const deployConfigFile =
    detail.projectConfig.status === "unknown"
      ? "deploy config"
      : detail.projectConfig.path.split("/").pop() || "deploy config";
  /* Launch options only make sense when something can actually be deployed:
   * a valid config plus either selectable services or compose mode. */
  const canDeploySomething =
    !configBlocksStart && (allServices.length > 0 || opts === undefined);
  const canSubmit = canStart && !submitting && !launching
    && !configBlocksStart
    && (allServices.length === 0 || !noneChecked);

  async function handleStart(): Promise<void> {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const selection = buildDeploymentSelection({
        hasGenerated: opts !== undefined,
        /* `custom` when the user has narrowed selection; `all` otherwise so
         * the daemon falls back to its full default deployment. */
        selectMode: opts !== undefined && !allChecked ? "custom" : "all",
        selectedTarget: "",
        selectedServices: selected,
        argumentNames: [],
        argumentValues: {},
      });
      await onStartSubmit(force, selection);
    } finally {
      setSubmitting(false);
    }
  }

  const headerActions = (
    <>
      {allServices.length > 0 ? (
        <>
          <Button
            size="xs"
            onClick={() => toggleAll(allServices, true)}
            disabled={allChecked}
          >
            Select all
          </Button>
          <Button
            size="xs"
            onClick={() => toggleAll(allServices, false)}
            disabled={noneChecked}
          >
            Clear
          </Button>
        </>
      ) : null}
      <div className="hidden lg:inline-flex items-center gap-2">
        <Button
          variant="solid"
          onClick={handleStart}
          disabled={!canSubmit}
          data-testid="start-worktree"
        >
          {launching || submitting ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Play />
          )}
          Start worktree
        </Button>
      </div>
    </>
  );

  return (
    <div
      className="flex-1 overflow-auto bg-[color:var(--surface)]"
      data-testid="worktree-not-started"
    >
      <div className="mx-auto w-full max-w-[880px] px-6 md:px-14 pt-9 pb-6 flex flex-col gap-3.5">
        {/* Touch primary action — the desktop Start lives in the section header
         * (hidden on mobile), so surface it full-width up top here. */}
        <div className="lg:hidden">
          <Button
            variant="solid"
            onClick={handleStart}
            disabled={!canSubmit}
            data-testid="start-worktree-mobile"
            className="h-11 w-full gap-2"
          >
            {launching || submitting ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Play />
            )}
            Start worktree
          </Button>
        </div>

        <EnvironmentSection detail={detail} />

        <DocumentSection
          title="Services to deploy"
          meta={
            allServices.length > 0
              ? `${selected.size} of ${allServices.length} selected`
              : "compose mode"
          }
          actions={headerActions}
        >
          {detail.launchPreview ? (
            <div className="mb-3.5">
              <LaunchPreviewLine preview={detail.launchPreview} />
            </div>
          ) : null}

          <TodoBanner tone="idle" meta="ready to launch" className="mb-3.5">
            <strong>{branch}</strong> is on standby
          </TodoBanner>

          <div className="mb-3.5">
            <span className="mb-1.5 block text-[13px] font-medium text-[color:var(--ink-2)]">
              Project config <Ic>{deployConfigFile}</Ic>
            </span>
            <WorktreeConfigStatusBody config={detail.projectConfig} />
            {configBlocksStart ? (
              <p
                className="mt-2 text-[12.5px] text-[color:var(--bad)]"
                data-testid="start-worktree-blocked"
              >
                Start is unavailable until <Ic>{deployConfigFile}</Ic> is{" "}
                {detail.projectConfig.status === "missing" ? "added" : "valid"}.
              </p>
            ) : null}
          </div>

          {allServices.length > 0 ? (
            <ul className="list-none p-0 m-0 [&_li]:list-none">
              {appServices.map((name) => (
                <li
                  key={`app-${name}`}
                  className="border-t border-[color:var(--hair)] first:border-t-0 last:border-b"
                >
                  <Checkbox
                    checked={selected.has(name)}
                    onCheckedChange={(next) => toggleService(name, next)}
                    data-testid={`launch-service-${name}`}
                  >
                    <Ic>{name}</Ic>
                  </Checkbox>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13.5px] text-[color:var(--muted-foreground)] italic m-0">
              All services in the compose file will be brought up. No per-service
              selection is available in compose mode.
            </p>
          )}
        </DocumentSection>

        {canDeploySomething ? (
          <DocumentSection title="Options">
            <ul className="list-none p-0 m-0 [&_li]:list-none">
              <li className="border-t border-b border-[color:var(--hair)]">
                <Checkbox
                  checked={force}
                  onCheckedChange={setForce}
                  trailing={
                    <span className="text-[color:var(--bad)]">destructive</span>
                  }
                  data-testid="launch-opt-force"
                >
                  Force — tear down current containers, networks, volumes before
                  bringing services up
                </Checkbox>
              </li>
            </ul>
          </DocumentSection>
        ) : null}
      </div>
    </div>
  );
}
