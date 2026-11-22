/*
 * A goal's story: what actually happened (history), what the plan was
 * (the same goal with no setbacks and no boosts, or at the expected market
 * return), the moments in between, how many months the gap costs, and one
 * "what if it happens again". No React here.
 */

import {
  CLASS_OF, addMonths, goalEmoji, inflate, monthsBetween, monthsToReach,
  type Goal, type GoalEvent, type GoalStatus, type Holding, type Marker,
} from "@/lib/wealth";

import type { OddsRow } from "./model";
import { SAFE_ODDS, simInput, simulate, type SimInput } from "./odds";
import { monYear, short } from "./words";

export interface Pt { date: string; value: number }

export interface Pin {
  date: string;
  value: number;          // where it sits on the actual path
  emoji: string;
  text: string;           // "−₹30k", "skipped", "+₹25k", "−10%"
  label: string;          // full label, for tooltips
  kind: GoalEvent["kind"];
  amount: number;
}

export interface WhatIfHit {
  emoji: string;
  /** "Another ₹30k hit", "Skip another month", "Another 10% fall" */
  label: string;
  amount: number;
  eta: string | null;
  /** Months later than today's ETA. */
  later: number;
  /** The forward path after the hit, monthly from asOf (expected return). */
  path: Pt[];
}

export interface GoalStory {
  start: string;
  past: Pt[];
  /** The plan line over the past (no setbacks / boosts, or expected returns). */
  planPast: Pt[];
  /** The plan line from today to the date, continuing at today's monthly. */
  planFwd: Pt[];
  planNow: number;
  pins: Pin[];
  /** Months the setbacks cost (actual ETA − plan ETA); null when unknown. */
  delay: number | null;
  etaActual: string | null;
  etaPlan: string | null;
  /** actual − plan today (negative: behind the plan). */
  gap: number;
  /** "market" when the money rides linked funds, else "saved". */
  mode: "market" | "saved";
  hit: WhatIfHit | null;
}

const DAY = 864e5;
const t = (iso: string) => Date.parse(iso);
const years = (a: string, b: string) => (t(b) - t(a)) / (365 * DAY);
const grow = (v: number, ratePct: number, from: string, to: string) => v * Math.pow(1 + ratePct / 100, Math.max(0, years(from, to)));

function nearest(path: Pt[], iso: string): number {
  if (!path.length) return 0;
  // The first sample on or after the date (that's where a step shows).
  const i = path.findIndex((p) => p.date >= iso);
  return path[i < 0 ? path.length - 1 : i].value;
}

function shortAmt(n: number): string {
  const a = Math.abs(n);
  const s = a >= 1e5 ? `₹${(a / 1e5).toFixed(1).replace(/\.0$/, "")}L` : a >= 1e3 ? `₹${Math.round(a / 1e3)}k` : `₹${Math.round(a)}`;
  return `${n < 0 ? "−" : "+"}${s}`;
}

function pinText(e: GoalEvent): string {
  if (e.kind === "pause") return "skipped";
  if (e.amount === 0) {
    const m = e.label.match(/(\d+(?:\.\d+)?)\s*%/);
    return m ? `−${m[1]}%` : "dip";
  }
  return shortAmt(e.amount);
}

/** Monthly path from `from` at `monthly`, expected return, yearly step-up, `months` long. */
function forward(from: string, v0: number, monthly: number, ratePct: number, months: number, step: number): Pt[] {
  const r = Math.pow(1 + ratePct / 100, 1 / 12) - 1;
  let v = v0, m = monthly;
  const out: Pt[] = [{ date: from, value: v0 }];
  const n = Math.max(1, Math.ceil(months));
  for (let i = 1; i <= n; i++) {
    v = v * (1 + r) + m;
    if (i % 12 === 0) m *= 1 + step / 100;
    out.push({ date: addMonths(from, i), value: Math.round(v) });
  }
  return out;
}

