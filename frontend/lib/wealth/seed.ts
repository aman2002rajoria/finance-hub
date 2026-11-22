// Synthetic wealth data for TEST DATA mode. Deterministic, invented, and
// consistent with the demo statements: ₹85k salary, a ₹5k + ₹3k SIP every
// month, a Goa trip in September, one Flipkart EMI, two credit cards.

import type { Flow, Goal, Holding, IncomeEvent, LifeEvent, Liability, WealthState } from "./types";
import { dayIndex, dayRange, normal, rng } from "./timeline";

export const SEED_AS_OF = "2026-11-20";

function monthsList(from: string, to: string, day: number): string[] {
  const out: string[] = [];
  const d = new Date(from);
  d.setDate(day);
  if (d.toISOString().slice(0, 10) < from) d.setMonth(d.getMonth() + 1);
  while (d.toISOString().slice(0, 10) <= to) {
    out.push(d.toISOString().slice(0, 10));
    d.setMonth(d.getMonth() + 1);
  }
  return out;
}

/* ---------------------------------------------------------- markets */
// A deterministic, made-up market: ~12% a year with real-looking noise,
// a sharp correction in March 2026 and a smaller one in August 2026.

const MARKET_START = "2022-06-01";
const DAILY_FROM = "2025-06-01";
const ALL_DAYS = dayRange(MARKET_START, SEED_AS_OF);

const SHOCKS: { from: string; to: string; total: number }[] = [
  { from: "2024-06-03", to: "2024-06-05", total: -0.05 },
  { from: "2025-02-03", to: "2025-02-28", total: -0.06 },
  { from: "2026-03-02", to: "2026-03-24", total: -0.10 },
  { from: "2026-08-04", to: "2026-08-26", total: -0.07 },
];

function walk(seed: number, drift: number, vol: number, shocks: typeof SHOCKS): number[] {
  const r = rng(seed);
  const out: number[] = [];
  let lv = 0;
  const muD = Math.log(1 + drift) / 252, sdD = vol / Math.sqrt(252);
  for (const d of ALL_DAYS) {
    const wd = new Date(d).getUTCDay();
    if (wd !== 0 && wd !== 6) {
      lv += muD + sdD * normal(r);
      for (const s of shocks) {
        if (d >= s.from && d <= s.to) {
          const n = dayRange(s.from, s.to).filter((x) => { const w = new Date(x).getUTCDay(); return w !== 0 && w !== 6; }).length;
          lv += Math.log(1 + s.total) / n;
        }
      }
    }
    out.push(lv);
  }
  // Pin the end point so the long-run return is exactly `drift` (noise and
  // shocks shape the path, not the destination).
  const want = Math.log(1 + drift) * (ALL_DAYS.length / 365);
  const fix = (want - out[out.length - 1]) / (out.length - 1);
  return out.map((v, i) => v + fix * i);
}

const MARKET = walk(7, 0.12, 0.13, SHOCKS);
const GOLD = walk(11, 0.15, 0.11, [{ from: "2026-05-04", to: "2026-05-22", total: -0.05 }]);

interface Style { beta: number; idio: number; gold?: boolean }
const STYLE: Partial<Record<Holding["kind"], Style>> = {
  equity_mf: { beta: 0.95, idio: 0.04 },
  elss: { beta: 1.05, idio: 0.05 },
  stocks: { beta: 1.2, idio: 0.14 },
  nps: { beta: 0.6, idio: 0.02 },
  gold: { beta: 0, idio: 0, gold: true },
};

/** Simulates a holding day by day (units bought at each day's price), so
 *  daily values, month-end history, flows and XIRR all agree. */
