/*
 * Words for the wealth screen: rupees the way people say them ("₹18.9 lakh"),
 * month names, and the one quiet line under each holding.
 */

import { inr } from "@/lib/format";
import type { Holding, RedeemInfo } from "@/lib/wealth";

import { shortInr } from "./chartKit";
import { elssLots } from "./mix";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** ₹18.9 lakh, ₹1.2 crore, ₹31,056. For sentences. */
export function rupees(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  const one = (v: number) => v.toFixed(1).replace(/\.0$/, "");
  if (abs >= 1e7) return `${sign}₹${one(abs / 1e7)} crore`;
  if (abs >= 1e5) return `${sign}₹${one(abs / 1e5)} lakh`;
  return `${sign}${inr(abs)}`;
}

/** Parts for a NumberTicker that counts up to `rupees(n)`. */
export function rupeesTicker(n: number): { value: number; prefix: string; suffix: string; decimals: number } {
  const abs = Math.abs(n);
  const prefix = n < 0 ? "−₹" : "₹";
  if (abs >= 1e7) return { value: round1(abs / 1e7), prefix, suffix: " crore", decimals: 1 };
  if (abs >= 1e5) return { value: round1(abs / 1e5), prefix, suffix: " lakh", decimals: 1 };
  return { value: Math.round(abs), prefix, suffix: "", decimals: 0 };
}
const round1 = (v: number) => Math.round(v * 10) / 10;

/** "2026-11" or "2026-11-20" -> "Nov" */
export const monShort = (iso?: string | null) => (iso ? MONTHS[Number(iso.slice(5, 7)) - 1] ?? "" : "");
/** "2026-11" -> "November" */
export const monLong = (iso?: string | null) => (iso ? MONTHS_LONG[Number(iso.slice(5, 7)) - 1] ?? "" : "");
/** "2027-12-20" -> "Dec 2027" */
export const monYear = (iso?: string | null) => (iso ? `${monShort(iso)} ${iso.slice(0, 4)}` : "");
/** "2026-11-20" -> "20 Nov 2026" */
export const dayMonYear = (iso?: string | null) =>
  iso ? `${Number(iso.slice(8, 10))} ${monShort(iso)} ${iso.slice(0, 4)}` : "";

/** "since June" within the same year as `ref`, else "since Dec 2025". */
export function sinceMonth(month: string, ref: string): string {
  return month.slice(0, 4) === ref.slice(0, 4) ? monLong(month) : monYear(month);
}

/** "+12.4%" / "−3.1%" */
export function signedPct(n: number, digits = 1): string {
  if (!isFinite(n)) return "–";
  const v = Math.abs(n).toFixed(digits).replace(/\.0$/, "");
  return `${n > 0.05 ? "+" : n < -0.05 ? "−" : ""}${v}%`;
}

export function pctText(n: number, digits = 1): string {
  return `${n.toFixed(digits).replace(/\.0$/, "")}%`;
}

/** The single quiet line under a holding: when can this money come out? */
export function redeemLine(h: Holding, r: RedeemInfo, asOf?: string): string {
  if (h.kind === "elss" && asOf) {
    const locked = elssLots(h).filter((l) => l.frees > asOf);
    if (locked.length > 1) return `First ${shortInr(locked[0].put)} frees ${monYear(locked[0].frees)}, rest ${monYear(locked[locked.length - 1].frees)}`;
    if (locked.length === 1) return `Locked until ${monYear(locked[0].frees)}`;
  }
  switch (h.kind) {
    case "epf":
      return "Paid out at retirement";
    case "nps":
      return "Locked until 60";
    case "bonds":
      return r.from ? `Matures ${monYear(r.from)}` : "Matured";
    case "fd":
      return r.from ? `Matures ${monYear(r.from)}, can break early` : "Matured";
    case "equity_mf":
      return r.from ? `Exit load until ${monYear(r.from)}` : "Can sell any day";
    case "liquid_mf":
      return "Money back the same day";
    case "stocks":
      return "Can sell any market day";
    default:
      if (!r.now && r.from) return `Locked until ${monYear(r.from)}`;
      return "Can sell any day";
  }
}

/** "1 thing" / "3 things" */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;
}

/** "Parag Parikh Flexi Cap Fund" -> "Parag Parikh Flexi Cap" */
export function shortName(name: string): string {
  return name
    .replace(/\s*\(.*?\)\s*/g, " ")
    .replace(/\b(Fund|Asset|Savings|Tax Saver|Series I+|Rate)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}
