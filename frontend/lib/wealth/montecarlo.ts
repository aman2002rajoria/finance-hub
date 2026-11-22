// Goal outcomes as a range, not a single line. Markets don't return 12%
// every year; this runs many paths and reports the spread and the odds.

import { normal, rng } from "./timeline";

/** Rough yearly volatility for a given expected return (debt ≈ calm, equity ≈ bumpy). */
export function volFor(expectedPct: number): number {
  if (expectedPct <= 7.5) return 2;
  if (expectedPct <= 10.5) return 9;
  return 16;
}

export interface Band { month: number; p10: number; p50: number; p90: number }

export interface Simulation {
  bands: Band[];             // one per month (thinned to <= 120 points)
  successPct: number;        // share of paths that reach the target by the date
  p10: number; p50: number; p90: number; // final values
}

/**
 * Monte Carlo of `pv` + `monthly` (stepping up yearly) over `months` at
 * `expectedPct` with volatility from volFor(). Deterministic per input.
 */
export function simulateGoal(o: {
  pv: number; monthly: number; expectedPct: number; months: number; target: number;
  stepUpPct?: number; paths?: number; seed?: number;
}): Simulation {
  const months = Math.max(1, Math.round(o.months));
  const paths = o.paths ?? 400;
  const vol = volFor(o.expectedPct) / 100;
  // lognormal monthly steps whose mean matches the expected return
  const mu = Math.log(1 + o.expectedPct / 100) / 12 - (vol * vol) / 24;
  const sig = vol / Math.sqrt(12);
  const r = rng(o.seed ?? Math.round(o.pv + o.monthly * 7 + o.months * 13 + o.target));
  const step = Math.max(1, Math.ceil(months / 120));
  const snaps: number[][] = [];
  const finals: number[] = [];
  let hits = 0;
  for (let p = 0; p < paths; p++) {
    let v = o.pv, m = o.monthly;
    const row: number[] = [];
    for (let i = 1; i <= months; i++) {
      v = v * Math.exp(mu + sig * normal(r)) + m;
      if (i % 12 === 0) m *= 1 + (o.stepUpPct ?? 0) / 100;
      if (i % step === 0 || i === months) row.push(v);
    }
    snaps.push(row);
    finals.push(v);
    if (v >= o.target) hits++;
  }
  const q = (xs: number[], k: number) => {
    const s = xs.slice().sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(k * s.length))];
  };
  const cols = snaps[0].length;
  const bands: Band[] = [{ month: 0, p10: o.pv, p50: o.pv, p90: o.pv }];
  for (let c = 0; c < cols; c++) {
    const col = snaps.map((row) => row[c]);
    bands.push({ month: Math.min(months, (c + 1) * step), p10: q(col, 0.1), p50: q(col, 0.5), p90: q(col, 0.9) });
  }
  return {
    bands,
    successPct: (hits / paths) * 100,
    p10: q(finals, 0.1), p50: q(finals, 0.5), p90: q(finals, 0.9),
  };
}
