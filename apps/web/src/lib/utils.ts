import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Formats an ISO timestamp as a compact relative string (e.g. "2h ago").
 * Returns null for missing or unparseable input.
 */
export function formatRelativeTime(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const diff = Date.now() - d.getTime();
  const seconds = Math.max(0, Math.round(diff / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/**
 * Formats an elapsed duration in milliseconds as a single-unit compact string
 * (`<1m`, `45m`, `2h`, `3d`), matching the session rows' age idiom. For a live
 * session footer where it reads as "how long this session has run".
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "<1m";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
