/* Add-project modal helpers extracted so they can be unit-tested without
 * mounting React. The modal owns the rendering and side-effect wiring; this
 * module owns the path-derivation rules used by the autocomplete combobox. */

import type { DirectorySuggestion } from "@/lib/ui-api";

/**
 * Resolve the candidate path to send to the daemon for listing, given the
 * current input. The daemon resolves it: an existing directory is listed
 * directly; a path that does not exist falls back to its parent.
 *
 *   ""             → ""       (caller skips loading)
 *   "/"            → "/"
 *   "/usr/"        → "/usr"   (trailing slashes collapsed)
 *   "/usr/local"   → "/usr/local"
 *   "/usr/loc"     → "/usr/loc"
 */
export function deriveDirPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) return "";
  const collapsed = trimmed.replace(/\/+$/, "");
  return collapsed.length === 0 ? "/" : collapsed;
}

/** The parent directory of a candidate path (string-only, no fs access). */
export function parentDirOf(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash <= 0) return "/";
  return path.slice(0, lastSlash);
}

/**
 * Resolve the partial filename to filter the listing by, derived from the
 * directory the daemon actually listed (`listedPath`). When the daemon listed
 * the candidate itself (an exact existing directory), there is no partial
 * segment and all children are shown. When it fell back to the parent, the
 * candidate's last segment is the filter query.
 */
export function deriveQuery(input: string, listedPath: string): string {
  const candidate = deriveDirPath(input);
  if (candidate.length === 0 || candidate === listedPath) return "";
  return candidate.slice(candidate.lastIndexOf("/") + 1);
}

/** Prefix-filter suggestions by the typed partial segment (case-insensitive). */
export function filterSuggestions(
  entries: DirectorySuggestion[],
  query: string,
): DirectorySuggestion[] {
  if (query.length === 0) return entries;
  const q = query.toLowerCase();
  return entries.filter((e) => e.name.toLowerCase().startsWith(q));
}

/**
 * Strip trailing slashes from the input before submission. The canonical
 * project path is what the daemon validates and stores.
 */
export function normalizeForValidation(input: string): string {
  return input.trim().replace(/\/+$/, "");
}