function build(o: {
  id: string; name: string; kind: Holding["kind"]; start: string;
  sip?: number; sipDay?: number; lumps?: Flow[]; annual: number; seed?: number;
  extra?: Partial<Holding>;
}): Holding {
  const flows: Flow[] = [...(o.lumps ?? [])];
  if (o.sip) for (const d of monthsList(o.start, SEED_AS_OF, o.sipDay ?? 5)) flows.push({ date: d, amount: o.sip });
  flows.sort((a, b) => a.date.localeCompare(b.date));

  const st = STYLE[o.kind] ?? { beta: 0, idio: 0 };
  const idioWalk = st.idio ? walk(o.seed ?? 3, 0, st.idio, []) : null;
  const base = st.gold ? GOLD : MARKET;
  const baseDrift = st.gold ? 0.15 : 0.12;
  const beta = st.gold ? 1 : st.beta;
  const alpha = Math.log(1 + o.annual / 100) / 365 - (beta ? (beta * Math.log(1 + baseDrift)) / 365 : 0);
  const nav = ALL_DAYS.map((_, i) => Math.exp(beta * base[i] + alpha * i + (idioWalk ? idioWalk[i] : 0)));

  const iStart = Math.max(0, dayIndex(MARKET_START, o.start));
  let units = 0, k = 0;
  const values: number[] = [];
  const hist = new Map<string, number>();
  for (let i = iStart; i < ALL_DAYS.length; i++) {
    const d = ALL_DAYS[i];
    while (k < flows.length && flows[k].date <= d) { units += flows[k].amount / nav[i]; k++; }
    const v = Math.round(units * nav[i]);
    values.push(v);
    hist.set(d.slice(0, 7), v);
  }
  const iDaily = Math.max(0, dayIndex(ALL_DAYS[iStart], DAILY_FROM));
  const invested = flows.reduce((s, f) => s + f.amount, 0);
  return {
    id: o.id,
    name: o.name,
    kind: o.kind,
    invested,
    current: values[values.length - 1],
    asOf: SEED_AS_OF,
    startDate: o.start,
    sipMonthly: o.sip,
    flows,
    valueHistory: Array.from(hist.entries()).map(([month, value]) => ({ month, value })).slice(-36),
    daily: { start: ALL_DAYS[iStart + iDaily] ?? o.start, values: values.slice(iDaily) },
    ...o.extra,
  };
}

const holdings: Holding[] = [
  build({
    id: "h-flexi", name: "Parag Parikh Flexi Cap Fund", kind: "equity_mf",
    start: "2023-04-05", sip: 5000, annual: 15, seed: 21,
    extra: {},
  }),
  build({
    id: "h-index", name: "UTI Nifty 50 Index Fund", kind: "equity_mf",
    start: "2024-01-05", sip: 3000, annual: 13, seed: 22,
    extra: { goalId: "g-house" },
  }),
  build({
    id: "h-elss", name: "Mirae Asset ELSS Tax Saver", kind: "elss",
    start: "2023-12-20", annual: 14,
    lumps: [{ date: "2023-12-20", amount: 50000 }, { date: "2024-12-20", amount: 50000 }],
    extra: { lockInUntil: "2027-12-20", goalId: "g-house", note: "Bought for the 80C deduction. The second purchase frees up in Dec 2027." },
  }),
  build({
    id: "h-liquid", name: "HDFC Liquid Fund", kind: "liquid_mf",
    start: "2024-06-01", annual: 6.6,
    lumps: [{ date: "2024-06-01", amount: 100000 }, { date: "2025-09-01", amount: 60000 }],
    extra: { isEmergency: true },
  }),
  build({
    id: "h-fd", name: "SBI fixed deposit", kind: "fd",
    start: "2025-03-10", annual: 7.1,
    lumps: [{ date: "2025-03-10", amount: 100000 }],
    extra: { rate: 7.1, maturityDate: "2027-03-10" },
  }),
  build({
    id: "h-rbi", name: "RBI Floating Rate Savings Bond", kind: "bonds",
    start: "2025-07-01", annual: 0,
    lumps: [{ date: "2025-07-01", amount: 50000 }],
    extra: { rate: 8.05, maturityDate: "2032-07-01", note: "Pays interest every January and July." },
  }),
  build({
    id: "h-ppf", name: "PPF account", kind: "ppf",
    start: "2023-04-02", annual: 7.1,
    lumps: ["2023-04-02", "2024-04-02", "2025-04-02", "2026-04-02"].map((d) => ({ date: d, amount: 30000 })),
    extra: { rate: 7.1, lockInUntil: "2038-04-01" },
  }),
  build({
    id: "h-epf", name: "EPF (employer)", kind: "epf",
    start: "2022-07-01", sip: 7200, sipDay: 1, annual: 8.25,
    extra: { rate: 8.25, note: "Deducted from salary before it reaches your bank, so statements don't show it." },
  }),
  build({
    id: "h-stocks", name: "Direct stocks (4 companies)", kind: "stocks",
    start: "2024-08-10", annual: 9,
    lumps: [{ date: "2024-08-10", amount: 25000 }, { date: "2025-02-14", amount: 15000 }],
  }),
  build({
    id: "h-sgb", name: "Sovereign Gold Bond 2024 Series I", kind: "gold",
    start: "2024-02-20", annual: 18,
    lumps: [{ date: "2024-02-20", amount: 12630 }],
    extra: { lockInUntil: "2029-02-20", note: "2 grams. Also pays 2.5% a year interest." },
  }),
];

