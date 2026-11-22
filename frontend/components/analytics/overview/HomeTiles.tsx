"use client";

/*
 * Home's headline and its four tiles: Spent (living, no investments), Saved
 * in bank, Invested, Net worth. Each compares with a usual month (or, while
 * the month is partial, the usual by the same day), and carries a chip when
 * a one-off (bonus, iPad) sits inside the number.
 */

import clsx from "clsx";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";

import { MotionReveal } from "@/components/motion/MotionReveal";
import { NumberTicker } from "@/components/motion/NumberTicker";
import { Skeleton } from "@/components/ui";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { CHART, CHART_ANIM } from "@/lib/chart-theme";
import { inr } from "@/lib/format";
import type { DayPoint, Marker } from "@/lib/wealth";

import { humanInr } from "../fmt";
import { type Baseline, type Figures, keptPct, oneOffName } from "./homeData";
import { weeklyClose } from "./smooth";

export function OneOffChip({ m }: { m: Marker }) {
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 truncate rounded-pill bg-surface px-2 py-0.5 text-[12px] font-semibold text-ink-2"
      title={`${m.label}, ${inr(Math.abs(m.amount))} on ${m.date}`}
    >
      incl. <span aria-hidden>{m.emoji}</span> {humanInr(Math.abs(m.amount))} {oneOffName(m)}
    </span>
  );
}

export function Headline({
  fig, partial, months, incomeOneOffs,
}: {
  fig: Figures | null;
  partial: boolean;
  months: number;
  incomeOneOffs: Marker[];
}) {
  if (!fig) return <Skeleton className="h-12 w-full max-w-[560px]" />;
  const pct = keptPct(fig);
  const came = months > 1 ? `${humanInr(fig.income)} came in over ${months} months` : `${humanInr(fig.income)} came in${partial ? " so far" : ""}`;
  return (
    <MotionReveal>
      <h1 className="text-[30px] font-black leading-[1.1] tracking-[-0.01em] text-ink md:text-[44px]">
        {fig.income > 0 ? (
          <>
            {came}
            {pct != null && (
              <>
                <span className="mx-2 text-faint md:mx-3" aria-hidden>·</span>
                <span className={pct >= 0 ? "text-accent-600" : "text-danger-text"}>{pct}% saved or invested</span>
              </>
            )}
          </>
        ) : (
          <>Nothing came in{partial ? " yet" : ""}</>
        )}
      </h1>
      {incomeOneOffs.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">{incomeOneOffs.map((m) => <OneOffChip key={m.date + m.label} m={m} />)}</div>
      )}
    </MotionReveal>
  );
}

/* --------------------------------------------------------------- tiles */

type Good = "up" | "down";

function Delta({ diff, good, vs, title }: { diff: number | null; good: Good; vs: string; title?: string }) {
  if (diff == null) return null;
  const small = Math.abs(diff) < 500;
  const up = diff > 0;
  const better = small ? null : (up ? good === "up" : good === "down");
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-1 text-[13px] font-semibold" title={title}>
      {small ? (
        <span className="text-muted">About {vs}</span>
      ) : (
        <>
          <span className={clsx("inline-flex items-center gap-0.5 whitespace-nowrap", better ? "text-success-text" : "text-warning-text")}>
            {up ? <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden /> : <ArrowDownRight className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden />}
            {humanInr(Math.abs(diff))} {up ? "more" : "less"}
          </span>
          <span className="whitespace-nowrap font-medium text-muted">than {vs}</span>
        </>
      )}
    </p>
  );
}

function Tile({
  label, value, children, href, index, accent, chips,
}: {
  label: string;
  value: number | null;
  children?: React.ReactNode;
  href?: string;
  index: number;
  accent?: boolean;
  chips?: Marker[];
}) {
  const body = (
    <>
      <span className="text-[13px] font-semibold text-muted md:text-sm">{label}</span>
      {value == null ? (
        <Skeleton className="mt-3 h-8 w-28" />
      ) : (
        <NumberTicker
          value={Math.round(Math.abs(value))}
          prefix={value < 0 ? "−₹" : "₹"}
          className={clsx(
            "mt-2 block text-[24px] font-black leading-none tracking-[-0.01em] tabular-nums md:text-[30px]",
            accent ? "text-accent-600" : value < 0 ? "text-danger-text" : "text-ink",
          )}
        />
      )}
      {children}
      {chips && chips.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">{chips.map((m) => <OneOffChip key={m.date + m.label} m={m} />)}</div>
      )}
    </>
  );
  const cls = "flex h-full flex-col rounded-m bg-card p-4 shadow-flat md:p-5";
  return (
    <MotionReveal index={index} className="h-full">
      {href ? <Link href={href} className={clsx(cls, "transition-colors hover:bg-surface")}>{body}</Link> : <div className={cls}>{body}</div>}
    </MotionReveal>
  );
}

