import type { ComponentType, SVGProps } from "react";

import { cn } from "@/lib/utils";

/* SegmentedControl — one primitive, two rail roles (see
 * demo/side-menu-v2.html):
 *
 *   variant="mode"   — the Workspaces ⟷ Terminals switcher: a chip-bg track
 *                      whose active tab lifts onto the surface with a soft
 *                      shadow. Tabs carry an icon, a label, and an optional
 *                      neutral count badge.
 *   variant="filter" — the per-mode status filters (All / Running / Attention,
 *                      All / Agents / Other): small inline pills, active pill
 *                      framed by a hairline. A `count` renders as a local red
 *                      accent (used by the Attention segment).
 *
 * `size="touch"` enlarges hit targets for the mobile drawer. */

export interface SegmentOption {
  value: string;
  label: string;
  icon?: ComponentType<SVGProps<SVGSVGElement>>;
  /** Optional trailing count — neutral badge in `mode`, red accent in `filter`. */
  count?: number;
}

interface SegmentedControlProps {
  options: readonly SegmentOption[];
  value: string;
  onChange: (value: string) => void;
  variant?: "mode" | "filter";
  /**
   * `filter` only — how the trailing count reads. `danger` (default) is the red
   * accent for an attention segment (e.g. Waiting). `neutral` renders a quiet
   * badge for plain group counts (the rail's Sessions attention filter, where
   * every segment carries a count).
   */
  countTone?: "danger" | "neutral";
  size?: "default" | "touch";
  /**
   * `mode` only — whether tabs share the track equally (`flex-1`, the default
   * for the full-width rail switch) or size to their content (inline toolbar
   * toggles, so a wider label is never squeezed below its text).
   */
  stretch?: boolean;
  ariaLabel?: string;
  className?: string;
  "data-testid"?: string;
}

export function SegmentedControl({
  options,
  value,
  onChange,
  variant = "mode",
  countTone = "danger",
  size = "default",
  stretch = true,
  ariaLabel,
  className,
  "data-testid": dataTestId,
}: SegmentedControlProps) {
  const touch = size === "touch";

  if (variant === "filter") {
    return (
      <div
        role="tablist"
        aria-label={ariaLabel}
        data-testid={dataTestId}
        className={cn("flex gap-1", className)}
      >
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={dataTestId ? `${dataTestId}-${opt.value}` : undefined}
              onClick={() => onChange(opt.value)}
              className={cn(
                "inline-flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[7px] border text-[12px]",
                "transition-[background-color,color,border-color] duration-100",
                touch ? "h-[34px] px-3.5 text-[13.5px]" : "h-6 px-[9px]",
                active
                  ? "border-[color:var(--hair-2)] bg-[color:var(--surface)] font-medium text-[color:var(--ink)]"
                  : "border-transparent text-[color:var(--muted-foreground)] hover:bg-[color:var(--hover)] hover:text-[color:var(--ink-2)]",
              )}
            >
              <span>{opt.label}</span>
              {opt.count != null && opt.count > 0 && (
                <span
                  className={cn(
                    "grid h-[15px] min-w-[15px] place-items-center rounded-full px-1 font-mono text-[10.5px]",
                    countTone === "neutral"
                      ? active
                        ? "bg-[color:var(--hover)] text-[color:var(--ink-2)]"
                        : "bg-[color:var(--hair-2)] text-[color:var(--muted-foreground)]"
                      : "bg-[color:var(--bad-soft)] text-[color:var(--bad)]",
                  )}
                >
                  {opt.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      data-testid={dataTestId}
      className={cn(
        "flex gap-[3px] rounded-[10px] bg-[color:var(--chip-bg)] p-[3px]",
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        const Icon = opt.icon;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            data-testid={dataTestId ? `${dataTestId}-${opt.value}` : undefined}
            onClick={() => onChange(opt.value)}
            className={cn(
              "inline-flex cursor-pointer items-center justify-center gap-[7px] whitespace-nowrap rounded-lg border-0 font-medium",
              "transition-[background-color,color,box-shadow] duration-100",
              stretch ? "flex-1" : touch ? "px-3.5" : "px-2.5",
              touch ? "h-[38px] text-[13.5px]" : "h-7 text-[12.5px]",
              active
                ? "bg-[color:var(--surface)] text-[color:var(--ink)] shadow-[0_1px_2px_rgb(0_0_0_/_0.06)]"
                : "bg-transparent text-[color:var(--muted-foreground)] hover:text-[color:var(--ink-2)]",
            )}
          >
            {Icon && (
              <Icon
                className={cn(
                  touch ? "size-4" : "size-3.5",
                  active
                    ? "text-[color:var(--ink)]"
                    : "text-[color:var(--muted-foreground)]",
                )}
                strokeWidth={1.75}
              />
            )}
            <span>{opt.label}</span>
            {opt.count != null && opt.count > 0 && (
              <span
                className={cn(
                  "grid h-4 min-w-4 place-items-center rounded-full px-1.5 font-mono text-[10.5px]",
                  active
                    ? "bg-[color:var(--hover)] text-[color:var(--ink-2)]"
                    : "bg-[color:var(--hair-2)] text-[color:var(--muted-foreground)]",
                )}
              >
                {opt.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