export function goalStory(goal: Goal, s: GoalStatus, asOf: string, step: number): GoalStory {
  const r = goal.expectedReturn;
  const hist = (goal.history ?? []).filter((p) => p.date <= asOf);
  const past: Pt[] = hist.length ? hist.slice() : [{ date: goal.createdAt < asOf ? goal.createdAt : asOf, value: s.current }];
  // The last point is today, at today's value (holdings may be newer than history).
  if (past[past.length - 1].date < asOf) past.push({ date: asOf, value: s.current });
  else past[past.length - 1] = { date: asOf, value: s.current };
  const start = past[0].date;

  const linked = s.linked;
  const market = linked.length > 0 && linked.some((h) => CLASS_OF[h.kind] === "equity");
  const events = (goal.events ?? []).filter((e) => e.date > start && e.date <= asOf);

  // The plan over the past.
  let planPast: Pt[];
  if (market) {
    // Same money in, at the expected return: what the market owed you.
    const v0 = past[0].value;
    const flows = linked.flatMap((h: Holding) => (h.flows ?? []).filter((f) => f.date > start && f.date <= asOf));
    planPast = past.map((p) => ({
      date: p.date,
      value: Math.round(grow(v0, r, start, p.date)
        + flows.filter((f) => f.date <= p.date).reduce((acc, f) => acc + grow(f.amount, r, f.date, p.date), 0)),
    }));
  } else {
    // The same goal with every setback, skip and boost taken out.
    planPast = past.map((p) => ({
      date: p.date,
      value: Math.round(p.value - events.filter((e) => e.date <= p.date).reduce((acc, e) => acc + grow(e.amount, r, e.date, p.date), 0)),
    }));
  }
  const planNow = planPast[planPast.length - 1].value;
  const months = Math.max(1, s.months);
  const planFwd = forward(asOf, planNow, s.monthly, r, months, step);

  const toReach = (pv: number) => monthsToReach(s.target, pv, s.monthly, r, step);
  const mA = toReach(s.current);
  const mP = toReach(planNow);
  const etaActual = mA == null ? null : addMonths(asOf, mA);
  const etaPlan = mP == null ? null : addMonths(asOf, mP);
  const delay = mA == null || mP == null ? null : mA - mP;

  const pins: Pin[] = (goal.events ?? [])
    .filter((e) => e.date >= start && e.date <= asOf)
    .map((e) => ({
      date: e.date, value: nearest(past, e.date), emoji: e.emoji, text: pinText(e), label: e.label, kind: e.kind, amount: e.amount,
    }));

  // One more of what already happened.
  let hit: WhatIfHit | null = null;
  const setbacks = (goal.events ?? []).filter((e) => e.kind === "setback" && e.amount < 0);
  const dips = (goal.events ?? []).filter((e) => e.kind === "setback" && e.amount === 0);
  const pauses = (goal.events ?? []).filter((e) => e.kind === "pause");
  let amount = 0, emoji = "⚡", label = "";
  if (setbacks.length) {
    const worst = setbacks.reduce((a, b) => (b.amount < a.amount ? b : a));
    amount = -worst.amount; emoji = worst.emoji; label = `Another ${shortAmt(worst.amount).slice(1)} hit`;
  } else if (market && dips.length) {
    const eq = linked.filter((h) => CLASS_OF[h.kind] === "equity").reduce((acc, h) => acc + h.current, 0);
    amount = eq * 0.1; emoji = dips[0].emoji; label = "Another 10% fall";
  } else if (s.monthly > 0) {
    amount = goal.monthly || s.monthly; emoji = pauses[0]?.emoji ?? "⏸️"; label = pauses.length ? "Skip another month" : "Skip a month";
  }
  if (amount > 0 && s.current < s.target) {
    const mH = toReach(Math.max(0, s.current - amount));
    hit = {
      emoji, label, amount,
      eta: mH == null ? null : addMonths(asOf, mH),
      later: mH == null || mA == null ? 0 : mH - mA,
      path: forward(asOf, Math.max(0, s.current - amount), s.monthly, r, months, step),
    };
  }

  return {
    start, past, planPast, planFwd, planNow, pins, delay, etaActual, etaPlan,
    gap: s.current - planNow, mode: market ? "market" : "saved", hit,
  };
}

