// Test data mode (design.md §16).
//
// "own"  -> the real backend at /api      (your finance.db)
// "test" -> the demo backend at /demo-api (synthetic demo.db, safe to show)
//
// The choice lives in localStorage. `?mode=test` / `?mode=own` in the URL
// sets it (handy for portfolio deep links). NEXT_PUBLIC_DEFAULT_MODE sets
// the default for a deployment; NEXT_PUBLIC_TEST_ONLY=1 locks a public
// build to test data so real statements can never be served from it.


import { useSyncExternalStore } from "react";

export type DataMode = "own" | "test";

const KEY = "fh-data-mode";
const EVENT = "fh-data-mode-change";

export const TEST_ONLY = process.env.NEXT_PUBLIC_TEST_ONLY === "1";
const ENV_DEFAULT = process.env.NEXT_PUBLIC_DEFAULT_MODE as DataMode | undefined;

function readStored(): DataMode | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "own" || v === "test" ? v : null;
  } catch {
    return null;
  }
}

/** Apply ?mode= from the URL once, on first read in the browser. */
let urlApplied = false;
function applyUrlMode() {
  if (urlApplied || typeof window === "undefined") return;
  urlApplied = true;
  try {
    const m = new URLSearchParams(window.location.search).get("mode");
    if (m === "own" || m === "test") window.localStorage.setItem(KEY, m);
  } catch { /* storage blocked: fall through to defaults */ }
}

/** The mode the app should use right now, or null if the user hasn't chosen. */
export function getDataMode(): DataMode | null {
  if (TEST_ONLY) return "test";
  applyUrlMode();
  return readStored() ?? ENV_DEFAULT ?? null;
}

/** Mode used for requests before a choice exists: never leak own data by default on a public build. */
export function effectiveMode(): DataMode {
  return getDataMode() ?? (ENV_DEFAULT ?? "own");
}

export function apiPrefix(): string {
  return effectiveMode() === "test" ? "/demo-api" : "/api";
}

export function directApiRoot(): string {
  if (effectiveMode() === "test") {
    return process.env.NEXT_PUBLIC_DEMO_API_URL || "http://localhost:8001";
  }
  return process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
}

/**
 * Switch mode. Reloads so every SWR cache and in-flight request starts
 * clean against the other backend.
 */
export function setDataMode(mode: DataMode, { reload = true } = {}) {
  if (TEST_ONLY && mode === "own") return;
  try { window.localStorage.setItem(KEY, mode); } catch { /* ignore */ }
  window.dispatchEvent(new Event(EVENT));
  if (reload) window.location.reload();
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

/** React hook: current mode (null until chosen). Server snapshot is "pending". */
export function useDataMode(): DataMode | null | "pending" {
  return useSyncExternalStore(
    subscribe,
    () => getDataMode(),
    () => "pending" as const,
  );
}
