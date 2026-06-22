import { useCallback, useEffect, useRef, useState } from "react";

import { COMPACT_VIEWPORT_PX } from "@/lib/worktree-tabs";

/**
 * Tracks a DOM element's offsetWidth via ResizeObserver. Returns 0 when the
 * element is unmounted; callers can use this as a "not laid out yet" signal.
 */
export function useContentWidth(): {
  ref: (el: HTMLElement | null) => void;
  width: number;
} {
  const [width, setWidth] = useState(0);
  const elementRef = useRef<HTMLElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  const ref = useCallback((el: HTMLElement | null) => {
    elementRef.current = el;
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (!el) {
      setWidth(0);
      return;
    }
    setWidth(el.offsetWidth);
    if (typeof ResizeObserver !== "undefined") {
      const obs = new ResizeObserver((entries) => {
        for (const entry of entries) {
          setWidth(entry.contentRect.width);
        }
      });
      obs.observe(el);
      observerRef.current = obs;
    }
  }, []);

  useEffect(() => {
    return () => observerRef.current?.disconnect();
  }, []);

  return { ref, width };
}

/**
 * Tracks whether the viewport is compact (iPad-sized or smaller). The worktree
 * detail page uses this to lead with touch chrome instead of the desktop tab
 * strip and focus control.
 */
export function useIsCompactViewport(): boolean {
  const query = `(max-width: ${COMPACT_VIEWPORT_PX - 1}px)`;
  const [compact, setCompact] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setCompact(e.matches);
    setCompact(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [query]);
  return compact;
}

/**
 * Tracks whether the device has any touch input, independent of viewport width.
 *
 * Unlike `(pointer: coarse)` — which reflects only the *primary* pointer and is
 * false on a touchscreen laptop driven mostly by its trackpad — `(any-pointer:
 * coarse)` is true whenever *any* available pointer is coarse, so a wide
 * touchscreen desktop is recognised as touch-capable. Used to layer
 * touch-friendly affordances (larger hit targets, inline actions in place of
 * hover-only ones) on top of the width-based desktop layout, which stays put.
 */
export function useHasTouch(): boolean {
  const query = "(any-pointer: coarse)";
  const [hasTouch, setHasTouch] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setHasTouch(e.matches);
    setHasTouch(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return hasTouch;
}
