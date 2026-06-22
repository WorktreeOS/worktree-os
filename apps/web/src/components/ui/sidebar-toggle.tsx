import { PanelLeft } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/* SidebarToggle — the rail collapse/expand control. It lives in the page header
 * (not inside the rail and not as a floating overlay), so every primary surface
 * carries the same affordance: collapse the rail when open, reopen it when
 * collapsed. Desktop-only by convention — on touch the rail is reached through
 * the bottom-sheet navigator, so the control is hidden below `lg`. */
export function SidebarToggle({
  sidebarOpen,
  onToggle,
  className,
}: {
  sidebarOpen: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const label = sidebarOpen ? "Collapse sidebar" : "Open menu";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onToggle}
          aria-label={label}
          data-testid="open-sidebar-button"
          className={cn(
            "hidden size-8 shrink-0 cursor-pointer place-items-center rounded-md text-[color:var(--muted-foreground)] transition-colors hover:bg-[color:var(--hover)] hover:text-[color:var(--ink)] focus-ring lg:inline-grid",
            className,
          )}
        >
          <PanelLeft className="h-4 w-4" strokeWidth={1.75} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
