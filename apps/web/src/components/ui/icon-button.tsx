import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/* IconButton — square pill button used for trailing actions
 * (logs / restart / stop on a service row, breadcrumb tools, …).
 * Aria-pressed renders the active background. */

const iconButtonVariants = cva(
  [
    "inline-grid place-items-center rounded-md cursor-pointer",
    "text-[color:var(--muted-foreground)] bg-transparent border-0",
    "transition-[background-color,color] duration-100",
    "hover:bg-[color:var(--hover)] hover:text-[color:var(--ink)]",
    "aria-pressed:bg-[color:var(--hover)] aria-pressed:text-[color:var(--ink)]",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:color-mix(in_oklch,var(--ink)_50%,transparent)]",
    "disabled:pointer-events-none disabled:opacity-40",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      size: {
        xs: "h-[22px] w-[22px] [&_svg]:size-3",
        sm: "h-[26px] w-[26px] [&_svg]:size-[13px]",
        default: "h-[28px] w-[28px] [&_svg]:size-[15px]",
        md: "h-[32px] w-[32px] [&_svg]:size-4",
        lg: "h-[36px] w-[36px] [&_svg]:size-4",
      },
      tone: {
        default: "",
        danger:
          "hover:bg-[color:var(--bad-soft)] hover:text-[color:var(--bad)] aria-pressed:bg-[color:var(--bad-soft)] aria-pressed:text-[color:var(--bad)] text-[color:var(--bad)]",
        muted:
          "text-[color:color-mix(in_oklch,var(--ink)_55%,transparent)]",
      },
    },
    defaultVariants: {
      size: "default",
      tone: "default",
    },
  },
);

type IconButtonProps = ComponentProps<"button"> &
  VariantProps<typeof iconButtonVariants>;

function IconButton({
  className,
  size,
  tone,
  type = "button",
  ...props
}: IconButtonProps) {
  return (
    <button
      data-slot="icon-button"
      type={type}
      className={cn(iconButtonVariants({ size, tone, className }))}
      {...props}
    />
  );
}

export { IconButton, iconButtonVariants };
export type { IconButtonProps };
