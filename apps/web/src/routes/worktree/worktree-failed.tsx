import { FileText, RotateCw, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { TodoBanner } from "@/components/ui/todo-banner";
import { DocumentSection } from "@/routes/worktree/document";
import { ErrorBlock } from "@/components/ui/error-block";
import { Ic } from "@/components/ui/inline-code";
import { channelLabel } from "@/components/logs-view";
import { cn } from "@/lib/utils";
import type { LogChannel, WorktreeDetailResponse } from "@/lib/ui-api";
import {
  deploymentStepLabel,
  type WorktreeSurface,
} from "@/lib/worktree-view-model";

type WorktreeFailedProps = {
  surface: Extract<WorktreeSurface, { kind: "failed" }>;
  emphasizedChannel: LogChannel | null;
  onOpenLogs: (channel: LogChannel) => void;
  onRetry: () => void;
  canRetry: boolean;
  /** Tear the failed deployment fully down (stop services, drop tunnels). */
  onStop: () => void;
  /** A teardown is already in flight; disables the Stop control. */
  stopPending: boolean;
  detail: WorktreeDetailResponse;
};

export function WorktreeFailed({
  surface,
  emphasizedChannel,
  onOpenLogs,
  onRetry,
  canRetry,
  onStop,
  stopPending,
  detail,
}: WorktreeFailedProps) {
  const message =
    surface.message ?? detail.statusError ?? "Operation failed.";
  const stepLabel = surface.step ? deploymentStepLabel(surface.step) : null;

  const stopButton = (
    <Button
      onClick={onStop}
      disabled={stopPending}
      data-testid="failed-stop"
      className="text-[color:var(--bad)] hover:text-[color:var(--bad)]"
    >
      <Square fill="currentColor" strokeWidth={0} className="size-[10px]" />
      Stop &amp; reset
    </Button>
  );

  const failedActions = (
    <div className="hidden lg:inline-flex items-center gap-2">
      <Button
        variant="solid"
        onClick={onRetry}
        disabled={!canRetry}
        data-testid="failed-retry"
      >
        <RotateCw />
        {stepLabel ? "Retry from failed step" : "Retry"}
      </Button>
      {stopButton}
      {emphasizedChannel ? (
        <Button
          onClick={() => onOpenLogs(emphasizedChannel)}
          data-testid="open-failed-channel"
          data-failed-channel={emphasizedChannel}
        >
          <FileText />
          {channelLabel(emphasizedChannel)} logs
        </Button>
      ) : null}
      <Button onClick={() => onOpenLogs("init")} data-testid="open-init-logs">
        <FileText />
        Init log
      </Button>
    </div>
  );

  return (
    <div
      className="flex-1 overflow-auto bg-[color:var(--surface)]"
      data-testid="worktree-failure"
    >
      <div className="mx-auto w-full max-w-[880px] px-6 md:px-14 pt-9 pb-6 flex flex-col gap-3.5">
        {/* Touch actions — desktop keeps these in the section header (hidden on
         * mobile), so surface them here, primary action full-width. */}
        <div className="flex flex-col gap-2 lg:hidden">
          <Button
            variant="solid"
            onClick={onRetry}
            disabled={!canRetry}
            data-testid="failed-retry-mobile"
            className="h-11 w-full gap-2"
          >
            <RotateCw />
            {stepLabel ? "Retry from failed step" : "Retry"}
          </Button>
          <div className="flex flex-wrap gap-2">
            {emphasizedChannel ? (
              <Button
                onClick={() => onOpenLogs(emphasizedChannel)}
                data-testid="open-failed-channel-mobile"
                className="h-10 flex-1 gap-2"
              >
                <FileText />
                {channelLabel(emphasizedChannel)} logs
              </Button>
            ) : null}
            <Button
              onClick={() => onOpenLogs("init")}
              data-testid="open-init-logs-mobile"
              className="h-10 flex-1 gap-2"
            >
              <FileText />
              Init log
            </Button>
            <Button
              onClick={onStop}
              disabled={stopPending}
              data-testid="failed-stop-mobile"
              className="h-10 flex-1 gap-2 text-[color:var(--bad)] hover:text-[color:var(--bad)]"
            >
              <Square fill="currentColor" strokeWidth={0} className="size-[10px]" />
              Stop &amp; reset
            </Button>
          </div>
        </div>

        <DocumentSection title="What happened" actions={failedActions}>
          <TodoBanner
            tone="failed"
            meta={stepLabel ? stepLabel : undefined}
            className="mb-3.5"
          >
            {stepLabel ? (
              <>
                Step <strong>{stepLabel}</strong> failed
              </>
            ) : (
              <>Last operation failed</>
            )}
          </TodoBanner>
          <p>
            Inspect the captured error excerpt below, then open the relevant
            log channel for the full trace. Once the underlying issue is fixed,
            retry the deployment.
          </p>
          <ErrorBlock
            title={
              stepLabel ? (
                <>
                  Application error · <Ic>{stepLabel}</Ic>
                </>
              ) : (
                <>Application error</>
              )
            }
          >
            {message}
          </ErrorBlock>
          {surface.logTail && surface.logTail.length > 0 ? (
            <pre
              data-testid="failure-log-tail"
              className="mt-3.5 max-h-56 overflow-auto rounded-[10px] border border-[color:var(--hair-2)] bg-[color:var(--shell)] px-3 py-2 font-mono text-[12px] leading-relaxed text-[color:var(--muted-foreground)] whitespace-pre-wrap"
            >
              {surface.logTail.join("\n")}
            </pre>
          ) : null}
        </DocumentSection>

        {detail.services.length > 0 ? (
          <DocumentSection
            title="Services"
            meta={`${detail.services.length} ${detail.services.length === 1 ? "unit" : "units"}`}
          >
            <div className="flex flex-col">
              {detail.services.map((svc) => (
                <button
                  key={svc.service}
                  type="button"
                  onClick={() => onOpenLogs(`service:${svc.service}`)}
                  data-testid={`open-service-logs:${svc.service}`}
                  className={cn(
                    "grid items-baseline gap-3 py-2.5 border-t border-[color:var(--hair)] first:border-t-0 last:border-b last:border-[color:var(--hair)]",
                    "grid-cols-[minmax(0,1fr)_auto] text-left cursor-pointer hover:bg-[color:var(--hover)] px-1.5 -mx-1.5 rounded",
                  )}
                >
                  <span className="font-medium text-[14px] text-[color:var(--ink)]">
                    {svc.service}
                  </span>
                  <span className="text-[12.5px] text-[color:var(--muted-foreground)]">
                    {svc.state}
                  </span>
                </button>
              ))}
            </div>
          </DocumentSection>
        ) : null}
      </div>
    </div>
  );
}
