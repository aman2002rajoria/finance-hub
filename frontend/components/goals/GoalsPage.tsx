"use client";

/*
 * Goals: a few goals, each with its real story.
 *
 * The headline counts the likely ones and the monthly top-up for 80% on
 * all. One bar splits the usual surplus into goals and free / short, with
 * two or three realistic changes. Each goal gets a roomy section: what
 * happened against the plan, the range ahead, and the numbers to act on.
 * Net worth at retirement closes the page.
 */

import { Plus } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { MotionReveal } from "@/components/motion/MotionReveal";
import {
  Button, Card, ErrorCard, IllustrationSlot, Modal, Skeleton,
} from "@/components/ui";
import { goalEmoji, useWealth } from "@/lib/wealth";

import AddGoal, { TemplatePicker, useTemplates } from "./AddGoal";
import GoalCard from "./GoalCard";
import GoalDetail from "./GoalDetail";
import { goalColors, monthlyPlan, type GoalRow, type OddsRow, type TemplateKey } from "./model";
import NetWorthImpact, { useNetWorthPath } from "./NetWorthImpact";
import { ODDS_TEXT, SAFE_ODDS, goalOdds, oddsLabel, oddsTone } from "./odds";
import PlanCard from "./PlanCard";
import { whatToChange } from "./story";
import { short } from "./words";

export default function GoalsPage() {
  const view = useWealth();
  const [mounted, setMounted] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ template: TemplateKey | null } | null>(null);
  useEffect(() => setMounted(true), []);

  const step = view.state.profile.sipStepUpPct;
  const rows = view.goals as GoalRow[];
  const oddsRows: OddsRow[] = useMemo(
    () => rows.map((r) => ({ ...r, odds: goalOdds(r.goal, r.status, step) })),
    [rows, step],
  );
  const colors = useMemo(() => goalColors(rows), [rows]);
  const plan = useMemo(() => monthlyPlan(view), [view]);
  const path = useNetWorthPath(view);
  const changes = useMemo(() => whatToChange(oddsRows, view.markers, view.asOf, step), [oddsRows, view.markers, view.asOf, step]);
  const tpl = useTemplates(view);

  const openAdd = useCallback((template: TemplateKey | null = null) => setAdding({ template }), []);
  const closeAdd = useCallback(() => setAdding(null), []);
  const closeDetail = useCallback(() => setOpenId(null), []);

  if (!mounted || (view.isLoading && !view.error)) return <GoalsSkeleton />;

  if (view.error && view.income <= 0 && rows.length === 0) {
    return (
      <div className="space-y-8">
        <h1 className="text-[32px] font-black leading-[1.08] tracking-[-0.01em] text-ink md:text-h1">Your goals</h1>
        <ErrorCard
          title="Your goals didn't load"
          message="We couldn't reach the Finance Hub server for your income and spending, which every goal is measured against. Check it's running, then try again."
          onRetry={view.retry}
        />
      </div>
    );
  }

  const addModal = (
    <Modal open={!!adding} onClose={closeAdd} title="Add a goal" width="max-w-[1000px]">
      {adding && <AddGoal view={view} plan={plan} initial={adding.template} onDone={closeAdd} />}
    </Modal>
  );

  if (rows.length === 0) {
    return (
      <>
        <EmptyGoals onAdd={openAdd} picker={<TemplatePicker list={tpl} compact onPick={(t) => openAdd(t.key)} />} />
        {addModal}
      </>
    );
  }

  const likely = oddsRows.filter((r) => r.odds.pct >= SAFE_ODDS).length;
  const open = oddsRows.find((r) => r.goal.id === openId);
  const retirement = oddsRows.find((r) => r.goal.kind === "retirement");
  const nwEnd = path.at(-1)?.netWorth;
  const usedKinds = new Set(rows.map((r) => r.goal.kind));
  // The emergency fund lives on Wealth and retirement in the net worth chart.
  const ideas = tpl.filter((t) => !["custom", "emergency", "retirement"].includes(t.key) && !usedKinds.has(t.kind)).slice(0, 4);

  return (
    <div className="space-y-6 md:space-y-8">
      {/* 1. The answer, in numbers */}
      <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5">
        <div className="min-w-0">
          <MotionReveal>
            <h1 className="text-[32px] font-black leading-[1.06] tracking-[-0.01em] text-ink tabular-nums md:text-[48px]">
              {likely} of {rows.length} likely
            </h1>
          </MotionReveal>
          <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[17px] font-bold">
            {oddsRows.map((r) => (
              <span key={r.goal.id} className="tabular-nums text-ink-2">
                <span aria-hidden>{goalEmoji(r.goal)}</span> <span className={ODDS_TEXT[oddsTone(r.odds.pct)]}>{oddsLabel(r.odds.pct)}</span>
              </span>
            ))}
          </p>
        </div>
        <Button variant="primary" size="lg" onClick={() => openAdd()}>
          <Plus className="h-5 w-5" strokeWidth={2} aria-hidden /> Add a goal
        </Button>
      </header>

      {/* 2. The monthly money */}
      <MotionReveal>
        <PlanCard rows={oddsRows} plan={plan} colors={colors} changes={changes} onOpen={setOpenId} />
      </MotionReveal>

      {/* 3. Each goal */}
      <section aria-label="Each goal" className="space-y-4 md:space-y-6">
        {oddsRows.map((r, i) => (
          <MotionReveal key={r.goal.id} index={i}>
            <GoalCard
              row={r}
              color={colors.get(r.goal.id)!}
              asOf={view.asOf}
              profile={view.state.profile}
              onOpen={() => setOpenId(r.goal.id)}
            />
          </MotionReveal>
        ))}
      </section>

      {ideas.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-sm font-semibold text-muted">Add</span>
          {ideas.map((t) => (
            <Button key={t.key} variant="ghost" size="sm" onClick={() => openAdd(t.key)}>
              <span aria-hidden>{t.emoji}</span> {t.label}
            </Button>
          ))}
        </div>
      )}

      {/* 4. The long view */}
      <MotionReveal>
        <NetWorthImpact view={view} retirement={retirement} retireColor={retirement ? colors.get(retirement.goal.id) : undefined} />
      </MotionReveal>

      {addModal}
      <Modal open={!!open} onClose={closeDetail} title={open ? `${goalEmoji(open.goal)} ${open.goal.name}` : ""} width="max-w-[1040px]">
        {open && (
          <GoalDetail
            key={open.goal.id}
            row={open}
            color={colors.get(open.goal.id)!}
            view={view}
            plan={plan}
            allAssets={open.goal.kind === "retirement" ? nwEnd : undefined}
            onClose={closeDetail}
          />
        )}
      </Modal>
    </div>
  );
}

