/*
 * Goals screen logic on top of lib/wealth: the monthly surplus, goal
 * colours, which goal to fund first, emoji defaults, the add-a-goal
 * what-if and the starter templates. No React here.
 */

import {
  GOAL_EMOJI, addMonths, goalStatus, inflate, monthsBetween, projectNetWorth,
  requiredMonthlyStepped, suggestedReturn,
  type Goal, type GoalKind, type GoalStatus, type WealthView,
} from "@/lib/wealth";
import { CHART_SERIES } from "@/lib/chart-theme";

import { SAFE_ODDS, simulate, type GoalOdds } from "./odds";

export type GoalRow = { goal: Goal; status: GoalStatus };
export type OddsRow = GoalRow & { odds: GoalOdds };

/* ------------------------------------------------------------ colours */

// Every series colour except the accent green, which means "free money".
const GOAL_COLORS = CHART_SERIES.filter((_, i) => i !== 1);

/** One stable colour per goal, in date order, shared by the plan bar, cards and charts. */
export function goalColors(rows: GoalRow[]): Map<string, string> {
  return new Map(rows.map((r, i) => [r.goal.id, GOAL_COLORS[i % GOAL_COLORS.length]]));
}

/* ---------------------------------------------------- monthly money */

export interface MonthlyPlan {
  /** What's left after living costs and SIPs that already leave the bank. Null when unknown. */
  surplus: number | null;
  /** Goals' own monthly amounts (money that has to come out of the surplus). */
  committed: number;
  free: number | null;
  /** Linked SIPs and EPF that already run before the surplus. */
  linkedSips: number;
}

export function monthlyPlan(view: WealthView): MonthlyPlan {
  const committed = view.goals.reduce((s, r) => s + r.goal.monthly, 0);
  const linkedSips = view.goals.reduce((s, r) => s + (r.status.monthly - r.goal.monthly), 0);
  // The usual month (medians), so a bonus or a big one-off doesn't move it.
  const surplus = view.usual.income > 0 ? view.usual.surplus : null;
  return { surplus, committed, free: surplus == null ? null : surplus - committed, linkedSips };
}

/** Own monthly money (not linked SIPs) every goal needs for SAFE_ODDS, and the gap to the surplus. */
export function safePlan(rows: OddsRow[], plan: MonthlyPlan) {
  const total = rows.reduce((s, r) => s + r.goal.monthly + r.odds.extra, 0);
  const short = plan.surplus == null ? null : Math.max(0, total - plan.surplus);
  return { total, short };
}

/* ------------------------------------------------- fund this first */

export interface FundStep { row: OddsRow; add: number; oddsAfter: number }

/**
 * Where the free money should go: emergency fund first, then must-haves,
 * then the nearest dates, each topped up to SAFE_ODDS until it runs out.
 */
export function fundFirst(rows: OddsRow[], free: number, step: number): FundStep[] {
  const order = rows
    .filter((r) => r.odds.extra > 0)
    .sort((a, b) => rank(a) - rank(b) || a.goal.targetDate.localeCompare(b.goal.targetDate));
  let left = Math.floor(free / 100) * 100;
  const out: FundStep[] = [];
  for (const r of order) {
    if (left < 100) break;
    const add = Math.min(left, r.odds.extra);
    left -= add;
    const oddsAfter = add >= r.odds.extra
      ? Math.max(SAFE_ODDS, r.odds.pct)
      : simulate({
          id: r.goal.id, current: r.status.current, monthly: r.status.monthly + add,
          expectedReturn: r.goal.expectedReturn, months: r.status.months, target: r.status.target, step,
        }).successPct;
    out.push({ row: r, add, oddsAfter });
  }
  return out;
}
const rank = (r: GoalRow) => (r.goal.kind === "emergency" ? 0 : r.goal.priority === "must" ? 1 : 2);

/* ------------------------------------------------------------ emoji */

/** A small curated set for the picker. */
export const EMOJI_CHOICES = [
  "🛟", "💻", "📱", "🚗", "🏍️", "🗾", "✈️", "🏖️", "🏔️", "🏠", "💍", "🎓", "👶", "🐶", "🎸", "📷", "🎮", "🛋️", "🌴", "🎯",
];