// Card bills come from the statements (unpaid spend); the phone EMI is
// already inside a paid card bill. Only loans the statements can't see go here.
const liabilities: Liability[] = [];

let n = 0;
const ev = (date: string, kind: IncomeEvent["kind"], amount: number, source: string): IncomeEvent =>
  ({ id: `i-${++n}`, date, kind, amount, source });

const income: IncomeEvent[] = [
  // RBI bond coupons
  ev("2026-01-01", "interest", 2013, "RBI Floating Rate Savings Bond"),
  ev("2026-07-01", "interest", 2013, "RBI Floating Rate Savings Bond"),
  // SGB interest
  ev("2026-02-20", "interest", 158, "Sovereign Gold Bond"),
  ev("2026-08-20", "interest", 158, "Sovereign Gold Bond"),
  // Dividends
  ev("2026-02-12", "dividend", 340, "Direct stocks"),
  ev("2026-07-24", "dividend", 585, "Direct stocks"),
  ev("2026-08-30", "dividend", 220, "Direct stocks"),
];

/* ---------------------------------------------------------- goals */
// Three goals with a real past: money in most months, a medical bill that
// raided the laptop fund, a skipped month for Goa, a bonus top-up, and a
// home fund that rides the market.

function pot(o: {
  start: string; end: string; monthly: number; day?: number; ratePct: number; opening?: number;
  moves: { date: string; amount: number }[];          // one-off adds / withdrawals
  skip?: string[];                                    // YYYY-MM months with no contribution
}): { date: string; value: number }[] {
  const days = dayRange(o.start, o.end);
  const r = Math.pow(1 + o.ratePct / 100, 1 / 365) - 1;
  let v = o.opening ?? 0;
  const out: { date: string; value: number }[] = [];
  days.forEach((d, i) => {
    v *= 1 + r;
    if (Number(d.slice(8, 10)) === (o.day ?? 5) && !o.skip?.includes(d.slice(0, 7))) v += o.monthly;
    for (const m of o.moves) if (m.date === d) v += m.amount;
    if (i % 7 === 0 || i === days.length - 1) out.push({ date: d, value: Math.round(v) });
  });
  return out;
}

const laptopHist = pot({
  start: "2026-01-05", end: SEED_AS_OF, monthly: 10000, ratePct: 6.5,
  skip: ["2026-09"],
  moves: [
    { date: "2026-08-22", amount: -30000 },
    { date: "2026-10-16", amount: 25000 },
  ],
});
const japanHist = pot({
  start: "2026-02-01", end: SEED_AS_OF, monthly: 6000, day: 10, ratePct: 7, opening: 40000,
  skip: ["2026-10"],
  moves: [],
});

