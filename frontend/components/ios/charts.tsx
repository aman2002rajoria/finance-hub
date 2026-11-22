"use client";

/* Hand-drawn SVG charts for the phones: crisp at 3x, themed by CSS vars. */

import type { DayPoint, Marker } from "@/lib/wealth";
import { monthName, short } from "./data";
import { scale, smooth, thin } from "./kit";

const DATA = { violet: "#7C5CFF", green: "#00B86B", orange: "#FF5A1F", pink: "#E54B8C", teal: "#00A3BF" };
export { DATA };

/** Emoji pin: a disc in the pin row, a hairline stem down to the point on the line. */
export function Pin({ x, y, hx, hy, emoji, active, size = 26 }: { x: number; y: number; hx: number; hy: number; emoji: string; active?: boolean; size?: number }) {
  const r = size / 2;
  return (
    <g>
      <path d={`M${x},${y - 4} L${x},${hy + r + 6} L${hx},${hy + r}`} fill="none" stroke={active ? "var(--tint-fill)" : "var(--l3)"} strokeWidth={active ? 1.5 : 1} strokeLinejoin="round" />
      <circle cx={x} cy={y} r={active ? 4.5 : 3.5} fill="var(--cell)" stroke={active ? "var(--tint-fill)" : "var(--l1)"} strokeWidth={active ? 2.5 : 1.75} />
      <circle cx={hx} cy={hy} r={r} fill="var(--cell)" stroke={active ? "var(--tint-fill)" : "var(--sep)"} strokeWidth={active ? 2 : 1} />
      <text x={hx} y={hy + 0.5} textAnchor="middle" dominantBaseline="central" fontSize={size * 0.54}>{emoji}</text>
    </g>
  );
}

/** Spread pin heads so none overlap (min `gap` apart), staying near their points and inside [lo, hi]. */
export function fan(xs: number[], gap: number, lo: number, hi: number): number[] {
  const out = xs.slice();
  for (let iter = 0; iter < 20; iter++) {
    let moved = false;
    let i = 0;
    while (i < out.length) {
      let j = i;
      while (j + 1 < out.length && out[j + 1] - out[j] < gap - 0.01) j++;
      if (j > i) {
        const mean = xs.slice(i, j + 1).reduce((a, b) => a + b, 0) / (j - i + 1);
        let start = mean - ((j - i) * gap) / 2;
        start = Math.min(Math.max(start, lo), hi - (j - i) * gap);
        for (let k = i; k <= j; k++) out[k] = start + (k - i) * gap;
        moved = true;
      }
      i = j + 1;
    }
    if (!moved) break;
  }
  return out;
}

/**
 * Net worth, daily, with moments. Pin heads sit in one row above the line and
 * fan apart when moments are close (Aug: phone + medical, Oct: bonus + iPad).
 */
