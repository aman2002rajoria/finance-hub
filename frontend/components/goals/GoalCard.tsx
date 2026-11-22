"use client";

/*
 * One goal, roomy: its story on one chart (what happened, the plan, the
 * moments, the range ahead) and the few numbers worth acting on: saved vs
 * target, the gap to the plan in months, the monthly for 80% against what
 * goes in, one "what if it happens again", and where the money sits.
 */

import clsx from "clsx";
import { ChevronRight } from "lucide-react";
import type React from "react";
import { useMemo, useState } from "react";

import { KIND_EMOJI, goalEmoji, type Profile } from "@/lib/wealth";

import type { OddsRow } from "./model";
import { SAFE_ODDS, freeUps, monthlyForOdds, simInput } from "./odds";
import { EmojiDot, OddsBadge } from "./parts";
import { goalStory, type GoalStory } from "./story";
import StoryChart from "./StoryChart";
import { monYear, short, spanShort } from "./words";

export default function GoalCard({
  row, color, asOf, profile, onOpen,
}: {
  row: OddsRow;
  color: string;
  asOf: string;
  profile: Profile;
  onOpen: () => void;
}) {
  const { goal, status: s, odds } = row;
  const step = profile.sipStepUpPct;
  const story = useMemo(() => goalStory(goal, s, asOf, step), [goal, s, asOf, step]);
  // Total monthly (own + linked SIPs) for SAFE_ODDS, shown even when the goal is already there.
  const safe = useMemo(
    () => (s.current >= s.target ? 0 : odds.safeMonthly ?? monthlyForOdds(simInput(goal, s, step), SAFE_ODDS, s.neededMonthly)),
    [goal, s, step, odds.safeMonthly],
  );
  const [showHit, setShowHit] = useState(false);
  const late = !!story.etaActual && story.etaActual.slice(0, 7) > goal.targetDate.slice(0, 7);

  return (
    <article className="rounded-l bg-card p-5 shadow-flat md:p-6" aria-label={goal.name}>
      <header className="flex items-start justify-between gap-3">
        <button
          type="button"
          data-goal-open
          onClick={onOpen}
          className="group flex min-w-0 items-center gap-3 rounded-m text-left focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-[3px] focus-visible:outline-accent-500"
          aria-label={`${goal.name}: open details`}
        >
          <EmojiDot emoji={goalEmoji(goal)} size={48} />
          <span className="min-w-0">
            <span className="flex items-center gap-1 text-[19px] font-black leading-tight text-ink md:text-[22px]">
              <span className="truncate">{goal.name}</span>
              <ChevronRight className="h-5 w-5 shrink-0 text-faint transition-transform group-hover:translate-x-0.5" strokeWidth={2} aria-hidden />
            </span>
            <span className="mt-1 block text-[13px] font-semibold tabular-nums text-muted">
              {goal.plannedDate && goal.plannedDate.slice(0, 7) !== goal.targetDate.slice(0, 7) && (
                <><s className="text-faint">{monYear(goal.plannedDate)}</s> → </>
              )}
              <span className="text-ink-2">{monYear(goal.targetDate)}</span> · {spanShort(s.months)}
              {late && story.etaActual && <span className="text-warning-text"> · pace {monYear(story.etaActual)}</span>}
            </span>
          </span>
        </button>
        <OddsBadge pct={odds.pct} />
      </header>

      <div className="mt-4 grid gap-x-8 gap-y-5 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-8">
          <Legend color={color} />
          <StoryChart
            story={story}
            bands={odds.sim.bands}
            target={s.target}
            targetDate={goal.targetDate}
            plannedDate={goal.plannedDate}
            asOf={asOf}
            color={color}
            showHit={showHit}
          />
        </div>

        <dl className="grid content-start gap-4 sm:grid-cols-2 lg:col-span-4 lg:grid-cols-1">
          <Saved current={s.current} target={s.target} plan={story.planNow} color={color} />
          <VsPlan story={story} emojis={story.pins.filter((p) => p.date > story.start).map((p) => p.emoji)} />
          <Stat label="Monthly">
            <span className={clsx(s.monthly >= safe ? "text-success-text" : "text-warning-text")}>{short(s.monthly)} in</span>
            <span className="text-muted"> · {SAFE_ODDS}% needs </span>
            <span className="text-ink">{short(safe)}</span>
            {s.monthly > goal.monthly && (
              <span className="block text-[12px] font-semibold text-muted">incl. {short(s.monthly - goal.monthly)} linked SIP</span>
            )}
          </Stat>
          {story.hit && (
            <Stat label="What if">
              <button
                type="button"
                aria-pressed={showHit}
                onClick={() => setShowHit((v) => !v)}
                title={`${story.hit.label}: ${short(story.hit.amount)} out today. Shown on the chart as a dotted line.`}
                className={clsx(
                  "inline-flex max-w-full items-center gap-1.5 rounded-pill px-3 py-1.5 text-left text-[13px] font-bold tabular-nums transition-colors",
                  showHit ? "bg-warning-tint text-warning-text shadow-[0_0_0_1.5px_var(--warning)]" : "bg-surface text-ink hover:bg-surface-2",
                )}
              >
                <span aria-hidden>{story.hit.emoji}</span>
                {story.hit.label}
                <span className={showHit ? "" : "text-muted"}>→ {story.hit.eta ? monYear(story.hit.eta) : "50 yrs+"}</span>
              </button>
            </Stat>
          )}
          <Where row={row} asOf={asOf} profile={profile} />
        </dl>
      </div>
    </article>
  );
}

