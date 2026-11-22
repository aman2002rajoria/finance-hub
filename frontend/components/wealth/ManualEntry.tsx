"use client";

/*
 * Manual entry for what statements can't see: investments, loans and card
 * bills, and passive income. The three forms are exported on their own so
 * the Upload page and the Wealth page share them.
 *
 * Forms ask for the minimum (name, type, money in, value now, start date)
 * and show extra fields only when the type needs them.
 */

import clsx from "clsx";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { Button, Card, CardTitle, Input, Label, Segmented, Select } from "@/components/ui";
import {
  KIND_LABEL, addMonths, monthKey, todayISO, useWealthState, wealth,
  type Holding, type HoldingKind, type IncomeKind, type Liability, type LiabilityKind,
} from "@/lib/wealth";

/* ------------------------------------------------------------ helpers */

const KIND_ORDER: HoldingKind[] = [
  "equity_mf", "elss", "debt_mf", "liquid_mf", "stocks", "fd", "bonds", "ppf", "epf", "nps", "gold", "other",
];

/** Kinds with a fixed or declared rate. */
const HAS_RATE: HoldingKind[] = ["fd", "bonds", "ppf", "epf"];
const HAS_MATURITY: HoldingKind[] = ["fd", "bonds"];
const HAS_LOCK: HoldingKind[] = ["elss", "ppf", "gold"];
const CAN_BE_EMERGENCY: HoldingKind[] = ["liquid_mf", "debt_mf", "fd"];

/** Typical lock-in from the start date, used to pre-fill the field. */
const LOCK_YEARS: Partial<Record<HoldingKind, number>> = { elss: 3, ppf: 15, gold: 5 };

const toNum = (s: string) => {
  const n = Number(String(s).replace(/[,₹\s]/g, ""));
  return isFinite(n) ? n : NaN;
};
const numStr = (n?: number) => (n == null ? "" : String(n));

function Field({
  label, children, hint, error, className, htmlFor,
}: {
  label: string; children: React.ReactNode; hint?: string; error?: string | null; className?: string; htmlFor?: string;
}) {
  return (
    <div className={className}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? (
        <p className="mt-1.5 text-[13px] font-medium text-danger-text">{error}</p>
      ) : hint ? (
        <p className="mt-1.5 text-[13px] font-medium text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

function MoneyInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="relative">
      <span aria-hidden className="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 text-base text-muted">₹</span>
      <Input inputMode="decimal" autoComplete="off" {...props} className="pl-9 tabular-nums" />
    </div>
  );
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center gap-4 rounded-m bg-surface px-5 py-3.5 text-left transition-colors hover:bg-surface-2 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-[3px] focus-visible:outline-accent-500"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold text-ink">{label}</span>
        {hint && <span className="mt-0.5 block text-[13px] font-medium text-muted">{hint}</span>}
      </span>
      <span
        aria-hidden
        className={clsx(
          "relative h-7 w-12 shrink-0 rounded-pill transition-colors duration-200",
          checked ? "bg-accent-500" : "bg-surface-2 shadow-[inset_0_0_0_1px_var(--line)]",
        )}
      >
        <span
          className={clsx(
            "absolute top-1 h-5 w-5 rounded-full bg-card shadow-flat transition-[left] duration-300",
            checked ? "left-6" : "left-1",
          )}
          style={{ transitionTimingFunction: "var(--spring)" }}
        />
      </span>
    </button>
  );
}

