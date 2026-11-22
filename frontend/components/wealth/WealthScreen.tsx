"use client";

/*
 * Wealth, in the order people check it:
 *   1. Am I richer?         the number, chips for invested / bank / owed,
 *                           then net worth over time with pins both ways.
 *   2. Is my money working? one Investments card: worth vs put in,
 *                           returns vs FD and Nifty, passive income.
 *   3. Am I safe?           equity mix, emergency fund, the gaps.
 *   4. What can I touch?    liquid vs locked, every holding.
 */

import { Plus } from "lucide-react";
import clsx from "clsx";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { MotionReveal } from "@/components/motion/MotionReveal";
import { NumberTicker } from "@/components/motion/NumberTicker";
import { Button, Card, ErrorCard, IllustrationSlot, Modal, Skeleton } from "@/components/ui";
import { useWealth, type Liability } from "@/lib/wealth";

import AllocationCard from "./AllocationCard";
import { dayMon, shortInr } from "./chartKit";
import EmergencyCard from "./EmergencyCard";
import HealthCheckCard from "./HealthCheckCard";
import HoldingsCard from "./HoldingsCard";
import InvestmentsCard from "./InvestmentsCard";
import LiquidityCard from "./LiquidityCard";
import { HoldingForm, IncomeForm, LiabilityForm } from "./ManualEntry";
import { longTermMix, mixCheck } from "./mix";
import NetWorthDayCard from "./NetWorthDayCard";
import OwedChip from "./OwedChip";
import { rupees, rupeesTicker } from "./words";

type Dialog =
  | { kind: "holding" }
  | { kind: "liability"; initial?: Liability }
  | { kind: "income" }
  | null;

const H1 = "text-[40px] font-black leading-none tracking-[-0.01em] text-ink tabular-nums md:text-[56px]";

function Section({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <section aria-label={q} className="space-y-4">
      <h2 className="eyebrow text-muted">{q}</h2>
      {children}
    </section>
  );
}

function Money({ n }: { n: number }) {
  const t = rupeesTicker(n);
  return <NumberTicker value={t.value} prefix={t.prefix} suffix={t.suffix} decimalPlaces={t.decimals} className="whitespace-nowrap" />;
}

function LoadingPage() {
  return (
    <div className="space-y-10" aria-busy="true" aria-label="Loading your wealth">
      <div>
        <Skeleton className="h-14 w-full max-w-[720px]" />
        <Skeleton className="mt-4 h-5 w-full max-w-[460px]" />
      </div>
      <div className="dashboard-grid">
        <div className="rounded-l bg-card p-6 shadow-flat min-[900px]:col-span-8">
          <Skeleton className="h-5 w-56" />
          <Skeleton className="mt-6 h-[280px] w-full" />
        </div>
        <div className="rounded-l bg-card p-6 shadow-flat min-[900px]:col-span-4">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="mt-6 h-3 w-full" />
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="mt-4 h-4 w-full" />)}
        </div>
      </div>
      <div className="rounded-l bg-card p-6 shadow-flat">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="mt-6 h-24 w-full" />
      </div>
    </div>
  );
}

