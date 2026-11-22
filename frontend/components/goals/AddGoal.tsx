"use client";

/*
 * Add a goal: pick a type, set the amount and date, and watch the what-if
 * update: the monthly amount for 80% odds, the odds and range at what you
 * can afford, whether it fits the free money, which goals it would squeeze
 * if it doesn't (always shown when nothing is free), one date that would fit, and the change to net worth at 55.
 */

import { ArrowLeft, ArrowRight } from "lucide-react";
import { useMemo, useState } from "react";
import clsx from "clsx";

import { Button, Input, Label, Segmented } from "@/components/ui";
import { addMonths, goalEmoji, inflate, wealth, type WealthView } from "@/lib/wealth";

import { MiniFan } from "./charts";
import {
  draftGoal, endOfMonth, suggestEmoji, suggestedReturn, templates, whatIf,
  type Draft, type MonthlyPlan, type Template, type TemplateKey,
} from "./model";
import { SAFE_ODDS, monthlyForOdds, simulate, type SimInput } from "./odds";
import { EmojiPicker, Lever, OddsBadge } from "./parts";
import { monYear, short, spanShort } from "./words";

export function useTemplates(view: WealthView) {
  const p = view.state.profile;
  return useMemo(() => templates(view.monthlyExpenses, p.age, p.retireAge), [view.monthlyExpenses, p.age, p.retireAge]);
}

