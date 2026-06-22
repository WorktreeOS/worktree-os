import { cn } from "@/lib/utils";
import { contextPercent, formatTokenCount } from "@/lib/agent-telemetry";
import { TelemetryPopover } from "@/components/ui/telemetry-popover";
import type { AgentTelemetry } from "@/lib/terminal-protocol";

/* TelemetryCluster — the line-2 telemetry cluster shared by the worktree-tree
 * session row (`TerminalSessionRow`) and the Sessions-mode stream row
 * (`StreamSessionRow`). Extracted verbatim so the two rows render identical
 * telemetry and cannot drift: a context meter + context tokens in use + total
 * token spend, reddening past the warn threshold, wrapped in the same
 * `TelemetryPopover` hover card. Keeps the `rail-terminal-telemetry`,
 * `-context`, and `-tokens` test ids so existing coverage is unaffected. */

/** Context fullness past which the meter + context count turn red. */
const CONTEXT_WARN_PERCENT = 90;

interface TelemetryClusterProps {
  telemetry: AgentTelemetry;
  touch?: boolean;
}

export function TelemetryCluster({
  telemetry,
  touch = false,
}: TelemetryClusterProps) {
  const ctxPercent = contextPercent(telemetry);
  const ctxWarn = ctxPercent >= CONTEXT_WARN_PERCENT;
  // Keep a rounded sliver visible whenever the context carries real usage, so a
  // barely-filled context still reads as "started" rather than an empty track.
  const ctxFill = ctxPercent === 0 ? 0 : Math.max(ctxPercent, 8);

  return (
    <TelemetryPopover telemetry={telemetry}>
      <span
        data-testid="rail-terminal-telemetry"
        className={cn(
          "ml-auto inline-flex shrink-0 items-center font-mono tabular-nums",
          touch ? "gap-2" : "gap-1.5",
        )}
      >
        {/* context meter — a hairline-ringed capsule whose fill tracks how full
            the context window is and eases on growth; reds past the warn line. */}
        <span
          aria-hidden
          className={cn(
            "overflow-hidden rounded-full bg-[color:var(--hair)]",
            "shadow-[inset_0_0_0_0.5px_var(--hair-2)]",
            touch ? "h-1.5 w-14" : "h-[5px] w-11",
          )}
        >
          <span
            className={cn(
              "block h-full rounded-full transition-[width] duration-500 ease-out",
              ctxWarn ? "bg-[color:var(--bad)]" : "bg-[color:var(--ink-2)]",
            )}
            style={{ width: `${ctxFill}%` }}
          />
        </span>
        {/* context tokens in use — replaces the bare percent; the meter beside
            it still carries the fullness at a glance. */}
        <span
          data-testid="rail-terminal-context"
          className={
            ctxWarn ? "text-[color:var(--bad)]" : "text-[color:var(--ink-2)]"
          }
        >
          {formatTokenCount(telemetry.contextUsed)}
        </span>
        <span className="text-[color:var(--hair-2)]">·</span>
        <span data-testid="rail-terminal-tokens">
          <span className="font-medium text-[color:var(--ink-2)]">
            {formatTokenCount(telemetry.mainTokens)}
          </span>
        </span>
      </span>
    </TelemetryPopover>
  );
}