export default function WealthScreen() {
  const w = useWealth();
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = () => setDialog(null);
  const holdingsList = w.state.holdings;
  const ltMix = useMemo(() => longTermMix(holdingsList), [holdingsList]);

  if (w.error) {
    return (
      <div className="space-y-8">
        <h1 className={H1}>Your net worth</h1>
        <ErrorCard
          title="Your bank balances didn't load"
          message="Net worth starts from the cash in your statements, and the Finance Hub server didn't answer. Check it's running, then try again. Your investments are safe in this browser."
          onRetry={w.retry}
        />
      </div>
    );
  }

  if (w.isLoading) return <LoadingPage />;

  const { totals: t, hasHoldings, cash, state, daily, liabilities } = w;
  const hasAnything = hasHoldings || cash > 0 || liabilities.length > 0;
  const first = daily[0];
  const change = first ? t.netWorth - first.netWorth : null;
  const up = (change ?? 0) >= 0;
  const big = hasHoldings || liabilities.length ? t.netWorth : cash;
  const checks = (hasHoldings ? w.checks : w.checks.map((c) =>
    // Without holdings we can't judge the mix or SIPs; don't call them failures.
    c.key === "mix" || c.key === "invest"
      ? { ...c, ok: null, detail: c.key === "mix" ? "Add your investments to check this." : "Add your investments and their SIPs to check this." }
      : c)).map((c) => mixCheck(c, ltMix, w.mix.targetPct));

  const addButton = (
    <Button variant="primary" onClick={() => setDialog({ kind: "holding" })}>
      <Plus className="h-4 w-4" strokeWidth={2} aria-hidden />Add investment
    </Button>
  );
  const chips = [
    hasHoldings && { e: "📈", label: "invested", v: t.investments },
    { e: "🏦", label: "bank", v: cash },
  ].filter(Boolean) as { e: string; label: string; v: number }[];

  return (
    <div className="space-y-10">
      <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5">
        <div className="min-w-0">
          <MotionReveal>
            <p className="eyebrow mb-3 text-muted">{hasHoldings ? "Net worth" : "In the bank"}</p>
            <h1 className={H1}><Money n={big} /></h1>
          </MotionReveal>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm font-semibold">
            {change != null && Math.abs(change) >= 1000 && first && (
              <span className={clsx("inline-flex items-center gap-0.5 tabular-nums", up ? "text-success-text" : "text-danger-text")}>
                {up ? <ArrowUpRight className="h-4 w-4" strokeWidth={2} aria-hidden /> : <ArrowDownRight className="h-4 w-4" strokeWidth={2} aria-hidden />}
                {rupees(Math.abs(change))}
                <span className="ml-1 font-medium text-muted">since {dayMon(first.date)}</span>
              </span>
            )}
            {chips.map((c) => (
              <span key={c.label} className="rounded-pill bg-card px-2.5 py-1 font-medium text-ink-2 shadow-flat">
                <span aria-hidden>{c.e}</span> <span className="tabular-nums font-semibold text-ink">{shortInr(c.v)}</span> {c.label}
              </span>
            ))}
            <OwedChip
              liabilities={liabilities}
              onAdd={() => setDialog({ kind: "liability" })}
              onEdit={(l) => setDialog({ kind: "liability", initial: l })}
            />
            {!hasHoldings && w.passive.total > 0 && (
              <span className="rounded-pill bg-card px-2.5 py-1 font-medium text-ink-2 shadow-flat" title="Interest, coupons and dividends in the last 12 months">
                <span aria-hidden>💸</span> <span className="tabular-nums font-semibold text-ink">{shortInr(w.passive.total)}</span> paid to you
              </span>
            )}
          </div>
        </div>
        {hasHoldings && addButton}
      </header>

      {hasAnything && daily.length > 1 && (
        <MotionReveal>
          <NetWorthDayCard daily={daily} markers={w.markers} events={state.events} hasHoldings={hasHoldings} />
        </MotionReveal>
      )}

      {!hasHoldings && (
        <MotionReveal>
          <Card className="flex flex-col items-center gap-6 px-6 py-10 text-center md:flex-row md:px-10 md:text-left">
            <IllustrationSlot label="piggy bank with a sprout" size={112} />
            <div className="min-w-0 flex-1">
              <p className="text-h3 font-black text-ink">Add your first investment</p>
              <p className="mt-2 max-w-[56ch] text-base text-muted">📈 Funds, 🔒 FDs, 🏛️ PPF, 👔 EPF, 📊 stocks, 🪙 gold. Stays in this browser.</p>
              <div className="mt-5 flex flex-wrap items-center justify-center gap-3 md:justify-start">
                {addButton}
                {cash <= 0 && <Link href="/upload" className="btn ghost sm">Upload statements</Link>}
              </div>
            </div>
          </Card>
        </MotionReveal>
      )}

      {hasHoldings && (
        <Section q="Investments">
          <MotionReveal>
            <InvestmentsCard
              daily={daily}
              holdings={state.holdings}
              xirrPct={w.xirrPct}
              passive={w.passive}
              onLogIncome={() => setDialog({ kind: "income" })}
            />
          </MotionReveal>
        </Section>
      )}

      <Section q="Am I safe?">
        <div className="dashboard-grid">
          {hasHoldings && (
            <MotionReveal index={0} className="min-[900px]:col-span-4">
              <AllocationCard mix={ltMix} targetPct={w.mix.targetPct} />
            </MotionReveal>
          )}
          <MotionReveal index={1} className={hasHoldings ? "min-[900px]:col-span-4" : "min-[900px]:col-span-6"}>
            <EmergencyCard
              em={w.emergency}
              targetMonths={state.profile.emergencyMonthsTarget}
              monthlyExpenses={w.monthlyExpenses}
              holdings={state.holdings}
            />
          </MotionReveal>
          <MotionReveal index={2} className={hasHoldings ? "min-[900px]:col-span-4" : "min-[900px]:col-span-6"}>
            <HealthCheckCard checks={checks} />
          </MotionReveal>
        </div>
      </Section>

      {hasHoldings && <Section q="What can I touch?">
        {hasHoldings && (
          <MotionReveal>
            <LiquidityCard cash={cash} holdings={state.holdings} asOf={w.asOf} profile={state.profile} />
          </MotionReveal>
        )}
        {hasHoldings && (
          <MotionReveal>
            <HoldingsCard holdings={state.holdings} goals={state.goals} asOf={w.asOf} />
          </MotionReveal>
        )}
      </Section>}

      <Modal open={dialog?.kind === "holding"} onClose={close} title="Add an investment" width="max-w-[560px]">
        {dialog?.kind === "holding" && <HoldingForm onDone={close} />}
      </Modal>
      <Modal
        open={dialog?.kind === "liability"}
        onClose={close}
        title={dialog?.kind === "liability" && dialog.initial ? `Edit ${dialog.initial.name}` : "Add a loan"}
        width="max-w-[560px]"
      >
        {dialog?.kind === "liability" && <LiabilityForm initial={dialog.initial} onDone={close} />}
      </Modal>
      <Modal open={dialog?.kind === "income"} onClose={close} title="Log passive income">
        {dialog?.kind === "income" && <IncomeForm onDone={close} />}
      </Modal>
    </div>
  );
}