function Legend({ color }: { color: string }) {
  return (
    <div className="mb-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] font-semibold text-muted" aria-hidden>
      <span className="inline-flex items-center gap-1.5"><span className="h-[3px] w-4 rounded-pill" style={{ background: color }} />Saved</span>
      <span className="inline-flex items-center gap-1.5"><span className="w-4 border-t-2 border-dashed border-faint" />Plan</span>
      <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-[3px]" style={{ background: color, opacity: 0.22 }} />Likely range</span>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] font-semibold text-muted">{label}</dt>
      <dd className="mt-1 text-[15px] font-extrabold tabular-nums text-ink">{children}</dd>
    </div>
  );
}

function Saved({ current, target, plan, color }: { current: number; target: number; plan: number; color: string }) {
  const pct = (v: number) => `${Math.max(1.5, Math.min(100, (v / Math.max(1, target)) * 100))}%`;
  return (
    <div className="min-w-0">
      <dt className="text-[12px] font-semibold text-muted">Saved</dt>
      <dd className="mt-1 tabular-nums">
        <span className="text-[22px] font-black text-ink">{short(current)}</span>
        <span className="text-[14px] font-bold text-muted"> of {short(target)}</span>
        <div className="relative mt-2 h-2 w-full rounded-pill bg-surface-2" title={`Plan by now: ${short(plan)}`}>
          <div className="h-full rounded-pill" style={{ width: pct(current), background: color }} />
          {Math.abs(plan - current) / Math.max(1, target) > 0.005 && (
            <span className="absolute -bottom-1 -top-1 w-0 border-l-2 border-dashed border-ink-2" style={{ left: pct(plan) }} aria-hidden />
          )}
        </div>
      </dd>
    </div>
  );
}

function VsPlan({ story, emojis }: { story: GoalStory; emojis: string[] }) {
  const behind = story.gap < 0;
  const uniq = Array.from(new Set(emojis)).join("");
  return (
    <Stat label={story.mode === "market" ? "Markets vs plan" : "Setbacks vs plan"}>
      <span title={`Plan by now ${short(story.planNow)}. Plan reaches 🎯 ${story.etaPlan ? monYear(story.etaPlan) : "later"}; now ${story.etaActual ? monYear(story.etaActual) : "later"}.`}>
        {uniq && <span aria-hidden className="mr-1">{uniq}</span>}
        <span className={behind ? "text-danger-text" : "text-success-text"}>{behind ? "−" : "+"}{short(Math.abs(story.gap))}</span>
        {story.delay != null && story.delay !== 0 && (
          <span className={story.delay > 0 ? "text-warning-text" : "text-success-text"}>
            {" · "}{story.delay > 0 ? "+" : "−"}{Math.abs(story.delay)} mo
          </span>
        )}
      </span>
    </Stat>
  );
}

function Where({ row, asOf, profile }: { row: OddsRow; asOf: string; profile: Profile }) {
  const { goal, status: s } = row;
  const ups = freeUps(goal, s.linked, asOf, profile);
  return (
    <Stat label="Money sits in">
      <ul className="space-y-1 text-[13px] font-semibold">
        {goal.saved > 0 && (
          <li className="flex items-baseline justify-between gap-2">
            <span className="truncate text-ink"><span aria-hidden>💰</span> Set aside {short(goal.saved)}</span>
            <span className="shrink-0 text-success-text">any day</span>
          </li>
        )}
        {ups.map((u) => (
          <li key={u.holding.id} className="flex items-baseline justify-between gap-2" title={u.note}>
            <span className="truncate text-ink"><span aria-hidden>{KIND_EMOJI[u.holding.kind]}</span> {u.holding.name.replace(/ (Fund|Tax Saver)$/i, "")} {short(u.holding.current)}</span>
            <span className={clsx("shrink-0", u.late || u.risky ? "text-warning-text" : u.from ? "text-muted" : "text-success-text")}>
              {u.from ? `${u.kind === "lock" ? "🔒" : "fee till"} ${monYear(u.from)}` : "any day"}
            </span>
          </li>
        ))}
        {goal.saved <= 0 && ups.length === 0 && <li className="text-muted">Nothing set aside yet</li>}
      </ul>
    </Stat>
  );
}