/* ----------------------------------------------- what would fix it */

/** Lump sum added today that lifts the odds to `odds`% at today's monthly. Rounded up to ₹1,000. */
export function lumpForOdds(i: SimInput, odds = SAFE_ODDS): number {
  const ok = (l: number) => simulate({ ...i, current: i.current + l, paths: 250 }).successPct >= odds;
  if (ok(0)) return 0;
  let lo = 0, hi = Math.max(10000, i.target - i.current);
  if (!ok(hi)) return Math.ceil(hi / 1000) * 1000;
  for (let k = 0; k < 18 && hi - lo > Math.max(1000, hi * 0.01); k++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) hi = mid; else lo = mid;
  }
  return Math.ceil(hi / 1000) * 1000;
}

/** Months from asOf at which today's money and monthly reach `odds`% (target inflating with the date). */
export function monthsForOdds(g: Goal, s: GoalStatus, step: number, odds = SAFE_ODDS): number | null {
  const base = Math.max(1, Math.round(s.months));
  // Quarter steps, ten years out at most: it's for a tooltip, not a plan.
  for (let m = base; m <= base + 120; m += 3) {
    const target = inflate(g.targetToday, g.inflation, m);
    const sim = simulate({ id: g.id, current: s.current, monthly: s.monthly, expectedReturn: g.expectedReturn, months: m, target, step, paths: 200 });
    if (sim.successPct >= odds) return m;
  }
  return null;
}

/** The last big income one-off (a bonus), if any: the next one is assumed a year later. */
export function lastBonus(markers: Marker[]): Marker | null {
  const xs = markers.filter((m) => m.kind === "income" && m.amount > 0).sort((a, b) => b.date.localeCompare(a.date));
  return xs[0] ?? null;
}

/* ------------------------------------------------- across goals */

export interface Change {
  goalId: string;
  emoji: string;
  /** "Next 🎉 bonus: ₹54k to 🗾" */
  text: string;
  title: string;
}

/**
 * Two or three realistic moves for the goals that are behind, nearest date
 * first: a slice of the next bonus (when one came last year and the next
 * lands before the date), and the monthly top-up for SAFE_ODDS.
 */
export function whatToChange(rows: OddsRow[], markers: Marker[], asOf: string, step: number): Change[] {
  const behind = rows
    .filter((r) => r.odds.pct < SAFE_ODDS && r.status.current < r.status.target)
    .sort((a, b) => a.goal.targetDate.localeCompare(b.goal.targetDate));
  const bonus = lastBonus(markers);
  const out: Change[] = [];
  behind.forEach((r, i) => {
    const e = goalEmoji(r.goal);
    const input = simInput(r.goal, r.status, step);
    if (i === 0 && bonus) {
      const next = addMonths(bonus.date, 12);
      if (next < r.goal.targetDate && next > asOf) {
        const now = lumpForOdds(input);
        const k = Math.max(0, monthsBetween(asOf, next));
        const then = Math.ceil((now * Math.pow(1 + r.goal.expectedReturn / 100, k / 12)) / 1000) * 1000;
        if (then > 0 && then <= bonus.amount * 0.6) {
          out.push({
            goalId: r.goal.id, emoji: e,
            text: `Next 🎉 bonus: ${short(then)} to ${e}`,
            title: `If ${monYear(next)} brings a bonus like ${monYear(bonus.date)}'s, putting ${short(then)} of it into ${r.goal.name} lifts the odds to ${SAFE_ODDS}% at today's monthly.`,
          });
        }
      }
    }
    if (r.odds.extra > 0) {
      const late = monthsForOdds(r.goal, r.status, step);
      out.push({
        goalId: r.goal.id, emoji: e,
        text: `+${short(r.odds.extra)}/mo keeps ${e} on time`,
        title: `${SAFE_ODDS}% odds by ${monYear(r.goal.targetDate)}.${late ? ` At today's monthly, ${SAFE_ODDS}% comes only by ${monYear(addMonths(asOf, late))}.` : ""}`,
      });
    }
  });
  return out.slice(0, 3);
}

