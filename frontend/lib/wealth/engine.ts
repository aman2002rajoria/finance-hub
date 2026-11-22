// Pure maths for the wealth and goals screens. No React, no storage.
// Rates are % a year; months are calendar months; all money is ₹.

import type {
  AssetClass, Flow, Goal, Holding, HoldingKind, IncomeEvent, Liability, Profile,
} from "./types";

/* ---------------------------------------------------------------- dates */

export const todayISO = () => new Date().toISOString().slice(0, 10);

export function monthsBetween(fromISO: string, toISO: string): number {
  const a = new Date(fromISO), b = new Date(toISO);
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) + (b.getDate() - a.getDate()) / 30;
}

export function addMonths(iso: string, n: number): string {
  const d = new Date(iso);
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 10);
}

export const monthKey = (iso: string) => iso.slice(0, 7);

/* --------------------------------------------------------- compounding */

const monthlyRate = (annualPct: number) => Math.pow(1 + annualPct / 100, 1 / 12) - 1;

/** Future value of `pv` plus `monthly` contributions for `months`, with a yearly step-up. */
export function futureValue(pv: number, monthly: number, annualPct: number, months: number, stepUpPct = 0): number {
  const r = monthlyRate(annualPct);
  let v = pv, m = monthly;
  const n = Math.max(0, Math.round(months));
  for (let i = 1; i <= n; i++) {
    v = v * (1 + r) + m;
    if (i % 12 === 0) m *= 1 + stepUpPct / 100;
  }
  return v;
}

/** Monthly amount needed to reach `target` from `pv` in `months` (no step-up). */
export function requiredMonthly(target: number, pv: number, annualPct: number, months: number): number {
  const n = Math.max(1, Math.round(months));
  const r = monthlyRate(annualPct);
  const grown = pv * Math.pow(1 + r, n);
  if (grown >= target) return 0;
  if (r === 0) return (target - grown) / n;
  return ((target - grown) * r) / (Math.pow(1 + r, n) - 1);
}

/** Starting monthly amount (raised by stepUpPct every year) that reaches target. */
export function requiredMonthlyStepped(target: number, pv: number, annualPct: number, months: number, stepUpPct: number): number {
  if (stepUpPct <= 0) return requiredMonthly(target, pv, annualPct, months);
  if (futureValue(pv, 0, annualPct, months) >= target) return 0;
  let lo = 0, hi = Math.max(1, target);
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (futureValue(pv, mid, annualPct, months, stepUpPct) >= target) hi = mid; else lo = mid;
  }
  return hi;
}

/** Months until pv + monthly reaches target, or null if not within 50 years. */
export function monthsToReach(target: number, pv: number, monthly: number, annualPct: number, stepUpPct = 0): number | null {
  const r = monthlyRate(annualPct);
  let v = pv, m = monthly;
  for (let i = 0; i <= 600; i++) {
    if (v >= target) return i;
    v = v * (1 + r) + m;
    if ((i + 1) % 12 === 0) m *= 1 + stepUpPct / 100;
  }
  return null;
}

export const inflate = (amount: number, inflationPct: number, months: number) =>
  amount * Math.pow(1 + inflationPct / 100, Math.max(0, months) / 12);

/* ----------------------------------------------------------------- XIRR */

/** Annualised return (%) of flows (+ = invested) against a value today. */
export function xirr(flows: Flow[], currentValue: number, asOf = todayISO()): number | null {
  if (!flows.length || currentValue <= 0) return null;
  const t0 = new Date(asOf).getTime();
  const cf = flows.map((f) => ({ t: (t0 - new Date(f.date).getTime()) / (365.25 * 864e5), a: -f.amount }));
  cf.push({ t: 0, a: currentValue });
  const npv = (rate: number) => cf.reduce((s, c) => s + c.a * Math.pow(1 + rate, c.t), 0);
  let lo = -0.99, hi = 5;
  if (npv(lo) * npv(hi) > 0) return null;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid; else lo = mid;
  }
  // npv uses (1+r)^t for money in the past, so the root is the return.
  return ((lo + hi) / 2) * 100;
}

export function holdingFlows(h: Holding): Flow[] {
  return h.flows?.length ? h.flows : [{ date: h.startDate, amount: h.invested }];
}

export function holdingXirr(h: Holding): number | null {
  // Coupon bonds pay interest out, so their value doesn't grow: show the coupon.
  if (h.kind === "bonds" && h.rate != null) return h.rate;
  // Very new money gives silly annualised numbers; don't show them.
  if (monthsBetween(h.startDate, h.asOf) < 6) return null;
  return xirr(holdingFlows(h), h.current, h.asOf);
}

