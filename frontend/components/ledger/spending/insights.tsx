"use client";

/*
 * Spending's analysis cards, all from one six-month pass (model.ts):
 *   Pace        running total against a usual month, with a month-end guess
 *   KindMix     fixed / everyday / lifestyle / one-offs, month by month
 *   Merchants   where, specifically: top payees by spend or by visits
 *   When        a calendar (one month) or weekday grid (six months)
 *   HowYouPay   UPI, card, bank transfer, plus the EMI load
 *   SmallPays   payments under ₹200 that add up
 * Every amount is living spend (no Investments, card bills or transfers).
 */

import clsx from "clsx";
import type React from "react";
import { useMemo, useState } from "react";
import {
  Bar, BarChart, Cell, ComposedChart, LabelList, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

import { Segmented } from "@/components/ui";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { CHART, CHART_ANIM, CHART_SERIES } from "@/lib/chart-theme";
import { inr } from "@/lib/format";

import { catEmoji, catLabel, Delta, Rows, StoryCard } from "./cards";
import {
  daysIn, KINDS, PAYS, selectedMonths, usualKind, type Kind, type Pay, type SpendModel, type SpendModelQ, type SpendRow,
} from "./model";
import { kInr, median, monthShort, shortDay, type SpendingPeriod } from "./period";

export const KIND_COLOR: Record<Kind, string> = {
  fixed: CHART_SERIES[0],
  everyday: CHART_SERIES[1],
  lifestyle: CHART_SERIES[2],
  oneoff: CHART_SERIES[5],
};
const PAY_COLOR: Record<Pay, string> = {
  upi: CHART_SERIES[1],
  card: CHART_SERIES[0],
  bank: CHART_SERIES[4],
  other: "#A1A1A8",
};

const SUB_EMOJI: Record<string, string> = {
  "Online Ordering": "🛵", Groceries: "🛒", "Dine-out": "🍽️", "Daily Commute": "🚕", Fuel: "⛽",
  Health: "💊", Subscriptions: "📺", Entertainment: "🎬", Clothing: "👕", "Online Shopping": "📦",
};
const rowEmoji = (category: string, sub: string) => SUB_EMOJI[sub] ?? catEmoji(category);

const isHabit = (r: SpendRow) => (r.kind === "everyday" || r.kind === "lifestyle") && !r.emi && r.amount > 0;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** Monday = 0. */
const dow = (iso: string) => (new Date(`${iso}T00:00:00`).getDay() + 6) % 7;

function rowsIn(p: SpendingPeriod, m: SpendModel): SpendRow[] {
  const sel = new Set(selectedMonths(p, m));
  return m.rows.filter(r => sel.has(r.period));
}

function Legend({ items }: { items: { color: string; label: string; dashed?: boolean }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] font-medium text-muted" aria-hidden>
      {items.map(i => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          {i.dashed
            ? <span className="h-0 w-4 border-t-2 border-dashed" style={{ borderColor: i.color }} />
            : <span className="h-2.5 w-2.5 rounded-full" style={{ background: i.color }} />}
          {i.label}
        </span>
      ))}
    </div>
  );
}

const tooltipProps = () => ({
  contentStyle: CHART.tooltip,
  itemStyle: { color: CHART.ink2, fontSize: 14, padding: 0 },
  labelStyle: { color: CHART.ink, fontWeight: 600, fontSize: 14, marginBottom: 4 },
});

// ---------------------------------------------------------------------------
// Pace: this month's running total against a usual month.
// ---------------------------------------------------------------------------

