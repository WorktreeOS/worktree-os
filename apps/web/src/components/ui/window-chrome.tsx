import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/* WindowChrome — top strip of the document window: traffic-light dots on the
 * left (always rendered for desktop layouts), breadcrumb in the centre, and
 * tool icon-buttons on the right. Decorative — actual control affordances
 * live in the rail or the document footer. */

type WindowChromeProps = {
  crumbs?: ReactNode;          /* "shop-checkout-v2 — WorktreeOS" or a node */
  trailing?: ReactNode;        /* status pill, ctx info, etc. */
  tools?: ReactNode;           /* IconButton cluster on the right edge */
  showTrafficLights?: boolean; /* hide for embedded/mobile contexts */
  className?: string;
  "data-testid"?: string;
};

function WindowChrome({
  crumbs,
  trailing,
  tools,
  showTrafficLights = true,
  className,
  "data-testid": testId,
}: WindowChromeProps) {
  return (
    <div
      data-slot="window-chrome"
      data-testid={testId}
      className={cn(
        "flex items-center gap-2.5 h-[38px] px-3.5",
        "border-b border-[color:var(--hair)] bg-[color:var(--shell)]",
        "text-[12.5px] text-[color:var(--muted-foreground)] select-none",
        className,
      )}
    >
      {showTrafficLights ? (
        <div className="flex items-center gap-2" aria-hidden>
          <span className="size-3 rounded-full bg-[#FF5F57]" />
          <span className="size-3 rounded-full bg-[#FEBC2E]" />
          <span className="size-3 rounded-full bg-[#28C840]" />
        </div>
      ) : null}
      {crumbs !== undefined && crumbs !== null ? (
        <div className="inline-flex items-center gap-2 ml-2 min-w-0">{crumbs}</div>
      ) : null}
      <div className="flex-1" />
      {trailing !== undefined && trailing !== null ? (
        <div className="inline-flex items-center gap-2">{trailing}</div>
      ) : null}
      {tools !== undefined && tools !== null ? (
        <div className="inline-flex items-center gap-0.5 ml-1">{tools}</div>
      ) : null}
    </div>
  );
}

export { WindowChrome };
export type { WindowChromeProps };
