import type { DayPoint } from "@/lib/wealth";

/**
 * Weekly close: the last day of each week (weeks end on Sunday), plus the
 * latest day. Takes the salary sawtooth out of the daily series so the trend
 * reads as a trend.
 */
export function weeklyClose(daily: DayPoint[]): DayPoint[] {
  const out: DayPoint[] = [];
  for (let i = 0; i < daily.length; i++) {
    const d = daily[i];
    const sunday = new Date(`${d.date}T00:00:00Z`).getUTCDay() === 0;
    if (i === 0 || sunday || i === daily.length - 1) out.push(d);
  }
  return out;
}

/** Net worth on the last day of `period` (or the latest day inside it). */
export function closeOf(daily: DayPoint[], period: string): DayPoint | null {
  let last: DayPoint | null = null;
  for (const d of daily) {
    if (d.date.slice(0, 7) === period) last = d;
    else if (d.date.slice(0, 7) > period) break;
  }
  return last;
}

/** Net worth on the day before `period` starts (falls back to its first day). */
export function openOf(daily: DayPoint[], period: string): DayPoint | null {
  let prev: DayPoint | null = null;
  for (const d of daily) {
    if (d.date.slice(0, 7) >= period) return prev ?? d;
    prev = d;
  }
  return null;
}