export function PaceCard({ p, q, className }: { p: SpendingPeriod; q: SpendModelQ; className?: string }) {
  const reduced = usePrefersReducedMotion();
  const m = q.model;
  const month = p.month;

  const calc = useMemo(() => {
    if (!m || !month || !m.cumulative.has(month)) return null;
    const dim = daysIn(month);
    const partial = month === p.latest && p.latestPartial;
    const upto = partial && p.asOf ? Number(p.asOf.slice(8, 10)) : dim;
    const cum = m.cumulative.get(month)!;
    const base = m.complete.filter(x => x !== month).length >= 2 ? m.complete.filter(x => x !== month) : m.complete;
    const usual = Array.from({ length: dim }, (_, i) =>
      median(base.map(b => { const c = m.cumulative.get(b)!; return c[Math.min(i, c.length - 1)]; })));
    const now = cum[upto - 1] ?? 0;
    const end = partial ? now + (usual[dim - 1] - usual[upto - 1]) : cum[dim - 1];
    const data = Array.from({ length: dim }, (_, i) => ({
      day: i + 1,
      spent: i < upto ? cum[i] : null,
      usual: base.length ? usual[i] : null,
      proj: partial && i >= upto - 1 ? now + (usual[i] - usual[upto - 1]) : null,
    }));
    return { dim, partial, upto, now, end, usualEnd: usual[dim - 1], usualNow: usual[upto - 1], data, hasUsual: base.length > 0 };
  }, [m, month, p.latest, p.latestPartial, p.asOf]);

  const mon = monthShort(month);
  return (
    <StoryCard
      title="Pace"
      className={className}
      loading={q.loading}
      error={q.error}
      onRetry={q.retry}
      empty={!!m && !calc}
      emptyTitle="No month to pace"
      skeleton={<Rows n={3} />}
    >
      {calc && (
        <>
          <div className="mb-4 flex flex-wrap items-end gap-x-4 gap-y-1">
            <p className="text-[28px] font-black leading-none tracking-[-0.01em] text-ink tabular-nums">
              {calc.partial && <span className="mr-1.5 text-base font-semibold text-muted">heading for</span>}
              {kInr(calc.end)}
            </p>
            {calc.hasUsual && (
              <p className="pb-0.5 text-sm font-medium text-muted tabular-nums" title={`A usual month ends near ${inr(Math.round(calc.usualEnd))}`}>
                {Math.abs(calc.end - calc.usualEnd) < calc.usualEnd * 0.03
                  ? "about a usual month"
                  : `${kInr(Math.abs(calc.end - calc.usualEnd))} ${calc.end > calc.usualEnd ? "over" : "under"} usual`}
              </p>
            )}
          </div>
          <Legend
            items={[
              { color: CHART.accent, label: calc.partial ? `1–${calc.upto} ${mon}` : `${mon}` },
              ...(calc.partial ? [{ color: CHART.accent, label: "likely", dashed: true }] : []),
              ...(calc.hasUsual ? [{ color: CHART.faint, label: "usual month", dashed: true }] : []),
            ]}
          />
          <div className="mt-2 h-[170px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={calc.data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                <XAxis
                  dataKey="day"
                  type="number"
                  domain={[1, calc.dim]}
                  ticks={[1, 10, 20, calc.dim]}
                  interval={0}
                  padding={{ left: 14, right: 14 }}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: CHART.faint, fontSize: 12, fontWeight: 500 }}
                  tickFormatter={(d: number) => `${d} ${mon}`}
                />
                <YAxis hide domain={[0, "auto"]} />
                <Tooltip
                  cursor={{ stroke: CHART.line, strokeWidth: 1 }}
                  {...tooltipProps()}
                  labelFormatter={(d: number) => `By ${d} ${mon}`}
                  formatter={(v: number, name: string) => [inr(Math.round(v)), name === "spent" ? "Spent" : name === "proj" ? "Likely" : "Usual month"]}
                />
                {calc.hasUsual && (
                  <Line dataKey="usual" type="monotone" stroke={CHART.faint} strokeWidth={2} strokeDasharray="4 5" dot={false} activeDot={false} isAnimationActive={false} />
                )}
                <Line dataKey="proj" type="monotone" stroke={CHART.accent} strokeWidth={2} strokeDasharray="2 5" strokeLinecap="round" dot={false} activeDot={false} connectNulls isAnimationActive={false} />
                <Line
                  dataKey="spent"
                  type="monotone"
                  stroke={CHART.accent}
                  strokeWidth={3}
                  dot={false}
                  activeDot={{ r: 4, fill: CHART.accent, stroke: CHART.card, strokeWidth: 2 }}
                  isAnimationActive={!reduced}
                  animationBegin={CHART_ANIM.begin}
                  animationDuration={CHART_ANIM.lineDuration}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <span className="sr-only">
            {`Spent ${inr(Math.round(calc.now))} by day ${calc.upto}; a usual month is at ${inr(Math.round(calc.usualNow))} by then.`}
          </span>
        </>
      )}
    </StoryCard>
  );
}

// ---------------------------------------------------------------------------
// Kind of spend: is lifestyle creeping up?
// ---------------------------------------------------------------------------

