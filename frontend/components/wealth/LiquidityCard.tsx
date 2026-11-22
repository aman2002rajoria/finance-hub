"use client";

/*
 * What can I touch? One split bar (reachable this week vs locked), then a
 * timeline of when locked money frees up. Time is linear, with one marked
 * break: the next 3 years get most of the width, the far years (PPF, EPF)
 * sit after the break. ELSS shows each purchase as its own lot, freeing
 * 3 years after it was bought.
 */

import clsx from "clsx";

import { Card, CardTitle } from "@/components/ui";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { KIND_EMOJI, monthsBetween, redeemInfo, type Holding, type Profile } from "@/lib/wealth";

import { shortInr } from "./chartKit";
import { elssLots } from "./mix";
import { monYear, shortName } from "./words";

interface Row { key: string; h: Holding; name: string; value: number; until: string; label: string; breakable: boolean }

const NEAR = 36;      // months shown on the near scale
const NEAR_W = 62;    // % of the width they get
const GAP = 5;        // % for the break

export default function LiquidityCard({
  cash, holdings, asOf, profile,
}: {
  cash: number; holdings: Holding[]; asOf: string; profile: Profile;
}) {
  const reduced = usePrefersReducedMotion();
  const retire = `${Number(asOf.slice(0, 4)) + Math.max(1, profile.retireAge - profile.age)}${asOf.slice(4)}`;

  let now = Math.max(0, cash);
  const rows: Row[] = [];
  for (const h of holdings) {
    const r = redeemInfo(h, asOf);
    const base = { h, name: shortName(h.name), value: h.current };
    if (h.kind === "elss") {
      const lots = elssLots(h);
      const locked = lots.filter((l) => l.frees > asOf);
      for (const l of lots) if (l.frees <= asOf) now += l.value;
      locked.forEach((l, i) => rows.push({
        ...base, key: `${h.id}-${i}`, value: l.value, until: l.frees, label: monYear(l.frees), breakable: false,
        name: locked.length > 1 ? `ELSS lot ${lots.indexOf(l) + 1}` : shortName(h.name),
      }));
      if (!lots.length) now += h.current;
    } else if (h.kind === "epf" || h.kind === "nps") {
      rows.push({ ...base, key: h.id, until: retire, label: `At ${h.kind === "nps" ? 60 : profile.retireAge}`, breakable: false });
    } else if (h.kind === "fd" && r.from) {
      rows.push({ ...base, key: h.id, until: r.from, label: monYear(r.from), breakable: true });
    } else if (!r.now && r.from) {
      rows.push({ ...base, key: h.id, until: r.from, label: monYear(r.from), breakable: false });
    } else {
      now += h.current;
    }
  }
  rows.sort((a, b) => a.until.localeCompare(b.until));
  const locked = rows.reduce((s, r) => s + r.value, 0);
  const total = now + locked || 1;

  const maxM = Math.max(12, ...rows.map((r) => monthsBetween(asOf, r.until)));
  const broken = maxM > NEAR + 12;
  const pos = (iso: string) => {
    const m = Math.max(0, monthsBetween(asOf, iso));
    if (!broken) return (m / maxM) * 100;
    if (m <= NEAR) return (m / NEAR) * NEAR_W;
    return NEAR_W + GAP + ((m - NEAR) / (maxM - NEAR)) * (100 - NEAR_W - GAP);
  };
  // Ticks: each January on the near scale, then the far rows' years.
  const ticks: { label: string; at: number }[] = [];
  const startY = Number(asOf.slice(0, 4)) + 1;
  for (let y = startY; monthsBetween(asOf, `${y}-01-01`) <= (broken ? NEAR : maxM); y++) {
    const at = pos(`${y}-01-01`);
    if (at >= 10) ticks.push({ label: String(y), at });
  }
  if (broken) {
    for (const y of Array.from(new Set(rows.filter((r) => monthsBetween(asOf, r.until) > NEAR).map((r) => r.until.slice(0, 4))))) {
      const at = pos(`${y}-${rows.find((r) => r.until.startsWith(y))!.until.slice(5)}`);
      if (!ticks.length || at - ticks[ticks.length - 1].at >= 9) ticks.push({ label: y, at });
    }
  }

  return (
    <Card className="flex h-full flex-col">
      <CardTitle>{shortInr(now)} you can reach this week</CardTitle>

      <div className="mt-4 flex h-3 w-full gap-[3px] overflow-hidden rounded-[10px]" aria-hidden>
        <span className={clsx("h-full bg-accent-500", !reduced && "lq-grow")} style={{ width: `${(now / total) * 100}%` }} />
        <span className="h-full flex-1 bg-surface-2" />
      </div>
      <div className="mt-1.5 flex justify-between text-[13px] font-medium tabular-nums text-muted">
        <span>💧 Bank + sellable <span className="font-semibold text-ink">{shortInr(now)}</span></span>
        <span>🔒 Locked <span className="font-semibold text-ink">{shortInr(locked)}</span></span>
      </div>

      {rows.length > 0 && (
        <div className="mt-5">
          <ul className="space-y-1.5">
            {rows.map((r, i) => (
              <li key={r.key} className="flex items-center gap-2" title={`${r.h.name}: ${shortInr(r.value)}, frees up ${r.label}${r.breakable ? " (can break early)" : ""}`}>
                <span className="flex w-[34%] min-w-0 items-center gap-1.5 sm:w-[200px]">
                  <span aria-hidden className="text-[14px]">{KIND_EMOJI[r.h.kind]}</span>
                  <span className="truncate text-[13px] font-semibold text-ink-2">{r.name}</span>
                </span>
                <span className="relative h-5 min-w-0 flex-1">
                  <span
                    className={clsx(
                      "absolute inset-y-[5px] left-0 rounded-[6px]",
                      r.breakable ? "bg-[repeating-linear-gradient(90deg,var(--surface-2)_0_6px,transparent_6px_9px)]" : "bg-surface-2",
                      !reduced && "lq-grow",
                    )}
                    style={{ width: `${pos(r.until)}%`, animationDelay: `${200 + i * 50}ms` }}
                  />
                  {broken && pos(r.until) > NEAR_W && (
                    <span aria-hidden className="absolute inset-y-0 bg-card" style={{ left: `${NEAR_W + 1}%`, width: `${GAP - 2}%` }} />
                  )}
                  <span
                    aria-hidden
                    className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent-500 shadow-[0_0_0_2px_var(--card)]"
                    style={{ left: `${pos(r.until)}%` }}
                  />
                </span>
                <span className="w-[64px] shrink-0 text-right text-[12px] font-semibold tabular-nums text-ink-2">{r.label}</span>
                <span className="hidden w-[52px] shrink-0 text-right text-[13px] font-extrabold tabular-nums text-ink sm:block">{shortInr(r.value)}</span>
              </li>
            ))}
          </ul>
          <div className="relative ml-[calc(34%+8px)] mr-[72px] mt-2 h-4 sm:ml-[208px] sm:mr-[132px]" aria-hidden>
            <span className="absolute left-0 text-[11px] font-semibold text-muted">Now</span>
            {ticks.map((t, i) => (
              <span
                key={t.label}
                className={clsx("absolute -translate-x-1/2 text-[11px] font-medium tabular-nums text-faint", i < ticks.length - 1 && "hidden sm:block")}
                style={{ left: `${t.at}%` }}
              >
                {t.label}
              </span>
            ))}
            {broken && (
              <span className="absolute -translate-x-1/2 text-[12px] font-bold text-muted" style={{ left: `${NEAR_W + GAP / 2}%` }} title="Axis break: the years after this are squeezed">
                ≈
              </span>
            )}
          </div>
        </div>
      )}
      <style>{`
        .lq-grow { transform-origin: left; animation: lq-grow .9s var(--spring) both; }
        @keyframes lq-grow { from { transform: scaleX(0) } to { transform: scaleX(1) } }
      `}</style>
    </Card>
  );
}
