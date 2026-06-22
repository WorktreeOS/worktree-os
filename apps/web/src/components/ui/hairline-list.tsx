import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

/* HairlineList / HairlineRow — vertical list with 1px dividers between rows
 * and at the bottom edge. Replaces the old "card-of-cards" service list.
 *
 *     <HairlineList>
 *       <HairlineRow leading={<Dot />} actions={<IconButton .../>}>
 *         postgres
 *       </HairlineRow>
 *     </HairlineList>
 */

type HairlineListProps = HTMLAttributes<HTMLDivElement>;

function HairlineList({ className, children, ...props }: HairlineListProps) {
  return (
    <div
      data-slot="hairline-list"
      className={cn(
        "flex flex-col [&>*]:border-t [&>*]:border-[color:var(--hair)]",
        "[&>*:last-child]:border-b",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

type HairlineRowProps = HTMLAttributes<HTMLDivElement> & {
  leading?: ReactNode;       /* left column — typically a status dot or number */
  trailing?: ReactNode;      /* right column — ports / metadata / actions */
  actions?: ReactNode;       /* far-right action cluster */
};

function HairlineRow({
  className,
  children,
  leading,
  trailing,
  actions,
  ...props
}: HairlineRowProps) {
  return (
    <div
      data-slot="hairline-row"
      className={cn(
        "grid items-baseline gap-3 py-2.5",
        "[grid-template-columns:auto_minmax(0,1fr)_auto_auto] empty:hidden",
        className,
      )}
      {...props}
    >
      <div className="self-start pt-[6px]">{leading}</div>
      <div className="min-w-0">{children}</div>
      <div className="text-[13px] text-[color:var(--ink-2)]">{trailing}</div>
      <div className="inline-flex items-center gap-0.5">{actions}</div>
    </div>
  );
}

export { HairlineList, HairlineRow };
export type { HairlineListProps, HairlineRowProps };
