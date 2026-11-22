"use client";

/*
 * "Where your money went": income sources -> Income -> Invested and Saved in
 * bank (the hero bands, in strong colours, bracketed together), then at most
 * five spending categories and Other in quiet neutrals. If spending ran past
 * income, "From savings" joins the sources instead. Under 560px wide the
 * flow becomes one stacked bar with a list. Hover for amounts; a category
 * opens its drilldown.
 */

import { motion } from "framer-motion";
import Link from "next/link";
import { useMemo, useState } from "react";

import { FloatTip, TipRow, useWidth } from "@/components/wealth/chartKit";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { CHART, CHART_SERIES } from "@/lib/chart-theme";
import { inr } from "@/lib/format";
import { CATEGORY_EMOJI } from "@/lib/wealth";

import { StatefulCard } from "../cardStates";
import { humanInr, isUncategorised } from "../fmt";
import { type Figures, keptPct } from "./homeData";

interface Node {
  key: string;
  label: string;
  emoji: string;
  value: number;
  color: string;
  hero?: boolean;
  drill?: string;
  tip?: string;
}

const TOP = 5;
const SHORT: Record<string, string> = { "Bills & Utilities": "Bills", Entertainment: "Fun" };
/** The second hero colour: saved in bank. */
export const SAVED_COLOR = CHART_SERIES[6];

function stack(nodes: Node[], k: number, top: number, avail: number, gap: number, slot: number) {
  const hs = nodes.map((n) => Math.max(2, n.value * k));
  const steps = hs.map((h) => Math.max(h + gap, slot));
  const total = steps.reduce((a, b) => a + b, 0) - gap;
  let y = top + Math.max(0, (avail - total) / 2);
  return hs.map((h, i) => {
    const pad = (steps[i] - gap - h) / 2;
    const out = { y: y + Math.max(0, pad), h };
    y += steps[i];
    return out;
  });
}

function scaleFor(nodes: Node[], avail: number, gap: number, slot: number) {
  let k = avail / Math.max(1, nodes.reduce((s, n) => s + n.value, 0));
  for (let it = 0; it < 6; it++) {
    const small = nodes.filter((n) => n.value * k + gap < slot);
    const big = nodes.filter((n) => n.value * k + gap >= slot);
    const room = avail + gap - small.length * slot - big.length * gap;
    const v = big.reduce((s, n) => s + n.value, 0);
    if (v <= 0 || room <= 0) break;
    k = room / v;
  }
  return k;
}

function spread(ys: number[], min: number, lo: number, hi: number): number[] {
  const out = [...ys];
  for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1] + min);
  const over = out[out.length - 1] - hi;
  if (over > 0) {
    out[out.length - 1] -= over;
    for (let i = out.length - 2; i >= 0; i--) out[i] = Math.min(out[i], out[i + 1] - min);
  }
  return out.map((y) => Math.max(lo, y));
}

function band(x0: number, y0a: number, y0b: number, x1: number, y1a: number, y1b: number) {
  const xm = (x0 + x1) / 2;
  return `M${x0},${y0a}C${xm},${y0a} ${xm},${y1a} ${x1},${y1a}L${x1},${y1b}C${xm},${y1b} ${xm},${y0b} ${x0},${y0b}Z`;
}

/** Sources and destinations for a scope's figures. */
export function flowOf(fig: Figures) {
  const src = fig.sources;
  const sources: Node[] = [
    { key: "s-salary", label: "Salary", emoji: "💼", value: src.salary, color: CHART.ink2 },
    { key: "s-bonus", label: "Bonus", emoji: "🎉", value: src.bonus, color: CHART.ink2 },
    { key: "s-interest", label: "Interest", emoji: "🪙", value: src.interest, color: CHART.ink2 },
    { key: "s-other", label: "Other", emoji: "➕", value: src.other, color: CHART.ink2 },
  ].filter((n) => n.value >= 1);
  if (fig.saved < 0) {
    sources.push({ key: "s-savings", label: "From savings", emoji: "🐷", value: -fig.saved, color: CHART.warning, tip: "Spending and investing ran past income" });
  }

  const dests: Node[] = [];
  if (fig.invested > 0) dests.push({ key: "d-invest", label: "Invested", emoji: "📈", value: fig.invested, color: CHART.accent, hero: true, drill: "Investments", tip: "SIPs from the bank" });
  if (fig.saved > 0) dests.push({ key: "d-saved", label: "Saved in bank", emoji: "🏦", value: fig.saved, color: SAVED_COLOR, hero: true, tip: "Income left in your accounts" });
  const named = fig.cats.filter((r) => !isUncategorised(r.category));
  const top = named.slice(0, TOP);
  const rest = fig.spent - top.reduce((s, r) => s + r.amount, 0);
  for (const r of top) {
    dests.push({
      key: `d-${r.category}`, label: SHORT[r.category] ?? r.category, emoji: CATEGORY_EMOJI[r.category] ?? "•",
      value: r.amount, color: CHART.faint, drill: r.category,
    });
  }
  if (rest >= 1) dests.push({ key: "d-other", label: "Other", emoji: "🧺", value: rest, color: CHART.faint, tip: "Smaller categories and untagged spending" });
  const inTotal = sources.reduce((s, n) => s + n.value, 0);
  const outTotal = dests.reduce((s, n) => s + n.value, 0);
  return { sources, dests, income: fig.income, total: Math.max(inTotal, outTotal) };
}

