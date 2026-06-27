import { Check } from "lucide-react";

import { cn } from "@/lib/utils";
import { PROJECT_PALETTE_SIZE } from "@/lib/project-identity";

/* ProjectColorPicker — a grid of the curated project-identity swatches
 * (--p-1 … --p-36). The project's color is a palette slot, not a freeform hex,
 * so the picker offers exactly the curated colors (keeping light/dark theming
 * and palette harmony). Selecting a swatch calls back with its slot index. */

interface ProjectColorPickerProps {
  /** Currently selected slot, or undefined while loading. */
  value: number;
  disabled?: boolean;
  onSelect: (slot: number) => void;
  className?: string;
}

export function ProjectColorPicker({
  value,
  disabled = false,
  onSelect,
  className,
}: ProjectColorPickerProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Project color"
      className={cn("flex flex-wrap gap-1.5", className)}
    >
      {Array.from({ length: PROJECT_PALETTE_SIZE }, (_, slot) => {
        const active = slot === value;
        return (
          <button
            key={slot}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`Color ${slot + 1}`}
            disabled={disabled}
            data-testid={`project-color-swatch-${slot}`}
            onClick={() => onSelect(slot)}
            className={cn(
              "grid size-6 shrink-0 place-items-center rounded-md transition-[transform,box-shadow]",
              "hover:scale-110 disabled:cursor-not-allowed disabled:opacity-50",
              active
                ? "ring-2 ring-[color:var(--ink)] ring-offset-2 ring-offset-[color:var(--surface)]"
                : "ring-1 ring-inset ring-black/10",
            )}
            style={{ background: `var(--p-${slot + 1})` }}
          >
            {active && (
              <Check
                className="size-3.5 text-white drop-shadow-[0_0_1px_rgba(0,0,0,0.6)]"
                strokeWidth={2.5}
                aria-hidden
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
