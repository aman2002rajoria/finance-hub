// Small formatters for the ledger and tagging screens (design.md §4, §17).
// Kept local so the shared lib/format.ts stays untouched.

import { inr } from "@/lib/format";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseIso(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  // Treat YYYY-MM-DD as a calendar date, never shifted by the timezone.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** `15 Nov` this year, `15 Nov 2025` otherwise. */
export function dayMonth(iso: string | null | undefined): string {
  const d = parseIso(iso);
  if (!d) return iso || "";
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === new Date().getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

/** Always `15 Nov 2026`. */
export function fullDate(iso: string | null | undefined): string {
  const d = parseIso(iso);
  if (!d) return iso || "";
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** `₹1,20,000`. Credits get a leading plus so direction never relies on colour alone. */
export function signedRupees(amount: number, type: "debit" | "credit"): string {
  return type === "credit" ? `+${inr(amount)}` : inr(amount);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;
}

/** Strip the `400: ` status prefix the API client adds, so errors read as sentences. */
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replace(/^\d{3}:\s*/, "");
}

/** Category path as `Food › Delivery`. */
export function categoryPath(...parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join(" › ");
}