export function NetWorthChart({
  daily, markers, w, h, active, axis = true, pinSize = 26, top = 46, kinds, yTicks = false,
}: {
  daily: DayPoint[]; markers: Marker[]; w: number; h: number; active?: string; axis?: boolean; pinSize?: number; top?: number; yTicks?: boolean;
  kinds?: Marker["kind"][];
}) {
  if (!daily.length) return <svg width={w} height={h} />;
  const pts = thin(daily, 90, (p) => p.netWorth);
  const vals = daily.map((p) => p.netWorth);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.08;
  const bottom = axis ? 22 : 4;
  const t0 = Date.parse(daily[0].date), t1 = Date.parse(daily[daily.length - 1].date);
  const right = yTicks ? 34 : 2;
  const X = scale(t0, t1, 2, w - right);
  const Y = scale(lo - pad, hi + pad, h - bottom, top);
  const STEP = 1e5;
  const gy: number[] = [];
  if (yTicks) for (let v = Math.ceil((lo - pad) / STEP) * STEP; v <= hi + pad; v += STEP) if (Math.round(v / STEP) % 1 === 0) gy.push(v);
  const P = pts.map((p) => ({ x: X(Date.parse(p.date)), y: Y(p.netWorth) }));
  const line = smooth(P);
  const area = `${line} L${P[P.length - 1].x},${h - bottom} L${P[0].x},${h - bottom} Z`;
  const valAt = (iso: string) => (daily.find((p) => p.date === iso) ?? daily[daily.length - 1]).netWorth;
  const ms = markers.filter((m) => (!kinds || kinds.includes(m.kind)) && m.date >= daily[0].date && m.date <= daily[daily.length - 1].date);
  const r = pinSize / 2;
  const xs = ms.map((m) => X(Date.parse(m.date)));
  const hx = fan(xs, pinSize + 3, r + 1, w - r - 1);
  const pins = ms.map((m, i) => ({ m, x: xs[i], y: Y(valAt(m.date)), hx: hx[i] }));
  const months: { x: number; label: string }[] = [];
  for (const p of daily) if (p.date.endsWith("-01")) months.push({ x: X(Date.parse(p.date)), label: monthName(p.date) });
  const id = `nwg-${w}-${h}-${active ?? "x"}`;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: "block", overflow: "visible" }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#00B86B" stopOpacity="0.26" />
          <stop offset="1" stopColor="#00B86B" stopOpacity="0" />
        </linearGradient>
      </defs>
      {gy.map((v) => (
        <g key={v}>
          <line x1={0} x2={w - right + 2} y1={Y(v)} y2={Y(v)} stroke="var(--chart-grid)" strokeDasharray="2 3" />
          <text x={w} y={Y(v) + 4} textAnchor="end" fontSize={11} fill="var(--l2)" style={{ fontFamily: "var(--sf)" }}>{`₹${Math.round(v / 1e5)}L`}</text>
        </g>
      ))}
      {axis && months.map((mo) => (
        <g key={mo.label}>
          <line x1={mo.x} x2={mo.x} y1={top - 8} y2={h - bottom} stroke="var(--chart-grid)" strokeWidth={1} />
          <text x={mo.x + 4} y={h - 6} fontSize={11} fill="var(--l2)" style={{ fontFamily: "var(--sf)" }}>{mo.label}</text>
        </g>
      ))}
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke="#00B86B" strokeWidth={2.25} strokeLinejoin="round" strokeLinecap="round" />
      {pins.map(({ m, x, y, hx: px }) => (
        <Pin key={m.date + m.label} x={x} y={y} hx={px} hy={r + 1} emoji={m.emoji} active={active === m.date} size={pinSize} />
      ))}
      <circle cx={P[P.length - 1].x} cy={P[P.length - 1].y} r={4} fill="#00B86B" stroke="var(--cell)" strokeWidth={2} />
    </svg>
  );
}

/** Tiny sparkline. */
export function Spark({ values, w, h, color = "#00B86B", fill = true }: { values: number[]; w: number; h: number; color?: string; fill?: boolean }) {
  const lo = Math.min(...values), hi = Math.max(...values);
  const X = scale(0, values.length - 1, 1, w - 1);
  const Y = scale(lo, hi, h - 2, 2);
  const P = values.map((v, i) => ({ x: X(i), y: Y(v) }));
  const line = smooth(P);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: "block" }}>
      {fill && <path d={`${line} L${w - 1},${h} L1,${h} Z`} fill={color} opacity={0.14} />}
      <path d={line} fill="none" stroke={color} strokeWidth={1.75} strokeLinecap="round" />
    </svg>
  );
}

/**
 * A goal's real path (weekly money towards it), a dashed projection to the
 * date, the plan line, and the target. Event emojis sit on the path.
 */