export default function MoneyFlowCard({
  fig, loading, error, onRetry, onDrill, className, scopeWords,
}: {
  fig: Figures | null;
  loading: boolean;
  error?: unknown;
  onRetry?: () => void;
  onDrill?: (category: string) => void;
  className?: string;
  /** "in November", "over 6 months". */
  scopeWords?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const [ref, W] = useWidth();
  const [hover, setHover] = useState<{ key: string; x: number; y: number } | null>(null);
  const flow = useMemo(() => (fig ? flowOf(fig) : null), [fig]);
  const kept = fig ? keptPct(fig) : null;
  const empty = !loading && (!flow || flow.total <= 0);
  const mobile = W > 0 && W < 560;

  const geo = useMemo(() => {
    if (!flow || W === 0 || flow.total <= 0 || mobile) return null;
    const H = 380;
    const padT = 30, padB = 6, nodeW = 10, gap = 12;
    const Lw = 140, Rw = 250;
    const x0 = Lw, x2 = W - Rw - nodeW, x1 = Math.round((x0 + x2) / 2);
    const avail = H - padT - padB;
    const slot = 34;
    const k = Math.min(scaleFor(flow.sources, avail, gap, slot), scaleFor(flow.dests, avail, gap, slot), avail / flow.total);
    const S = stack(flow.sources, k, padT, avail, gap, slot);
    const D = stack(flow.dests, k, padT, avail, gap, slot);
    const midH = flow.total * k;
    const midY = Math.min(padT + (avail - midH) / 2, S[0]?.y ?? padT, D[0]?.y ?? padT);
    let off = midY;
    const inLinks = flow.sources.map((n, i) => {
      const h = n.value * k;
      const d = band(x0 + nodeW, S[i].y, S[i].y + h, x1, off, off + h);
      off += h;
      return { key: n.key, d, color: n.key === "s-savings" ? CHART.warning : CHART.faint };
    });
    off = midY;
    const outLinks = flow.dests.map((n, i) => {
      const h = n.value * k;
      const d = band(x1 + nodeW, off, off + h, x2, D[i].y, D[i].y + h);
      off += h;
      return { key: n.key, d, color: n.color, hero: n.hero };
    });
    const rLabels = spread(D.map((p) => p.y + p.h / 2), 32, 14, H - 14);
    const lLabels = spread(S.map((p) => p.y + p.h / 2), 32, 14, H - 14);
    const heroes = flow.dests.filter((d) => d.hero).length;
    return { H, nodeW, x0, x1, x2, S, D, midY, midH, inLinks, outLinks, rLabels, lLabels, heroes };
  }, [flow, W, mobile]);

  const pctOf = (v: number) => (flow && flow.income > 0 ? `${Math.round((v / flow.income) * 100)}%` : "");
  const hoverNode = hover && flow ? [...flow.sources, ...flow.dests].find((n) => n.key === hover.key) : null;
  const lit = (key: string) => !hover || hover.key === key;
  const ex = fig?.excluded;

  return (
    <StatefulCard
      className={className}
      title={flow && flow.income > 0 ? `Where your ${humanInr(flow.income)} went` : "Where your money went"}
      subtitle={scopeWords}
      loading={loading}
      error={error ?? undefined}
      onRetry={onRetry}
      empty={empty}
      emptyTitle="No money moved in these dates"
      emptyHint="Pick another month."
      what="where your money went"
      skeleton={<div className="h-[340px] w-full animate-pulse rounded-m bg-surface" />}
    >
      <div ref={ref} className="relative w-full" style={{ minHeight: mobile ? undefined : geo?.H ?? 360 }} onPointerLeave={() => setHover(null)}>
        {mobile && flow && <StackedFlow flow={flow} kept={kept} pctOf={pctOf} onDrill={onDrill} />}
        {geo && flow && (
          <svg width={W} height={geo.H} className="block overflow-visible" role="img"
            aria-label={`Income of ${inr(flow.income)} split into ${flow.dests.map((d) => `${d.label} ${inr(d.value)}`).join(", ")}`}>
            <defs>
              <clipPath id="mf-reveal">
                <motion.rect x={0} y={0} height={geo.H} initial={{ width: reduced ? W : 0 }} animate={{ width: W }}
                  transition={{ duration: reduced ? 0 : 1, ease: "easeOut", delay: reduced ? 0 : 0.15 }} />
              </clipPath>
            </defs>
            <g clipPath="url(#mf-reveal)">
              {geo.inLinks.map((l) => (
                <path key={l.key} d={l.d} fill={l.color} fillOpacity={lit(l.key) ? 0.22 : 0.08}
                  onPointerEnter={(e) => setHover({ key: l.key, x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY })} />
              ))}
              {geo.outLinks.map((l) => (
                <path key={l.key} d={l.d} fill={l.color}
                  fillOpacity={!lit(l.key) ? 0.08 : l.hero ? (hover ? 0.7 : 0.5) : (hover ? 0.45 : 0.28)}
                  className="transition-[fill-opacity] duration-200"
                  onPointerEnter={(e) => setHover({ key: l.key, x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY })} />
              ))}
            </g>
            {flow.sources.map((n, i) => (
              <rect key={n.key} x={geo.x0} y={geo.S[i].y} width={geo.nodeW} height={geo.S[i].h} rx={3} fill={n.color} />
            ))}
            <rect x={geo.x1} y={geo.midY} width={geo.nodeW} height={geo.midH} rx={3} fill={CHART.ink} />
            <text x={geo.x1 + geo.nodeW / 2} y={geo.midY - 10} textAnchor="middle" fontSize={12} fontWeight={800} fill={CHART.ink}>
              Income {humanInr(flow.income)}
            </text>
            {flow.dests.map((n, i) => (
              <rect key={n.key} x={geo.x2} y={geo.D[i].y} width={geo.nodeW} height={geo.D[i].h} rx={3} fill={n.hero ? n.color : CHART.muted} />
            ))}
            {flow.sources.map((n, i) => (
              <g key={n.key} onPointerEnter={() => setHover({ key: n.key, x: geo.x0, y: geo.lLabels[i] })}>
                <text x={geo.x0 - 8} y={geo.lLabels[i] - 2} textAnchor="end" fontSize={13} fontWeight={700} fill={CHART.ink}>{n.emoji} {n.label}</text>
                <text x={geo.x0 - 8} y={geo.lLabels[i] + 13} textAnchor="end" fontSize={12} fontWeight={500} fill={CHART.muted}>{humanInr(n.value)}</text>
              </g>
            ))}
            {flow.dests.map((n, i) => (
              <g key={n.key}
                onPointerEnter={() => setHover({ key: n.key, x: geo.x2, y: geo.rLabels[i] })}
                onClick={() => n.drill && onDrill?.(n.drill)}
                style={{ cursor: n.drill && onDrill ? "pointer" : undefined }}>
                <rect x={geo.x2} y={geo.rLabels[i] - 16} width={W - geo.x2 - 80} height={32} fill="transparent" />
                <text x={geo.x2 + geo.nodeW + 8} y={geo.rLabels[i] - 2} fontSize={13} fontWeight={n.hero ? 800 : 600} fill={n.hero ? CHART.ink : CHART.ink2}>
                  {n.emoji} {n.label}
                </text>
                <text x={geo.x2 + geo.nodeW + 8} y={geo.rLabels[i] + 13} fontSize={12} fontWeight={n.hero ? 700 : 500} fill={CHART.muted}>
                  {humanInr(n.value)} · {pctOf(n.value)}
                </text>
              </g>
            ))}
            {geo.heroes > 0 && kept != null && kept > 0 && (() => {
              const y0 = geo.rLabels[0] - 16;
              const y1 = geo.rLabels[geo.heroes - 1] + 16;
              const bx = W - 70;
              const ym = (y0 + y1) / 2;
              return (
                <g aria-hidden>
                  <path d={`M${bx - 6},${y0} H${bx} V${y1} H${bx - 6}`} fill="none" stroke={CHART.accent} strokeWidth={1.5} strokeLinecap="round" />
                  <text x={bx + 10} y={ym - (geo.heroes > 1 ? 4 : 0)} fontSize={20} fontWeight={900} fill={CHART.accent700}>{kept}%</text>
                  <text x={bx + 10} y={ym + 13} fontSize={11} fontWeight={600} fill={CHART.muted}>{geo.heroes > 1 ? "saved +" : "kept"}</text>
                  {geo.heroes > 1 && <text x={bx + 10} y={ym + 26} fontSize={11} fontWeight={600} fill={CHART.muted}>invested</text>}
                </g>
              );
            })()}
          </svg>
        )}
        {hoverNode && hover && geo && (
          <FloatTip x={Math.min(hover.x, W - 20)} y={Math.max(0, hover.y - 40)} width={W}>
            <p className="mb-1 text-[13px] font-extrabold text-ink">{hoverNode.emoji} {hoverNode.key === "d-other" ? "Other spending" : hoverNode.label}</p>
            <TipRow dot={hoverNode.color} label={inr(hoverNode.value)} value={`${pctOf(hoverNode.value)} of income`} />
            {hoverNode.tip && <p className="mt-1 text-[12px] font-medium text-muted">{hoverNode.tip}</p>}
          </FloatTip>
        )}
      </div>
      {ex && ex.cardBills + ex.transfers > 0 && (
        <Link
          href="/transactions"
          className="mt-3 inline-flex items-center gap-1 rounded-pill bg-surface px-2.5 py-1 text-[12px] font-semibold text-muted hover:text-ink"
          title="Card bill payments and transfers between your own accounts aren't counted, so nothing counts twice"
        >
          🔁 {[ex.cardBills ? `${ex.cardBills} card bill${ex.cardBills === 1 ? "" : "s"}` : null, ex.transfers ? `${ex.transfers} transfer${ex.transfers === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ")} hidden
        </Link>
      )}
    </StatefulCard>
  );
}

/* ------------------------------------------------- narrow: one stacked bar */

function StackedFlow({
  flow, kept, pctOf, onDrill,
}: {
  flow: ReturnType<typeof flowOf>;
  kept: number | null;
  pctOf: (v: number) => string;
  onDrill?: (c: string) => void;
}) {
  const total = Math.max(1, flow.dests.reduce((s, d) => s + d.value, 0));
  const heroes = flow.dests.filter((d) => d.hero);
  const heroPct = (heroes.reduce((s, d) => s + d.value, 0) / total) * 100;
  const showBracket = heroes.length > 0 && kept != null && kept > 0;
  return (
    <div>
      <p className="text-[13px] font-medium text-muted">
        {flow.sources.map((s, i) => (
          <span key={s.key}>{i > 0 && " · "}<span className="whitespace-nowrap">{s.emoji} {s.label} {humanInr(s.value)}</span></span>
        ))}
      </p>
      {showBracket && (
        <>
          <p className="mt-4 text-[12px] font-extrabold text-accent-700">Saved + invested {kept}%</p>
          <div className="mt-1 h-1.5 rounded-t-[3px] border-x-2 border-t-2 border-accent-500" style={{ width: `${Math.max(heroPct, 12)}%` }} />
        </>
      )}
      <div className={`${showBracket ? "mt-1" : "mt-4"} flex h-7 w-full gap-[2px] overflow-hidden rounded-s`} role="img" aria-label="Where income went">
        {flow.dests.map((d) => (
          <div key={d.key} style={{ width: `${(d.value / total) * 100}%`, background: d.hero ? d.color : undefined }}
            className={d.hero ? undefined : "bg-surface-2"} />
        ))}
      </div>
      <ul className="mt-4 space-y-2.5">
        {flow.dests.map((d) => (
          <li key={d.key}>
            <button type="button" disabled={!d.drill || !onDrill} onClick={() => d.drill && onDrill?.(d.drill)}
              className="flex w-full items-center gap-2.5 text-left text-sm disabled:cursor-default">
              <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: d.hero ? d.color : CHART.faint }} />
              <span className={`min-w-0 flex-1 truncate ${d.hero ? "font-extrabold text-ink" : "font-medium text-ink-2"}`}>{d.emoji} {d.label}</span>
              <span className="shrink-0 font-semibold tabular-nums text-ink">{humanInr(d.value)}</span>
              <span className="w-10 shrink-0 text-right tabular-nums text-muted">{pctOf(d.value)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
