import { Check } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/* Checkbox — v3 outlined checkbox with filled ink fill when checked.
 * Used in the NotStarted surface launch options. */

type CheckboxProps = {
  checked: boolean;
  onCheckedChange?: (next: boolean) => void;
  disabled?: boolean;
  children?: ReactNode;
  trailing?: ReactNode;
  className?: string;
  "data-testid"?: string;
};

function Checkbox({
  checked,
  onCheckedChange,
  disabled,
  children,
  trailing,
  className,
  "data-testid": testId,
}: CheckboxProps) {
  return (
    <label
      data-slot="checkbox"
      data-testid={testId}
      className={cn(
        "flex items-center gap-3 cursor-pointer select-none py-2.5",
        disabled ? "opacity-50 cursor-not-allowed" : "",
        className,
      )}
    >
      <input
        type="checkbox"
        className="sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onCheckedChange?.(e.target.checked)}
      />
      <span
        aria-hidden
        className={cn(
          "inline-grid place-items-center size-[18px] rounded-[5px] border transition-colors shrink-0",
          checked
            ? "bg-[color:var(--ink)] border-[color:var(--ink)] text-[color:var(--surface)]"
            : "bg-[color:var(--surface)] border-[color:var(--hair-2)]",
        )}
      >
        {checked ? <Check className="size-[12px]" /> : null}
      </span>
      <span className="flex-1 text-[14px] text-[color:var(--ink)]">{children}</span>
      {trailing !== undefined && trailing !== null ? (
        <span className="text-[12.5px] text-[color:var(--muted-foreground)]">
          {trailing}
        </span>
      ) : null}
    </label>
  );
}

export { Checkbox };
export type { CheckboxProps };