export function portfolioXirr(holdings: Holding[]): number | null {
  const hs = holdings.filter((h) => h.current > 0);
  if (!hs.length) return null;
  const asOf = hs.map((h) => h.asOf).sort().at(-1)!;
  return xirr(hs.flatMap(holdingFlows), hs.reduce((s, h) => s + h.current, 0), asOf);
}

/* --------------------------------------------------- returns & classes */

export const DEFAULT_RETURN: Record<HoldingKind, number> = {
  equity_mf: 12, elss: 12, stocks: 12, nps: 10,
  debt_mf: 7, liquid_mf: 6.5, fd: 7, bonds: 7.5, ppf: 7.1, epf: 8.25,
  gold: 8, other: 6,
};

export const expectedReturn = (h: Holding) => h.rate ?? DEFAULT_RETURN[h.kind];

export const CLASS_OF: Record<HoldingKind, AssetClass> = {
  equity_mf: "equity", elss: "equity", stocks: "equity", nps: "equity",
  debt_mf: "debt", liquid_mf: "debt", fd: "debt", bonds: "debt", ppf: "debt", epf: "debt",
  gold: "gold", other: "other",
};

/** Suggested return for goal money by how far away the goal is. */
export function suggestedReturn(months: number): number {
  if (months < 36) return 7;   // debt / liquid
  if (months < 84) return 10;  // hybrid
  return 12;                   // equity
}

export function horizonOf(months: number): "short" | "medium" | "long" {
  return months < 36 ? "short" : months < 84 ? "medium" : "long";
}
export const HORIZON_LABEL = { short: "Under 3 years", medium: "3 to 7 years", long: "7 years or more" } as const;

/* ------------------------------------------------------------ totals */

export interface Totals {
  cash: number;
  investments: number;
  invested: number;
  gain: number;
  gainPct: number;
  liabilities: number;
  netWorth: number;
  sipMonthly: number;      // all recurring contributions
  sipFromBank: number;     // excluding payroll-deducted EPF (what statements see)
  emiMonthly: number;
}

export function totals(cash: number, holdings: Holding[], liabilities: Liability[]): Totals {
  const investments = sum(holdings, (h) => h.current);
  const invested = sum(holdings, (h) => h.invested);
  const liab = sum(liabilities, (l) => l.outstanding);
  return {
    cash,
    investments,
    invested,
    gain: investments - invested,
    gainPct: invested > 0 ? ((investments - invested) / invested) * 100 : 0,
    liabilities: liab,
    netWorth: cash + investments - liab,
    sipMonthly: sum(holdings, (h) => h.sipMonthly ?? 0),
    sipFromBank: sum(holdings.filter((h) => h.kind !== "epf"), (h) => h.sipMonthly ?? 0),
    emiMonthly: sum(liabilities, (l) => l.emi ?? 0),
  };
}

export interface Slice { key: AssetClass; value: number; pct: number }

