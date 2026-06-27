import type { ProjectSummary } from "./ui-api";

/* Deterministic project identity for the rail's session-stream tiles (see
 * demo/sidebar-stream-v3.html, design D3). A project's color is its persisted
 * palette slot (`colorSlot`, assigned round-robin by least-used slot in the
 * registry and user-overridable in Settings → Projects), mapped to one of the
 * --p-1 … --p-36 tokens in index.css. The monogram is the first two
 * alphanumerics of its display name, lowercased. When a record momentarily
 * lacks a slot (e.g. a path used as a stand-in project), the slot falls back to
 * a stable hash of the id so the tile still renders deterministically. */

/** Number of curated palette slots; must equal the --p-* count in index.css and
 * PROJECT_PALETTE_SIZE in packages/core/src/project-registry.ts. */
export const PROJECT_PALETTE_SIZE = 36;

export interface ProjectTileIdentity {
  /** CSS color reference, e.g. `var(--p-3)`. */
  colorVar: string;
  /** 1–2 char lowercased monogram. */
  monogram: string;
}

export interface WorktreeTileIdentity extends ProjectTileIdentity {
  /** Shade tier in [0, WORKTREE_TONES) — distinguishes worktrees that share a
   * project hue by stepping the tile's fill/ring strength. */
  tone: number;
}

/** Shade tiers a worktree tile can take within its project hue. */
export const WORKTREE_TONES = 4;

/** Stable non-negative hash of a string (djb2-ish, 32-bit). */
function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** Whether a value is a valid palette slot index. */
function isValidSlot(slot: unknown): slot is number {
  return (
    typeof slot === "number" &&
    Number.isInteger(slot) &&
    slot >= 0 &&
    slot < PROJECT_PALETTE_SIZE
  );
}

/** Deterministic fallback palette slot for a project id (hash). Used only when
 * a project has no persisted `colorSlot` yet. */
export function projectPaletteSlot(id: string): number {
  return hashId(id) % PROJECT_PALETTE_SIZE;
}

/** A project's identity color, expressed as a CSS var for its palette slot. */
function colorVarForSlot(slot: number): string {
  return `var(--p-${slot + 1})`;
}

/** Identity to color: the persisted `colorSlot` when valid, else a stable hash
 * of the id (fallback for records that predate the slot or stand-in paths). */
function resolveSlot(project: { id?: string; colorSlot?: number }): number {
  if (isValidSlot(project.colorSlot)) return project.colorSlot;
  return project.id ? projectPaletteSlot(project.id) : 0;
}

/** First two alphanumerics of a display name, lowercased: `depboy`→`de`,
 * `lk_current`→`lk`, `hr`→`hr`. Falls back to `??` when the name has none. */
export function projectMonogram(displayName: string): string {
  const chars = displayName.match(/[a-z0-9]/gi) ?? [];
  const mono = chars.slice(0, 2).join("").toLowerCase();
  return mono || "??";
}

export function projectTile(
  project: Pick<ProjectSummary, "displayName"> & {
    id?: string;
    colorSlot?: number;
  },
): ProjectTileIdentity {
  return {
    colorVar: colorVarForSlot(resolveSlot(project)),
    monogram: projectMonogram(project.displayName),
  };
}

/* Worktree identity for the session stream. The tile encodes both axes the rail
 * needs to read at a glance: the project (its color slot — so every session in a
 * project stays the same hue family) and the worktree (a distinct monogram +
 * shade tier, so sibling worktrees of one project no longer collapse into one
 * identical tile). Tone collisions inside a project are acceptable — the
 * monogram and the line-2 branch label disambiguate. */

/** Worktree monogram: branch labels are usually multi-segment (`feature/login`,
 * `wos-d38cf804`), so prefer the initials of the first two segments
 * (`feature-tree`→`ft`, `fix/auth`→`fa`); fall back to the first two
 * alphanumerics of a single-segment label (`main`→`ma`). */
export function worktreeMonogram(label: string): string {
  const segments = label.split(/[^a-z0-9]+/i).filter(Boolean);
  if (segments.length >= 2) {
    return (segments[0]![0]! + segments[1]![0]!).toLowerCase();
  }
  return projectMonogram(label);
}

/** Shade tier in [0, WORKTREE_TONES) for a worktree path. */
export function worktreeTone(path: string): number {
  return hashId(path) % WORKTREE_TONES;
}

export function worktreeTile(
  project: { id?: string; colorSlot?: number },
  worktree: { path: string; label: string },
): WorktreeTileIdentity {
  return {
    colorVar: colorVarForSlot(resolveSlot(project)),
    monogram: worktreeMonogram(worktree.label),
    tone: worktreeTone(worktree.path),
  };
}
