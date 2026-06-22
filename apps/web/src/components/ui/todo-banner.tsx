import { Check, Loader, X } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/* TodoBanner — single-line "N of M completed" / "running" / "failed" strip
 * placed just below the CommandPill. Replaces the old chip-with-glow status
 * affordance. */

type TodoTone = "done" | "running" | "failed" | "idle";

type TodoBannerProps = {
  tone?: TodoTone;
  children: ReactNode;          /* main text — supports inline <strong>, <Ic> */
  meta?: ReactNode;             /* right-aligned secondary text */
  className?: string;
  "data-testid"?: string;
};

function toneStyles(tone: TodoTone) {
  switch (tone) {
    case "running":
      return {
        wrap: "border-[color:var(--hair-2)] bg-[color:var(--surface)]",
        check: "bg-[color:var(--accent-cmd-soft)] text-[color:var(--accent-cmd)]",
        meta: "text-[color:var(--muted-foreground)]",
      };
    case "failed":
      return {
        wrap: "border-[color:var(--bad-border)] bg-[color:var(--bad-soft)]",
        check: "bg-[color:color-mix(in_oklch,var(--bad)_18%,transparent)] text-[color:var(--bad)]",
        meta: "text-[color:var(--bad)]",
      };
    case "idle":
      return {
        wrap: "border-[color:var(--hair-2)] bg-[color:var(--surface)]",
        check: "bg-[color:var(--chip-bg)] text-[color:var(--muted-foreground)]",
        meta: "text-[color:var(--muted-foreground)]",
      };
    case "done":
    default:
      return {
        wrap: "border-[color:var(--hair-2)] bg-[color:var(--surface)]",
        check:
          "bg-[color:color-mix(in_oklch,var(--good)_16%,transparent)] text-[color:var(--good)]",
        meta: "text-[color:var(--muted-foreground)]",
      };
  }
}

function ToneIcon({ tone }: { tone: TodoTone }) {
  if (tone === "running") return <Loader className="size-3 animate-spin" />;
  if (tone === "failed") return <X className="size-3" />;
  if (tone === "idle") return <span className="size-2 rounded-full bg-current" aria-hidden />;
  return <Check className="size-3" />;
}

function TodoBanner({
  tone = "done",
  children,
  meta,
  className,
  "data-testid": testId,
}: TodoBannerProps) {
  const t = toneStyles(tone);
  return (
    <div
      data-slot="todo-banner"
      data-tone={tone}
      data-testid={testId}
      className={cn(
        "flex items-center gap-2.5 rounded-[10px] px-3.5 py-2.5 border text-[13.5px]",
        t.wrap,
        className,
      )}
    >
      <span
        className={cn(
          "inline-grid place-items-center size-[18px] rounded-full",
          t.check,
        )}
        aria-hidden
      >
        <ToneIcon tone={tone} />
      </span>
      <span className="text-[color:var(--ink)] flex-1 min-w-0">{children}</span>
      {meta !== undefined && meta !== null ? (
        <span className={cn("text-[12.5px] shrink-0", t.meta)}>{meta}</span>
      ) : null}
    </div>
  );
}

export { TodoBanner };
export type { TodoBannerProps, TodoTone };
