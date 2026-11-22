"use client";

/*
 * Small pieces for the goals screen: the odds badge, emoji picker, lever
 * slider and a reduced-motion-aware chart flag.
 */

import clsx from "clsx";
import type React from "react";
import { useEffect, useId, useRef } from "react";

import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

import { EMOJI_CHOICES } from "./model";
import { ODDS_TEXT, ODDS_WORD, oddsLabel, oddsTone } from "./odds";

/* -------------------------------------------------------------- odds */

/** "72%" in the odds colour, with the word under it. */
export function OddsBadge({ pct, size = "md" }: { pct: number; size?: "sm" | "md" | "lg" }) {
  const tone = oddsTone(pct);
  return (
    <span className="inline-flex flex-col items-end leading-none" title={`${oddsLabel(pct)} of market paths reach the target by the date`}>
      <span className={clsx(
        "font-black tabular-nums tracking-[-0.01em]",
        size === "lg" ? "text-[40px]" : size === "md" ? "text-[26px]" : "text-[18px]",
        ODDS_TEXT[tone],
      )}>
        {oddsLabel(pct)}
      </span>
      <span className={clsx("mt-1 font-semibold text-muted", size === "sm" ? "text-[11px]" : "text-[12px]")}>{ODDS_WORD[tone]}</span>
    </span>
  );
}

/** Emoji in a soft circle. */
export function EmojiDot({ emoji, size = 44 }: { emoji: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-full bg-surface"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}
    >
      {emoji}
    </span>
  );
}

export function EmojiPicker({ value, onChange }: { value: string; onChange: (e: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  // A custom or far-right pick should be visible when the row opens.
  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    if (box.current && el) box.current.scrollLeft = Math.max(0, el.offsetLeft - box.current.clientWidth / 2);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const list = EMOJI_CHOICES.includes(value) ? EMOJI_CHOICES : [value, ...EMOJI_CHOICES];
  return (
    <div ref={box} role="radiogroup" aria-label="Emoji" className="-mx-1 flex gap-1 overflow-x-auto px-1 py-1 [scrollbar-width:none]">
      {list.map((e) => (
        <button
          key={e}
          type="button"
          role="radio"
          aria-checked={value === e}
          onClick={() => onChange(e)}
          className={clsx(
            "grid h-11 w-11 shrink-0 place-items-center rounded-full text-[22px] transition-colors",
            "focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-[3px] focus-visible:outline-accent-500",
            value === e ? "bg-accent-50 shadow-[0_0_0_2px_var(--accent-500)]" : "hover:bg-surface",
          )}
        >
          {e}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ slider */

export function Lever({
  label,
  value,
  display,
  min,
  max,
  step,
  onChange,
  hint,
  ariaValueText,
}: {
  label: string;
  value: number;
  display: React.ReactNode;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  hint?: React.ReactNode;
  ariaValueText?: string;
}) {
  const id = useId();
  const pct = max > min ? ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100 : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[13px] font-semibold text-ink-2">{label}</label>
        <span className="text-[15px] font-extrabold tabular-nums text-ink">{display}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={ariaValueText}
        onChange={(e) => onChange(Number(e.target.value))}
        className="fh-lever mt-3 w-full"
        style={{ ["--p" as string]: `${pct}%` }}
      />
      {hint && <p className="mt-2 text-[13px] font-medium text-muted">{hint}</p>}
      <style>{`
        .fh-lever { -webkit-appearance: none; appearance: none; height: 28px; background: transparent; cursor: pointer; }
        .fh-lever:focus { outline: none; }
        .fh-lever::-webkit-slider-runnable-track {
          height: 8px; border-radius: 10px;
          background: linear-gradient(to right, var(--accent-500) var(--p), var(--surface-2) var(--p));
        }
        .fh-lever::-moz-range-track { height: 8px; border-radius: 10px; background: var(--surface-2); }
        .fh-lever::-moz-range-progress { height: 8px; border-radius: 10px; background: var(--accent-500); }
        .fh-lever::-webkit-slider-thumb {
          -webkit-appearance: none; width: 24px; height: 24px; margin-top: -8px; border-radius: 999px;
          background: var(--card); box-shadow: 0 0 0 1.5px var(--surface-2), 0 3px 0 var(--surface-2), 0 6px 14px -6px rgba(0,0,0,.35);
          transition: transform .3s var(--spring);
        }
        .fh-lever::-moz-range-thumb {
          width: 24px; height: 24px; border: 0; border-radius: 999px;
          background: var(--card); box-shadow: 0 0 0 1.5px var(--surface-2), 0 3px 0 var(--surface-2);
        }
        .fh-lever:active::-webkit-slider-thumb { transform: scale(1.12); }
        .fh-lever:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 3px var(--accent-500), 0 0 0 7px var(--accent-100); }
        .fh-lever:focus-visible::-moz-range-thumb { box-shadow: 0 0 0 3px var(--accent-500), 0 0 0 7px var(--accent-100); }
      `}</style>
    </div>
  );
}

/* ---------------------------------------------------------- swatch */

export function Swatch({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden className={clsx("inline-block h-2.5 w-2.5 shrink-0 rounded-full", className)} style={{ background: color }} />;
}

/** Recharts animation flag that respects reduced motion. */
export function useChartMotion() {
  const reduced = usePrefersReducedMotion();
  return !reduced;
}
