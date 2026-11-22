/*
 * Wealth-screen maths that lib/wealth doesn't have: the equity share of
 * long-term money (emergency fund left out, with and without EPF/PPF), and
 * ELSS lots, each freeing three years after it was bought.
 */

import { CLASS_OF, addMonths, holdingFlows, xirr, type AssetClass, type Check, type Holding } from "@/lib/wealth";

export interface LongTermMix {
  /** Long-term money: every holding except the emergency fund. */
  total: number;
  equity: number;
  equityPct: number;
  /** Same, leaving out EPF and PPF (retirement money you can't steer). */
  totalExRetire: number;
  equityPctExRetire: number;
  emergency: number;
  retire: number;
  parts: { key: AssetClass; pct: number }[];
  partsExRetire: { key: AssetClass; pct: number }[];
}

const ORDER: AssetClass[] = ["equity", "debt", "gold", "other"];

function split(hs: Holding[]) {
  const by: Record<AssetClass, number> = { equity: 0, debt: 0, gold: 0, cash: 0, other: 0 };
  for (const h of hs) by[CLASS_OF[h.kind]] += h.current;
  const total = ORDER.reduce((s, k) => s + by[k], 0);
  return { total, equity: by.equity, parts: ORDER.map((k) => ({ key: k, pct: total > 0 ? (by[k] / total) * 100 : 0 })) };
}

export function longTermMix(holdings: Holding[]): LongTermMix {
  const lt = holdings.filter((h) => !h.isEmergency);
  const exR = lt.filter((h) => h.kind !== "epf" && h.kind !== "ppf");
  const a = split(lt), b = split(exR);
  return {
    total: a.total,
    equity: a.equity,
    equityPct: a.total > 0 ? (a.equity / a.total) * 100 : 0,
    totalExRetire: b.total,
    equityPctExRetire: b.total > 0 ? (b.equity / b.total) * 100 : 0,
    emergency: holdings.filter((h) => h.isEmergency).reduce((s, h) => s + h.current, 0),
    retire: lt.filter((h) => h.kind === "epf" || h.kind === "ppf").reduce((s, h) => s + h.current, 0),
    parts: a.parts,
    partsExRetire: b.parts,
  };
}

/** The health check's equity line, on the same long-term money the allocation card uses. */
export function mixCheck(c: Check, mix: LongTermMix, targetPct: number): Check {
  if (c.key !== "mix" || mix.total <= 0) return c;
  return {
    ...c,
    ok: Math.abs(mix.equityPct - targetPct) <= 10,
    detail: `${Math.round(mix.equityPct)}% equity in long-term money against ${Math.round(targetPct)}% target.`,
  };
}

/* ------------------------------------------------------------ ELSS lots */

export interface Lot { bought: string; frees: string; put: number; value: number }

/** One lot per ELSS purchase, each locked for 3 years; today's value split by growth since each buy. */
export function elssLots(h: Holding): Lot[] {
  if (h.kind !== "elss") return [];
  const flows = holdingFlows(h).filter((f) => f.amount > 0).sort((a, b) => a.date.localeCompare(b.date));
  if (!flows.length) return [];
  const rate = (xirr(flows, h.current, h.asOf) ?? 0) / 100;
  const yrs = (d: string) => (Date.parse(h.asOf) - Date.parse(d)) / (365.25 * 864e5);
  const raw = flows.map((f) => f.amount * Math.pow(1 + rate, Math.max(0, yrs(f.date))));
  const sum = raw.reduce((s, v) => s + v, 0) || 1;
  return flows.map((f, i) => ({
    bought: f.date,
    frees: addMonths(f.date, 36),
    put: f.amount,
    value: Math.round((raw[i] / sum) * h.current),
  }));
}
