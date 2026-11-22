// Light / dark theme. The choice ("light" | "dark" | "system") lives in
// localStorage; the resolved theme is written to <html data-theme="…">.
// A tiny inline script in app/layout.tsx applies it before first paint.

import { useSyncExternalStore } from "react";

export type ThemeChoice = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const KEY = "fh-theme";
const EVENT = "fh-theme-change";

export { THEME_BOOT_SCRIPT } from "./themeScript";

function readChoice(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "system";
  } catch {
    return "system";
  }
}

function systemDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolvedTheme(): ResolvedTheme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function apply(choice: ThemeChoice) {
  const dark = choice === "dark" || (choice === "system" && systemDark());
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
}

export function setTheme(choice: ThemeChoice) {
  try { window.localStorage.setItem(KEY, choice); } catch { /* ignore */ }
  apply(choice);
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(cb: () => void) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onSystem = () => {
    if (readChoice() === "system") { apply("system"); cb(); }
  };
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  mq.addEventListener("change", onSystem);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
    mq.removeEventListener("change", onSystem);
  };
}

/** The user's choice. */
export function useTheme(): ThemeChoice {
  return useSyncExternalStore(subscribe, readChoice, () => "system" as const);
}

/** What's actually on screen. Use it to key charts so they redraw on switch. */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, resolvedTheme, () => "light" as const);
}