function FormActions({ onCancel, submitLabel, extra }: { onCancel: () => void; submitLabel: string; extra?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 pt-2">
      {extra}
      <div className="ml-auto flex flex-wrap items-center gap-3">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button variant="dark" type="submit">{submitLabel}</Button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------- investment */

export function HoldingForm({ initial, onDone }: { initial?: Holding; onDone: () => void }) {
  const id = useId();
  const { goals } = useWealthState();
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<HoldingKind>(initial?.kind ?? "equity_mf");
  const [invested, setInvested] = useState(numStr(initial?.invested));
  const [current, setCurrent] = useState(numStr(initial?.current));
  const [startDate, setStartDate] = useState(initial?.startDate ?? "");
  const [sip, setSip] = useState(numStr(initial?.sipMonthly));
  const [rate, setRate] = useState(numStr(initial?.rate));
  const [maturity, setMaturity] = useState(initial?.maturityDate ?? "");
  const [lockIn, setLockIn] = useState(initial?.lockInUntil ?? "");
  const [lockTouched, setLockTouched] = useState(!!initial?.lockInUntil);
  // null = the default for the type (liquid funds count, others don't).
  const [isEmergency, setIsEmergency] = useState<boolean | null>(initial ? !!initial.isEmergency : null);
  const [goalId, setGoalId] = useState(initial?.goalId ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Pre-fill the usual lock-in until the person types their own.
  const suggestedLock = useMemo(() => {
    const y = LOCK_YEARS[kind];
    return y && startDate ? addMonths(startDate, y * 12) : "";
  }, [kind, startDate]);
  const lockValue = lockTouched ? lockIn : suggestedLock;
  const emergencyOn = isEmergency ?? kind === "liquid_mf";

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const inv = invested.trim() === "" ? NaN : toNum(invested);
    const cur = current.trim() === "" ? inv : toNum(current);
    const sipN = sip.trim() === "" ? undefined : toNum(sip);
    const rateN = rate.trim() === "" ? undefined : toNum(rate);
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = "Give it a name you'll recognise.";
    if (!isFinite(inv) || inv < 0) errs.invested = "Enter the money you put in, in rupees.";
    if (current.trim() !== "" && (!isFinite(cur) || cur < 0)) errs.current = "Enter what it's worth today, in rupees.";
    if (!startDate) errs.startDate = "When did you start?";
    else if (startDate > todayISO()) errs.startDate = "The start date can't be in the future.";
    if (sipN != null && (!isFinite(sipN) || sipN < 0)) errs.sip = "Enter a monthly amount, or leave it empty.";
    if (rateN != null && (!isFinite(rateN) || rateN < 0 || rateN > 30)) errs.rate = "Enter a yearly rate, like 7.1.";
    setErrors(errs);
    if (Object.keys(errs).length) return;

    const asOf = todayISO();
    // Keep the detailed flows and history only while they still agree with the totals.
    const flows = initial?.flows && initial.invested === inv && initial.startDate === startDate ? initial.flows : undefined;
    let valueHistory = initial?.valueHistory;
    if (valueHistory?.length) {
      const m = monthKey(asOf);
      valueHistory = [...valueHistory.filter((v) => v.month !== m), { month: m, value: cur }].sort((a, b) => a.month.localeCompare(b.month));
    }

    wealth.saveHolding({
      id: initial?.id,
      name: name.trim(),
      kind,
      invested: inv,
      current: cur,
      asOf,
      startDate,
      sipMonthly: sipN || undefined,
      rate: HAS_RATE.includes(kind) ? rateN : undefined,
      maturityDate: HAS_MATURITY.includes(kind) && maturity ? maturity : undefined,
      lockInUntil: HAS_LOCK.includes(kind) && lockValue ? lockValue : undefined,
      isEmergency: CAN_BE_EMERGENCY.includes(kind) ? emergencyOn : undefined,
      goalId: goalId || undefined,
      flows,
      valueHistory,
      note: note.trim() || undefined,
    });
    onDone();
  }

  const showRate = HAS_RATE.includes(kind);
  const showMaturity = HAS_MATURITY.includes(kind);
  const showLock = HAS_LOCK.includes(kind);
  const showEmergency = CAN_BE_EMERGENCY.includes(kind);

  return (
    <form onSubmit={submit} noValidate className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Name" htmlFor={`${id}-name`} error={errors.name} className="sm:col-span-2">
          <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} placeholder="Parag Parikh Flexi Cap" autoFocus={!initial} />
        </Field>
        <Field label="Type" htmlFor={`${id}-kind`} className="sm:col-span-2">
          <Select id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value as HoldingKind)}>
            {KIND_ORDER.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </Select>
        </Field>
        <Field label="Money you put in" htmlFor={`${id}-inv`} error={errors.invested}>
          <MoneyInput id={`${id}-inv`} value={invested} onChange={(e) => setInvested(e.target.value)} placeholder="1,00,000" />
        </Field>
        <Field label="Worth today" htmlFor={`${id}-cur`} error={errors.current} hint={errors.current ? undefined : "Leave empty if it's the same."}>
          <MoneyInput id={`${id}-cur`} value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="1,12,400" />
        </Field>
        <Field label="Started on" htmlFor={`${id}-start`} error={errors.startDate}>
          <Input id={`${id}-start`} type="date" value={startDate} max={todayISO()} onChange={(e) => setStartDate(e.target.value)} />
        </Field>
        <Field label="Monthly SIP (optional)" htmlFor={`${id}-sip`} error={errors.sip}>
          <MoneyInput id={`${id}-sip`} value={sip} onChange={(e) => setSip(e.target.value)} placeholder="5,000" />
        </Field>

        {showRate && (
          <Field label="Interest rate, % a year" htmlFor={`${id}-rate`} error={errors.rate}>
            <Input id={`${id}-rate`} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder={kind === "epf" ? "8.25" : kind === "ppf" ? "7.1" : "7.0"} />
          </Field>
        )}
        {showMaturity && (
          <Field label="Matures on" htmlFor={`${id}-mat`}>
            <Input id={`${id}-mat`} type="date" value={maturity} onChange={(e) => setMaturity(e.target.value)} />
          </Field>
        )}
        {showLock && (
          <Field
            label="Locked until"
            htmlFor={`${id}-lock`}
            hint={kind === "elss" ? "3 years from each purchase." : kind === "ppf" ? "15 years from opening." : "Gold bonds can be redeemed from year 5."}
          >
            <Input
              id={`${id}-lock`}
              type="date"
              value={lockValue}
              onChange={(e) => { setLockTouched(true); setLockIn(e.target.value); }}
            />
          </Field>
        )}
      </div>

      {showEmergency && (
        <Toggle
          checked={emergencyOn}
          onChange={setIsEmergency}
          label="Counts as emergency money"
          hint="Money you could reach within a few days if something went wrong."
        />
      )}

      {goals.length > 0 && (
        <Field label="For a goal (optional)" htmlFor={`${id}-goal`}>
          <Select id={`${id}-goal`} value={goalId} onChange={(e) => setGoalId(e.target.value)}>
            <option value="">Not for a specific goal</option>
            {goals.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </Select>
        </Field>
      )}

      <Field label="Note (optional)" htmlFor={`${id}-note`}>
        <Input id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Bought for the 80C deduction" />
      </Field>

      <FormActions onCancel={onDone} submitLabel={initial ? "Save changes" : "Add investment"} />
    </form>
  );
}

/* -------------------------------------------------------- loan or card */

const LIAB_LABEL: Record<LiabilityKind, string> = {
  credit_card: "Credit card bill",
  loan: "Loan",
  emi: "EMI purchase",
};

export function LiabilityForm({ initial, onDone }: { initial?: Liability; onDone: () => void }) {
  const id = useId();
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<LiabilityKind>(initial?.kind ?? "loan");
  const [outstanding, setOutstanding] = useState(numStr(initial?.outstanding));
  const [emi, setEmi] = useState(numStr(initial?.emi));
  const [rate, setRate] = useState(numStr(initial?.rate));
  const [endDate, setEndDate] = useState(initial?.endDate ?? "");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const isCard = kind === "credit_card";

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const out = toNum(outstanding);
    const emiN = emi.trim() === "" ? undefined : toNum(emi);
    const rateN = rate.trim() === "" ? undefined : toNum(rate);
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = "Give it a name you'll recognise.";
    if (outstanding.trim() === "" || !isFinite(out) || out < 0) errs.outstanding = "Enter what you still owe, in rupees.";
    if (emiN != null && (!isFinite(emiN) || emiN < 0)) errs.emi = "Enter a monthly amount, or leave it empty.";
    if (rateN != null && (!isFinite(rateN) || rateN < 0 || rateN > 60)) errs.rate = "Enter a yearly rate, like 10.5.";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    wealth.saveLiability({
      id: initial?.id,
      name: name.trim(),
      kind,
      outstanding: out,
      emi: isCard ? undefined : emiN,
      rate: rateN,
      endDate: isCard ? undefined : endDate || undefined,
    });
    onDone();
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Name" htmlFor={`${id}-name`} error={errors.name} className="sm:col-span-2">
          <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} placeholder={isCard ? "HDFC credit card bill" : "Car loan"} autoFocus={!initial} />
        </Field>
        <Field label="Type" htmlFor={`${id}-kind`} className="sm:col-span-2">
          <Select id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value as LiabilityKind)}>
            {(Object.keys(LIAB_LABEL) as LiabilityKind[]).map((k) => <option key={k} value={k}>{LIAB_LABEL[k]}</option>)}
          </Select>
        </Field>
        <Field label={isCard ? "Bill amount" : "Still to pay"} htmlFor={`${id}-out`} error={errors.outstanding}>
          <MoneyInput id={`${id}-out`} value={outstanding} onChange={(e) => setOutstanding(e.target.value)} placeholder="14,820" />
        </Field>
        <Field
          label="Interest, % a year"
          htmlFor={`${id}-rate`}
          error={errors.rate}
          hint={errors.rate ? undefined : isCard ? "Leave at 0 if you pay the full bill each month." : "Optional."}
        >
          <Input id={`${id}-rate`} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder={isCard ? "0" : "9.5"} />
        </Field>
        {!isCard && (
          <>
            <Field label="EMI per month" htmlFor={`${id}-emi`} error={errors.emi}>
              <MoneyInput id={`${id}-emi`} value={emi} onChange={(e) => setEmi(e.target.value)} placeholder="3,332" />
            </Field>
            <Field label="Last EMI on (optional)" htmlFor={`${id}-end`}>
              <Input id={`${id}-end`} type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </Field>
          </>
        )}
      </div>

      {confirmRemove && initial ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-m bg-danger-tint px-5 py-4">
          <p className="min-w-0 flex-1 text-[15px] font-medium text-danger-text">Remove {initial.name}? This can't be undone.</p>
          <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(false)}>Keep it</Button>
          <Button variant="danger" size="sm" onClick={() => { wealth.removeLiability(initial.id); onDone(); }}>Remove</Button>
        </div>
      ) : (
        <FormActions
          onCancel={onDone}
          submitLabel={initial ? "Save changes" : `Add ${LIAB_LABEL[kind].toLowerCase()}`}
          extra={initial ? (
            <button type="button" onClick={() => setConfirmRemove(true)} className="text-sm font-semibold text-danger-text hover:underline">
              Remove
            </button>
          ) : undefined}
        />
      )}
    </form>
  );
}

