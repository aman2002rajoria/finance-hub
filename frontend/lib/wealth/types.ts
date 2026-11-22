// Wealth model (frontend only for now; lives in localStorage per data mode).
// Bank cash is NOT stored here: it comes from the statements via
// /analytics/net-worth. Everything below is what statements can't see.

export type HoldingKind =
  | "equity_mf"   // equity / index / flexi-cap mutual funds
  | "elss"        // tax-saver equity fund, 3-year lock-in
  | "debt_mf"     // debt / gilt / corporate-bond funds
  | "liquid_mf"   // liquid / overnight funds (emergency money)
  | "stocks"
  | "fd"          // fixed deposits
  | "bonds"       // corporate bonds, RBI floating bonds, G-secs
  | "ppf"
  | "epf"
  | "nps"
  | "gold"        // SGB / gold funds
  | "other";

export type AssetClass = "equity" | "debt" | "gold" | "cash" | "other";

export interface Flow {
  date: string;   // YYYY-MM-DD
  amount: number; // + money put in, - money taken out
}

export interface Holding {
  id: string;
  name: string;
  kind: HoldingKind;
  invested: number;          // net money put in
  current: number;           // value today
  asOf: string;              // when `current` was last updated (YYYY-MM-DD)
  startDate: string;
  sipMonthly?: number;       // running SIP / recurring contribution
  rate?: number;             // % a year for FD / bonds / PPF / EPF
  maturityDate?: string;     // FD / bonds
  lockInUntil?: string;      // ELSS / PPF / anything locked
  isEmergency?: boolean;     // counts towards the emergency fund
  goalId?: string;           // earmarked for one goal
  flows?: Flow[];            // for XIRR; falls back to one flow on startDate
  valueHistory?: { month: string; value: number }[]; // YYYY-MM -> value at month end
  daily?: { start: string; values: number[] };        // value each calendar day from `start`
  note?: string;
}

export type LiabilityKind = "credit_card" | "loan" | "emi";

export interface Liability {
  id: string;
  name: string;
  kind: LiabilityKind;
  outstanding: number;
  emi?: number;        // per month
  rate?: number;       // % a year
  endDate?: string;
}

export type IncomeKind = "dividend" | "interest" | "realised_gain";

export interface IncomeEvent {
  id: string;
  date: string;
  kind: IncomeKind;
  amount: number;
  source: string;      // holding or account name
}

export type GoalKind = "emergency" | "purchase" | "travel" | "home" | "education" | "wedding" | "retirement" | "other";

export interface Goal {
  id: string;
  name: string;
  kind: GoalKind;
  targetToday: number;     // cost in today's rupees
  targetDate: string;      // YYYY-MM-DD
  inflation: number;       // % a year applied to targetToday
  saved: number;           // money already set aside that isn't a linked holding
  monthly: number;         // what you put towards it each month
  expectedReturn: number;  // % a year on that money
  priority: "must" | "want";
  createdAt: string;
  emoji?: string;          // falls back to GOAL_EMOJI[kind]
  plannedDate?: string;    // the date first planned, if it has slipped since
  history?: { date: string; value: number }[]; // money towards it over time (weekly)
  events?: GoalEvent[];    // setbacks and boosts along the way
}

export interface GoalEvent {
  date: string;
  label: string;
  emoji: string;
  amount: number;          // + added, - taken out
  kind: "setback" | "boost" | "pause";
}

/** A moment worth marking on the net worth chart ("Goa trip", "Bonus"). */
export interface LifeEvent {
  id: string;
  date: string;
  label: string;
  emoji?: string;
  amount?: number;         // + money in, - money out
}

export interface Profile {
  age: number;
  retireAge: number;
  monthlyIncome?: number;      // overrides the statement average when set
  targetEquityPct?: number;    // overrides the age rule
  sipStepUpPct: number;        // yearly raise to SIPs in projections
  termCover?: number;          // life cover, ₹
  healthCover?: number;        // health insurance, ₹
  emergencyMonthsTarget: number;
}

export interface WealthState {
  version: 2;
  profile: Profile;
  holdings: Holding[];
  liabilities: Liability[];
  income: IncomeEvent[];
  goals: Goal[];
  events: LifeEvent[];
}

export const KIND_LABEL: Record<HoldingKind, string> = {
  equity_mf: "Equity fund",
  elss: "Tax-saver fund (ELSS)",
  debt_mf: "Debt fund",
  liquid_mf: "Liquid fund",
  stocks: "Stocks",
  fd: "Fixed deposit",
  bonds: "Bonds",
  ppf: "PPF",
  epf: "EPF",
  nps: "NPS",
  gold: "Gold",
  other: "Other",
};

export const GROUP_OF: Record<HoldingKind, "mutual_funds" | "fixed_income" | "retirement" | "market" | "other"> = {
  equity_mf: "mutual_funds",
  elss: "mutual_funds",
  debt_mf: "mutual_funds",
  liquid_mf: "mutual_funds",
  stocks: "market",
  gold: "market",
  fd: "fixed_income",
  bonds: "fixed_income",
  ppf: "retirement",
  epf: "retirement",
  nps: "retirement",
  other: "other",
};

export const GROUP_LABEL = {
  mutual_funds: "Mutual funds",
  fixed_income: "Bonds and deposits",
  retirement: "Retirement accounts",
  market: "Stocks and gold",
  other: "Other",
} as const;

export const CLASS_LABEL: Record<AssetClass, string> = {
  equity: "Equity",
  debt: "Debt",
  gold: "Gold",
  cash: "Cash",
  other: "Other",
};

export const GOAL_KIND_LABEL: Record<GoalKind, string> = {
  emergency: "Emergency fund",
  purchase: "Big purchase",
  travel: "Travel",
  home: "Home",
  education: "Education",
  wedding: "Wedding",
  retirement: "Retirement",
  other: "Other",
};

export const GOAL_EMOJI: Record<GoalKind, string> = {
  emergency: "🛟",
  purchase: "🛍️",
  travel: "✈️",
  home: "🏠",
  education: "🎓",
  wedding: "💍",
  retirement: "🌴",
  other: "🎯",
};

export const goalEmoji = (g: Pick<Goal, "emoji" | "kind">) => g.emoji || GOAL_EMOJI[g.kind];

/** Emoji for spending categories (statement taxonomy names). */
export const CATEGORY_EMOJI: Record<string, string> = {
  "Bills & Utilities": "🧾",
  Rent: "🏠",
  Food: "🍜",
  Groceries: "🛒",
  Travel: "✈️",
  Shopping: "🛍️",
  Electronics: "📱",
  Gifts: "🎁",
  Personal: "💆",
  Health: "💊",
  Entertainment: "🎬",
  Investments: "📈",
  Education: "🎓",
  Transport: "🚕",
  Other: "•",
};

export const KIND_EMOJI: Record<HoldingKind, string> = {
  equity_mf: "📈", elss: "🧾", debt_mf: "🏦", liquid_mf: "💧", stocks: "📊",
  fd: "🔒", bonds: "📜", ppf: "🏛️", epf: "👔", nps: "🌴", gold: "🪙", other: "•",
};