const goalsBase: Goal[] = [
  {
    id: "g-laptop", name: "MacBook Pro", kind: "purchase", emoji: "💻",
    targetToday: 160000, targetDate: "2027-06-30", plannedDate: "2027-04-30", inflation: 3,
    saved: laptopHist[laptopHist.length - 1].value, monthly: 10000, expectedReturn: 6.5, priority: "want",
    createdAt: "2026-01-05", history: laptopHist,
    events: [
      { date: "2026-08-22", label: "Medical emergency", emoji: "🏥", amount: -30000, kind: "setback" },
      { date: "2026-09-05", label: "Skipped for Goa", emoji: "🏖️", amount: -10000, kind: "pause" },
      { date: "2026-10-16", label: "Topped up from bonus", emoji: "🎉", amount: 25000, kind: "boost" },
    ],
  },
  {
    id: "g-japan", name: "Japan trip", kind: "travel", emoji: "🗾",
    targetToday: 250000, targetDate: "2028-04-15", inflation: 5,
    saved: japanHist[japanHist.length - 1].value, monthly: 6000, expectedReturn: 7, priority: "want",
    createdAt: "2026-02-01", history: japanHist,
    events: [
      { date: "2026-02-01", label: "Started with old savings", emoji: "🐷", amount: 40000, kind: "boost" },
      { date: "2026-10-10", label: "Paused the month of the iPad", emoji: "📱", amount: -6000, kind: "pause" },
    ],
  },
  {
    id: "g-house", name: "Home down payment", kind: "home", emoji: "🏠",
    targetToday: 2000000, targetDate: "2033-03-31", inflation: 6,
    saved: 0, monthly: 5000, expectedReturn: 12, priority: "must", createdAt: "2025-06-01",
    // history is filled from the linked equity funds below (it moves with the market)
  },
];

function withHouseHistory(goals: Goal[], hs: Holding[]): Goal[] {
  const linked = hs.filter((h) => h.goalId === "g-house" && h.daily);
  if (!linked.length) return goals;
  const days = dayRange("2026-01-01", SEED_AS_OF).filter((_, i, a) => i % 7 === 0 || i === a.length - 1);
  const history = days.map((d) => ({
    date: d,
    value: Math.round(linked.reduce((sum, h) => {
      const i = dayIndex(h.daily!.start, d);
      return sum + (i < 0 ? 0 : h.daily!.values[Math.min(i, h.daily!.values.length - 1)]);
    }, 0)),
  }));
  // Its own ₹5k a month started in June 2026, on top of the linked funds.
  const own = pot({ start: "2026-06-01", end: SEED_AS_OF, monthly: 5000, ratePct: 7, moves: [] });
  const ownAt = (d: string) => {
    let v = 0;
    for (const p of own) { if (p.date <= d) v = p.value; else break; }
    return v;
  };
  const withOwn = history.map((p) => ({ date: p.date, value: p.value + ownAt(p.date) }));
  return goals.map((g) => (g.id === "g-house" ? {
    ...g, history: withOwn, saved: own[own.length - 1].value,
    events: [
      { date: "2026-03-24", label: "Markets fell 10%", emoji: "📉", amount: 0, kind: "setback" },
      { date: "2026-08-26", label: "Markets fell 7%", emoji: "📉", amount: 0, kind: "setback" },
    ],
  } : g));
}
const goals: Goal[] = withHouseHistory(goalsBase, holdings);


// Your own labels for moments on the chart. Auto-detected moments near these
// dates take the label ("Goa trip" instead of "Trip"). Everything else
// (the bonus, the iPad, the phone) is found automatically from statements.
const events: LifeEvent[] = [
  { id: "e-medical", date: "2026-08-22", label: "Medical emergency", emoji: "🏥", amount: -30000 },
  { id: "e-goa", date: "2026-09-18", label: "Goa trip", emoji: "🏖️", amount: -17482 },
];

export function demoWealth(): WealthState {
  return {
    version: 2,
    profile: {
      age: 27,
      retireAge: 55,
      sipStepUpPct: 10,
      termCover: 10000000,
      healthCover: 500000,
      emergencyMonthsTarget: 6,
    },
    holdings: structuredClone(holdings),
    liabilities: structuredClone(liabilities),
    income: structuredClone(income),
    goals: structuredClone(goals),
    events: structuredClone(events),
  };
}

export function emptyWealth(): WealthState {
  return {
    version: 2,
    profile: { age: 27, retireAge: 55, sipStepUpPct: 10, emergencyMonthsTarget: 6 },
    holdings: [],
    liabilities: [],
    income: [],
    goals: [],
    events: [],
  };
}
