/*
 * Odds, glide path and "when can the money come out" for the goals screen.
 * Built on lib/wealth's Monte Carlo. No React here.
 *
 * Every simulation for one goal uses the same seed, so moving a lever moves
 * the odds smoothly (common random numbers) instead of jittering.
 */

import {
  CLASS_OF, addMonths, monthsBetween, redeemInfo, simulateGoal,
  type Goal, type GoalStatus, type Holding, type Profile, type Simulation,
} from "@/lib/wealth";

/** The confidence planners aim for. Below this, a goal needs attention. */
export const SAFE_ODDS = 80;

export function seedFor(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return Math.abs(h) % 1_000_000 + 1;
}

export interface SimInput {
  id: string;
  current: number;
  monthly: number;      // all money going in each month (goal's own + linked SIPs)
  expectedReturn: number;
  months: number;
  target: number;
  step: number;
  paths?: number;
}

export function simulate(i: SimInput): Simulation {
  return simulateGoal({
    pv: i.current, monthly: i.monthly, expectedPct: i.expectedReturn, months: Math.max(1, i.months),
    target: i.target, stepUpPct: i.step, seed: seedFor(i.id), paths: i.paths,
  });
}

export const simInput = (g: Goal, s: GoalStatus, step: number): SimInput => ({
  id: g.id, current: s.current, monthly: s.monthly, expectedReturn: g.expectedReturn,
  months: s.months, target: s.target, step,
});

/**
 * Total monthly (stepping up yearly) that gives `odds`% odds, rounded up to
 * ₹100. `hint` (the straight-line amount needed) brackets the search.
 */
export function monthlyForOdds(i: SimInput, odds = SAFE_ODDS, hint = 0): number {
  // 250 paths is plenty to place the amount; the shown odds use the full run.
  const ok = (m: number) => simulate({ ...i, monthly: m, paths: 250 }).successPct >= odds;
  if (ok(0)) return 0;
  let lo = 0;
  let hi = Math.max(500, hint * 1.6, hint + 500);
  for (let k = 0; k < 14 && !ok(hi); k++) { lo = hi; hi *= 2; }
  if (hint > 0 && lo === 0) {
    const h = hint * 0.7;
    if (!ok(h)) lo = h; else hi = h;
  }
  for (let k = 0; k < 16 && hi - lo > Math.max(100, hi * 0.015); k++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) hi = mid; else lo = mid;
  }
  return Math.ceil(hi / 100) * 100;
}

export interface GoalOdds {
  sim: Simulation;
  pct: number;
  /** Total monthly for SAFE_ODDS; null when the goal is already there. */
  safeMonthly: number | null;
  /** Extra on top of today's monthly for SAFE_ODDS (0 when already there). */
  extra: number;
}

export function goalOdds(g: Goal, s: GoalStatus, step: number): GoalOdds {
  const input = simInput(g, s, step);
  const sim = simulate(input);
  if (s.current >= s.target || sim.successPct >= SAFE_ODDS) return { sim, pct: sim.successPct, safeMonthly: null, extra: 0 };
  const safeMonthly = monthlyForOdds(input, SAFE_ODDS, s.neededMonthly);
  return { sim, pct: sim.successPct, safeMonthly, extra: Math.max(100, safeMonthly - s.monthly) };
}

/* ------------------------------------------------------------ labels */

export type OddsTone = "success" | "neutral" | "warning" | "danger";

export function oddsTone(pct: number): OddsTone {
  return pct >= SAFE_ODDS ? "success" : pct >= 60 ? "neutral" : pct >= 35 ? "warning" : "danger";
}

export const ODDS_WORD: Record<OddsTone, string> = {
  success: "Likely",
  neutral: "Fair",
  warning: "Toss-up",
  danger: "At risk",
};

export const ODDS_TEXT: Record<OddsTone, string> = {
  success: "text-success-text",
  neutral: "text-ink",
  warning: "text-warning-text",
  danger: "text-danger-text",
};

export const oddsLabel = (pct: number) => (pct < 1 ? "<1%" : pct > 99 ? ">99%" : `${Math.round(pct)}%`);

/* --------------------------------------------------------- glide path */

/** Recommended equity share by months left: debt under 3 years, hybrid 3 to 7, equity beyond. */
export function equityFor(monthsLeft: number, retirement = false): number {
  const y = monthsLeft / 12;
  if (retirement) return y >= 10 ? 75 : y >= 7 ? 65 : y >= 5 ? 55 : y >= 3 ? 45 : 35;
  return y >= 10 ? 80 : y >= 7 ? 70 : y >= 5 ? 50 : y >= 3 ? 35 : y >= 1 ? 10 : 0;
}

export interface GlideStep { label: string; m: number; equity: number }

/** One bar per year (or per 2 / 5 years for long goals) from today to the date. */
export function glidePath(months: number, asOf: string, retirement: boolean): GlideStep[] {
  const years = Math.max(1, Math.ceil(months / 12));
  const every = years > 24 ? 4 : years > 12 ? 2 : 1;
  const out: GlideStep[] = [];
  for (let y = 0; y < years; y += every) {
    const m = y * 12;
    out.push({ label: addMonths(asOf, m).slice(0, 4), m, equity: equityFor(months - m, retirement) });
  }
  return out;
}

/** Equity share of the money linked to a goal today (money saved on its own counts as safe). */
export function equityNow(linked: Holding[], saved: number): number | null {
  const total = saved + linked.reduce((s, h) => s + h.current, 0);
  if (total <= 0) return null;
  const eq = linked.filter((h) => CLASS_OF[h.kind] === "equity").reduce((s, h) => s + h.current, 0);
  return (eq / total) * 100;
}

/* ------------------------------------------------ when can it come out */

export interface FreeUp {
  holding: Holding;
  /** First day the money can come out without a lock or penalty; null = today. */
  from: string | null;
  /** "lock" can't come out; "cost" can, at a price (FD break, exit load). */
  kind: "lock" | "cost" | "none";
  /** Frees up after the goal's date. */
  late: boolean;
  /** Short reason, for tooltips. */
  note: string;
  /** Equity money due within 2 years: a market dip could land on the date. */
  risky: boolean;
}

export function freeUps(goal: Goal, linked: Holding[], asOf: string, profile: Profile): FreeUp[] {
  const ageDate = (age: number) => addMonths(asOf, Math.round((age - profile.age) * 12));
  const monthsLeft = monthsBetween(asOf, goal.targetDate);
  return linked.map((h) => {
    const r = redeemInfo(h, asOf);
    let from = r.from;
    let kind: FreeUp["kind"] = !from ? "none" : r.now ? "cost" : "lock";
    if (h.kind === "epf") { from = ageDate(profile.retireAge); kind = "lock"; }
    if (h.kind === "nps") { from = ageDate(60); kind = "lock"; }
    const late = !!from && from > goal.targetDate && goal.kind !== "retirement";
    const risky = CLASS_OF[h.kind] === "equity" && monthsLeft < 24 && goal.kind !== "retirement";
    return { holding: h, from, kind, late, note: r.note, risky };
  });
}
