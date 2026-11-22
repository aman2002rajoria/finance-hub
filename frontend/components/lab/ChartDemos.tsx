"use client";

import { motion } from "framer-motion";

import { CHART, seriesColor } from "@/lib/chart-theme";

import { SOFT, Stage, formatINR, spring, useReduced, useTween } from "./kit";

const SOFT_EASE = SOFT as unknown as number[];

// ---------------------------------------------------------------------------
// Section 3: month bars, current month in accent
// ---------------------------------------------------------------------------

const MONTHS = [
  { m: "May", v: 38400 },
  { m: "Jun", v: 42100 },
  { m: "Jul", v: 35900 },
  { m: "Aug", v: 51200 },
  { m: "Sep", v: 44700 },
  { m: "Oct", v: 48320 },
];
const MAX = 52000;

export type BarKind = "together" | "stagger" | "focus" | "labels";

function BarLabel({ value }: { value: number }) {
  const v = useTween(value, { from: 0, duration: 1 });
  return <>{`₹${Math.round(v / 1000)}k`}</>;
}

export function BarsDemo({ kind }: { kind: BarKind }) {
  const reduced = useReduced();
  const last = MONTHS.length - 1;

  return (
    <Stage>
      <div className="rounded-m bg-card p-3 shadow-flat">
        <div className="flex items-baseline justify-between">
          <p className="text-sm font-semibold text-muted">Spend by month</p>
          <p className="text-[15px] font-black tabular-nums text-ink">
            {formatINR(MONTHS[last].v)}
          </p>
        </div>
        <div className="mt-4 flex h-[140px] items-end gap-2">
          {MONTHS.map((b, i) => {
            const focus = i === last;
            const color = focus ? CHART.accent : CHART.surface2;
            let initial: Record<string, number | string> = { scaleY: 0 };
            let animate: Record<string, number | string> = { scaleY: 1 };
            let transition: Record<string, unknown> = {
              duration: 1,
              ease: spring,
              delay: 0.2,
            };

            const h = `${(b.v / MAX) * 100}%`;
            let style: React.CSSProperties = {
              height: h,
              background: color,
              transformOrigin: "bottom",
            };

            if (reduced) {
              initial = { opacity: 0 };
              animate = { opacity: 1 };
              transition = { duration: 0.4, delay: 0.1 };
            } else if (kind === "stagger") {
              transition = { duration: 1, ease: spring, delay: 0.2 + i * 0.07 };
            } else if (kind === "focus") {
              if (focus) {
                transition = { duration: 1, ease: spring, delay: 0.5 };
              } else {
                initial = { opacity: 0 };
                animate = { opacity: 1 };
                transition = {
                  duration: 0.4,
                  ease: SOFT_EASE,
                  delay: 0.1 + i * 0.03,
                };
              }
            } else if (kind === "labels") {
              // Height (not scale) so the value label rides on top of the bar.
              style = { background: color };
              initial = { height: "0%" };
              animate = { height: h };
            }
            if (reduced) style = { height: h, background: color };

            return (
              <div
                key={b.m}
                className="flex h-full min-w-0 flex-1 flex-col items-center justify-end"
              >
                {kind === "labels" && (
                  <span className="mb-1 text-[11px] font-semibold tabular-nums text-muted">
                    {reduced ? (
                      `₹${Math.round(b.v / 1000)}k`
                    ) : (
                      <BarLabel value={b.v} />
                    )}
                  </span>
                )}
                <motion.div
                  initial={initial}
                  animate={animate}
                  transition={transition}
                  className="w-full rounded-t-[8px] rounded-b-[3px]"
                  style={style}
                />
                <span
                  className={
                    "mt-1.5 text-[11px] font-semibold " +
                    (focus ? "text-ink" : "text-faint")
                  }
                >
                  {b.m}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </Stage>
  );
}

// ---------------------------------------------------------------------------
// Section 4: donut of October spend by category
// ---------------------------------------------------------------------------

const CATS = [
  { name: "Food", v: 12480 },
  { name: "Shopping", v: 9830 },
  { name: "Travel", v: 8900 },
  { name: "Bills", v: 6210 },
  { name: "Other", v: 4100 },
];
const TOTAL = CATS.reduce((s, c) => s + c.v, 0);

export type DonutKind = "sweep" | "pop" | "fade";

const R = 46;
const C = 2 * Math.PI * R;
const GAP = 3;

export function DonutDemo({ kind, id }: { kind: DonutKind; id: string }) {
  const reduced = useReduced();
  let acc = 0;
  const segs = CATS.map((c, i) => {
    const len = (c.v / TOTAL) * C;
    const seg = {
      ...c,
      color: seriesColor(c.name, i),
      len: Math.max(len - GAP, 1),
      offset: -acc,
    };
    acc += len;
    return seg;
  });
  const maskId = `donut-sweep-${id}`;

  const ring = (
    <g
      transform="rotate(-90 60 60)"
      mask={kind === "sweep" && !reduced ? `url(#${maskId})` : undefined}
    >
      {segs.map((s, i) => (
        <motion.circle
          key={s.name}
          cx={60}
          cy={60}
          r={R}
          fill="none"
          stroke={s.color}
          strokeWidth={16}
          strokeDasharray={`${s.len} ${C}`}
          strokeDashoffset={s.offset}
          style={{ transformOrigin: "60px 60px" }}
          {...(kind === "pop" && !reduced
            ? {
                initial: { opacity: 0, scale: 0.8 },
                animate: { opacity: 1, scale: 1 },
                transition: {
                  scale: { duration: 0.6, ease: spring, delay: 0.2 + i * 0.14 },
                  opacity: { duration: 0.25, delay: 0.2 + i * 0.14 },
                },
              }
            : {})}
        />
      ))}
    </g>
  );

  return (
    <Stage className="flex items-center gap-4">
      <motion.svg
        viewBox="0 0 120 120"
        className="h-[132px] w-[132px] shrink-0"
        style={{ transformOrigin: "center" }}
        {...(reduced
          ? {
              initial: { opacity: 0 },
              animate: { opacity: 1 },
              transition: { duration: 0.4 },
            }
          : kind === "fade"
            ? {
                initial: { opacity: 0, scale: 0.9 },
                animate: { opacity: 1, scale: 1 },
                transition: {
                  scale: { duration: 0.7, ease: spring, delay: 0.2 },
                  opacity: { duration: 0.4, ease: SOFT_EASE, delay: 0.2 },
                },
              }
            : {})}
      >
        {kind === "sweep" && !reduced && (
          <defs>
            <mask
              id={maskId}
              maskUnits="userSpaceOnUse"
              x="0"
              y="0"
              width="120"
              height="120"
            >
              <motion.circle
                cx={60}
                cy={60}
                r={R}
                fill="none"
                stroke="white"
                strokeWidth={20}
                strokeDasharray={`${C} ${C}`}
                initial={{ strokeDashoffset: C }}
                animate={{ strokeDashoffset: 0 }}
                transition={{ duration: 1, ease: SOFT_EASE, delay: 0.2 }}
              />
            </mask>
          </defs>
        )}
        {ring}
        <text
          x={60}
          y={58}
          textAnchor="middle"
          fontSize={15}
          fontWeight={900}
          fill={CHART.ink}
        >
          {formatINR(TOTAL)}
        </text>
        <text
          x={60}
          y={74}
          textAnchor="middle"
          fontSize={10}
          fontWeight={500}
          fill={CHART.muted}
        >
          in October
        </text>
      </motion.svg>
      <ul className="min-w-0 space-y-1.5">
        {segs.map((s) => (
          <li
            key={s.name}
            className="flex items-center gap-2 text-[13px] font-medium text-ink-2"
          >
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: s.color }}
            />
            <span className="truncate">{s.name}</span>
          </li>
        ))}
      </ul>
    </Stage>
  );
}
