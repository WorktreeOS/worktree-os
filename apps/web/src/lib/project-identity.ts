import type { ProjectSummary } from "./ui-api";

/* Deterministic project identity for the rail's Sessions-mode tiles (see
 * demo/sidebar-stream-v3.html, design D3). A project gets a stable color slot
 * (hash of its id → one of the --p-1 … --p-8 palette in index.css) and a short
 * monogram (first two alphanumerics of its display name, lowercased). Hashing
 * the id alone — not the project set — keeps each project's color independent
 * and stable across devices, so there is no migration and no settings surface.
 * Color collisions across many projects are acceptable: the color is an
 * orientation hint, the monogram + worktree subtitle disambiguate. */

const PALETTE_SIZE = 8;

export interface ProjectTileIdentity {
  /** CSS color reference, e.g. `var(--p-3)`. */
  colorVar: string;
  /** 1–2 char lowercased monogram. */
  monogram: string;
}

/** Stable non-negative hash of a string (djb2-ish, 32-bit). */
function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** Palette slot in [0, PALETTE_SIZE) for a project id. */
export function projectPaletteSlot(id: string): number {
  return hashId(id) % PALETTE_SIZE;
}

/** First two alphanumerics of a display name, lowercased: `depboy`→`de`,
 * `lk_current`→`lk`, `hr`→`hr`. Falls back to `??` when the name has none. */
export function projectMonogram(displayName: string): string {
  const chars = displayName.match(/[a-z0-9]/gi) ?? [];
  const mono = chars.slice(0, 2).join("").toLowerCase();
  return mono || "??";
}

export function projectTile(
  project: Pick<ProjectSummary, "id" | "displayName">,
): ProjectTileIdentity {
  return {
    colorVar: `var(--p-${projectPaletteSlot(project.id) + 1})`,
    monogram: projectMonogram(project.displayName),
  };
}