function Spark({ daily }: { daily: DayPoint[] }) {
  const reduced = usePrefersReducedMotion();
  const pts = useMemo(() => weeklyClose(daily.slice(-183)), [daily]);
  if (pts.length < 3) return null;
  return (
    <div className="mt-3 h-9 w-full" aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={pts} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Area
            dataKey="netWorth" type="monotone" stroke={CHART.accent} strokeWidth={1.75}
            fill={CHART.accent} fillOpacity={0.1} dot={false} activeDot={false}
            isAnimationActive={!reduced} animationBegin={CHART_ANIM.begin} animationDuration={CHART_ANIM.areaDuration}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function HomeTiles({
  fig, base, vs, perMonth, spendOneOffs, netWorth, nwChange, nwUsual, daily, nwLabel, partial,
}: {
  fig: Figures | null;
  /** What "usual" means here; null in the 6-month view. */
  base: Baseline | null;
  vs: string;
  /** Months in scope when showing a multi-month total. */
  perMonth: number | null;
  spendOneOffs: Marker[];
  netWorth: number | null;
  nwChange: number | null;
  nwUsual: number | null;
  daily: DayPoint[];
  nwLabel: string;
  partial: boolean;
}) {
  const avg = (v: number) => (perMonth ? <p className="mt-2 text-[13px] font-medium text-muted">{humanInr(v / perMonth)} a month</p> : null);
  const tip = (what: string, now: number, usual: number) =>
    `${what}: ${inr(now)}. ${vs.charAt(0).toUpperCase() + vs.slice(1)}: ${inr(usual)}.`;

  return (
    <div className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4">
      <Tile label={partial ? "Spent so far" : "Spent"} value={fig ? fig.spent : null} index={0} href="/transactions" chips={spendOneOffs}>
        {fig && (perMonth ? avg(fig.spent) : base && (
          <Delta diff={fig.spent - base.spent} good="down" vs={vs} title={tip("Living spend, without investments", fig.spent, base.spent)} />
        ))}
      </Tile>
      <Tile label="🏦 Saved in bank" value={fig ? fig.saved : null} index={1} accent={!!fig && fig.saved > 0}>
        {fig && (perMonth ? avg(fig.saved) : base && (
          <Delta diff={fig.saved - base.saved} good="up" vs={vs} title={tip("Income left after spending and investing", fig.saved, base.saved)} />
        ))}
      </Tile>
      <Tile label="📈 Invested" value={fig ? fig.invested : null} index={2} accent={!!fig && fig.invested > 0} href="/wealth">
        {fig && (perMonth ? avg(fig.invested) : base && (
          <Delta diff={fig.invested - base.invested} good="up" vs={vs} title={tip("SIPs from the bank", fig.invested, base.invested)} />
        ))}
      </Tile>
      <Tile label="Net worth" value={netWorth} index={3} href="/wealth">
        {nwChange != null && (
          <p
            className="mt-2 flex flex-wrap items-center gap-x-1 text-[13px] font-semibold"
            title={nwUsual != null ? `A usual month: ${nwUsual >= 0 ? "+" : "−"}${inr(Math.abs(nwUsual))}` : undefined}
          >
            <span className={clsx("inline-flex items-center gap-0.5 whitespace-nowrap", nwChange >= 0 ? "text-success-text" : "text-warning-text")}>
              {nwChange >= 0 ? <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden /> : <ArrowDownRight className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden />}
              {humanInr(Math.abs(nwChange))}
            </span>
            <span className="whitespace-nowrap font-medium text-muted">{nwLabel}</span>
            {nwUsual != null && <span className="whitespace-nowrap font-medium text-muted">· usual {nwUsual >= 0 ? "+" : "−"}{humanInr(Math.abs(nwUsual))}</span>}
          </p>
        )}
        <Spark daily={daily} />
      </Tile>
    </div>
  );
}