/* --------------------------------------------------------------- income */

const INCOME_OPTIONS: { value: IncomeKind; label: string }[] = [
  { value: "dividend", label: "Dividend" },
  { value: "interest", label: "Interest" },
  { value: "realised_gain", label: "Gain from a sale" },
];

export function IncomeForm({ onDone }: { onDone: () => void }) {
  const id = useId();
  const { holdings } = useWealthState();
  const [kind, setKind] = useState<IncomeKind>("dividend");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayISO());
  const [source, setSource] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const amt = toNum(amount);
    const errs: Record<string, string> = {};
    if (amount.trim() === "" || !isFinite(amt) || amt <= 0) errs.amount = "Enter the amount that came in.";
    if (!date) errs.date = "When did it come in?";
    else if (date > todayISO()) errs.date = "The date can't be in the future.";
    if (!source.trim()) errs.source = "Where did it come from?";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    wealth.addIncome({ kind, amount: amt, date, source: source.trim() });
    onDone();
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-5">
      <div>
        <Label>What came in</Label>
        <Segmented options={INCOME_OPTIONS} value={kind} onChange={setKind} ariaLabel="Kind of income" />
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Amount" htmlFor={`${id}-amt`} error={errors.amount}>
          <MoneyInput id={`${id}-amt`} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="585" autoFocus />
        </Field>
        <Field label="Date" htmlFor={`${id}-date`} error={errors.date}>
          <Input id={`${id}-date`} type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="From" htmlFor={`${id}-src`} error={errors.source} className="sm:col-span-2">
          <Input
            id={`${id}-src`}
            list={`${id}-src-list`}
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder={kind === "interest" ? "SBI savings account" : "Infosys shares"}
          />
          <datalist id={`${id}-src-list`}>
            {holdings.map((h) => <option key={h.id} value={h.name} />)}
          </datalist>
        </Field>
      </div>
      <FormActions onCancel={onDone} submitLabel="Log income" />
    </form>
  );
}

