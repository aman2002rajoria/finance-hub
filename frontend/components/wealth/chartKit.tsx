"use client";

/*
 * Small shared pieces for the hand-drawn wealth charts: a width hook, short
 * money for axes and labels, tidy ticks, and the floating tooltip box.
 */

import clsx from "clsx";
import { useCallback, useEffect, useState } from "react";

/** Size of a container, updated on resize. A callback ref, so it works
 *  even when the element mounts after the component (e.g. after loading). */
export function useSize<T extends HTMLElement = HTMLDivElement>() {
  const [el, setEl] = useState<T | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(el);
    const r = el.getBoundingClientRect();
    setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    return () => ro.disconnect();
  }, [el]);
  const ref = useCallback((node: T | null) => setEl(node), []);
  return [ref, size] as const;
}

/** Width of a container (see useSize). 0 until measured. */
export function useWidth<T extends HTMLElement = HTMLDivElement>() {
  const [ref, size] = useSize<T>();
  return [ref, size.w] as const;
}

/** ₹15.5L, ₹69k, ₹640. For axes, pins and tight labels. */
export function shortInr(n: number, signed = false): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : signed && n > 0 ? "+" : "";
  const one = (v: number) => (v >= 100 ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, ""));
  if (abs >= 1e7) return `${sign}₹${one(abs / 1e7)}Cr`;
  if (abs >= 1e5) return `${sign}₹${one(abs / 1e5)}L`;
  if (abs >= 1e3) return `${sign}₹${Math.round(abs / 1e3)}k`;
  return `${sign}₹${Math.round(abs)}`;
}

/** About `count` round ticks covering [lo, hi]. */
export function niceTicks(lo: number, hi: number, count = 4): number[] {
  const span = Math.max(1, hi - lo);
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-6; v += step) out.push(v);
  return out;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-09-18" -> "18 Sep" */
export const dayMon = (iso: string) => `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]}`;
/** "2026-09" -> "Sep" */
export const mon = (iso: string) => MON[Number(iso.slice(5, 7)) - 1] ?? "";

/** Tooltip box positioned inside a relative parent, flipped to stay in view. */
export function FloatTip({
  x, y, width, children, className, align = "auto",
}: {
  x: number; y: number; width: number; children: React.ReactNode; className?: string;
  align?: "auto" | "center";
}) {
  const boxW = 210;
  let left = align === "center" ? x - boxW / 2 : x + 14;
  if (align === "auto" && left + boxW > width) left = x - boxW - 14;
  left = Math.max(0, Math.min(width - boxW, left));
  return (
    <div
      role="status"
      className={clsx("pointer-events-none absolute z-20 rounded-s bg-card px-3.5 py-2.5 shadow-float", className)}
      style={{ left, top: Math.max(0, y), width: boxW }}
    >
      {children}
    </div>
  );
}

/** One "label …… value" line inside a tooltip. */
export function TipRow({ dot, label, value, strong }: { dot?: string; label: string; value: string; strong?: boolean }) {
  return (
    <p className={clsx("flex items-center gap-2 text-[13px]", strong ? "font-extrabold text-ink" : "text-ink-2")}>
      {dot && <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: dot }} />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="tabular-nums">{value}</span>
    </p>
  );
}
