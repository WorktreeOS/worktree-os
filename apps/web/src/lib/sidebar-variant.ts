import { useSyncExternalStore } from "react";

/* Rail body preference — which sidebar layout renders inside the shared rail
 * chrome (scope header / filter bar / footer stay identical either way):
 *   "v3" — flat attention stream + a separate flat Worktrees band (default).
 *   "v4" — a worktree tree: each worktree is a node, sessions are its
 *          children (see demo/sidebar-worktree-tree-v4.html).
 * Per-device only, picked in Settings → Web → Sidebar. */

export type SidebarVariant = "v3" | "v4";

export const SIDEBAR_VARIANT_STORAGE_KEY = "wos.sidebar.variant";

export function readSidebarVariant(
  storage?: Pick<Storage, "getItem"> | null,
): SidebarVariant {
  if (!storage) return "v3";
  try {
    return storage.getItem(SIDEBAR_VARIANT_STORAGE_KEY) === "v4" ? "v4" : "v3";
  } catch {
    return "v3";
  }
}

export function writeSidebarVariant(
  storage: Pick<Storage, "setItem"> | null | undefined,
  next: SidebarVariant,
): void {
  if (!storage) return;
  try {
    storage.setItem(SIDEBAR_VARIANT_STORAGE_KEY, next);
  } catch {
    /* ignore quota / privacy mode */
  }
}

function localStorageOrNull(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/* Module-level subscribable store: the rail (`Sidebar`, mounted once and
 * never remounted across route navigation) and the Settings page are two
 * different component trees. A plain `useState(() => readSidebarVariant())`
 * initializer — the pattern used by lib/sidebar-scope.ts — would only read
 * localStorage once at mount, so flipping the Settings toggle would never
 * reach the already-mounted rail. `useSyncExternalStore` keeps every
 * subscriber in sync instead, including across browser tabs via `storage`. */
let snapshot: SidebarVariant = readSidebarVariant(localStorageOrNull());
const listeners = new Set<() => void>();

function setSidebarVariant(next: SidebarVariant): void {
  writeSidebarVariant(localStorageOrNull(), next);
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (typeof window === "undefined") {
    return () => listeners.delete(listener);
  }
  const onStorage = (e: StorageEvent) => {
    if (e.key !== SIDEBAR_VARIANT_STORAGE_KEY) return;
    snapshot = readSidebarVariant(localStorageOrNull());
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function getSnapshot(): SidebarVariant {
  return snapshot;
}

function getServerSnapshot(): SidebarVariant {
  return "v3";
}

export function useSidebarVariant(): [
  SidebarVariant,
  (next: SidebarVariant) => void,
] {
  const variant = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  return [variant, setSidebarVariant];
}
