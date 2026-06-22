import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

/* ProjectTile — the rounded-square monogram tile that gives a project its
 * identity in the rail's Sessions-mode stream (see demo/sidebar-stream-v3.html,
 * design D3/D5). A color-mix fill + inset ring in the project color, with the
 * 2-char monogram centered in Geist Mono. When `working`, a short bead traces
 * the tile border in the project color (the project icon doubles as the
 * activity light) — the runner CSS (`.tile-run`) lives in index.css and is
 * removed under prefers-reduced-motion. The tile is always a rounded square; it
 * never becomes a circle. */

interface ProjectTileProps {
  /** 1–2 char monogram (see projectMonogram). */
  monogram: string;
  /** CSS color reference for this project, e.g. `var(--p-3)`. */
  colorVar: string;
  /** Animate the border runner — the session is working. */
  working?: boolean;
  /** Edge length in px. Defaults to 26 (desktop stream row). */
  size?: number;
  className?: string;
}

export function ProjectTile({
  monogram,
  colorVar,
  working = false,
  size = 26,
  className,
}: ProjectTileProps) {
  const style: CSSProperties = {
    // `--pc` drives both the fill/ring (here) and the runner stroke (.tile-run).
    ["--pc" as string]: colorVar,
    width: size,
    height: size,
    color: "var(--pc)",
    background: "color-mix(in oklch, var(--pc) 10%, var(--surface))",
    boxShadow: "inset 0 0 0 1px color-mix(in oklch, var(--pc) 22%, transparent)",
  };

  return (
    <span
      aria-hidden
      className={cn(
        "relative grid shrink-0 place-items-center rounded-lg font-mono text-[10px] font-semibold tracking-[-0.02em]",
        className,
      )}
      style={style}
    >
      {working && (
        <svg className="tile-run" viewBox="0 0 26 26" aria-hidden="true">
          <rect x="1" y="1" width="24" height="24" rx="7" ry="7" pathLength={100} />
        </svg>
      )}
      {monogram}
    </span>
  );
}