/* ----------------------------------------------------------- states */

function EmptyGoals({ onAdd, picker }: { onAdd: () => void; picker: React.ReactNode }) {
  return (
    <div className="space-y-8">
      <h1 className="text-[32px] font-black leading-[1.08] tracking-[-0.01em] text-ink md:text-h1">Your goals</h1>
      <Card className="!p-6 md:!p-10">
        <div className="mx-auto flex max-w-[760px] flex-col items-center text-center">
          <IllustrationSlot label="piggy bank" size={128} />
          <h2 className="mt-6 text-[26px] font-black leading-[1.15] text-ink md:text-h2">Give your money a job</h2>
          <p className="mt-2 max-w-[48ch] text-base text-ink-2 md:text-body-l">
            Name it, date it. See the monthly amount and the odds before you commit.
          </p>
        </div>
        <div className="mx-auto mt-8 max-w-[760px]">
          {picker}
        </div>
        <div className="mt-8 flex justify-center">
          <Button variant="primary" size="lg" onClick={() => onAdd()}>
            <Plus className="h-5 w-5" strokeWidth={2} aria-hidden /> Add your first goal
          </Button>
        </div>
      </Card>
    </div>
  );
}

function GoalsSkeleton() {
  return (
    <div className="space-y-10" aria-busy="true" aria-label="Loading your goals">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="w-full max-w-[720px]">
          <Skeleton className="h-12 w-full md:h-14" />
          <Skeleton className="mt-4 h-5 w-4/5" />
        </div>
        <Skeleton className="h-[52px] w-40 !rounded-pill" />
      </div>
      <div className="rounded-l bg-card p-6 shadow-flat">
        <Skeleton className="h-6 w-72 max-w-full" />
        <Skeleton className="mt-6 h-5 w-full !rounded-pill" />
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-5 w-full" />)}
        </div>
      </div>
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-l bg-card p-6 shadow-flat">
            <div className="flex gap-4">
              <Skeleton className="h-[76px] w-[76px] !rounded-full" />
              <div className="flex-1"><Skeleton className="h-5 w-40" /><Skeleton className="mt-2 h-4 w-28" /></div>
            </div>
            <Skeleton className="mt-5 h-[220px] w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
