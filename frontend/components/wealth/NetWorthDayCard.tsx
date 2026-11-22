"use client";

/*
 * Net worth over time, on an axis that starts at ₹0 so growth reads true.
 * Investments are the base (accent), bank cash sits on top, the ink line is
 * net worth after what you owe. Weekly closes by default (calm); "Daily"
 * shows the salary sawtooth. A bracket on the right edge shows the last
 * 3 months' growth. Emoji pins mark moments both ways (🎉 bonus, 📱 iPad,
 * ✈️ trip); market dips sit on the investment line. Tap a pin to rename it.
 */

import clsx from "clsx";
import { motion } from "framer-motion";
import { useMemo, useState } from "react";

import { Card, CardTitle, Modal, Segmented } from "@/components/ui";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { CHART, CHART_SERIES } from "@/lib/chart-theme";
import { inr } from "@/lib/format";
import { dayIndex, type DayPoint, type LifeEvent, type Marker } from "@/lib/wealth";

import { FloatTip, TipRow, dayMon, mon, niceTicks, shortInr, useWidth } from "./chartKit";
import { EventForm } from "./ManualEntry";
import { rupees } from "./words";

type Range = "1M" | "3M" | "All";
type Grain = "weekly" | "daily";
const SPAN: Record<Range, number> = { "1M": 31, "3M": 92, All: Infinity };
const CASH = CHART_SERIES[0];

interface Pin { x: number; y: number; items: Marker[]; market: boolean }

/** Collapse pins closer than `gap` px into one. */
function cluster(pins: { x: number; y: number; m: Marker }[], gap: number, market: boolean): Pin[] {
  const out: Pin[] = [];
  for (const p of [...pins].sort((a, b) => a.x - b.x)) {
    const last = out[out.length - 1];
    if (last && p.x - last.x < gap) {
      last.items.push(p.m);
      last.items.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    } else out.push({ x: p.x, y: p.y, items: [p.m], market });
  }
  return out;
}