export function allocation(cash: number, holdings: Holding[]): Slice[] {
  const by: Record<AssetClass, number> = { equity: 0, debt: 0, gold: 0, cash, other: 0 };
  for (const h of holdings) by[CLASS_OF[h.kind]] += h.current;
  const total = Object.values(by).reduce((a, b) => a + b, 0) || 1;
  return (Object.keys(by) as AssetClass[])
    .map((k) => ({ key: k, value: by[k], pct: (by[k] / total) * 100 }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value);
}

/** Equity share of investments (cash excluded) and the age-based target. */
export function equityMix(holdings: Holding[], profile: Profile) {
  // Long-term money only: the emergency fund is meant to sit in debt.
  const longTerm = holdings.filter((h) => !h.isEmergency);
  const inv = sum(longTerm, (h) => h.current) || 1;
  const eq = sum(longTerm.filter((h) => CLASS_OF[h.kind] === "equity"), (h) => h.current);
  const target = profile.targetEquityPct ?? clamp(100 - profile.age, 40, 80);
  return { equityPct: (eq / inv) * 100, targetPct: target };
}

/* -------------------------------------------------------- emergency */

export function emergency(cash: number, holdings: Holding[], monthlyExpenses: number, targetMonths: number) {
  const earmarked = sum(holdings.filter((h) => h.isEmergency), (h) => h.current);
  // Count at most one month of spending from the bank as "emergency" cash;
  // the rest of the bank balance is working money.
  const fromBank = Math.min(cash, monthlyExpenses);
  const have = earmarked + fromBank;
  const target = monthlyExpenses * targetMonths;
  return {
    have,
    earmarked,
    fromBank,
    target,
    months: monthlyExpenses > 0 ? have / monthlyExpenses : 0,
    gap: Math.max(0, target - have),
  };
}

/* ---------------------------------------------------- passive income */

export function passiveIncome(events: IncomeEvent[], months = 12, asOf = todayISO()) {
  const from = addMonths(asOf, -months);
  const recent = events.filter((e) => e.date > from && e.date <= asOf);
  const byKind = { dividend: 0, interest: 0, realised_gain: 0 };
  for (const e of recent) byKind[e.kind] += e.amount;
  const byMonth = new Map<string, { dividend: number; interest: number; realised_gain: number }>();
  for (let i = months - 1; i >= 0; i--) byMonth.set(monthKey(addMonths(asOf, -i)), { dividend: 0, interest: 0, realised_gain: 0 });
  for (const e of recent) {
    const m = byMonth.get(monthKey(e.date));
    if (m) m[e.kind] += e.amount;
  }
  const total = byKind.dividend + byKind.interest + byKind.realised_gain;
  return {
    total,
    monthlyAvg: total / months,
    byKind,
    series: Array.from(byMonth.entries()).map(([month, v]) => ({ month, ...v })),
  };
}

/* -------------------------------------------------- can I redeem it? */

export interface RedeemInfo {
  now: boolean;
  from: string | null;   // date it frees up
  note: string;          // one plain sentence
  tax: string;           // one plain sentence
}

export function redeemInfo(h: Holding, asOf = todayISO()): RedeemInfo {
  const heldMonths = monthsBetween(h.startDate, asOf);
  const lock = h.lockInUntil && h.lockInUntil > asOf ? h.lockInUntil : null;
  const eqTax = heldMonths >= 12
    ? "Gains over ₹1.25 lakh a year are taxed at 12.5%."
    : "Sold within a year, gains are taxed at 20%.";
  switch (h.kind) {
    case "elss":
      return lock
        ? { now: false, from: lock, note: "Locked for 3 years from each purchase.", tax: "Gains over ₹1.25 lakh a year are taxed at 12.5% once it frees up." }
        : { now: true, from: null, note: "Lock-in is over.", tax: eqTax };
    case "equity_mf":
      return heldMonths < 12
        ? { now: true, from: addMonths(h.startDate, 12), note: "Can sell now, but most funds charge 1% exit load in the first year.", tax: eqTax }
        : { now: true, from: null, note: "Can sell any day; money lands in 2 to 3 working days.", tax: eqTax };
    case "stocks":
      return { now: true, from: null, note: "Can sell on any market day.", tax: eqTax };
    case "liquid_mf":
      return { now: true, from: null, note: "Up to ₹50,000 can come back the same day.", tax: "Gains are added to your income and taxed at your slab." };
    case "debt_mf":
      return { now: true, from: null, note: "Can sell any day; money lands next working day.", tax: "Gains are added to your income and taxed at your slab." };
    case "fd":
      return h.maturityDate && h.maturityDate > asOf
        ? { now: true, from: h.maturityDate, note: "Breaking it early usually costs about 1% of the interest rate.", tax: "Interest is taxed at your slab every year, even before it pays out." }
        : { now: true, from: null, note: "Matured.", tax: "Interest is taxed at your slab." };
    case "bonds":
      return h.maturityDate && h.maturityDate > asOf
        ? { now: false, from: h.maturityDate, note: "Pays back on maturity; selling early depends on finding a buyer.", tax: "Interest is taxed at your slab." }
        : { now: true, from: null, note: "Matured.", tax: "Interest is taxed at your slab." };
    case "ppf":
      return lock
        ? { now: false, from: lock, note: "Partial withdrawals open from the 7th year; full payout after 15.", tax: "Tax free." }
        : { now: true, from: null, note: "Can be withdrawn or extended in 5-year blocks.", tax: "Tax free." };
    case "epf":
      return { now: false, from: null, note: "Paid at retirement, or after 2 months out of work. Some advances allowed (home, illness).", tax: "Tax free after 5 years of service." };
    case "nps":
      return { now: false, from: null, note: "Locked until 60; then 60% can come out, 40% buys a pension.", tax: "The 60% lump sum is tax free." };
    case "gold":
      return lock
        ? { now: false, from: lock, note: "Sovereign gold bonds can be redeemed from the 5th year.", tax: "Tax free if held to maturity." }
        : { now: true, from: null, note: "Can sell any day.", tax: "Gains after 2 years are taxed at 12.5%." };
    default:
      return { now: true, from: null, note: "", tax: "" };
  }
}

/* ----------------------------------------------------------- goals */

export interface GoalStatus {
  months: number;
  horizon: "short" | "medium" | "long";
  target: number;          // inflated to the target date
  current: number;         // saved + linked holdings
  projected: number;       // where current + monthly gets you by then
  pct: number;             // current / target
  projectedPct: number;
  status: "done" | "on_track" | "close" | "behind";
  monthly: number;         // goal's own monthly + linked SIPs
  neededMonthly: number;   // to hit target on time with current savings
  extraMonthly: number;    // needed - monthly
  eta: string | null;      // when you'd actually get there at this pace
  linked: Holding[];
}

/** stepUpPct: yearly raise applied to the monthly amount (the profile's SIP step-up). */
export function goalStatus(g: Goal, holdings: Holding[], asOf = todayISO(), stepUpPct = 0): GoalStatus {
  const months = Math.max(0, monthsBetween(asOf, g.targetDate));
  const linked = holdings.filter((h) => h.goalId === g.id);
  const current = g.saved + sum(linked, (h) => h.current);
  const target = inflate(g.targetToday, g.inflation, months);
  // Linked holdings' SIPs count towards the goal too.
  const monthly = g.monthly + sum(linked, (h) => h.sipMonthly ?? 0);
  const projected = futureValue(current, monthly, g.expectedReturn, months, stepUpPct);
  const neededMonthly = requiredMonthlyStepped(target, current, g.expectedReturn, months, stepUpPct);
  const toReach = monthsToReach(target, current, monthly, g.expectedReturn, stepUpPct);
  const pPct = target > 0 ? projected / target : 1;
  // Within 1% of the target counts as on track: a few hundred rupees short
  // two years out is noise, not a problem.
  const status: GoalStatus["status"] =
    current >= target ? "done" : pPct >= 0.99 ? "on_track" : pPct >= 0.85 ? "close" : "behind";
  return {
    months,
    horizon: horizonOf(months),
    target,
    current,
    projected,
    pct: target > 0 ? current / target : 1,
    projectedPct: pPct,
    status,
    neededMonthly,
    monthly,
    extraMonthly: Math.max(0, neededMonthly - monthly),
    eta: toReach == null ? null : addMonths(asOf, toReach),
    linked,
  };
}

export const STATUS_LABEL: Record<GoalStatus["status"], string> = {
  done: "Done",
  on_track: "On track",
  close: "Slightly behind",
  behind: "Behind",
};

/* ---------------------------------------------- net worth projection */

export interface ProjectionPoint { year: number; age: number; netWorth: number; withoutGoals: number }

/**
 * Year-by-year net worth from today to retirement.
 * Investments grow at their own expected return with SIPs stepping up yearly;
 * cash stays flat; debts run down by their EMI; goals are paid out of the
 * pot on their date (that's the "impact on net worth").
 */
export function projectNetWorth(opts: {
  cash: number;
  holdings: Holding[];
  liabilities: Liability[];
  goals: Goal[];
  profile: Profile;
  extraMonthly?: number;   // e.g. a new goal's SIP, or more saving
  asOf?: string;
}): ProjectionPoint[] {
  const { cash, holdings, liabilities, goals, profile, extraMonthly = 0, asOf = todayISO() } = opts;
  const years = Math.max(1, profile.retireAge - profile.age);
  const startYear = new Date(asOf).getFullYear();
  const step = profile.sipStepUpPct;

  // One pot per holding, plus one pot for goal SIPs not tied to a holding.
  const pots = holdings.map((h) => ({ v: h.current, m: h.sipMonthly ?? 0, r: monthlyRate(expectedReturn(h)) }));
  // One pot per goal: its monthly stops once the goal's date arrives
  // (retirement keeps going). Plus a pot for any extra monthly saving.
  const goalRate = monthlyRate(10);
  const goalPots = goals.map((g) => ({
    // g.saved is money already in the bank, so it's in `cash`: start at 0.
    v: 0, m: g.monthly, r: goalRate,
    end: g.kind === "retirement" ? Infinity : Math.round(Math.max(0, monthsBetween(asOf, g.targetDate))),
  }));
  const extraPot = { v: 0, m: extraMonthly, r: goalRate, end: Infinity };
  const goalPot = { r: goalRate };
  let debt = sum(liabilities, (l) => l.outstanding);
  const emi = sum(liabilities, (l) => l.emi ?? 0);

  // Emergency and retirement money is kept, not spent on the day, so only
  // the other goals leave the pot.
  const payouts = goals.filter((g) => g.kind !== "emergency" && g.kind !== "retirement").map((g) => {
    const m = Math.max(0, monthsBetween(asOf, g.targetDate));
    return { atMonth: Math.round(m), amount: inflate(g.targetToday, g.inflation, m) };
  });

  const out: ProjectionPoint[] = [];
  let paidOut = 0;
  const all = [...pots.map((p) => ({ ...p, end: Infinity })), ...goalPots, extraPot];
  for (let mo = 0; mo <= years * 12; mo++) {
    if (mo > 0) {
      for (const p of all) {
        p.v = p.v * (1 + p.r) + (mo <= p.end ? p.m : 0);
        if (mo % 12 === 0) p.m *= 1 + step / 100;
      }
      debt = Math.max(0, debt - emi);
      // Money spent on a goal also stops growing: carry it at the goal pot's rate.
      paidOut *= 1 + goalPot.r;
      for (const po of payouts) if (po.atMonth === mo) paidOut += po.amount;
    }
    if (mo % 12 === 0) {
      const gross = cash + all.reduce((s, p) => s + p.v, 0) - debt;
      out.push({ year: startYear + mo / 12, age: profile.age + mo / 12, netWorth: gross - paidOut, withoutGoals: gross });
    }
  }
  return out;
}

/** Corpus needed to retire: 25× yearly spending at retirement (the 4% rule). */
export function fiNumber(monthlyExpenses: number, profile: Profile, inflationPct = 6) {
  const months = (profile.retireAge - profile.age) * 12;
  return inflate(monthlyExpenses * 12, inflationPct, months) * 25;
}

/* ---------------------------------------------------- health checks */

export interface Check { key: string; label: string; ok: boolean | null; detail: string }

export function healthChecks(o: {
  emergencyMonths: number;
  emergencyTarget: number;
  savingsRatePct: number | null;
  investRatePct: number | null;
  equityPct: number;
  targetEquityPct: number;
  liabilities: Liability[];
  profile: Profile;
  annualIncome: number;
}): Check[] {
  const ccDebt = o.liabilities.filter((l) => l.kind === "credit_card" && (l.rate ?? 0) > 0);
  const termNeed = o.annualIncome * 10;
  return [
    {
      key: "emergency",
      label: "Emergency fund",
      ok: o.emergencyMonths >= o.emergencyTarget,
      detail: `${o.emergencyMonths.toFixed(1)} of ${o.emergencyTarget} months of spending set aside.`,
    },
    {
      key: "savings",
      label: "Savings rate",
      ok: o.savingsRatePct == null ? null : o.savingsRatePct >= 20,
      detail: o.savingsRatePct == null ? "Needs statements." : `You keep ${Math.round(o.savingsRatePct)}% of income. 20% or more is healthy.`,
    },
    {
      key: "invest",
      label: "Investing every month",
      ok: o.investRatePct == null ? null : o.investRatePct >= 15,
      detail: o.investRatePct == null ? "Needs statements." : `SIPs are ${Math.round(o.investRatePct)}% of income. 15% or more builds wealth in your 20s and 30s.`,
    },
    {
      key: "mix",
      label: "Equity mix",
      ok: Math.abs(o.equityPct - o.targetEquityPct) <= 10,
      detail: `${Math.round(o.equityPct)}% in equity against about ${Math.round(o.targetEquityPct)}% for your age.`,
    },
    {
      key: "debt",
      label: "No costly debt",
      ok: ccDebt.length === 0,
      detail: ccDebt.length ? "A card balance is being carried at card interest. Clear it first." : "No card balance carried over.",
    },
    {
      key: "term",
      label: "Life cover",
      ok: o.profile.termCover == null ? null : o.profile.termCover >= termNeed,
      detail: o.profile.termCover == null
        ? "Add your term cover in Settings."
        : `₹${fmtL(o.profile.termCover)} cover against about ₹${fmtL(termNeed)} (10× income).`,
    },
    {
      key: "health",
      label: "Health cover",
      ok: o.profile.healthCover == null ? null : o.profile.healthCover >= 500000,
      detail: o.profile.healthCover == null
        ? "Add your health insurance in Settings."
        : `₹${fmtL(o.profile.healthCover)} cover. ₹5 lakh or more is a sensible floor.`,
    },
  ];
}

/* ---------------------------------------------------------- helpers */

export function sum<T>(xs: T[], f: (x: T) => number): number {
  let s = 0;
  for (const x of xs) s += f(x) || 0;
  return s;
}
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
function fmtL(n: number) {
  return n >= 1e7 ? `${(n / 1e7).toFixed(1).replace(/\.0$/, "")} crore` : `${Math.round(n / 1e5)} lakh`;
}