/* ------------------------------------------------------ life events */

const EVENT_EMOJI = ["✈️", "🏖️", "🏡", "📱", "💻", "🛍️", "🏥", "🎁", "💍", "🚗", "🎓", "🎉", "💰", "📍"];

/** Name a moment on the net worth chart ("Goa trip"), or edit / remove one. */
export function EventForm({
  initial, onDone,
}: {
  initial: { id?: string; date: string; label?: string; emoji?: string; amount?: number };
  onDone: () => void;
}) {
  const id = useId();
  const [emoji, setEmoji] = useState(initial.emoji && initial.emoji !== "📉" ? initial.emoji : "📍");
  const [label, setLabel] = useState(initial.label?.startsWith("Markets down") ? "" : initial.label ?? "");
  const [dir, setDir] = useState<"out" | "in">((initial.amount ?? -1) >= 0 && initial.amount ? "in" : "out");
  const [amount, setAmount] = useState(initial.amount ? String(Math.abs(Math.round(initial.amount))) : "");
  const [date, setDate] = useState(initial.date);
  const [err, setErr] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!label.trim()) { setErr("Give it a short name, like Goa trip."); return; }
    const amt = toNum(amount);
    wealth.saveEvent({
      id: initial.id,
      date,
      label: label.trim(),
      emoji,
      amount: amount.trim() && isFinite(amt) ? (dir === "out" ? -Math.abs(amt) : Math.abs(amt)) : undefined,
    });
    onDone();
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-5">
      <div role="radiogroup" aria-label="Emoji" className="flex flex-wrap gap-1.5">
        {EVENT_EMOJI.map((e) => (
          <button
            key={e}
            type="button"
            role="radio"
            aria-checked={emoji === e}
            onClick={() => setEmoji(e)}
            className={clsx(
              "grid h-10 w-10 place-items-center rounded-s text-[20px] transition-colors",
              emoji === e ? "bg-accent-50 shadow-[0_0_0_2px_var(--accent-500)]" : "bg-surface hover:bg-surface-2",
            )}
          >
            {e}
          </button>
        ))}
      </div>
      <Field label="Name" htmlFor={`${id}-label`} error={err}>
        <Input id={`${id}-label`} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Goa trip" autoFocus maxLength={28} />
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Amount" htmlFor={`${id}-amt`}>
          <MoneyInput id={`${id}-amt`} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="17,500" />
          <Segmented<"out" | "in">
            className="mt-2"
            size="sm"
            ariaLabel="Money out or in"
            value={dir}
            onChange={setDir}
            options={[{ value: "out", label: "Went out" }, { value: "in", label: "Came in" }]}
          />
        </Field>
        <Field label="Date" htmlFor={`${id}-date`}>
          <Input id={`${id}-date`} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
      <FormActions
        onCancel={onDone}
        submitLabel="Save"
        extra={initial.id ? (
          <button
            type="button"
            onClick={() => { wealth.removeEvent(initial.id!); onDone(); }}
            className="text-sm font-semibold text-danger-text hover:underline"
          >
            Remove
          </button>
        ) : undefined}
      />
    </form>
  );
}

