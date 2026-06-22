import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/* ErrorBlock — soft-red surface for an error excerpt. Renders a leading
 * title strong-line and a monospace stack body. Used by the failed-state
 * worktree surface. */

type ErrorBlockProps = {
  title?: ReactNode;          /* "Application error · db migrate" */
  children: ReactNode;        /* the body — typically a <pre>-like stack */
  className?: string;
  "data-testid"?: string;
};

function ErrorBlock({ title, children, className, "data-testid": testId }: ErrorBlockProps) {
  return (
    <div
      data-slot="error-block"
      data-testid={testId}
      className={cn(
        "rounded-[10px] px-3.5 py-3 my-3 text-[13.5px] leading-[1.55]",
        "border border-[color:var(--bad-border)] bg-[color:var(--bad-soft)] text-[color:var(--bad)]",
        className,
      )}
    >
      {title !== undefined && title !== null ? (
        <div className="font-semibold mb-1.5">{title}</div>
      ) : null}
      <div className="font-mono text-[12.5px] text-[color:color-mix(in_oklch,var(--bad)_88%,black)] whitespace-pre-wrap break-words">
        {children}
      </div>
    </div>
  );
}

export { ErrorBlock };
export type { ErrorBlockProps };
