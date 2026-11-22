"use client";

import { motion, type Transition, type Variants } from "framer-motion";

import { SOFT, Stage, spring, useReduced } from "./kit";

const TILES = [
  { label: "Spent in October", value: "₹48,320", sub: "3 accounts", focus: true },
  { label: "Food", value: "₹12,480", sub: "26% of spend" },
  { label: "Travel", value: "₹8,900", sub: "Up ₹1,200" },
  { label: "Bills", value: "₹6,210", sub: "4 paid, 1 due" },
];

export type EntranceKind = "rise" | "riseScale" | "pop" | "blur";

const FROM: Record<EntranceKind, Variants[string]> = {
  rise: { opacity: 0, y: 16 },
  riseScale: { opacity: 0, y: 16, scale: 0.98 },
  pop: { opacity: 0, scale: 0.92 },
  blur: { opacity: 0, filter: "blur(8px)" },
};

const TO: Record<EntranceKind, Variants[string]> = {
  rise: { opacity: 1, y: 0 },
  riseScale: { opacity: 1, y: 0, scale: 1 },
  pop: { opacity: 1, scale: 1 },
  blur: { opacity: 1, filter: "blur(0px)" },
};

function transitionFor(kind: EntranceKind, delay: number): Transition {
  switch (kind) {
    case "rise":
    case "blur":
      return { duration: 0.6, ease: SOFT as unknown as number[], delay };
    case "riseScale":
      return {
        y: { duration: 0.6, ease: spring, delay },
        scale: { duration: 0.6, ease: spring, delay },
        opacity: { duration: 0.6, ease: SOFT as unknown as number[], delay },
      };
    case "pop":
      return {
        scale: { duration: 0.6, ease: spring, delay },
        opacity: { duration: 0.3, ease: SOFT as unknown as number[], delay },
      };
  }
}

function variantsFor(kind: EntranceKind, reduced: boolean, i: number): Variants {
  const delay = 0.1 + i * 0.06;
  if (reduced) {
    return { hidden: { opacity: 0 }, show: { opacity: 1, transition: { duration: 0.4, delay } } };
  }
  return {
    hidden: FROM[kind],
    show: { ...(TO[kind] as object), transition: transitionFor(kind, delay) } as Variants[string],
  };
}

export function CardEntrance({ kind }: { kind: EntranceKind }) {
  const reduced = useReduced();
  return (
    <Stage>
      <div className="grid grid-cols-2 gap-2.5">
        {TILES.map((t, i) => (
          <motion.div
            key={t.label}
            variants={variantsFor(kind, reduced, i)}
            initial="hidden"
            animate="show"
            className="rounded-m bg-card p-3 shadow-flat"
          >
            <p className="truncate text-[12px] font-semibold text-muted">{t.label}</p>
            <p
              className={
                "mt-1.5 text-[19px] font-black leading-none tabular-nums " +
                (t.focus ? "text-accent-600" : "text-ink")
              }
            >
              {t.value}
            </p>
            <p className="mt-1.5 truncate text-[12px] font-medium text-muted">{t.sub}</p>
          </motion.div>
        ))}
      </div>
    </Stage>
  );
}
