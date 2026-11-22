"use client";

/*
 * Emergency fund as a meter of months: one block per month of spending you
 * aim to cover, filled up to what you have. Under it, what counts and the gap.
 */

import clsx from "clsx";

import { Card, CardTitle } from "@/components/ui";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { inr } from "@/lib/format";
import type { Holding } from "@/lib/wealth";


export default function EmergencyCard({
  em, targetMonths, monthlyExpenses, holdings,
}: {
  em: { have: number; earmarked: number; fromBank: number; target: number; months: number; gap: number };
  targetMonths: number;
  monthlyExpenses: number;
  holdings: Holding[];
}) {
  const reduced = usePrefersReducedMotion();

  if (monthlyExpenses <= 0) {
    return (
      <Card className="h-full">
        <CardTitle>🛟 Emergency fund</CardTitle>
        <p className="mt-5 text-base text-muted">A month of statements measures this.</p>
      </Card>
    );
  }

  const months = em.months;
  const done = months >= targetMonths;
  const blocks = Math.max(1, Math.round(targetMonths));
  const earmarked = holdings.filter((h) => h.isEmergency);
  const shown = Math.round(months * 10) / 10;

  return (
    <Card className="flex h-full flex-col">
      <CardTitle>🛟 {done ? `${shown.toFixed(1)} months covered` : `${shown.toFixed(1)} of ${targetMonths} months covered`}</CardTitle>

      <div className="mt-5 flex gap-1.5" role="meter" aria-valuemin={0} aria-valuemax={targetMonths} aria-valuenow={Number(shown.toFixed(1))} aria-label="Months of spending covered">
        {Array.from({ length: blocks }).map((_, i) => {
          const fill = Math.max(0, Math.min(1, months - i));
          return (
            <div key={i} className="h-9 flex-1 overflow-hidden rounded-s bg-surface-2">
              <div
                className={clsx("h-full rounded-s bg-accent-500", !reduced && "wl-grow")}
                style={{ width: `${fill * 100}%`, animationDelay: `${200 + i * 80}ms` }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-[13px] font-medium tabular-nums text-muted" aria-hidden>
        <span>{inr(em.have)}</span>
        <span>{inr(em.target)}</span>
      </div>

      <ul className="mt-4 space-y-1 text-[13px] font-medium text-muted">
        {earmarked.map((h) => (
          <li key={h.id} className="flex items-baseline gap-2">
            <span aria-hidden>💧</span>
            <span className="min-w-0 flex-1 truncate">{h.name}</span>
            <span className="tabular-nums text-ink-2">{inr(h.current)}</span>
          </li>
        ))}
        <li className="flex items-baseline gap-2" title="Only one month of bank cash counts; the rest is money you live on.">
          <span aria-hidden>🏦</span>
          <span className="min-w-0 flex-1 truncate">1 month of bank cash</span>
          <span className="tabular-nums text-ink-2">{inr(em.fromBank)}</span>
        </li>
      </ul>
      {!done && (
        <p className="mt-auto pt-4 text-[14px] font-medium text-ink-2">
          <span className="font-extrabold text-ink">{inr(em.gap)}</span> more to {targetMonths} months
        </p>
      )}
      <style>{`
        .wl-grow { transform-origin: left; animation: wl-grow 1s var(--spring) both; }
        @keyframes wl-grow { from { transform: scaleX(0) } to { transform: scaleX(1) } }
      `}</style>
    </Card>
  );
}