const NAME_EMOJI: [RegExp, string][] = [
  [/laptop|macbook|computer|\bpc\b/i, "💻"],
  [/phone|iphone|pixel/i, "📱"],
  [/\bcar\b|sedan|suv/i, "🚗"],
  [/bike|scooter|motorcycle/i, "🏍️"],
  [/japan|tokyo|kyoto/i, "🗾"],
  [/goa|beach|bali|maldives|thailand/i, "🏖️"],
  [/trek|ladakh|himalaya|mountain|swiss|europe/i, "🏔️"],
  [/home|house|flat|apartment/i, "🏠"],
  [/wedding|marriage/i, "💍"],
  [/master|mba|degree|course|college|school/i, "🎓"],
  [/baby|child|kid/i, "👶"],
  [/dog|cat|pet|puppy/i, "🐶"],
  [/guitar|piano|music/i, "🎸"],
  [/camera/i, "📷"],
  [/playstation|\bps5\b|xbox|console|gaming/i, "🎮"],
  [/sofa|furniture|couch/i, "🛋️"],
  [/emergency|rainy day/i, "🛟"],
  [/retire/i, "🌴"],
  [/trip|travel|holiday|vacation/i, "✈️"],
];

/** A smart default: from the name when it's obvious, else by kind. */
export function suggestEmoji(name: string, kind: GoalKind): string {
  for (const [re, e] of NAME_EMOJI) if (re.test(name)) return e;
  return GOAL_EMOJI[kind];
}

/* -------------------------------------------------------- templates */

export type TemplateKey =
  | "emergency" | "travel" | "gadget" | "car" | "home" | "wedding" | "education" | "retirement" | "custom";

export interface Template {
  key: TemplateKey;
  label: string;
  emoji: string;
  kind: GoalKind;
  name: string;
  amount: number;
  months: number;
  inflation: number;
  priority: Goal["priority"];
}

/** Sensible defaults for someone in their 20s or 30s. */
export function templates(monthlyExpenses: number, age: number, retireAge: number): Template[] {
  const spend = monthlyExpenses > 0 ? monthlyExpenses : 40000;
  const round = (n: number, to: number) => Math.max(to, Math.round(n / to) * to);
  return [
    { key: "emergency", label: "Emergency fund", emoji: "🛟", kind: "emergency", name: "Emergency fund", amount: round(spend * 6, 10000), months: 12, inflation: 0, priority: "must" },
    { key: "travel", label: "Trip", emoji: "✈️", kind: "travel", name: "Trip abroad", amount: 250000, months: 18, inflation: 5, priority: "want" },
    { key: "gadget", label: "Gadget", emoji: "💻", kind: "purchase", name: "New laptop", amount: 120000, months: 10, inflation: 3, priority: "want" },
    { key: "car", label: "Car", emoji: "🚗", kind: "purchase", name: "Car down payment", amount: 300000, months: 36, inflation: 5, priority: "want" },
    { key: "home", label: "Home", emoji: "🏠", kind: "home", name: "Home down payment", amount: 2000000, months: 84, inflation: 6, priority: "must" },
    { key: "wedding", label: "Wedding", emoji: "💍", kind: "wedding", name: "Wedding", amount: 1000000, months: 36, inflation: 6, priority: "must" },
    { key: "education", label: "Education", emoji: "🎓", kind: "education", name: "Master's degree", amount: 2500000, months: 48, inflation: 8, priority: "must" },
    { key: "retirement", label: "Retirement", emoji: "🌴", kind: "retirement", name: `Retire at ${retireAge}`, amount: round(spend * 12 * 25, 100000), months: Math.max(12, (retireAge - age) * 12), inflation: 6, priority: "must" },
    { key: "custom", label: "Something else", emoji: "🎯", kind: "other", name: "", amount: 100000, months: 24, inflation: 5, priority: "want" },
  ];
}

/* ---------------------------------------------------------- what-if */

export interface Draft {
  name: string;
  emoji: string;
  /** False until the user picks one; until then the name can change it. */
  emojiPicked: boolean;
  kind: GoalKind;
  amount: number;        // today's rupees
  months: number;        // from asOf
  saved: number;
  expectedReturn: number;
  inflation: number;
  priority: Goal["priority"];
}

export function draftGoal(d: Draft, asOf: string, monthly = 0, id = "draft"): Goal {
  return {
    id,
    name: d.name || "New goal",
    kind: d.kind,
    emoji: d.emoji,
    targetToday: d.amount,
    targetDate: endOfMonth(addMonths(asOf, d.months)),
    inflation: d.inflation,
    saved: d.saved,
    monthly,
    expectedReturn: d.expectedReturn,
    priority: d.priority,
    createdAt: asOf,
  };
}

export function endOfMonth(iso: string): string {
  const d = new Date(iso);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return last.toISOString().slice(0, 10);
}

export interface Squeeze {
  row: GoalRow;
  cut: number;
  stops: boolean;
  newEta: string | null;
}

