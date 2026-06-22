import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";
import type { DeploymentStatus } from "@/lib/ui-api";

/* StatusDot — the primary per-row health signal in the status-first rail
 * (see demo/side-menu-v2.html). Filled discs carry live states; hollow rings
 * carry off states. Colours come from index.css tokens — running maps to
 * `--good`, failed to `--bad`, the hollow rings to `--muted-foreground` /
 * `--hair-2`. Partial uses the demo's status amber `#F59E0B`, which is
 * deliberately distinct from the command-only `--accent-cmd`. No new tokens. */

export type StatusDotVariant = "run" | "partial" | "fail" | "stopped" | "idle";

const FILLED: Partial<Record<StatusDotVariant, string>> = {
  run: "var(--good)",
  partial: "#F59E0B",
  fail: "var(--bad)",
};

const RING: Partial<Record<StatusDotVariant, string>> = {
  stopped: "var(--muted-foreground)",
  idle: "var(--hair-2)",
};

/** Map a deployment status onto one of the five dot variants. */
export function statusDotVariant(status: DeploymentStatus): StatusDotVariant {
  switch (status) {
    case "running":
      return "run";
    case "running_partial":
    case "checking":
    case "pending":
      return "partial";
    case "failed":
      return "fail";
    case "stopped":
    case "stopping":
      return "stopped";
    case "not_started":
    case "unknown":
    default:
      return "idle";
  }
}

/* StatusSpinner — a dot-sized spinning arc for live "working" activity. Same
 * footprint as StatusDot so rows don't shift; hairline ring with a coloured
 * arc, ~1.1s like the TodoBanner spinner. Not a pulse on a dot — it replaces
 * the dot while the agent is actively working. The arc defaults to `--good`;
 * callers tint it with the agent brand (`color`) so the working signal carries
 * agent identity. */
export function StatusSpinner({
  size = 7,
  className,
  title,
  color = "var(--good)",
}: {
  size?: number;
  className?: string;
  title?: string;
  /** Arc colour — pass the agent brand to tint the working signal. */
  color?: string;
}) {
  const style: CSSProperties = {
    width: size,
    height: size,
    border: "1.5px solid var(--hair-2)",
    borderTopColor: color,
    animationDuration: "1.1s",
  };
  return (
    <span
      aria-hidden
      title={title}
      data-status-spinner
      className={cn("inline-block shrink-0 animate-spin rounded-full", className)}
      style={style}
    />
  );
}

interface StatusDotProps {
  variant: StatusDotVariant;
  /** Diameter in px. Defaults to 7 (rail); bump to ~9 for touch rows. */
  size?: number;
  className?: string;
  title?: string;
}

export function StatusDot({
  variant,
  size = 7,
  className,
  title,
}: StatusDotProps) {
  const ring = RING[variant];
  const style: CSSProperties = {
    width: size,
    height: size,
    background: ring ? "transparent" : FILLED[variant],
    boxShadow: ring ? `inset 0 0 0 1.5px ${ring}` : undefined,
  };
  return (
    <span
      aria-hidden
      title={title}
      data-status-dot={variant}
      className={cn("inline-block shrink-0 rounded-full", className)}
      style={style}
    />
  );
}
