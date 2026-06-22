import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/* quiet-workspace v3 Button.
 *
 * default — pill 30pt with 1px hairline border (the new resting button)
 * solid   — solid ink fill with surface text (former primary CTA)
 * ghost   — transparent, hover-fill only
 * danger  — text-only red; hover fades into bad-soft
 *
 * destructive/outline/secondary/link survive as compatibility aliases for
 * callers that haven't migrated yet. They render with v3 styling. */

const buttonVariants = cva(
  [
    "relative inline-flex cursor-pointer items-center justify-center gap-2",
    "whitespace-nowrap rounded-lg font-medium select-none",
    "transition-[background-color,color,border-color,box-shadow] duration-150",
    "outline-none focus-visible:outline-2 focus-visible:outline-offset-2",
    "focus-visible:outline-[color:color-mix(in_oklch,var(--ink)_50%,transparent)]",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        default:
          "bg-[color:var(--surface)] text-[color:var(--ink)] border border-[color:var(--hair-2)] hover:bg-[color:var(--hover)]",
        solid:
          "bg-[color:var(--ink)] text-[color:var(--surface)] border border-[color:var(--ink)] hover:brightness-[0.96]",
        ghost:
          "bg-transparent text-[color:var(--ink-2)] border border-transparent hover:bg-[color:var(--hover)] hover:text-[color:var(--ink)]",
        danger:
          "bg-transparent text-[color:var(--bad)] border border-transparent hover:bg-[color:var(--bad-soft)] hover:border-[color:var(--bad-border)]",
        // legacy aliases — keep existing callers compiling, render v3
        destructive:
          "bg-transparent text-[color:var(--bad)] border border-[color:var(--bad-border)] hover:bg-[color:var(--bad-soft)]",
        outline:
          "bg-[color:var(--surface)] text-[color:var(--ink)] border border-[color:var(--hair-2)] hover:bg-[color:var(--hover)]",
        secondary:
          "bg-[color:var(--hover)] text-[color:var(--ink)] border border-transparent hover:bg-[color:var(--chip-bg-2)]",
        link:
          "bg-transparent text-[color:var(--ink)] underline-offset-4 hover:underline px-0",
      },
      size: {
        xs: "h-[22px] px-2 text-xs gap-1.5 [&_svg]:size-3",
        sm: "h-[26px] px-2.5 text-[12.5px] [&_svg]:size-[13px]",
        default: "h-[30px] px-3 text-[13px] [&_svg]:size-[14px]",
        md: "h-[32px] px-3.5 text-[13px] [&_svg]:size-[14px]",
        lg: "h-[36px] px-3.5 text-[13.5px] [&_svg]:size-[15px]",
        icon: "h-[30px] w-[30px] [&_svg]:size-[14px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type ButtonProps = ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  };

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
export type { ButtonProps };