export interface WhatIf {
  target: number;
  /** Straight-line monthly (about even odds). */
  even: number;
  /** Monthly asked for: the SAFE_ODDS amount when given, else `even`. */
  needed: number;
  free: number | null;
  fits: boolean | null;
  left: number | null;
  squeeze: Squeeze[];
  squeezeCovers: boolean;
  /** One alternative date that fits the free money (later if it doesn't fit, sooner if it does). */
  alt: { date: string; months: number; monthly: number; later: boolean } | null;
  /** Net worth at retirement: change caused by this goal. */
  nw: { kept: boolean; delta: number; retireAge: number };
}

export function whatIf(d: Draft, view: WealthView, plan: MonthlyPlan, safe?: number): WhatIf {
  const { asOf, state } = view;
  const step = state.profile.sipStepUpPct;
  const g0 = draftGoal(d, asOf);
  const target = inflate(d.amount, d.inflation, Math.max(0, monthsBetween(asOf, g0.targetDate)));
  const even = Math.ceil(goalStatus(g0, [], asOf, step).neededMonthly / 100) * 100;
  const needed = safe ?? even;
  // The SAFE_ODDS amount scales roughly with the straight-line one at nearby dates.
  const ratio = even > 0 && safe != null ? safe / even : 1;
  const free = plan.free;
  const fits = free == null ? null : needed <= Math.max(0, free);
  const left = free == null ? null : free - needed;

  // Who gives way if it doesn't fit: nice-to-haves first, the furthest away first.
  const squeeze: Squeeze[] = [];
  // Money already over the surplus has to come from somewhere too.
  let short = free == null ? 0 : Math.max(0, needed - free);
  if (short > 0) {
    const order = [...view.goals]
      .filter((r) => r.goal.monthly > 0 && r.goal.kind !== "emergency")
      .sort((a, b) =>
        a.goal.priority !== b.goal.priority
          ? a.goal.priority === "want" ? -1 : 1
          : b.goal.targetDate.localeCompare(a.goal.targetDate));
    for (const r of order) {
      if (short <= 0 || squeeze.length >= 3) break;
      const cut = Math.min(r.goal.monthly, short);
      short -= cut;
      const after = goalStatus({ ...r.goal, monthly: r.goal.monthly - cut }, state.holdings, asOf, step);
      squeeze.push({ row: r, cut, stops: cut >= r.goal.monthly, newEta: after.eta });
    }
  }

  // One alternative date.
  const neededAt = (m: number) => {
    const g = draftGoal({ ...d, months: m }, asOf);
    const t = inflate(d.amount, d.inflation, m);
    return requiredMonthlyStepped(t, g.saved, d.expectedReturn, m, step) * ratio;
  };
  let alt: WhatIf["alt"] = null;
  if (free != null && free > 0) {
    if (!fits) {
      for (let m = d.months + 1; m <= Math.max(d.months + 1, 480); m++) {
        const n = neededAt(m);
        if (n <= free) { alt = { date: endOfMonth(addMonths(asOf, m)), months: m, monthly: Math.ceil(n / 100) * 100, later: true }; break; }
      }
    } else if (d.months > 2) {
      for (let m = 1; m < d.months; m++) {
        const n = neededAt(m);
        if (n <= free) {
          if (d.months - m >= 2) alt = { date: endOfMonth(addMonths(asOf, m)), months: m, monthly: Math.ceil(n / 100) * 100, later: false };
          break;
        }
      }
    }
  }

  // Net worth at retirement, with and without spending this goal.
  const base = { cash: view.cash, holdings: state.holdings, liabilities: view.liabilities, profile: state.profile, asOf };
  const others = state.goals;
  const kept = d.kind === "emergency" || d.kind === "retirement";
  const last = (goals: Goal[]) => projectNetWorth({ ...base, goals }).at(-1)?.netWorth ?? 0;
  const delta = kept
    ? last([...others, draftGoal(d, asOf, needed)]) - last(others)
    : last([...others, draftGoal(d, asOf, needed)]) - last([...others, { ...draftGoal(d, asOf, needed), targetToday: 0 }]);

  return {
    target, even, needed, free, fits, left, squeeze,
    squeezeCovers: short <= 0,
    alt,
    nw: { kept, delta, retireAge: state.profile.retireAge },
  };
}

/** Months from asOf to a goal's date, at least 1. */
export const monthsTo = (asOf: string, iso: string) => Math.max(1, Math.round(monthsBetween(asOf, iso)));

export { suggestedReturn };
