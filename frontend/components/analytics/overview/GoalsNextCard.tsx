"use client";

/*
 * The next three goals by date, with the same odds and words as the Goals
 * page (goalOdds / OddsBadge). The emergency fund lives on Wealth, so it's
 * left out here.
 */

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";

import { goalOdds } from "@/components/goals/odds";
import { EmojiDot, OddsBadge } from "@/components/goals/parts";
import { monYear } from "@/components/goals/words";
import { Card, Skeleton } from "@/components/ui";
import { goalEmoji, type WealthView } from "@/lib/wealth";

import { humanInr } from "../fmt";

export default function GoalsNextCard({ w, className }: { w: WealthView; className?: string }) {
  const step = w.state.profile.sipStepUpPct;
  const next = useMemo(
    () => w.goals
      .filter((g) => g.goal.kind !== "emergency" && g.status.status !== "done")
      .slice(0, 3)
      .map((g) => ({ ...g, odds: goalOdds(g.goal, g.status, step) })),
    [w.goals, step],
  );

  return (
    <Card className={`flex h-full flex-col ${className ?? ""}`}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-h3 font-black text-ink">🎯 Next goals</h2>
        <Link href="/goals" className="-my-2 inline-flex min-h-[44px] items-center gap-1 rounded-pill px-2 text-sm font-semibold text-accent-700 hover:underline">
          Goals <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
        </Link>
      </div>
      {w.isLoading && !w.hasGoals ? (
        <div className="mt-4 space-y-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : next.length === 0 ? (
        <div className="mt-4">
          <p className="text-[20px] font-black text-ink">{w.hasGoals ? "Every goal is funded" : "No goals yet"}</p>
          <p className="mt-1 text-sm font-medium text-muted">✈️ A trip, 🏠 a home, 🌴 retiring early.</p>
          {!w.hasGoals && <Link href="/goals" className="btn ghost sm mt-4">Set a goal</Link>}
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {next.map(({ goal, status, odds }) => (
            <li key={goal.id}>
              <Link href="/goals" className="flex items-center gap-3 py-3 transition-colors hover:bg-surface/60">
                <EmojiDot emoji={goalEmoji(goal)} size={40} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base font-semibold text-ink">{goal.name}</p>
                  <p className="text-[13px] font-medium tabular-nums text-muted">{humanInr(status.target)} by {monYear(goal.targetDate)}</p>
                </div>
                <OddsBadge pct={odds.pct} size="sm" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
