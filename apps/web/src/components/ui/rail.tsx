import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

/* Rail — left sidebar shell.
 *
 *   <Rail>
 *     <Rail.Group>
 *       <Rail.Row icon={<Plus />} kbd="⌘N">New worktree</Rail.Row>
 *       …
 *     </Rail.Group>
 *     <Rail.Label>Workspaces</Rail.Label>
 *     <Rail.Group>…</Rail.Group>
 *     <Rail.Footer>…</Rail.Footer>
 *   </Rail>
 */

type RailProps = HTMLAttributes<HTMLElement>;

function Rail({ className, children, ...props }: RailProps) {
  return (
    <aside
      data-slot="rail"
      className={cn(
        "flex flex-col min-h-0 w-[240px] shrink-0",
        "bg-[color:var(--shell)] border-r border-[color:var(--hair)]",
        "px-2.5 py-3",
        className,
      )}
      {...props}
    >
      {children}
    </aside>
  );
}

type RailGroupProps = HTMLAttributes<HTMLDivElement>;

function RailGroup({ className, children, ...props }: RailGroupProps) {
  return (
    <div
      data-slot="rail-group"
      className={cn("flex flex-col gap-0.5", className)}
      {...props}
    >
      {children}
    </div>
  );
}

type RailLabelProps = HTMLAttributes<HTMLDivElement>;

function RailLabel({ className, children, ...props }: RailLabelProps) {
  return (
    <div
      data-slot="rail-label"
      className={cn(
        "px-2.5 pt-4 pb-1.5 text-[11.5px] text-[color:var(--muted-foreground)]",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

type RailRowProps = HTMLAttributes<HTMLDivElement> & {
  icon?: ReactNode;
  trailing?: ReactNode;       /* e.g. kbd shortcut, count badge */
  kbd?: string;
  active?: boolean;
  nested?: boolean;
  asButton?: boolean;
};

function RailRow({
  className,
  children,
  icon,
  trailing,
  kbd,
  active,
  nested,
  asButton,
  onClick,
  onKeyDown,
  ...props
}: RailRowProps) {
  const Comp = asButton ? "button" : ("div" as const);
  const buttonProps =
    asButton
      ? ({
          type: "button" as const,
          onClick,
          onKeyDown,
        })
      : ({ onClick, onKeyDown, role: "button", tabIndex: 0 });

  return (
    <Comp
      data-slot="rail-row"
      data-active={active ? "true" : undefined}
      data-nested={nested ? "true" : undefined}
      className={cn(
        "flex items-center gap-2.5 h-[30px] px-2.5 rounded-[7px] w-full text-left",
        "text-[13.5px] text-[color:var(--ink-2)] cursor-pointer bg-transparent border-0",
        "transition-[background-color,color] duration-100",
        "hover:bg-[color:var(--hover)] hover:text-[color:var(--ink)]",
        "data-[active=true]:bg-[color:var(--hover)] data-[active=true]:text-[color:var(--ink)] data-[active=true]:font-medium",
        nested ? "pl-7 text-[13px]" : "",
        className,
      )}
      {...(buttonProps as Record<string, unknown>)}
      {...props}
    >
      {icon !== undefined && icon !== null ? (
        <span
          className={cn(
            "inline-flex items-center justify-center shrink-0 text-[color:var(--muted-foreground)] [&_svg]:size-[15px]",
            active ? "text-[color:var(--ink)]" : "",
          )}
          aria-hidden
        >
          {icon}
        </span>
      ) : null}
      <span className="flex-1 truncate">{children}</span>
      {kbd !== undefined ? (
        <span className="font-mono text-[11px] text-[color:var(--muted-foreground)] tracking-wide">
          {kbd}
        </span>
      ) : null}
      {trailing !== undefined && trailing !== null ? (
        <span className="text-[color:var(--muted-foreground)]">{trailing}</span>
      ) : null}
    </Comp>
  );
}

type RailFooterProps = HTMLAttributes<HTMLDivElement>;

function RailFooter({ className, children, ...props }: RailFooterProps) {
  return (
    <div
      data-slot="rail-footer"
      className={cn(
        "mt-auto pt-3 border-t border-[color:var(--hair)]",
        "flex items-center gap-2.5",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export { Rail, RailGroup, RailLabel, RailRow, RailFooter };
export type { RailRowProps };