export function TemplatePicker({ list, onPick, compact = false }: { list: Template[]; onPick: (t: Template) => void; compact?: boolean }) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {list.map((t) => (
        <li key={t.key}>
          <button
            type="button"
            onClick={() => onPick(t)}
            className="flex h-full w-full items-center gap-3 rounded-m bg-card p-4 text-left shadow-flat transition-[background,transform] duration-200 hover:bg-surface active:scale-[.98] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-[3px] focus-visible:outline-accent-500"
          >
            <span className="text-[28px] leading-none" aria-hidden>{t.emoji}</span>
            <span className="min-w-0">
              <span className="block text-[16px] font-black text-ink">{t.label}</span>
              {!compact && t.key !== "custom" && (
                <span className="mt-0.5 block text-[13px] font-semibold tabular-nums text-muted">{short(t.amount)} · {spanShort(t.months)}</span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function fromTemplate(t: Template): Draft {
  return {
    name: t.name, emoji: t.emoji, emojiPicked: false, kind: t.kind, amount: t.amount, months: t.months, saved: 0,
    expectedReturn: t.kind === "emergency" ? 6.5 : suggestedReturn(t.months),
    inflation: t.inflation, priority: t.priority,
  };
}

export default function AddGoal({
  view, plan, initial, onDone,
}: {
  view: WealthView;
  plan: MonthlyPlan;
  initial?: TemplateKey | null;
  onDone: () => void;
}) {
  const list = useTemplates(view);
  const start = initial ? list.find((t) => t.key === initial) ?? null : null;
  const [draft, setDraft] = useState<Draft | null>(start ? fromTemplate(start) : null);
  const [retTouched, setRetTouched] = useState(false);

  if (!draft) {
    return <TemplatePicker list={list} onPick={(t) => { setDraft(fromTemplate(t)); setRetTouched(false); }} />;
  }

  const set = (p: Partial<Draft>) => setDraft((d) => {
    const next = { ...d!, ...p };
    if (p.months != null && !retTouched && next.kind !== "emergency") next.expectedReturn = suggestedReturn(next.months);
    if (p.name != null && !next.emojiPicked) next.emoji = suggestEmoji(next.name, next.kind);
    return next;
  });

  return (
    <PlanStep
      draft={draft}
      set={set}
      view={view}
      plan={plan}
      onBack={() => setDraft(null)}
      onReturn={(v) => { setRetTouched(true); set({ expectedReturn: v }); }}
      onSave={(monthly) => {
        const g = draftGoal(draft, view.asOf, monthly);
        const { id: _id, createdAt: _c, ...rest } = g;
        wealth.saveGoal({ ...rest, name: draft.name.trim() || "New goal" });
        onDone();
      }}
    />
  );
}

function PlanStep({
  draft, set, view, plan, onBack, onReturn, onSave,
}: {
  draft: Draft;
  set: (p: Partial<Draft>) => void;
  view: WealthView;
  plan: MonthlyPlan;
  onBack: () => void;
  onReturn: (v: number) => void;
  onSave: (monthly: number) => void;
}) {
  const step = view.state.profile.sipStepUpPct;
  const date = endOfMonth(addMonths(view.asOf, draft.months));
  const target = inflate(draft.amount, draft.inflation, draft.months);
  const input: SimInput = useMemo(() => ({
    id: `draft-${draft.kind}`, current: draft.saved, monthly: 0, expectedReturn: draft.expectedReturn,
    months: draft.months, target, step,
  }), [draft.kind, draft.saved, draft.expectedReturn, draft.months, target, step]);
  const safe = useMemo(() => (draft.saved >= target ? 0 : monthlyForOdds(input, SAFE_ODDS)), [input, draft.saved, target]);
  const w = useMemo(() => whatIf(draft, view, plan, safe), [draft, view, plan, safe]);

  // Odds at what you can actually afford, when the full amount doesn't fit.
  const affordable = w.free != null && !w.fits ? Math.max(0, Math.floor(w.free / 100) * 100) : w.needed;
  const sim = useMemo(() => simulate({ ...input, monthly: affordable }), [input, affordable]);
  const sugg = draft.kind === "emergency" ? 6.5 : suggestedReturn(draft.months);

  return (
    <div className="grid gap-8 md:grid-cols-12">
      {/* The goal */}
      <div className="min-w-0 md:col-span-6">
        <button type="button" onClick={onBack} className="text-link inline-flex items-center gap-1.5 text-sm">
          <ArrowLeft className="h-4 w-4" strokeWidth={1.75} aria-hidden /> Type
        </button>

        <div className="mt-4 space-y-5">
          <EmojiPicker value={draft.emoji} onChange={(e) => set({ emoji: e, emojiPicked: true })} />
          <div>
            <Label htmlFor="new-goal-name">Name</Label>
            <Input id="new-goal-name" placeholder="Goa with friends" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="new-goal-amount">Cost today (₹)</Label>
              <Input
                id="new-goal-amount"
                inputMode="numeric"
                value={draft.amount ? draft.amount.toLocaleString("en-IN") : ""}
                onChange={(e) => set({ amount: Number(e.target.value.replace(/[^\d]/g, "")) || 0 })}
              />
            </div>
            <div>
              <Label htmlFor="new-goal-saved">Saved (₹)</Label>
              <Input
                id="new-goal-saved"
                inputMode="numeric"
                placeholder="0"
                value={draft.saved ? draft.saved.toLocaleString("en-IN") : ""}
                onChange={(e) => set({ saved: Number(e.target.value.replace(/[^\d]/g, "")) || 0 })}
              />
            </div>
          </div>
          <Lever
            label="When"
            value={draft.months}
            display={monYear(date)}
            min={1}
            max={Math.max(360, draft.months)}
            step={1}
            onChange={(v) => set({ months: v })}
            ariaValueText={monYear(date)}
            hint={draft.inflation > 0 ? `🎯 ${short(w.target)} then, at ${draft.inflation}% inflation` : undefined}
          />
          <Lever
            label="Return"
            value={draft.expectedReturn}
            display={`${draft.expectedReturn}%/yr`}
            min={4}
            max={14}
            step={0.5}
            onChange={onReturn}
            ariaValueText={`${draft.expectedReturn}% a year`}
            hint={<>
              {draft.months < 36 ? "Debt" : draft.months < 84 ? "Hybrid" : "Equity"} fits {spanShort(draft.months)}: {sugg}%
              {draft.expectedReturn !== sugg && <> <button type="button" className="text-link" onClick={() => onReturn(sugg)}>Use</button></>}
            </>}
          />
          <Segmented
            ariaLabel="Priority"
            value={draft.priority}
            onChange={(v) => set({ priority: v })}
            options={[{ value: "must", label: "Must have" }, { value: "want", label: "Nice to have" }]}
          />
        </div>
      </div>

      {/* The what-if */}
      <div className="min-w-0 md:col-span-6">
        <section aria-live="polite" className="rounded-m bg-surface p-5 md:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[13px] font-semibold text-muted">For {SAFE_ODDS}% odds</p>
              <p className="mt-1 text-[34px] font-black leading-none tabular-nums text-ink">
                {short(w.needed)}<span className="ml-1 text-base font-semibold text-ink-2">/mo</span>
              </p>
              <p className="mt-1.5 text-[13px] font-medium text-muted">+{step}% a year · 🎯 {short(w.target)}</p>
            </div>
            <div className="text-right">
              <OddsBadge pct={sim.successPct} />
              <p className="mt-1 text-[12px] font-semibold tabular-nums text-muted">at {short(affordable)}/mo</p>
            </div>
          </div>

          <div className="mt-4">
            <MiniFan bands={sim.bands} target={w.target} color="var(--accent-500)" height={96} />
          </div>

          <FitBar w={w} />

          {w.fits === false && w.squeeze.length > 0 && (
            <div className="mt-5">
              <p className="text-[13px] font-semibold text-muted">
                {(w.free ?? 0) <= 0
                  ? <>Nothing free{(w.free ?? 0) < 0 && <> (goals already {short(-(w.free ?? 0))}/mo over)</>}. This would squeeze</>
                  : "Or take from"}
              </p>
              <ul className="mt-2 space-y-1.5">
                {w.squeeze.map((q) => {
                  const late = !q.newEta || q.newEta > q.row.goal.targetDate;
                  return (
                    <li key={q.row.goal.id} className="flex items-center gap-2 text-[14px]">
                      <span aria-hidden>{goalEmoji(q.row.goal)}</span>
                      <span className="min-w-0 flex-1 truncate font-semibold text-ink">{q.row.goal.name}</span>
                      <span className="font-semibold tabular-nums text-ink-2">−{short(q.cut)}</span>
                      <span className={clsx("inline-flex items-center gap-1 tabular-nums", late ? "text-warning-text" : "text-muted")}>
                        {monYear(q.row.goal.targetDate).replace(" 20", " ’")}
                        <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                        <b>{q.newEta ? monYear(q.newEta).replace(" 20", " ’") : "never"}</b>
                      </span>
                    </li>
                  );
                })}
              </ul>
              {!w.squeezeCovers && <p className="mt-2 text-[13px] font-semibold text-warning-text">Still short after these</p>}
            </div>
          )}

          {w.alt && (
            <button
              type="button"
              onClick={() => set({ months: w.alt!.months })}
              className="mt-5 flex w-full items-center justify-between gap-3 rounded-m bg-card p-3 text-left shadow-flat transition-colors hover:bg-surface"
            >
              <span className="text-[14px] text-ink-2">
                📅 <b className="text-ink">{monYear(w.alt.date)}</b> · {short(w.alt.monthly)}/mo
              </span>
              <span className="text-link text-sm">{w.alt.later ? "Fits. Use" : "Sooner. Use"}</span>
            </button>
          )}

          <div className="mt-5 flex items-center justify-between border-t border-line pt-4 text-[14px]">
            <span className="font-semibold text-muted">🌴 Net worth at {w.nw.retireAge}</span>
            <span className={clsx("font-black tabular-nums", w.nw.delta >= 0 ? "text-success-text" : "text-ink")}>
              {Math.abs(w.nw.delta) < 1000 ? "±₹0" : `${w.nw.delta > 0 ? "+" : "−"}${short(Math.abs(w.nw.delta)).replace("−", "")}`}
            </span>
          </div>
        </section>

        <div className="mt-6 flex justify-end">
          <Button variant="primary" size="lg" onClick={() => onSave(w.needed)} disabled={draft.amount <= 0}>
            Add at {short(w.needed)}/mo
          </Button>
        </div>
      </div>
    </div>
  );
}

function FitBar({ w }: { w: ReturnType<typeof whatIf> }) {
  if (w.free == null) return null;
  const free = Math.max(0, w.free);
  const scale = Math.max(free, w.needed, 1);
  const used = Math.min(free, w.needed);
  // Goals already over the surplus count against the new one too.
  const over = Math.max(0, w.needed - w.free);
  return (
    <div className="mt-4">
      <div className="relative flex h-3 w-full gap-[2px] overflow-hidden rounded-pill bg-card" aria-hidden>
        {used > 0 && <div className="h-full rounded-pill bg-accent-500 transition-[width] duration-500" style={{ width: `${(used / scale) * 100}%` }} />}
        {over > 0 && <div className="h-full rounded-pill bg-warning transition-[width] duration-500" style={{ width: `${(over / scale) * 100}%` }} />}
      </div>
      <div className="mt-1.5 flex justify-between text-[13px] font-semibold tabular-nums">
        <span className="text-muted">Free {short(free)}/mo</span>
        {over > 0
          ? <span className="text-warning-text">{short(over)} short</span>
          : <span className="text-success-text">{short(w.left ?? 0)} left</span>}
      </div>
    </div>
  );
}
