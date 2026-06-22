import { Fragment, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/* MatchHighlight — wraps the substring(s) of `text` matching `query` in a
 * quiet <mark>. Case-insensitive, regex-escaped. Styling uses the neutral
 * chip token (not the amber command accent, which is reserved for slash
 * prefixes). When the query is empty or unmatched, renders the plain text.
 *
 *     <MatchHighlight text={branchName} query={searchQuery} />
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function MatchHighlight({
  text,
  query,
  className,
}: {
  text: string;
  query: string;
  className?: string;
}): ReactNode {
  const q = query.trim();
  if (!q) return text;
  const pattern = new RegExp(`(${escapeRegExp(q)})`, "ig");
  const parts = text.split(pattern);
  if (parts.length <= 1) return text;
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <mark
        key={index}
        className={cn(
          "rounded-[3px] bg-[color:var(--chip-bg-2)] px-[1px] text-[color:var(--ink)]",
          className,
        )}
      >
        {part}
      </mark>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    ),
  );
}
