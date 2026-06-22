import type { AttentionGroupKey } from "@/lib/sidebar-attention";

/* AttentionGroupHeader — the quiet divider above each non-empty group in the
 * rail's Sessions-mode stream (see demo/sidebar-stream-v3.html): a small colored
 * dot + the group name + a trailing count. The dot color is the only signal the
 * group state needs (the rows beneath carry no leading status dot). */

const DOT_COLOR: Record<AttentionGroupKey, string> = {
  needsYou: "#F59E0B", // status amber (matches StatusDot `partial`)
  unread: "var(--unread)",
  working: "var(--good)",
  idle: "var(--muted-foreground)",
};

interface AttentionGroupHeaderProps {
  variant: AttentionGroupKey;
  label: string;
  count: number;
}

export function AttentionGroupHeader({
  variant,
  label,
  count,
}: AttentionGroupHeaderProps) {
  return (
    <div className="flex items-center gap-2 px-2 pb-[5px] pt-3.5 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[color:var(--muted-foreground)] first:pt-1.5">
      <span
        aria-hidden
        className="size-1.5 shrink-0 rounded-full"
        style={{ background: DOT_COLOR[variant] }}
      />
      <span>{label}</span>
      <span className="ml-auto font-mono text-[10.5px] font-medium tabular-nums tracking-normal text-[color:var(--muted-foreground)]">
        {count}
      </span>
    </div>
  );
}
