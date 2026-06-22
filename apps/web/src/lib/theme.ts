import { useEffect, useState } from "react";

export type ThemeMode = "system" | "light" | "dark";

const STORAGE_KEY = "wos.theme";

const THEME_COLOR_LIGHT = "#FBFBFA";
const THEME_COLOR_DARK = "#161614";

function readStored(): ThemeMode {
  if (typeof window === "undefined") return "system";
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    /* ignore */
  }
  return "system";
}

function resolveSystem(): "light" | "dark" {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function setMetaThemeColor(effective: "light" | "dark"): void {
  if (typeof document === "undefined") return;
  const color = effective === "dark" ? THEME_COLOR_DARK : THEME_COLOR_LIGHT;
  let tag = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!tag) {
    tag = document.createElement("meta");
    tag.name = "theme-color";
    document.head.appendChild(tag);
  }
  tag.setAttribute("content", color);
}

export function applyTheme(mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  const effective = mode === "system" ? resolveSystem() : mode;
  document.documentElement.classList.toggle("dark", effective === "dark");
  setMetaThemeColor(effective);
}

applyTheme(readStored());

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(readStored);

  useEffect(() => {
    applyTheme(mode);
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* ignore quota / privacy mode */
    }
  }, [mode]);

  useEffect(() => {
    if (mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme("system");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [mode]);

  return { mode, setMode };
}