export function KindMixCard({ p, q, className }: { p: SpendingPeriod; q: SpendModelQ; className?: string }) {
  const reduced = usePrefersReducedMotion();
  const m = q.model;
  const partialSel = !!p.month && p.month === p.latest && p.latestPartial;

  const data = useMemo(() => (m?.months ?? []).map(per => {
    const k = m!.byKind.get(per)!;
    const partial = per === p.latest && p.latestPartial;
    return {
      period: per,
      label: partial ? `${monthShort(per)} so far` : monthShort(per),
      ...k,
      total: m!.totals.get(per) ?? 0,
      on: p.isRange || per === p.month,
    };
  }), [m, p.latest, p.latestPartial, p.isRange, p.month]);

  const tiles = useMemo(() => {
    if (!m) return [];
    const sel = selectedMonths(p, m);
    return KINDS.map(k => {
      const sum = sel.reduce((s, per) => s + (m.byKind.get(per)?.[k.key] ?? 0), 0);
      const value = sum / (p.isRange ? p.monthsSpan : 1);
      return { ...k, value, usual: usualKind(m, k.key) };
    });
  }, [m, p]);

  const empty = !!m && data.every(d => d.total <= 0);

  return (
    <StoryCard
      title="Fixed, everyday, lifestyle"
      subtitle={p.isRange ? "A month, on average" : undefined}
      className={className}
      loading={q.loading}
      error={q.error}
      onRetry={q.retry}
      empty={empty}
      emptyTitle="No spending yet"
      skeleton={<Rows n={5} />}
    >
      <ul className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        {tiles.map(t => (
          <li key={t.key} title={`${t.hint}. A usual month: ${inr(Math.round(t.usual))}`}>
            <span className="flex items-center gap-1.5 text-[13px] font-semibold text-muted">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: KIND_COLOR[t.key] }} aria-hidden />
              {t.label}
            </span>
            <span className="mt-1 block text-[22px] font-black leading-tight tabular-nums text-ink">{kInr(t.value)}</span>
            <span className="block">
              {t.key !== "oneoff" && partialSel
                ? <span className="text-sm font-medium tabular-nums text-muted">of {kInr(t.usual)}</span>
                : t.key === "oneoff"
                  ? <span className="text-sm font-medium text-muted">{t.value > 0 ? "not usual" : "none"}</span>
                  : <Delta d={t.value - t.usual} floor={Math.max(300, t.usual * 0.08)} />}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-5 h-[210px]" role="img" aria-label="Spend by kind, month by month">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 22, right: 4, left: 4, bottom: 0 }} barCategoryGap="22%">
            <XAxis dataKey="label" tickLine={false} axisLine={false} interval={0} tick={{ fill: CHART.muted, fontSize: 12, fontWeight: 500 }} />
            <YAxis hide />
            <Tooltip
              cursor={{ fill: CHART.surface }}
              {...tooltipProps()}
              formatter={(v: number, name: string) => [inr(Math.round(v)), KINDS.find(k => k.key === name)?.label ?? name]}
            />
            {KINDS.map((k, i) => (
              <Bar
                key={k.key}
                dataKey={k.key}
                stackId="s"
                fill={KIND_COLOR[k.key]}
                stroke={CHART.card}
                strokeWidth={1}
                radius={i === KINDS.length - 1 ? [6, 6, 0, 0] : 0}
                isAnimationActive={!reduced}
                animationBegin={CHART_ANIM.begin + i * CHART_ANIM.staggerMs}
                animationDuration={CHART_ANIM.barDuration}
              >
                {data.map(d => <Cell key={d.period} fillOpacity={d.on ? 1 : 0.35} />)}
                {i === KINDS.length - 1 && (
                  <LabelList
                    dataKey="total"
                    position="top"
                    formatter={(v: number) => kInr(v)}
                    style={{ fill: CHART.ink2, fontSize: 12, fontWeight: 700 }}
                  />
                )}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </StoryCard>
  );
}

// ---------------------------------------------------------------------------
// Where, specifically: top merchants by spend or by visits.
// ---------------------------------------------------------------------------

type MerchantSort = "spend" | "visits";

export function MerchantsCard({ p, q, className }: { p: SpendingPeriod; q: SpendModelQ; className?: string }) {
  const [sort, setSort] = useState<MerchantSort>("spend");
  const reduced = usePrefersReducedMotion();
  const m = q.model;

  const { list, food } = useMemo(() => {
    if (!m) return { list: [], food: [] };
    const rows = rowsIn(p, m).filter(isHabit);
    const by = new Map<string, { key: string; name: string; total: number; n: number; cats: Map<string, number> }>();
    for (const r of rows) {
      const g = by.get(r.key) ?? { key: r.key, name: r.name, total: 0, n: 0, cats: new Map() };
      g.total += r.amount;
      g.n += 1;
      const ck = `${r.category}|${r.sub}`;
      g.cats.set(ck, (g.cats.get(ck) ?? 0) + 1);
      if (r.name.length < g.name.length) g.name = r.name;
      by.set(r.key, g);
    }
    const list = Array.from(by.values()).map(g => {
      const [category, sub] = Array.from(g.cats.entries()).sort((a, b) => b[1] - a[1])[0][0].split("|");
      return { ...g, category, sub };
    });
    const foodParts = [
      { key: "delivery", label: "Delivery", emoji: "🛵", match: (r: SpendRow) => r.category === "Food" && r.sub === "Online Ordering" },
      { key: "groceries", label: "Groceries", emoji: "🛒", match: (r: SpendRow) => r.category === "Food" && r.sub === "Groceries" },
      { key: "dineout", label: "Eating out", emoji: "🍽️", match: (r: SpendRow) => r.category === "Food" && r.sub === "Dine-out" },
    ];
    const food = foodParts.map((f, i) => {
      const rs = rowsIn(p, m).filter(r => r.amount > 0 && f.match(r));
      return { ...f, total: rs.reduce((s, r) => s + r.amount, 0), n: rs.length, color: [CHART_SERIES[2], CHART_SERIES[1], CHART_SERIES[3]][i] };
    }).filter(f => f.n > 0);
    return { list, food };
  }, [m, p]);

  const top = [...list].sort((a, b) => (sort === "spend" ? b.total - a.total : b.n - a.n || b.total - a.total)).slice(0, 10);
  const max = top.reduce((s, g) => Math.max(s, sort === "spend" ? g.total : g.n), 0);
  const foodTotal = food.reduce((s, f) => s + f.total, 0);

  return (
    <StoryCard
      title="Where, specifically"
      subtitle="Rent, bills and one-offs left out"
      action={list.length > 0 ? (
        <Segmented<MerchantSort>
          size="sm"
          ariaLabel="Sort merchants"
          value={sort}
          onChange={setSort}
          options={[{ value: "spend", label: "Spend" }, { value: "visits", label: "Visits" }]}
        />
      ) : undefined}
      className={className}
      loading={q.loading}
      error={q.error}
      onRetry={q.retry}
      empty={!!m && list.length === 0}
      emptyTitle="No everyday spending here"
      skeleton={<Rows n={6} />}
    >
      {foodTotal > 0 && (
        <div className="mb-5">
          <div className="flex h-3 overflow-hidden rounded-pill bg-surface-2" aria-hidden>
            {food.map(f => (
              <span key={f.key} className="h-full border-r-2 border-card last:border-r-0" style={{ width: `${(f.total / foodTotal) * 100}%`, background: f.color }} />
            ))}
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[13px] font-medium text-muted" aria-label="Food split">
            {food.map(f => (
              <li key={f.key} className="tabular-nums" title={`${f.label}: ${inr(Math.round(f.total))} across ${f.n}, average ${inr(Math.round(f.total / f.n))}`}>
                <span aria-hidden>{f.emoji} </span>
                <span className="font-semibold text-ink">{f.label} {kInr(f.total)}</span> · {f.n} {f.key === "delivery" ? "orders" : "visits"} · avg {kInr(f.total / f.n)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ul className="space-y-2.5" aria-label={`Top merchants by ${sort}`}>
        {top.map((g, i) => {
          const v = sort === "spend" ? g.total : g.n;
          return (
            <li key={g.key} title={`${g.name} · ${g.sub || catLabel(g.category)}: ${inr(Math.round(g.total))} across ${g.n}`}>
              <div className="flex items-center gap-3">
                <span aria-hidden className="w-6 shrink-0 text-center text-[18px] leading-none">{rowEmoji(g.category, g.sub)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold text-ink">{g.name}</span>
                </span>
                <span className="shrink-0 text-[13px] font-medium tabular-nums text-muted">
                  {g.n}× · avg {kInr(g.total / g.n)}
                </span>
                <span className="w-[60px] shrink-0 text-right text-[15px] font-extrabold tabular-nums text-ink">{kInr(g.total)}</span>
              </div>
              <div className="ml-9 mr-[60px] mt-1 h-1.5 rounded-pill bg-surface-2">
                <div
                  className={clsx("h-full rounded-pill", i === 0 ? "bg-accent-500" : "bg-accent-200", !reduced && "sp-bar-grow")}
                  style={{ width: `${max > 0 ? Math.max(2, (v / max) * 100) : 0}%`, animationDelay: `${120 + i * 50}ms` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </StoryCard>
  );
}

// ---------------------------------------------------------------------------
// When: a calendar for a month, a weekday grid for six months.
// ---------------------------------------------------------------------------

function shade(v: number, max: number): number {
  return v <= 0 || max <= 0 ? 0 : 0.14 + 0.86 * Math.sqrt(v / max);
}

export function WhenCard({ p, q, className }: { p: SpendingPeriod; q: SpendModelQ; className?: string }) {
  const m = q.model;

  const calc = useMemo(() => {
    if (!m) return null;
    const asOf = p.asOf ?? "9999";
    const habit = rowsIn(p, m).filter(isHabit);
    const byDay = new Map<string, number>();
    habit.forEach(r => byDay.set(r.date, (byDay.get(r.date) ?? 0) + r.amount));

    // Weekday vs weekend, per calendar day (spend-free days count too).
    let wd = 0, we = 0, nWd = 0, nWe = 0;
    for (const per of selectedMonths(p, m)) {
      for (let d = 1; d <= daysIn(per); d++) {
        const iso = `${per}-${String(d).padStart(2, "0")}`;
        if (iso > asOf) break;
        const v = byDay.get(iso) ?? 0;
        if (dow(iso) >= 5) { we += v; nWe++; } else { wd += v; nWd++; }
      }
    }
    const weekday = nWd ? wd / nWd : 0;
    const weekend = nWe ? we / nWe : 0;

    if (!p.isRange && p.month) {
      const per = p.month;
      const lead = dow(`${per}-01`);
      const cells: ({ iso: string; day: number; v: number; future: boolean } | null)[] = Array(lead).fill(null);
      for (let d = 1; d <= daysIn(per); d++) {
        const iso = `${per}-${String(d).padStart(2, "0")}`;
        cells.push({ iso, day: d, v: byDay.get(iso) ?? 0, future: iso > asOf });
      }
      const max = Math.max(0, ...cells.map(c => c?.v ?? 0));
      return { mode: "month" as const, cells, max, weekday, weekend };
    }
    const grid = m.months.map(per => {
      const sums = Array(7).fill(0), counts = Array(7).fill(0);
      for (let d = 1; d <= daysIn(per); d++) {
        const iso = `${per}-${String(d).padStart(2, "0")}`;
        if (iso > asOf) break;
        const k = dow(iso);
        sums[k] += byDay.get(iso) ?? 0;
        counts[k] += 1;
      }
      return { per, vals: sums.map((s, i) => (counts[i] ? s / counts[i] : 0)) };
    });
    const max = Math.max(0, ...grid.flatMap(g => g.vals));
    return { mode: "range" as const, grid, max, weekday, weekend };
  }, [m, p]);

  const accent = CHART.accent;
  return (
    <StoryCard
      title="When you spend"
      subtitle="Everyday and lifestyle, a day"
      className={className}
      loading={q.loading}
      error={q.error}
      onRetry={q.retry}
      empty={!!calc && calc.max <= 0}
      emptyTitle="No everyday spending here"
      skeleton={<Rows n={4} />}
    >
      {calc && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-4">
            <div>
              <p className="text-[13px] font-semibold text-muted">Weekdays</p>
              <p className="text-[22px] font-black leading-tight tabular-nums text-ink">{kInr(calc.weekday)}</p>
            </div>
            <div>
              <p className="text-[13px] font-semibold text-muted">Weekends</p>
              <p className="text-[22px] font-black leading-tight tabular-nums text-ink">
                {kInr(calc.weekend)}
                {calc.weekday > 0 && calc.weekend / calc.weekday >= 1.15 && (
                  <span className="ml-1.5 text-sm font-semibold text-muted">{(calc.weekend / calc.weekday).toFixed(1)}×</span>
                )}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-[auto_repeat(7,minmax(0,1fr))] gap-1" role="img" aria-label="Spend by day">
            <span />
            {WEEKDAYS.map(d => (
              <span key={d} className="pb-1 text-center text-[11px] font-semibold text-faint">{d.slice(0, 2)}</span>
            ))}
            {calc.mode === "month"
              ? chunk(calc.cells, 7).map((week, wi) => (
                <Week key={wi}>
                  {Array.from({ length: 7 }, (_, i) => week[i] ?? null).map((c, i) => c ? (
                    <span
                      key={c.iso}
                      title={c.future ? shortDay(c.iso) : `${WEEKDAYS[i]} ${shortDay(c.iso)} · ${inr(Math.round(c.v))}`}
                      className={clsx(
                        "relative grid h-8 place-items-center rounded-[6px] text-[11px] font-semibold tabular-nums",
                        c.future ? "border border-dashed border-line text-faint" : "bg-surface text-muted",
                      )}
                    >
                      {!c.future && c.v > 0 && (
                        <span className="absolute inset-0 rounded-[6px]" style={{ background: accent, opacity: shade(c.v, calc.max) }} />
                      )}
                      <span className={clsx("relative", !c.future && shade(c.v, calc.max) > 0.55 && "text-white")}>{c.day}</span>
                    </span>
                  ) : <span key={`e${wi}-${i}`} />)}
                </Week>
              ))
              : calc.grid.map(g => (
                <Week key={g.per} label={monthShort(g.per)}>
                  {g.vals.map((v, i) => (
                    <span
                      key={i}
                      title={`${monthShort(g.per)}, ${WEEKDAYS[i]}s · ${inr(Math.round(v))} a day`}
                      className="relative h-7 rounded-[6px] bg-surface"
                    >
                      {v > 0 && <span className="absolute inset-0 rounded-[6px]" style={{ background: accent, opacity: shade(v, calc.max) }} />}
                    </span>
                  ))}
                </Week>
              ))}
          </div>
        </>
      )}
    </StoryCard>
  );
}

function Week({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <>
      <span className="flex items-center pr-1.5 text-[11px] font-semibold text-faint">{label ?? ""}</span>
      {children}
    </>
  );
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

// ---------------------------------------------------------------------------
// How you pay: UPI, card, transfers; plus the EMI load.
// ---------------------------------------------------------------------------

export function HowYouPayCard({ p, q, className }: { p: SpendingPeriod; q: SpendModelQ; className?: string }) {
  const m = q.model;
  const calc = useMemo(() => {
    if (!m) return null;
    const rows = rowsIn(p, m).filter(r => r.amount > 0);
    const total = rows.reduce((s, r) => s + r.amount, 0);
    const parts = PAYS.map(pp => {
      const rs = rows.filter(r => r.pay === pp.key);
      return { ...pp, total: rs.reduce((s, r) => s + r.amount, 0), n: rs.length };
    }).filter(x => x.n > 0);
    // EMIs still running at the end of the period.
    const endPer = p.isRange ? p.latest ?? "" : p.month ?? "";
    const live = m.plans.map(pl => {
      const start = pl.start_date.slice(0, 7);
      const done = (Number(endPer.slice(0, 4)) - Number(start.slice(0, 4))) * 12 + Number(endPer.slice(5, 7)) - Number(start.slice(5, 7)) + 1;
      return { pl, left: pl.tenure_months - done, started: start <= endPer };
    }).filter(x => x.started && x.left >= 0);
    const emi = live.reduce((s, x) => s + x.pl.monthly_amount, 0);
    return { total, parts, live, emi };
  }, [m, p]);

  const card = calc?.parts.find(x => x.key === "card");
  const cardShare = calc && calc.total > 0 ? Math.round(((card?.total ?? 0) / calc.total) * 100) : 0;

  return (
    <StoryCard
      title="How you pay"
      className={className}
      loading={q.loading}
      error={q.error}
      onRetry={q.retry}
      empty={!!calc && calc.total <= 0}
      emptyTitle="No payments here"
      skeleton={<Rows n={3} />}
    >
      {calc && (
        <>
          <p className="text-[28px] font-black leading-none tabular-nums text-ink">
            {cardShare}%<span className="ml-1.5 text-base font-semibold text-muted">on credit card</span>
          </p>
          <div className="mt-4 flex h-3 overflow-hidden rounded-pill bg-surface-2" aria-hidden>
            {calc.parts.map(x => (
              <span key={x.key} className="h-full border-r-2 border-card last:border-r-0" style={{ width: `${(x.total / calc.total) * 100}%`, background: PAY_COLOR[x.key] }} />
            ))}
          </div>
          <ul className="mt-3 divide-y divide-line">
            {calc.parts.map(x => (
              <li key={x.key} className="flex items-center gap-2 py-2 text-[14px]">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: PAY_COLOR[x.key] }} aria-hidden />
                <span className="min-w-0 flex-1 truncate font-semibold text-ink">{x.label}</span>
                <span className="shrink-0 font-medium tabular-nums text-muted">{x.n}×</span>
                <span className="w-[56px] shrink-0 text-right font-extrabold tabular-nums text-ink">{kInr(x.total)}</span>
              </li>
            ))}
          </ul>
          {calc.live.length > 0 && (
            <div className="mt-3 rounded-m bg-surface px-3 py-2.5 text-[13px] font-medium text-muted">
              <span className="font-semibold text-ink">EMIs {kInr(calc.emi)} a month</span>
              {calc.live.map(x => (
                <span key={x.pl.id} className="block truncate" title={x.pl.note ?? undefined}>
                  {inr(Math.round(x.pl.total_amount))} over {x.pl.tenure_months} months · {x.left === 0 ? "last one" : `${x.left} left`}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </StoryCard>
  );
}

// ---------------------------------------------------------------------------
// Small payments: many under ₹200 that add up.
// ---------------------------------------------------------------------------

const SMALL = 200;

export function SmallPaysCard({ p, q, className }: { p: SpendingPeriod; q: SpendModelQ; className?: string }) {
  const m = q.model;
  const calc = useMemo(() => {
    if (!m) return null;
    const rows = rowsIn(p, m).filter(r => r.amount > 0 && r.amount < SMALL && !r.emi);
    const total = rows.reduce((s, r) => s + r.amount, 0);
    const by = new Map<string, { name: string; total: number; n: number; category: string; sub: string }>();
    rows.forEach(r => {
      const g = by.get(r.key) ?? { name: r.name, total: 0, n: 0, category: r.category, sub: r.sub };
      g.total += r.amount; g.n += 1;
      by.set(r.key, g);
    });
    const top = Array.from(by.values()).sort((a, b) => b.total - a.total).slice(0, 4);
    return { n: rows.length, total, top };
  }, [m, p]);

  const runFrac = !p.isRange && p.month === p.latest && p.latestPartial && p.asOf && p.month
    ? Number(p.asOf.slice(8, 10)) / daysIn(p.month) : 1;
  const perMonth = calc ? calc.total / (p.isRange ? p.monthsSpan : runFrac) : 0;
  return (
    <StoryCard
      title={`Under ${inr(SMALL)}`}
      className={className}
      loading={q.loading}
      error={q.error}
      onRetry={q.retry}
      empty={!!calc && calc.n === 0}
      emptyTitle="No small payments"
      skeleton={<Rows n={3} />}
    >
      {calc && (
        <>
          <p className="text-[28px] font-black leading-none tabular-nums text-ink">
            {kInr(p.isRange ? perMonth : calc.total)}
            <span className="ml-1.5 text-base font-semibold text-muted">
              {p.isRange ? "a month" : ""} in {calc.n} payments
            </span>
          </p>
          <p className="mt-1.5 text-sm font-medium tabular-nums text-muted">{kInr(perMonth * 12)} a year at this rate</p>
          <ul className="mt-4 divide-y divide-line">
            {calc.top.map(g => (
              <li key={g.name} className="flex items-center gap-2 py-2 text-[14px]">
                <span aria-hidden className="w-5 shrink-0 text-center">{rowEmoji(g.category, g.sub)}</span>
                <span className="min-w-0 flex-1 truncate font-semibold text-ink" title={catLabel(g.category)}>{g.name}</span>
                <span className="shrink-0 font-medium tabular-nums text-muted">{g.n}×</span>
                <span className="w-[56px] shrink-0 text-right font-extrabold tabular-nums text-ink">{kInr(g.total)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </StoryCard>
  );
}
