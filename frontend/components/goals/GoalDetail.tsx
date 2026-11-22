"use client";

/*
 * Goal detail: the same story chart as the goal's section (what happened,
 * the plan, the moments, the range ahead), levers that move the future
 * live, when the linked money can come out, the equity glide path to the
 * date, and edit / delete.
 */

import { Link2, Unlink } from "lucide-react";
import { useMemo, useState } from "react";

import { Button, Input, Label, Segmented, Select } from "@/components/ui";
import { inr } from "@/lib/format";
import {
  KIND_EMOJI, addMonths, goalEmoji, goalStatus, suggestedReturn, wealth,
  type Goal, type Holding, type WealthView,
} from "@/lib/wealth";

import { GlidePath } from "./charts";
import { endOfMonth, monthsTo, type MonthlyPlan, type OddsRow } from "./model";
import {
  SAFE_ODDS, equityFor, equityNow, freeUps, glidePath, monthlyForOdds, simInput, simulate,
} from "./odds";
import { EmojiPicker, Lever, OddsBadge } from "./parts";
import { goalStory } from "./story";
import StoryChart from "./StoryChart";
import { monYear, perMonth, short, spanShort } from "./words";

export default function GoalDetail({
  row, color, view, plan, allAssets, onClose,
}: {
  row: OddsRow;
  color: string;
  view: WealthView;
  plan: MonthlyPlan;
  allAssets?: number;
  onClose: () => void;
}) {
  const { asOf, state } = view;
  const profile = state.profile;
  const step = profile.sipStepUpPct;
  const g = row.goal;

  const [name, setName] = useState(g.name);
  const [emoji, setEmoji] = useState(goalEmoji(g));
  const [priority, setPriority] = useState(g.priority);
  const [amount, setAmount] = useState(g.targetToday);
  const [monthly, setMonthly] = useState(g.monthly);
  const [months, setMonths] = useState(monthsTo(asOf, g.targetDate));
  const [ret, setRet] = useState(g.expectedReturn);
  const [linked, setLinked] = useState<Set<string>>(() => new Set(row.status.linked.map((h) => h.id)));
  const [confirmDelete, setConfirmDelete] = useState(false);

  const origMonths = monthsTo(asOf, g.targetDate);
  const targetDate = months === origMonths ? g.targetDate : endOfMonth(addMonths(asOf, months));
  const draft: Goal = {
    ...g, name: name.trim() || g.name, emoji, priority, targetToday: amount, monthly, targetDate, expectedReturn: ret,
  };
  const holdings: Holding[] = useMemo(
    () => state.holdings.map((h) => ({
      ...h,
      goalId: linked.has(h.id) ? g.id : h.goalId === g.id ? undefined : h.goalId,
    })),
    [state.holdings, linked, g.id],
  );
  const s = goalStatus(draft, holdings, asOf, step);
  const fromSips = s.monthly - monthly;
  const input = simInput(draft, s, step);
  const sim = useMemo(() => simulate(input),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [input.current, input.monthly, input.expectedReturn, input.months, input.target, step]);
  // Total monthly for SAFE_ODDS: independent of the monthly lever, so it stays put while dragging it.
  const safeTotal = useMemo(
    () => (s.current >= s.target ? 0 : monthlyForOdds(input, SAFE_ODDS, s.neededMonthly)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [input.current, input.expectedReturn, input.months, input.target, step],
  );
  const safeOwn = Math.max(0, safeTotal - fromSips);
  const ups = freeUps(draft, s.linked, asOf, profile);
  const story = useMemo(() => goalStory(draft, s, asOf, step),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s.current, s.monthly, s.target, s.months, ret, targetDate, step, asOf, g]);
  const retirement = g.kind === "retirement";
  const glide = glidePath(s.months, asOf, retirement);
  const eqNow = equityNow(s.linked, draft.saved);
  const eqWant = equityFor(s.months, retirement);

  const origLinked = new Set(row.status.linked.map((h) => h.id));
  const linkChanged = linked.size !== origLinked.size || Array.from(linked).some((id) => !origLinked.has(id));
  const dirty = name.trim() !== g.name || emoji !== goalEmoji(g) || priority !== g.priority || amount !== g.targetToday
    || monthly !== g.monthly || months !== origMonths || ret !== g.expectedReturn || linkChanged;

  const monthlyMax = useMemo(
    () => Math.max(5000, Math.ceil(Math.max(safeOwn * 1.5, g.monthly * 2) / 1000) * 1000),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [safeTotal],
  );
  const monthsMax = Math.max(120, Math.ceil((origMonths + 60) / 12) * 12);
  const free = plan.free == null ? null : plan.free - (monthly - g.monthly);
  const sugg = g.kind === "emergency" ? 6.5 : suggestedReturn(months);

  function save() {
    wealth.saveGoal({ ...draft });
    for (const h of state.holdings) {
      const was = origLinked.has(h.id);
      const now = linked.has(h.id);
      if (was !== now) wealth.linkHolding(h.id, now ? g.id : undefined);
    }
    onClose();
  }

  const unlinked = state.holdings.filter((h) => !linked.has(h.id));
  const goalName = (id?: string) => state.goals.find((x) => x.id === id)?.name;

  return (
    <div className="grid items-start gap-x-8 gap-y-6 md:grid-cols-12">
      {/* What happens */}
      <div className="min-w-0 md:col-span-7 md:row-start-1">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <OddsBadge pct={sim.successPct} size="lg" />
          <dl className="grid grid-cols-3 gap-4 text-right">
            <Outcome label="Bad mkts" value={sim.p10} target={s.target} />
            <Outcome label="Likely" value={sim.p50} target={s.target} strong />
            <Outcome label="Good mkts" value={sim.p90} target={s.target} />
          </dl>
        </div>
        <p className="mt-2 text-[13px] font-medium text-muted">
          🎯 {short(s.target)} by {monYear(targetDate)}
          {draft.inflation > 0 && <> · {short(amount)} today + {draft.inflation}%/yr</>}
          {" "}· {spanShort(s.months)}
        </p>

        <div className="mt-4">
          <StoryChart
            story={story}
            bands={sim.bands}
            target={s.target}
            targetDate={targetDate}
            plannedDate={g.plannedDate}
            asOf={asOf}
            color={color}
            height={280}
          />
          {story.delay != null && story.delay > 0 && (
            <p className="mt-2 text-[13px] font-semibold text-muted">
              {story.mode === "market" ? "Markets" : "Setbacks"} cost <span className="text-warning-text">{story.delay} mo</span>
              {" · "}plan reaches 🎯 {story.etaPlan ? monYear(story.etaPlan) : "later"}, now {story.etaActual ? monYear(story.etaActual) : "later"}
            </p>
          )}
          {ups.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-2">
              {ups.map((u) => (
                <li key={u.holding.id} title={u.note}
                  className={`rounded-pill bg-surface px-3 py-1.5 text-[13px] font-semibold tabular-nums ${u.late || u.risky ? "text-warning-text" : "text-ink-2"}`}>
                  <span aria-hidden>{KIND_EMOJI[u.holding.kind]}</span> {short(u.holding.current)} · {u.from ? `${u.kind === "lock" ? "🔒" : "fee till"} ${monYear(u.from)}` : "any day"}
                </li>
              ))}
            </ul>
          )}
        </div>

      </div>

      {/* The levers and the money linked */}
      <div className="min-w-0 md:col-span-5 md:col-start-8 md:row-start-1">
        <div className="rounded-m bg-surface p-5">
          <div className="space-y-6">
            <Lever
              label="You put in"
              value={monthly}
              display={`${perMonth(monthly)}/mo`}
              min={0}
              max={monthlyMax}
              step={100}
              onChange={setMonthly}
              ariaValueText={`${inr(monthly)} a month`}
              hint={<>
                {fromSips > 0 && <>+{short(fromSips)} linked SIPs · </>}
                {SAFE_ODDS}% needs {short(safeOwn)}{fromSips > 0 && <> + {short(fromSips)} SIP</>}
                {Math.abs(safeOwn - monthly) >= 100 && <> <button type="button" className="text-link" onClick={() => setMonthly(safeOwn)}>Use</button></>}
                {free != null && free < 0 && <span className="text-warning-text"> · {short(-free)} over surplus</span>}
              </>}
            />
            <Lever
              label="Date"
              value={months}
              display={monYear(targetDate)}
              min={1}
              max={monthsMax}
              step={1}
              onChange={setMonths}
              ariaValueText={monYear(targetDate)}
            />
            <Lever
              label="Return"
              value={ret}
              display={`${ret}%/yr`}
              min={4}
              max={14}
              step={0.5}
              onChange={setRet}
              ariaValueText={`${ret}% a year`}
              hint={ret !== sugg ? <>Fits {spanShort(months)}: {sugg}% <button type="button" className="text-link" onClick={() => setRet(sugg)}>Use</button></> : undefined}
            />
          </div>
        </div>

        <div className="mt-6">
          <p className="text-[13px] font-semibold text-ink-2">Linked money</p>
          {s.linked.length > 0 ? (
            <ul className="mt-2 divide-y divide-line">
              {s.linked.map((h) => (
                <li key={h.id} className="flex items-center gap-2 py-2">
                  <span aria-hidden>{KIND_EMOJI[h.kind]}</span>
                  <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">{h.name}</span>
                  <span className="text-[13px] font-semibold tabular-nums text-muted">{short(h.current)}</span>
                  <Button
                    variant="ghost" size="sm"
                    onClick={() => setLinked((prev) => { const n = new Set(prev); n.delete(h.id); return n; })}
                    aria-label={`Unlink ${h.name}`}
                  >
                    <Unlink className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm font-medium text-muted">{state.holdings.length ? "None yet" : "Add investments on the Wealth tab"}</p>
          )}
          {unlinked.length > 0 && (
            <div className="mt-2 flex items-center gap-2">
              <Link2 className="h-4 w-4 shrink-0 text-muted" strokeWidth={1.75} aria-hidden />
              <Select
                aria-label="Link an investment"
                value=""
                onChange={(e) => { const id = e.target.value; if (id) setLinked((prev) => new Set(prev).add(id)); }}
                className="!h-11 text-[15px]"
              >
                <option value="">Link an investment…</option>
                {unlinked.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name} ({short(h.current)}){h.goalId ? ` · now ${goalName(h.goalId)}` : ""}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>

      </div>

      {/* Glide path and the all-assets view (after the levers on phones) */}
      <div className="min-w-0 md:col-span-7 md:row-start-2">
        {allAssets != null && <CountEverything linked={sim.p50} all={allAssets} target={s.target} color={color} />}

        <div className={`${allAssets != null ? "mt-4" : ""} rounded-m bg-surface p-4`}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-[15px] font-black text-ink">Equity glide path</p>
            {eqNow != null && (
              <p className={`text-[13px] font-semibold tabular-nums ${Math.abs(eqNow - eqWant) > 20 ? "text-warning-text" : "text-muted"}`}>
                Now {Math.round(eqNow)}% · aim {eqWant}%
                {eqNow - eqWant > 20 ? " · shift to debt" : eqWant - eqNow > 20 ? " · room for equity" : ""}
              </p>
            )}
          </div>
          {glide.every((x) => x.equity === 0)
            ? <p className="mt-2 text-[13px] font-semibold text-muted">🛡️ Under a year to go: keep it out of equity</p>
            : <GlidePath steps={glide} now={eqNow} />}
        </div>
      </div>

      {/* Edit */}
      <div className="min-w-0 md:col-span-5 md:col-start-8 md:row-start-2">
        <div className="space-y-4">
          <EmojiPicker value={emoji} onChange={setEmoji} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-1 lg:grid-cols-2">
            <div>
              <Label htmlFor="goal-name">Name</Label>
              <Input id="goal-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="goal-amount">Cost today (₹)</Label>
              <Input
                id="goal-amount"
                inputMode="numeric"
                value={amount ? amount.toLocaleString("en-IN") : ""}
                onChange={(e) => setAmount(Number(e.target.value.replace(/[^\d]/g, "")) || 0)}
              />
            </div>
          </div>
          <Segmented
            ariaLabel="Priority"
            value={priority}
            onChange={(v) => setPriority(v)}
            options={[{ value: "must", label: "Must have" }, { value: "want", label: "Nice to have" }]}
          />
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-end gap-3">
          {confirmDelete ? (
            <>
              <span className="mr-auto text-sm font-medium text-ink-2">Delete? Linked money stays put.</span>
              <Button variant="ghost" size="md" onClick={() => setConfirmDelete(false)}>Keep</Button>
              <Button variant="danger" size="md" onClick={() => { wealth.removeGoal(g.id); onClose(); }}>Delete goal</Button>
            </>
          ) : (
            <>
              <button type="button" className="mr-auto text-sm font-semibold text-muted transition-colors hover:text-danger-text" onClick={() => setConfirmDelete(true)}>
                Delete
              </button>
              <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
              <Button variant="primary" size="md" disabled={!dirty} onClick={save}>Save</Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Outcome({ label, value, target, strong }: { label: string; value: number; target: number; strong?: boolean }) {
  const hit = value >= target;
  return (
    <div className="flex flex-col-reverse">
      <dt className="mt-1 text-[12px] font-semibold text-muted">{label}</dt>
      <dd className={`text-[17px] font-black tabular-nums leading-none md:text-[19px] ${hit ? "text-success-text" : strong ? "text-ink" : "text-ink-2"}`}>
        {short(value)}
      </dd>
    </div>
  );
}

/** Retirement: the linked pot alone against everything you'd own at retirement. */
function CountEverything({ linked, all, target, color }: { linked: number; all: number; target: number; color: string }) {
  const scale = Math.max(all, linked, target) * 1.05;
  const row = (label: string, v: number, bg: string) => (
    <div className="grid grid-cols-[92px_1fr_56px] items-center gap-2">
      <span className="text-[12px] font-semibold text-muted">{label}</span>
      <div className="relative h-3 rounded-pill bg-surface-2">
        <div className="h-full rounded-pill" style={{ width: `${(v / scale) * 100}%`, background: bg }} />
      </div>
      <span className="text-right text-[13px] font-bold tabular-nums text-ink">{short(v)}</span>
    </div>
  );
  return (
    <div className="relative mt-6 space-y-2 rounded-m bg-surface p-4" title="The odds count only the linked funds. Net worth counts everything you'd still own.">
      {row("Linked funds", linked, color)}
      {row("All you own", all, "var(--accent-500)")}
      <div className="relative ml-[100px] mr-[64px] h-4">
        <span className="absolute -translate-x-1/2 whitespace-nowrap text-[12px] font-semibold text-muted" style={{ left: `${(target / scale) * 100}%` }}>
          need {short(target)}
        </span>
      </div>
      <div className="pointer-events-none absolute bottom-8 left-[116px] right-[80px] top-3" aria-hidden>
        <div className="absolute inset-y-0 border-l-2 border-dashed border-ink-2" style={{ left: `${(target / scale) * 100}%` }} />
      </div>
    </div>
  );
}
