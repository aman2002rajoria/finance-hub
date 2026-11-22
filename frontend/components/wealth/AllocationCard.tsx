"use client";

/*
 * Equity share of long-term money (the emergency fund is left out), shown
 * twice: counting EPF and PPF, and without them. A dashed line marks the
 * target for your age. The gap is stated as a fact, in rupees.
 */

import clsx from "clsx";

import { Card, CardTitle } from "@/components/ui";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { CHART_OTHER, CHART_SERIES } from "@/lib/chart-theme";
import { CLASS_LABEL, type AssetClass } from "@/lib/wealth";

import { shortInr } from "./chartKit";
import type { LongTermMix } from "./mix";

const COLOR: Record<AssetClass, string> = {
  equity: "var(--accent-500)",
  debt: CHART_SERIES[4],
  gold: CHART_SERIES[5],
  cash: CHART_SERIES[0],
  other: CHART_OTHER,
};
const EMOJI: Record<AssetClass, string> = { equity: "📈", debt: "🏦", gold: "🪙", cash: "💵", other: "•" };

function Bar({ parts, label, value, reduced }: { parts: { key: AssetClass; pct: number }[]; label: string; value: number; reduced: boolean }) {
  return (
    <div className="grid grid-cols-[88px_1fr_40px] items-center gap-2">
      <span className="text-[12px] font-semibold leading-tight text-muted">{label}</span>
      <div className="flex h-6 min-w-0 gap-[2px] overflow-hidden rounded-s">
        {parts.filter((p) => p.pct > 0).map((p, i) => (
          <span
            key={p.key}
            className={clsx("h-full", !reduced && "al-grow")}
            style={{ width: `${p.pct}%`, background: COLOR[p.key], animationDelay: `${200 + i * 60}ms` }}
            title={`${CLASS_LABEL[p.key]} ${Math.round(p.pct)}%`}
          />
        ))}
      </div>
      <span className="text-right text-[14px] font-extrabold tabular-nums text-ink">{Math.round(value)}%</span>
    </div>
  );
}

export default function AllocationCard({ mix, targetPct }: { mix: LongTermMix; targetPct: number }) {
  const reduced = usePrefersReducedMotion();
  if (mix.total <= 0) {
    return (
      <Card className="h-full">
        <CardTitle>Equity mix</CardTitle>
        <p className="mt-5 text-base text-muted">Add investments to see the mix.</p>
      </Card>
    );
  }
  const gapAll = (targetPct / 100) * mix.total - mix.equity;
  const gapEx = ((targetPct - mix.equityPctExRetire) / 100) * mix.totalExRetire;
  const gapText = (g: number) => (Math.abs(g) < 1000 ? "On target" : `${shortInr(Math.abs(g))} ${g > 0 ? "under" : "over"}`);
  const legend = mix.parts.filter((p) => p.pct > 0);

  return (
    <Card className="flex h-full flex-col">
      <CardTitle>Equity {Math.round(mix.equityPct)}% · target {Math.round(targetPct)}%</CardTitle>

      <div className="relative mt-5 space-y-2.5">
        <Bar parts={mix.parts} label="With EPF, PPF" value={mix.equityPct} reduced={reduced} />
        {mix.retire > 0 && <Bar parts={mix.partsExRetire} label="Without" value={mix.equityPctExRetire} reduced={reduced} />}
        {/* Target line across both bars */}
        <div aria-hidden className="pointer-events-none absolute -bottom-1.5 -top-1.5 left-[96px] right-[48px]">
          <div className="absolute inset-y-0 border-l-2 border-dashed border-ink" style={{ left: `${targetPct}%` }} />
        </div>
      </div>
      <div className="relative ml-[96px] mr-[48px] mt-2 h-4" aria-hidden>
        <span className="absolute -translate-x-1/2 whitespace-nowrap text-[11px] font-semibold text-ink-2" style={{ left: `${targetPct}%` }}>
          target
        </span>
      </div>

      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] font-medium text-muted">
        {legend.map((p) => (
          <li key={p.key} className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: COLOR[p.key] }} />
            {EMOJI[p.key]} {CLASS_LABEL[p.key]}
          </li>
        ))}
      </ul>

      <dl className="mt-5 grid grid-cols-2 gap-3">
        <div>
          <dt className="text-[12px] font-semibold text-muted">Equity vs target, with EPF, PPF</dt>
          <dd className="mt-0.5 text-[16px] font-black tabular-nums text-ink">{gapText(gapAll)}</dd>
        </div>
        {mix.retire > 0 && (
          <div>
            <dt className="text-[12px] font-semibold text-muted">Without</dt>
            <dd className="mt-0.5 text-[16px] font-black tabular-nums text-ink">{gapText(gapEx)}</dd>
          </div>
        )}
      </dl>
      {mix.emergency > 0 && (
        <p className="mt-auto pt-3 text-[12px] font-medium text-muted">Long-term money only: the {shortInr(mix.emergency)} emergency fund is left out.</p>
      )}
      <style>{`
        .al-grow { transform-origin: left; animation: al-grow .9s var(--spring) both; }
        @keyframes al-grow { from { transform: scaleX(0) } to { transform: scaleX(1) } }
      `}</style>
    </Card>
  );
}