/* --------------------------------------------------------- the card */

type Tab = "investment" | "liability" | "income";

/** Compact card with one form per tab. Used on the Upload page. */
export default function ManualEntry() {
  const [tab, setTab] = useState<Tab>("investment");
  const [saved, setSaved] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // onDone fires on save and on cancel. A save writes to the store first,
  // which fires the store's change event, so remember whether that happened.
  const changed = useRef(false);
  useEffect(() => {
    const on = () => { changed.current = true; };
    window.addEventListener("fh-wealth-change", on);
    return () => window.removeEventListener("fh-wealth-change", on);
  }, []);

  const done = (what: string) => () => {
    setSaved(changed.current ? what : null);
    changed.current = false;
    setNonce((n) => n + 1); // fresh, empty form
  };

  return (
    <Card>
      <CardTitle subtitle="For what statements can't see: funds, deposits, EPF, loans and dividends.">
        Add by hand
      </CardTitle>
      <div className="mt-5">
        <Segmented
          options={[
            { value: "investment", label: "Investment" },
            { value: "liability", label: "Loan or card" },
            { value: "income", label: "Income" },
          ]}
          value={tab}
          onChange={(t) => { setTab(t); setSaved(null); }}
          ariaLabel="What to add"
        />
      </div>
      {saved && (
        <p role="status" className="mt-4 rounded-m bg-success-tint px-5 py-3 text-[15px] font-medium text-success-text">
          {saved} saved. It shows up on the Wealth page now.
        </p>
      )}
      <div className="mt-5" key={`${tab}-${nonce}`}>
        {tab === "investment" && <HoldingForm onDone={done("Investment")} />}
        {tab === "liability" && <LiabilityForm onDone={done("Loan or card")} />}
        {tab === "income" && <IncomeForm onDone={done("Income")} />}
      </div>
    </Card>
  );
}
