/** Date labels in the house style (design.md §4): `15 Nov`, `15 Nov 2025`, `Nov 2026`. */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parse(iso: string): Date {
  return new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
}

export function dayLabel(iso: string | null | undefined, { withYear }: { withYear?: boolean } = {}): string {
  if (!iso) return "—";
  const d = parse(iso);
  if (isNaN(d.getTime())) return iso;
  const showYear = withYear ?? d.getFullYear() !== new Date().getFullYear();
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${showYear ? ` ${d.getFullYear()}` : ""}`;
}

/** 'YYYY-MM' → 'Nov 2026'; `short` → 'Nov'. */
export function monthName(period: string, { short = false }: { short?: boolean } = {}): string {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m) return period;
  return short ? MONTHS[m - 1] : `${MONTHS[m - 1]} ${y}`;
}

/** Plural helper: plural(3, "order") → "3 orders". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;
}