export default function NetWorthDayCard({
  daily, markers, events, hasHoldings,
}: {
  daily: DayPoint[];
  markers: Marker[];
  events: LifeEvent[];
  hasHoldings: boolean;
}) {
  const reduced = usePrefersReducedMotion();
  const [range, setRange] = useState<Range>("All");
  const [grain, setGrain] = useState<Grain>("weekly");
  const [ref, W] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const [pinTip, setPinTip] = useState<{ pin: Pin; open: boolean } | null>(null);
  const [editing, setEditing] = useState<{ id?: string; date: string; label?: string; emoji?: string; amount?: number } | null>(null);

  const pts = useMemo(() => daily.slice(-Math.min(daily.length, SPAN[range])), [daily, range]);
  const mobile = W > 0 && W < 560;
  const H = mobile ? 236 : 300;
  const padT = 44, padB = 24, padL = 2, padR = mobile ? 40 : 48;

  const geo = useMemo(() => {
    if (pts.length < 2 || W === 0) return null;
    const n = pts.length;
    const inv = pts.map((p) => (hasHoldings ? p.investments : 0));
    const top = pts.map((p) => p.netWorth);
    const stack = pts.map((p, i) => inv[i] + Math.max(0, p.cash));
    // Weekly closes: every 7th day counting back from today, so the last
    // point is today's real number (it matches the header).
    const idx: number[] = [];
    if (grain === "weekly") {
      for (let i = n - 1; i >= 0; i -= 7) idx.unshift(i);
      if (idx[0] !== 0) idx.unshift(0);
    } else for (let i = 0; i < n; i++) idx.push(i);
    // The axis starts at ₹0: a non-zero floor would make a 15% rise look like a doubling.
    const lo = 0;
    const hi = Math.max(...stack, ...top) * 1.06;
    const x = (i: number) => padL + (i / (n - 1)) * (W - padL - padR);
    const y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
    const yb = H - padB;

    const line = (vals: number[], stepped: boolean) => {
      const out: string[] = [];
      idx.forEach((i, k) => {
        out.push(`${k === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(vals[i]).toFixed(1)}`);
        const nx = idx[k + 1];
        if (stepped && nx != null) out.push(`L${x(nx).toFixed(1)},${y(vals[i]).toFixed(1)}`);
      });
      return out.join("");
    };
    const back = (vals: number[]) => idx.slice().reverse().map((i) => `L${x(i).toFixed(1)},${y(vals[i]).toFixed(1)}`).join("");
    const daily = grain === "daily";
    const stepPath = line(top, daily);
    const invLine = line(inv, false);
    const invArea = `${invLine}L${x(n - 1).toFixed(1)},${yb}L${x(0).toFixed(1)},${yb}Z`;
    const stackLine = line(stack, daily);
    // Daily: the band's bottom edge is the investments line (not stepped), traced backwards.
    const band = hasHoldings ? `${stackLine}${back(inv)}Z` : `${stackLine}L${x(n - 1).toFixed(1)},${yb}L${x(0).toFixed(1)},${yb}Z`;
    const ticks = niceTicks(lo, hi, mobile ? 3 : 4).filter((t) => t > lo && t < hi);

    // Growth over the last 3 months (or the whole range when it's shorter).
    const bi = Math.max(0, n - 1 - 91);
    // Value on the drawn line at day i (weekly lines run straight between closes).
    const on = (vals: number[], i: number) => {
      if (daily) return vals[i];
      let k = 0;
      while (k < idx.length - 1 && idx[k + 1] < i) k++;
      const i0 = idx[k], i1 = idx[Math.min(k + 1, idx.length - 1)];
      if (i1 === i0) return vals[i0];
      const t = Math.max(0, Math.min(1, (i - i0) / (i1 - i0)));
      return vals[i0] + (vals[i1] - vals[i0]) * t;
    };
    const bracket = { from: bi, a: top[bi], b: top[n - 1], months: Math.max(1, Math.round((n - 1 - bi) / 30.4)) };

    // X labels: month starts, or weekly in the 1M view.
    const xl: { i: number; text: string }[] = [];
    if (range === "1M") {
      for (let i = n - 1; i >= 0; i -= 7) xl.unshift({ i, text: dayMon(pts[i].date) });
    } else {
      const starts = pts.map((p, i) => ({ p, i })).filter(({ p }) => p.date.endsWith("-01"));
      const every = Math.max(1, Math.ceil((starts.length * 44) / (W - padL - padR)));
      starts.forEach(({ p, i }, k) => {
        if (k % every === 0) xl.push({ i, text: p.date.slice(5, 7) === "01" ? p.date.slice(0, 4) : mon(p.date) });
      });
      if (!xl.length) xl.push({ i: 0, text: dayMon(pts[0].date) });
    }

    // Pins.
    const first = pts[0].date, last = pts[n - 1].date;
    // Your own labels always show; auto-detected spends only the biggest few
    // that fit, so a long range doesn't turn into a row of pins.
    const all = markers.filter((m) => m.date >= first && m.date <= last);
    const room = Math.max(3, Math.floor((W - padL - padR) / 90));
    const autoSpends = all.filter((m) => m.kind !== "event" && m.kind !== "market")
      .sort((p, q) => Math.abs(q.amount) - Math.abs(p.amount)).slice(0, room);
    const inRange = all.filter((m) => m.kind === "event" || m.kind === "market" || autoSpends.includes(m))
      .map((m) => (m.emoji === "•" || !m.emoji ? { ...m, emoji: "💸" } : m));
    const at = (m: Marker) => Math.max(0, Math.min(n - 1, dayIndex(first, m.date)));
    const life = cluster(
      inRange.filter((m) => m.kind !== "market").map((m) => ({ x: x(at(m)), y: y(on(top, at(m))), m })),
      mobile ? 30 : 34, false,
    );
    const market = hasHoldings
      ? cluster(inRange.filter((m) => m.kind === "market").map((m) => ({ x: x(at(m)), y: y(on(inv, at(m))), m })), 26, true)
      : [];
    return { x, y, yb, stepPath, invLine, invArea, band, ticks, xl, life, market, n, inv, top, idx, bracket, on };
  }, [pts, W, H, hasHoldings, markers, range, mobile, padR, grain]);

  if (daily.length < 2) {
    return (
      <Card className="h-full">
        <CardTitle>Net worth, day by day</CardTitle>
        <p className="mt-5 text-base text-muted">A month of statements draws this.</p>
      </Card>
    );
  }

  const a = pts[0], b = pts[pts.length - 1];
  const change = b.netWorth - a.netWorth;
  const market = hasHoldings ? (b.investments - a.investments) - (b.invested - a.invested) : 0;
  const added = change - market;
  const since = range === "All" ? `since ${dayMon(a.date)}` : range === "3M" ? "in 3 months" : "in a month";
  // With investments the title is the why: new money vs the market.
  const title = hasHoldings
    ? `${shortInr(added, true)} saved, ${shortInr(market, true)} from markets`
    : Math.abs(change) < 1000 ? `Flat ${since}` : `${change > 0 ? "Up" : "Down"} ${rupees(Math.abs(change))} ${since}`;

  const hv = hover != null && geo ? pts[hover] : null;
  const openPin = (pin: Pin) => setPinTip((t) => (t?.open && t.pin.x === pin.x && t.pin.y === pin.y ? null : { pin, open: true }));

  function edit(m: Marker) {
    const own = m.kind === "event" ? events.find((e) => e.date === m.date && e.label === m.label) : undefined;
    setPinTip(null);
    setEditing(own ? { ...own } : { date: m.date, label: m.label, emoji: m.emoji, amount: m.amount });
  }

  function move(e: React.PointerEvent<SVGRectElement>) {
    if (!geo) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const i = Math.max(0, Math.min(geo.n - 1, Math.round(((px - padL) / (W - padL - padR)) * (geo.n - 1))));
    // Weekly: snap to the nearest close, so the tooltip shows a real number.
    setHover(grain === "daily" ? i : geo.idx.reduce((best, j) => (Math.abs(j - i) < Math.abs(best - i) ? j : best), geo.idx[0]));
  }

  return (
    <Card className="flex h-full flex-col">
      <CardTitle
        action={
          <Segmented<Range>
            size="sm"
            ariaLabel="Range"
            value={range}
            onChange={(r) => { setRange(r); setHover(null); setPinTip(null); }}
            options={[{ value: "1M", label: "1M" }, { value: "3M", label: "3M" }, { value: "All", label: "All" }]}
          />
        }
      >
        {title}
      </CardTitle>
      {mobile && geo && geo.bracket.from > 0 && Math.abs(geo.bracket.b - geo.bracket.a) >= 1000 && (
        <p className={clsx("mt-1 text-[13px] font-extrabold tabular-nums", geo.bracket.b >= geo.bracket.a ? "text-accent-700" : "text-danger-text")}>
          {shortInr(geo.bracket.b - geo.bracket.a, true)} ({geo.bracket.a > 0 ? `${geo.bracket.b >= geo.bracket.a ? "+" : "−"}${Math.abs(((geo.bracket.b - geo.bracket.a) / geo.bracket.a) * 100).toFixed(0)}%` : ""}) in {geo.bracket.months} mo
        </p>
      )}
      <div ref={ref} className="relative mt-3 select-none" style={{ height: H }}>
        {geo && (
          <>
            <svg width={W} height={H} className="block overflow-visible" role="img" aria-label={`Net worth from ${inr(a.netWorth)} on ${dayMon(a.date)} to ${inr(b.netWorth)} on ${dayMon(b.date)}`}>
              <defs>
                <clipPath id="nw-reveal">
                  <motion.rect
                    key={range}
                    x={0} y={0} height={H}
                    initial={{ width: reduced ? W : 0 }}
                    animate={{ width: W }}
                    transition={{ duration: reduced ? 0 : 1, ease: "easeOut", delay: reduced ? 0 : 0.15 }}
                  />
                </clipPath>
              </defs>
              {geo.ticks.map((t) => (
                <g key={t}>
                  <line x1={padL} x2={W - padR} y1={geo.y(t)} y2={geo.y(t)} stroke={CHART.line} strokeWidth={1} />
                  <text x={W - padR + 6} y={geo.y(t) + 4} fontSize={11} fontWeight={500} fill={CHART.faint}>{shortInr(t)}</text>
                </g>
              ))}
              <g clipPath="url(#nw-reveal)">
                {hasHoldings && <path d={geo.invArea} fill={CHART.accent} fillOpacity={0.14} />}
                <path d={geo.band} fill={CASH} fillOpacity={0.16} />
                {hasHoldings && <path d={geo.invLine} fill="none" stroke={CHART.accent} strokeWidth={1.75} />}
                <path d={geo.stepPath} fill="none" stroke={CHART.ink} strokeWidth={1.75} strokeLinejoin="round" />
                {geo.life.map((p) => (
                  <g key={`s${p.x}`}>
                    <line x1={p.x} x2={p.x} y1={34} y2={p.y - 4} stroke={CHART.faint} strokeWidth={1} strokeDasharray="2 3" />
                    <circle cx={p.x} cy={p.y} r={3.5} fill={CHART.card} stroke={CHART.ink} strokeWidth={1.5} />
                  </g>
                ))}
              </g>
              {geo.bracket.from > 0 && Math.abs(geo.bracket.b - geo.bracket.a) >= 1000 && (() => {
                const bx = geo.x(geo.n - 1) - 3;
                const ya = geo.y(geo.bracket.a), yb2 = geo.y(geo.bracket.b);
                const d = geo.bracket.b - geo.bracket.a;
                const pct = geo.bracket.a > 0 ? (d / geo.bracket.a) * 100 : 0;
                const tone = d >= 0 ? CHART.accent700 : CHART.dangerText;
                return (
                  <g pointerEvents="none">
                    <line x1={geo.x(geo.bracket.from)} x2={bx} y1={ya} y2={ya} stroke={CHART.muted} strokeWidth={1} strokeDasharray="2 3" />
                    <circle cx={geo.x(geo.bracket.from)} cy={ya} r={3} fill={CHART.card} stroke={CHART.muted} strokeWidth={1.5} />
                    <path d={`M${bx - 4},${ya}H${bx}V${yb2}H${bx - 4}`} fill="none" stroke={tone} strokeWidth={1.75} />
                    {!mobile && (() => {
                      const label = `${shortInr(d, true)} (${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(0)}%) in ${geo.bracket.months} mo`;
                      const tw = label.length * 7.4 + 16;
                      const cy = Math.min(geo.yb - 14, Math.max(ya, yb2) + 16);
                      return (
                        <g>
                          <rect x={bx - tw} y={cy - 11} width={tw} height={22} rx={11} fill={CHART.card} stroke={tone} strokeWidth={1.25} />
                          <text x={bx - tw / 2} y={cy + 4.5} textAnchor="middle" fontSize={13} fontWeight={800} fill={tone}>{label}</text>
                        </g>
                      );
                    })()}
                  </g>
                );
              })()}
              {geo.xl.map((l) => (
                <text key={l.i} x={geo.x(l.i)} y={H - 6} fontSize={11} fontWeight={500} fill={CHART.faint} textAnchor={l.i === 0 ? "start" : "middle"}>{l.text}</text>
              ))}
              {hv && hover != null && (
                <g pointerEvents="none">
                  <line x1={geo.x(hover)} x2={geo.x(hover)} y1={padT - 6} y2={geo.yb} stroke={CHART.line} strokeWidth={1} />
                  <circle cx={geo.x(hover)} cy={geo.y(geo.on(geo.top, hover))} r={4} fill={CHART.ink} stroke={CHART.card} strokeWidth={2} />
                  {hasHoldings && <circle cx={geo.x(hover)} cy={geo.y(geo.on(geo.inv, hover))} r={3.5} fill={CHART.accent} stroke={CHART.card} strokeWidth={2} />}
                </g>
              )}
              <rect
                x={0} y={padT - 8} width={W - padR} height={H - padT - padB + 8} fill="transparent"
                style={{ touchAction: "pan-y" }}
                onPointerMove={move}
                onPointerDown={(e) => { setPinTip(null); move(e); }}
                onPointerLeave={() => setHover(null)}
              />
            </svg>

            {/* Pins: HTML so they're tappable and keyboard reachable. */}
            {[...geo.life, ...geo.market].map((p) => {
              const m = p.items[0];
              const size = p.market ? 22 : 30;
              const top = p.market ? Math.min(geo.yb - size - 2, p.y + 8) : 4;
              const names = p.items.map((i) => `${i.label}, ${shortInr(i.amount, true)}, ${dayMon(i.date)}`).join("; ");
              return (
                <button
                  key={`${p.market ? "m" : "l"}${p.x}`}
                  type="button"
                  aria-label={names}
                  onMouseEnter={() => setPinTip((t) => (t?.open ? t : { pin: p, open: false }))}
                  onMouseLeave={() => setPinTip((t) => (t?.open ? t : null))}
                  onFocus={() => setPinTip((t) => (t?.open ? t : { pin: p, open: false }))}
                  onBlur={() => setPinTip((t) => (t?.open ? t : null))}
                  onClick={() => openPin(p)}
                  className={clsx(
                    "absolute grid place-items-center rounded-full bg-card focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-accent-500",
                    p.market ? "text-[11px] shadow-[0_0_0_1px_var(--line)]" : "text-[16px] shadow-[0_0_0_1px_var(--line),0_6px_14px_-8px_rgba(0,0,0,.35)] hover:shadow-[0_0_0_2px_var(--accent-500)]",
                    !reduced && "nw-pin",
                  )}
                  style={{ left: p.x - size / 2, top, width: size, height: size }}
                >
                  <span aria-hidden className={p.market ? "opacity-70" : undefined}>{m.emoji}</span>
                  {!p.market && m.amount !== 0 && (
                    <span
                      aria-hidden
                      className={clsx(
                        "absolute -bottom-1 left-1/2 grid h-3.5 w-3.5 -translate-x-1/2 place-items-center rounded-full bg-card text-[8px] leading-none shadow-[0_0_0_1px_var(--line)]",
                        m.amount > 0 ? "text-success-text" : "text-danger-text",
                      )}
                    >
                      {m.amount > 0 ? "▲" : "▼"}
                    </span>
                  )}
                  {p.items.length > 1 && (
                    <span aria-hidden className="absolute -right-1.5 -top-1.5 grid h-4 min-w-4 place-items-center rounded-pill bg-ink px-1 text-[10px] font-extrabold text-card">
                      {p.items.length}
                    </span>
                  )}
                </button>
              );
            })}

            {pinTip && (
              <div
                className={clsx("absolute z-30 w-[220px] rounded-s bg-card px-3.5 py-2.5 shadow-float", !pinTip.open && "pointer-events-none")}
                style={{
                  left: Math.max(0, Math.min(W - 220, pinTip.pin.x - 110)),
                  top: pinTip.pin.market ? Math.max(0, pinTip.pin.y - 90) : 38,
                }}
              >
                <ul className="space-y-1.5">
                  {pinTip.pin.items.map((m) => (
                    <li key={m.date + m.label} className="flex items-center gap-2">
                      <span aria-hidden className="text-[16px]">{m.emoji}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-extrabold text-ink">{m.label}</span>
                        <span className="block text-[12px] font-medium text-muted">{dayMon(m.date)}</span>
                      </span>
                      <span className="text-[13px] font-semibold tabular-nums text-ink">{m.amount ? shortInr(m.amount, true) : ""}</span>
                      {pinTip.open && (
                        <button type="button" onClick={() => edit(m)} className="rounded-pill px-1.5 py-0.5 text-[12px] font-semibold text-accent-700 hover:bg-surface">
                          {m.kind === "event" ? "Edit" : "Name"}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {hv && hover != null && !pinTip && (
              <FloatTip x={geo.x(hover)} y={padT} width={W}>
                <p className="mb-1 text-[13px] font-semibold text-muted">{grain === "weekly" ? `Week to ${dayMon(hv.date)}` : dayMon(hv.date)}</p>
                <TipRow label="Net worth" value={inr(hv.netWorth)} strong />
                {hasHoldings && <TipRow dot={CHART.accent} label="Investments" value={inr(hv.investments)} />}
                <TipRow dot={CASH} label="Bank cash" value={inr(hv.cash)} />
                {hv.cash + hv.investments - hv.netWorth > 1 && (
                  <TipRow label="Owed" value={`−${inr(hv.cash + (hasHoldings ? hv.investments : 0) - hv.netWorth)}`} />
                )}
              </FloatTip>
            )}
          </>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] font-medium text-muted">
        {hasHoldings && <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-2.5 rounded-full bg-accent-500" />Investments</span>}
        <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: CASH, opacity: 0.6 }} />Bank cash</span>
        <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-0 w-4 border-t-2 border-ink" />Net worth</span>
        <span className="ml-auto">
          <Segmented<Grain>
            size="sm"
            ariaLabel="Detail"
            value={grain}
            onChange={(g) => { setGrain(g); setHover(null); }}
            options={[{ value: "weekly", label: "Weekly" }, { value: "daily", label: "Daily" }]}
          />
        </span>
        <button
          type="button"
          onClick={() => setEditing({ date: b.date })}
          className="rounded-pill px-2 py-1 font-semibold text-accent-700 hover:bg-surface"
        >
          📍 Mark a moment
        </button>
      </div>

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? "Edit moment" : "Name this moment"}>
        {editing && <EventForm initial={editing} onDone={() => setEditing(null)} />}
      </Modal>
      <style>{`
        .nw-pin { animation: nw-pin .4s var(--spring) 1s both; }
        @keyframes nw-pin { from { opacity: 0; transform: translateY(-6px) } to { opacity: 1; transform: none } }
      `}</style>
    </Card>
  );
}
