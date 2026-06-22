import type { CSSProperties } from "react";
import { getSetiFileIcon } from "@/lib/seti-icons";
import { cn } from "@/lib/utils";

/**
 * Renders the Seti UI glyph for a file path using the bundled `seti.woff`
 * font. The two CSS variables let the global stylesheet pick the right tint
 * for light vs dark themes without re-running the lookup on theme switch.
 *
 * Returns `null` when the file has no Seti mapping at all — callers should
 * render their own fallback in that case (e.g. a lucide File icon).
 */
export function SetiFileIcon({
  path,
  className,
}: {
  path: string;
  className?: string;
}) {
  const icon = getSetiFileIcon(path);
  if (!icon) return null;
  const style = {
    "--seti-icon-dark": icon.colorDark,
    "--seti-icon-light": icon.colorLight,
  } as CSSProperties;
  return (
    <span aria-hidden className={cn("seti-icon", className)} style={style}>
      {icon.char}
    </span>
  );
}
