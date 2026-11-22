"use client";

/*
 * Small building blocks for the Groceries screens (design.md §7, §9 step 6).
 * - ProductTile: a category-tinted initial tile standing in for a product photo.
 * - RankList: "comparison across items" as labelled bars with values (§10).
 * - ColumnBars: a few periods as big rounded bars, focus in accent (ref 03).
 */

import clsx from "clsx";
import React from "react";

import { CHART_OTHER } from "@/lib/chart-theme";
import { categoryColor } from "@/lib/blinkit-category-colors";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

// ---------------------------------------------------------------------------
// Product tile
// ---------------------------------------------------------------------------

function initialOf(name: string): string {
  const m = (name || "").match(/[A-Za-z0-9]/);
  return m ? m[0].toUpperCase() : "?";
}

export function ProductTile({
  name,
  category,
  size = 40,
  className,
}: {
  name: string;
  category?: string | null;
  size?: number;
  className?: string;
}) {
  const color = category ? categoryColor(category) : CHART_OTHER;
  return (
    <span
      aria-hidden
      className={clsx("grid shrink-0 place-items-center rounded-s font-black", className)}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        backgroundColor: `color-mix(in srgb, ${color} 16%, var(--card))`,
        color: `color-mix(in srgb, ${color} 62%, var(--ink))`,
      }}
    >
      {initialOf(name)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Rank list: name, value, and a thin bar. First row is the focus.
// ---------------------------------------------------------------------------

export type RankRow = {
  key: string;
  label: string;
  value: number;
  /** Shown under the label, muted. */
  sub?: string;
  /** The folded remainder: a quiet text line with no bar, not clickable. */
  other?: boolean;
};

export function RankList({
  rows,
  format,
  onPick,
  focusIndex = 0,
  className,
}: {
  rows: RankRow[];
  format: (v: number) => string;
  onPick?: (row: RankRow) => void;
  focusIndex?: number;
  className?: string;
}) {
  const max = Math.max(1, ...rows.filter(r => !r.other).map(r => r.value || 0));
  return (
    <ul className={clsx("space-y-1", className)}>
      {rows.map((r, i) => {
        const pct = Math.max(2, Math.round(((r.value || 0) / max) * 100));
        const fill = i === focusIndex ? "bg-accent-500" : "bg-surface-2";
        if (r.other) {
          return (
            <li key={r.key} className="flex items-baseline justify-between gap-4 pt-3 text-[15px] text-muted">
              <span className="min-w-0 truncate">{r.label}</span>
              <span className="shrink-0 tabular-nums">{format(r.value)}</span>
            </li>
          );
        }
        const body = (
          <>
            <span className="flex items-baseline justify-between gap-4">
              <span className="min-w-0 truncate text-[15px] font-semibold text-ink">{r.label}</span>
              <span className="shrink-0 text-[15px] font-semibold tabular-nums text-ink">{format(r.value)}</span>
            </span>
            {r.sub && <span className="mt-0.5 block text-sm text-muted">{r.sub}</span>}
            <span className="mt-2 block h-2 w-full" aria-hidden>
              <span className={clsx("fh-rank-bar block h-full rounded-[10px]", fill)} style={{ width: `${pct}%` }} />
            </span>
          </>
        );
        return (
          <li key={r.key}>
            {onPick ? (
              <button
                type="button"
                onClick={() => onPick(r)}
                className="-mx-3 block w-[calc(100%+24px)] rounded-s px-3 py-2.5 text-left transition-colors hover:bg-surface"
              >
                {body}
              </button>
            ) : (
              <div className="py-2.5">{body}</div>
            )}
          </li>
        );
      })}
      <style>{`
        .fh-rank-bar { transform-origin: left; animation: fh-rank 1s var(--spring) .2s both; }
        @keyframes fh-rank { from { transform: scaleX(0) } to { transform: scaleX(1) } }
        @media (prefers-reduced-motion: reduce) { .fh-rank-bar { animation: none; } }
      `}</style>
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Column bars: few periods, big rounded bars, labels under each (ref 03).
// ---------------------------------------------------------------------------

export type ColumnBar = {
  key: string;
  label: string;
  value: number;
  /** Optional second line under the label, e.g. the amount. */
  caption?: string;
  ariaLabel?: string;
};

export function ColumnBars({
  bars,
  focusIndex,
  height = 200,
  onPick,
  className,
}: {
  bars: ColumnBar[];
  focusIndex: number;
  height?: number;
  onPick?: (bar: ColumnBar) => void;
  className?: string;
}) {
  const max = Math.max(1, ...bars.map(b => b.value || 0));
  return (
    <div className={clsx("flex items-end gap-2 sm:gap-3", className)}>
      {bars.map((b, i) => {
        const h = Math.max(6, Math.round(((b.value || 0) / max) * height));
        const focus = i === focusIndex;
        const inner = (
          <>
            <span className="flex w-full items-end" style={{ height }}>
              <span
                className={clsx("fh-col-bar block w-full rounded-s", focus ? "bg-accent-500" : "bg-surface-2")}
                style={{ height: h }}
              />
            </span>
            <span className={clsx("mt-2 block text-center text-[13px] font-semibold", focus ? "text-ink" : "text-muted")}>{b.label}</span>
            {b.caption && (
              <span className={clsx("block text-center text-[12px] font-medium tabular-nums", focus ? "text-ink-2" : "text-faint")}>{b.caption}</span>
            )}
          </>
        );
        return onPick ? (
          <button
            key={b.key}
            type="button"
            onClick={() => onPick(b)}
            aria-label={b.ariaLabel ?? `${b.label} ${b.caption ?? ""}`}
            className="min-w-0 flex-1 rounded-s transition-opacity hover:opacity-80"
          >
            {inner}
          </button>
        ) : (
          <div key={b.key} className="min-w-0 flex-1" aria-label={b.ariaLabel}>{inner}</div>
        );
      })}
      <style>{`
        .fh-col-bar { transform-origin: bottom; animation: fh-col 1s var(--spring) .2s both; }
        @keyframes fh-col { from { transform: scaleY(0) } to { transform: scaleY(1) } }
        @media (prefers-reduced-motion: reduce) { .fh-col-bar { animation: none; } }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recharts animation props that respect reduced motion.
// ---------------------------------------------------------------------------

export function useRechartsAnim(begin = 200) {
  const reduced = usePrefersReducedMotion();
  return {
    reduced,
    props: {
      isAnimationActive: !reduced,
      animationDuration: 1000,
      animationBegin: begin,
      animationEasing: "ease-out" as const,
    },
  };
}

// ---------------------------------------------------------------------------
// Copy helpers
// ---------------------------------------------------------------------------

/** "Fruits & Vegetables" -> "fruits and vegetables" for use mid-sentence. */
export function inSentence(name: string): string {
  return (name || "").replace(/\s*&\s*/g, " and ").toLowerCase();
}

/** Trim invoice noise from a product name: "Amul Taaza Milk (500 ml) Pack" -> "Amul Taaza Milk". */
export function shortProduct(name: string): string {
  return (name || "").replace(/\s*\([^)]*\)/g, "").replace(/\s+(Pack|Packet|Combo|Pouch|Bottle|Tube|Box|Jar|Can|Tin)$/i, "").trim() || name;
}

/** "Koramangala 5th Block Store" -> "Koramangala 5th Block". */
export function shortStore(name: string | null | undefined): string {
  return (name || "").replace(/\s+(Store|Dark Store)$/i, "").trim();
}

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
export function countWord(n: number): string {
  return WORDS[n] ?? n.toLocaleString("en-IN");
}

/** How often, in words: "about one order a week", "about 3 orders a month". */
export function cadence(ordersPerMonth: number): string {
  const perWeek = ordersPerMonth / 4.35;
  if (perWeek >= 1.5) return `about ${countWord(Math.round(perWeek))} orders a week`;
  if (perWeek >= 0.75) return "about one order a week";
  const m = Math.max(1, Math.round(ordersPerMonth));
  return m === 1 ? "about one order a month" : `about ${countWord(m)} orders a month`;
}

/** Money without paise unless they matter. */
export function money(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "–";
  const rounded = Math.round(n * 100) / 100;
  return new Intl.NumberFormat("en-IN", {
    style: "currency", currency: "INR",
    maximumFractionDigits: Number.isInteger(rounded) ? 0 : 2,
    minimumFractionDigits: Number.isInteger(rounded) ? 0 : 2,
  }).format(rounded);
}
