"use client";

/*
 * Monthly money, as one bar on one scale: the usual month's surplus (a
 * dashed line), what's committed to goals (one colour per goal), what's
 * free, and how far past the surplus every goal at 80% odds would reach.
 * Under it, where money should go first.
 */

import { motion } from "framer-motion";

import { Card, CardTitle } from "@/components/ui";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { goalEmoji } from "@/lib/wealth";

import { safePlan, type MonthlyPlan, type OddsRow } from "./model";
import { SAFE_ODDS } from "./odds";
import type { Change } from "./story";
import { short } from "./words";

interface Seg { key: string; amount: number; fill: string; label: string; goal?: boolean }

const HATCH = "repeating-linear-gradient(135deg, var(--warning) 0 5px, transparent 5px 9px)";

export default function PlanCard({
  rows, plan, colors, changes, onOpen,
}: {
  rows: OddsRow[];
  plan: MonthlyPlan;
  colors: Map<string, string>;
  changes: Change[];
  onOpen: (id: string) => void;
}) {
  const reduced = usePrefersReducedMotion();
  if (plan.surplus == null) {
    return (
      <Card>
        <CardTitle subtitle="Upload statements to see what's left after spending.">Monthly money</CardTitle>
      </Card>
    );
  }
  const surplus = Math.max(0, plan.surplus);
  const free = plan.free ?? 0;
  const { total: safeTotal, short: gap } = safePlan(rows, plan);
  const committed = plan.committed;

  const segs: Seg[] = [
    ...rows.filter((r) => r.goal.monthly > 0).map((r) => ({
      key: r.goal.id, amount: r.goal.monthly, fill: colors.get(r.goal.id)!, label: `${goalEmoji(r.goal)} ${r.goal.name}`, goal: true,
    })),
    ...(free > 0 ? [{ key: "free", amount: free, fill: "var(--accent-500)", label: "Free" }] : []),
  ];
  const filled = committed + Math.max(0, free);
  const more = Math.max(0, safeTotal - filled);
  if (more > 0) segs.push({ key: "more", amount: more, fill: HATCH, label: `More for ${SAFE_ODDS}% on every goal` });
  const scale = Math.max(surplus, committed, safeTotal, 1);
  const at = (v: number) => `${(v / scale) * 100}%`;

  const legend = [
    { label: "To goals", value: short(committed), dot: "conic-gradient(var(--accent-500) 0 0)", emoji: "🎯", tone: "text-ink", note: "" },
    { label: "Free", value: short(Math.max(0, free)), dot: "var(--accent-500)", tone: free > 0 ? "text-accent-700" : "text-ink", note: free < 0 ? `goals ${short(-free)} over` : "" },
    ...(gap ? [{ label: `Short for ${SAFE_ODDS}% on all`, value: short(gap), dot: HATCH, tone: "text-warning-text", note: "" }] : []),
  ];

  return (
    <Card>
      <CardTitle
        action={plan.linkedSips > 0 ? (
          <span className="text-[12px] font-medium text-muted" title="Linked SIPs and EPF leave before the surplus, so they aren't in this bar.">
            + {short(plan.linkedSips)}/mo linked SIPs, EPF
          </span>
        ) : undefined}
      >
        Monthly money
      </CardTitle>

      <div className="relative mt-9">
        {/* Surplus marker */}
        <div className="pointer-events-none absolute -bottom-1.5 -top-7" style={{ left: at(surplus) }} aria-hidden>
          <span className="absolute -top-0.5 -translate-x-1/2 whitespace-nowrap text-[12px] font-bold tabular-nums text-ink">
            Usual surplus {short(surplus)}
          </span>
          <span className="absolute bottom-0 top-5 border-l-2 border-dashed border-ink" />
        </div>
        <div
          className="flex h-7 w-full gap-[2px] overflow-hidden rounded-pill"
          role="img"
          aria-label={`Usual surplus ${short(surplus)} a month. ${segs.map((s) => `${s.label} ${short(s.amount)}`).join(", ")}`}
        >
          {segs.map((s, i) => (
            <motion.button
              type="button"
              key={s.key}
              disabled={!s.goal}
              onClick={() => s.goal && onOpen(s.key)}
              title={`${s.label} ${short(s.amount)}/mo`}
              className="h-full min-w-[3px] disabled:cursor-default"
              style={{ background: s.fill, width: at(s.amount), transformOrigin: "left" }}
              initial={reduced ? false : { scaleX: 0, opacity: 0 }}
              whileInView={{ scaleX: 1, opacity: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.7, delay: 0.15 + i * 0.05, ease: [0.22, 1, 0.36, 1] }}
            />
          ))}
        </div>
      </div>

      <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2">
        {legend.map((l) => (
          <div key={l.label} className="flex items-center gap-2">
            {"emoji" in l ? <span aria-hidden className="text-[13px]">{l.emoji}</span>
              : <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: l.dot }} />}
            <dt className="text-[13px] font-semibold text-muted">{l.label}</dt>
            <dd className={`text-[15px] font-black tabular-nums ${l.tone}`}>
              {l.value}/mo{l.note && <span className="ml-1 text-[12px] font-semibold text-warning-text">({l.note})</span>}
            </dd>
          </div>
        ))}
      </dl>

      {changes.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <span className="text-[13px] font-bold text-ink-2">What to change</span>
          {changes.map((c) => (
            <button
              key={c.text}
              type="button"
              onClick={() => onOpen(c.goalId)}
              title={c.title}
              className="inline-flex items-center gap-1.5 rounded-pill bg-surface px-3 py-1.5 text-[13px] font-semibold tabular-nums text-ink transition-colors hover:bg-surface-2"
            >
              {c.text}
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}
