"use client";

import clsx from "clsx";
import { AnimatePresence, motion, useAnimationControls } from "framer-motion";
import { useEffect, useState } from "react";

import { Segmented } from "@/components/ui";

import { SOFT, Stage, formatINR, spring, useReduced, useTween } from "./kit";

const SOFT_EASE = SOFT as unknown as number[];

// ---------------------------------------------------------------------------
// Section 2: KPI numbers on first load
// ---------------------------------------------------------------------------

export type KpiKind = "count" | "odometer" | "fade" | "countPulse";

const KPIS = [
  { label: "Spent in October", value: 48320, sub: "Across 3 accounts, transfers left out", focus: true },
  { label: "Saved", value: 21680, sub: "31% of income, best since June" },
];

const valueClass = "text-[28px] font-black leading-none tracking-[-0.01em] tabular-nums";

function CountUp({ value, focus, pulse }: { value: number; focus?: boolean; pulse?: boolean }) {
  const reduced = useReduced();
  const controls = useAnimationControls();
  const shown = useTween(value, {
    from: 0,
    duration: 0.8,
    onDone: () => {
      if (pulse && !reduced) {
        controls.start({ scale: [1, 1.07, 1], transition: { duration: 0.5, ease: SOFT_EASE } });
      }
    },
  });
  return (
    <motion.span
      animate={controls}
      style={{ transformOrigin: "left center" }}
      className={clsx("inline-block", valueClass, focus ? "text-accent-600" : "text-ink")}
    >
      {formatINR(shown)}
    </motion.span>
  );
}

/** Digits roll up like an odometer; separators stay put. */
function Odometer({ value, focus }: { value: number; focus?: boolean }) {
  const reduced = useReduced();
  const chars = formatINR(value).split("");
  let digitIndex = 0;
  return (
    <span
      className={clsx("inline-flex", valueClass, focus ? "text-accent-600" : "text-ink")}
      aria-label={formatINR(value)}
    >
      {chars.map((c, i) => {
        if (!/\d/.test(c)) {
          return (
            <span key={i} aria-hidden>
              {c}
            </span>
          );
        }
        const d = Number(c);
        const order = digitIndex++;
        return (
          <span key={i} aria-hidden className="relative inline-block h-[1em] overflow-hidden">
            <motion.span
              className="flex flex-col"
              initial={reduced ? { opacity: 0, y: `-${d * 10}%` } : { y: "0%" }}
              animate={reduced ? { opacity: 1, y: `-${d * 10}%` } : { y: `-${d * 10}%` }}
              transition={
                reduced
                  ? { duration: 0.4 }
                  : { duration: 0.9, ease: spring, delay: 0.1 + order * 0.06 }
              }
            >
              {Array.from({ length: 10 }, (_, k) => (
                <span key={k} className="block h-[1em] leading-none">
                  {k}
                </span>
              ))}
            </motion.span>
          </span>
        );
      })}
    </span>
  );
}

function FadeValue({ value, focus }: { value: number; focus?: boolean }) {
  return (
    <motion.span
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5, ease: SOFT_EASE, delay: 0.1 }}
      className={clsx("inline-block", valueClass, focus ? "text-accent-600" : "text-ink")}
    >
      {formatINR(value)}
    </motion.span>
  );
}

export function KpiDemo({ kind }: { kind: KpiKind }) {
  return (
    <Stage className="space-y-2.5">
      {KPIS.map(k => (
        <div key={k.label} className="rounded-m bg-card p-4 shadow-flat">
          <p className="text-sm font-semibold text-muted">{k.label}</p>
          <p className="mt-2.5">
            {kind === "count" && <CountUp value={k.value} focus={k.focus} />}
            {kind === "countPulse" && <CountUp value={k.value} focus={k.focus} pulse={k.focus} />}
            {kind === "odometer" && <Odometer value={k.value} focus={k.focus} />}
            {kind === "fade" && <FadeValue value={k.value} focus={k.focus} />}
          </p>
          <p className="mt-2.5 text-[13px] font-medium text-muted">{k.sub}</p>
        </div>
      ))}
    </Stage>
  );
}

// ---------------------------------------------------------------------------
// Section 10: number change on filter switch
// ---------------------------------------------------------------------------

type Range = "1M" | "3M" | "6M";
const RANGES: { value: Range; label: string }[] = [
  { value: "1M", label: "1M" },
  { value: "3M", label: "3M" },
  { value: "6M", label: "6M" },
];
const SPEND: Record<Range, { total: number; sub: string }> = {
  "1M": { total: 48320, sub: "October so far" },
  "3M": { total: 144140, sub: "August to October" },
  "6M": { total: 261620, sub: "May to October" },
};

export type ChangeKind = "instant" | "count" | "slide";

function ChangingValue({ value, kind }: { value: number; kind: ChangeKind }) {
  const reduced = useReduced();
  const tweened = useTween(value, { duration: 0.6 });
  const cls = clsx(valueClass, "text-accent-600");

  if (kind === "count") return <span className={cls}>{formatINR(tweened)}</span>;
  if (kind === "instant") return <span className={cls}>{formatINR(value)}</span>;

  return (
    <span className="relative inline-grid h-[1.15em] overflow-hidden align-bottom text-[28px] leading-none">
      <AnimatePresence initial={false}>
        <motion.span
          key={value}
          className={clsx(cls, "[grid-area:1/1]")}
          initial={reduced ? { opacity: 0 } : { y: "100%", opacity: 0 }}
          animate={reduced ? { opacity: 1 } : { y: "0%", opacity: 1 }}
          exit={reduced ? { opacity: 0 } : { y: "-100%", opacity: 0 }}
          transition={reduced ? { duration: 0.2 } : { duration: 0.45, ease: SOFT_EASE }}
        >
          {formatINR(value)}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

export function NumberChangeDemo({ kind, run }: { kind: ChangeKind; run: number }) {
  const [range, setRange] = useState<Range>("1M");

  // Replay steps every option to the next range together.
  useEffect(() => {
    if (run === 0) return;
    setRange(r => (r === "1M" ? "3M" : r === "3M" ? "6M" : "1M"));
  }, [run]);

  return (
    <Stage>
      <Segmented options={RANGES} value={range} onChange={setRange} size="sm" ariaLabel="Time range" />
      <div className="mt-3 rounded-m bg-card p-4 shadow-flat">
        <p className="text-sm font-semibold text-muted">Spent</p>
        <p className="mt-2.5 flex">
          <ChangingValue value={SPEND[range].total} kind={kind} />
        </p>
        <p className="mt-2.5 text-[13px] font-medium text-muted">{SPEND[range].sub}</p>
      </div>
    </Stage>
  );
}