export function GoalPath({
  history, events, target, start, end, plannedEnd, asOf, current, projected, w, h, color, pinSize = 22, showPlan = false, labels = false,
}: {
  history: { date: string; value: number }[]; events: { date: string; emoji: string }[];
  target: number; start: string; end: string; plannedEnd?: string; asOf: string; current: number; projected: number;
  w: number; h: number; color: string; pinSize?: number; showPlan?: boolean; labels?: boolean;
}) {
  const t0 = Date.parse(start), t1 = Date.parse(end);
  const top = pinSize + 10, bottom = labels ? 20 : 4;
  const hi = Math.max(target, projected, ...history.map((p) => p.value)) * 1.04;
  const X = scale(t0, t1, 2, w - 6);
  const Y = scale(0, hi, h - bottom, top);
  const P = history.map((p) => ({ x: X(Date.parse(p.date)), y: Y(p.value) }));
  // keep drops sharp: straight segments, rounded joins
  const path = P.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const nowX = X(Date.parse(asOf)), nowY = Y(current);
  const id = `gp-${color.slice(1)}-${w}`;
  const valAt = (iso: string) => {
    let v = history[0]?.value ?? 0;
    for (const p of history) if (p.date <= iso) v = p.value;
    return v;
  };
  const evs = events.filter((e) => e.date >= start && e.date <= asOf);
  const exs = evs.map((e) => X(Date.parse(e.date)));
  const ehx = fan(exs, pinSize + 3, pinSize / 2 + 1, w - pinSize / 2 - 1);
  const pins = evs.map((e, i) => {
    // pin at the point after the move (the dip or the jump), so it reads as the cause
    const after = history.find((p) => p.date >= e.date) ?? history[history.length - 1];
    const v = Math.min(valAt(e.date), after.value);
    return { e, x: exs[i], y: Y(v), hx: ehx[i] };
  });
  const ticks = labels ? (() => {
    const out: { x: number; label: string }[] = [];
    const s = new Date(start); s.setDate(1);
    for (let d = new Date(s); d.getTime() <= t1; d.setMonth(d.getMonth() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      if (Date.parse(iso) < t0) continue;
      const m = d.getMonth();
      if (m % 3 === 0) out.push({ x: X(d.getTime()), label: m === 0 ? String(d.getFullYear()) : monthName(iso) });
    }
    return out;
  })() : [];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: "block", overflow: "visible" }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.22" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {ticks.map((t) => (
        <text key={t.x} x={t.x} y={h - 4} fontSize={11} fill="var(--l2)" textAnchor="middle" style={{ fontFamily: "var(--sf)" }}>{t.label}</text>
      ))}
      {/* target */}
      <line x1={2} x2={w - 6} y1={Y(target)} y2={Y(target)} stroke="var(--l3)" strokeDasharray="2 4" strokeLinecap="round" />
      {showPlan && plannedEnd && (
        <line x1={P[0]?.x ?? 2} y1={P[0]?.y ?? Y(0)} x2={X(Date.parse(plannedEnd))} y2={Y(target)} stroke="var(--l2)" strokeWidth={1.5} strokeDasharray="5 4" />
      )}
      {showPlan && plannedEnd && <circle cx={X(Date.parse(plannedEnd))} cy={Y(target)} r={3.5} fill="var(--cell)" stroke="var(--l2)" strokeWidth={1.5} />}
      <path d={`${path} L${nowX},${h - bottom} L${P[0]?.x ?? 0},${h - bottom} Z`} fill={`url(#${id})`} />
      <path d={path} fill="none" stroke={color} strokeWidth={2.25} strokeLinejoin="round" strokeLinecap="round" />
      {/* projection: to the target at the date it gets there, or to where it lands by the end */}
      <line x1={nowX} y1={nowY} x2={projected >= target ? nowX + (X(t1) - nowX) * Math.min(1, (target - current) / Math.max(1, projected - current)) : X(t1)} y2={Y(Math.min(projected, target))} stroke={color} strokeWidth={2} strokeDasharray="1 5" strokeLinecap="round" />
      <circle cx={X(t1)} cy={Y(target)} r={4} fill={color} />
      {pins.map(({ e, x, y, hx: px }) => <Pin key={e.date} x={x} y={y} hx={px} hy={pinSize / 2 + 1} emoji={e.emoji} size={pinSize} />)}
      <circle cx={nowX} cy={nowY} r={4} fill={color} stroke="var(--cell)" strokeWidth={2} />
    </svg>
  );
}

export const fmtAxis = (v: number) => short(v, 0);
