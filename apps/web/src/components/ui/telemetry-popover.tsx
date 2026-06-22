import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import {
  contextPercent,
  formatTokenCount,
  hasMeaningfulTelemetry,
  shortModelName,
} from "@/lib/agent-telemetry";
import type { AgentTelemetry } from "@/lib/terminal-protocol";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/* TelemetryPopover — hover card breaking down an agent session's telemetry.
 * Replaces the plain `title` tooltip on the rail's context meter / token
 * cluster. Quiet-workspace: a white document card with hairline dividers,
 * mono numbers, and a single context meter — no chips, no colored fills
 * beyond the meter itself (red past the warn threshold). */

/** Context fullness past which the popover meter turns red. */
const CONTEXT_WARN_PERCENT = 90;

function formatUpdatedAge(updatedAt: string): string | undefined {
  const diff = Date.now() - new Date(updatedAt).getTime();
  if (!Number.isFinite(diff) || diff < 0) return undefined;
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function LedgerLine({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-6">
      <span className="text-[color:var(--muted-foreground)]">{label}</span>
      <span className="font-mono tabular-nums text-[color:var(--ink-2)]">
        {value}
      </span>
    </div>
  );
}

interface TelemetryPopoverProps {
  telemetry: AgentTelemetry;
  /** The hover trigger (the rail's telemetry cluster). Rendered asChild. */
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
}

export function TelemetryPopover({
  telemetry,
  children,
  side = "right",
}: TelemetryPopoverProps) {
  // An all-zero block (e.g. just after /clear) has nothing to break down —
  // render the trigger without the hover card.
  if (!hasMeaningfulTelemetry(telemetry)) return <>{children}</>;

  const pct = contextPercent(telemetry);
  const warn = pct >= CONTEXT_WARN_PERCENT;
  const totalTokens = telemetry.mainTokens + telemetry.subagentTokens;
  const updated = formatUpdatedAge(telemetry.updatedAt);

  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side={side}
        sideOffset={8}
        data-testid="telemetry-popover"
        className={cn(
          // Override the dark ink tooltip: a quiet document card instead.
          "w-[228px] rounded-lg bg-[color:var(--surface)] p-0 font-normal",
          "text-[11.5px] leading-normal text-[color:var(--ink)]",
          "shadow-[0_0_0_1px_var(--hair),0_8px_24px_-8px_color-mix(in_oklch,var(--ink)_22%,transparent)]",
        )}
      >
        <div className="flex flex-col gap-2 px-3 py-2.5">
          {telemetry.model && (
            <div className="font-mono text-[11px] font-medium text-[color:var(--ink)]">
              {shortModelName(telemetry.model)}
            </div>
          )}

          {/* context — meter + used-of-window, red past the warn line. */}
          <div className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between">
              <span className="text-[color:var(--muted-foreground)]">
                Context
              </span>
              <span
                className={cn(
                  "font-mono tabular-nums",
                  warn ? "text-[color:var(--bad)]" : "text-[color:var(--ink-2)]",
                )}
              >
                {pct}%
              </span>
            </div>
            <span className="h-1 overflow-hidden rounded-full bg-[color:var(--hair)]">
              <span
                className={cn(
                  "block h-full rounded-full",
                  warn ? "bg-[color:var(--bad)]" : "bg-[color:var(--ink-2)]",
                )}
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="font-mono tabular-nums text-[10.5px] text-[color:var(--muted-foreground)]">
              {formatTokenCount(telemetry.contextUsed)} of{" "}
              {formatTokenCount(telemetry.contextWindow)} tokens
            </span>
          </div>
        </div>

        <div className="h-px bg-[color:var(--hair)]" />

        {/* token spend ledger — main / subagents / total. */}
        <div className="flex flex-col gap-1 px-3 py-2.5">
          <LedgerLine
            label="Main agent"
            value={formatTokenCount(telemetry.mainTokens)}
          />
          {telemetry.subagentTokens > 0 && (
            <>
              <LedgerLine
                label="Subagents"
                value={formatTokenCount(telemetry.subagentTokens)}
              />
              <LedgerLine
                label="Total"
                value={
                  <span className="font-medium text-[color:var(--ink)]">
                    {formatTokenCount(totalTokens)}
                  </span>
                }
              />
            </>
          )}
          {updated && (
            <div className="pt-0.5 text-[10.5px] text-[color:var(--muted-foreground)]">
              updated {updated}
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
