"use client";

/*
 * Every holding, grouped (mutual funds, bonds and deposits, retirement,
 * stocks and gold). Each row: name, type, value, gain and yearly return,
 * plus one quiet line saying when the money can come out. A row opens the
 * detail modal with Edit and Remove.
 */

import clsx from "clsx";
import { ChevronRight } from "lucide-react";
import { useState } from "react";

import { Button, Card, CardTitle, Chip, Modal } from "@/components/ui";
import { CHART_OTHER, CHART_SERIES } from "@/lib/chart-theme";
import { inr } from "@/lib/format";
import {
  GROUP_LABEL, GROUP_OF, KIND_EMOJI, KIND_LABEL, holdingFlows, holdingXirr, redeemInfo, wealth,
  type Goal, type Holding,
} from "@/lib/wealth";

import { HoldingForm } from "./ManualEntry";
import { dayMonYear, pctText, plural, redeemLine, signedPct } from "./words";

/** One colour per group. */
const GROUP_COLOR: Record<keyof typeof GROUP_LABEL, string> = {
  mutual_funds: CHART_SERIES[0],
  fixed_income: CHART_SERIES[4],
  retirement: CHART_SERIES[6],
  market: CHART_SERIES[5],
  other: CHART_OTHER,
};
const GROUP_ORDER: (keyof typeof GROUP_LABEL)[] = ["mutual_funds", "fixed_income", "retirement", "market", "other"];

function returnText(h: Holding): { value: string; label: string } {
  const x = holdingXirr(h);
  if (x != null) return { value: pctText(x), label: h.kind === "bonds" ? "coupon a year" : "a year" };
  if (h.rate != null) return { value: pctText(h.rate), label: "rate a year" };
  return { value: "New", label: "too new to annualise" };
}

function gainPct(h: Holding) {
  return h.invested > 0 ? ((h.current - h.invested) / h.invested) * 100 : 0;
}

/* ------------------------------------------------------------ detail */

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[13px] font-semibold text-muted">{label}</dt>
      <dd className="mt-1 text-[15px] font-semibold tabular-nums text-ink">{children}</dd>
    </div>
  );
}

function HoldingDetail({
  h, goals, asOf, onEdit, onClose,
}: {
  h: Holding; goals: Goal[]; asOf: string; onEdit: () => void; onClose: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const r = redeemInfo(h, asOf);
  const ret = returnText(h);
  const g = h.current - h.invested;
  const goal = goals.find((x) => x.id === h.goalId);
  const flows = holdingFlows(h);
  const lockedUntil = h.lockInUntil && h.lockInUntil > asOf ? h.lockInUntil : null;

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Chip size="sm">{KIND_LABEL[h.kind]}</Chip>
          {h.isEmergency && <Chip size="sm" tone="accent">Emergency money</Chip>}
        </div>
        <p className="mt-4 text-[32px] font-black leading-none tabular-nums text-ink">{inr(h.current)}</p>
        <p className={clsx("mt-2 text-[15px] font-semibold tabular-nums", g >= 0 ? "text-success-text" : "text-danger-text")}>
          {g >= 0 ? "+" : "−"}{inr(Math.abs(g))} ({signedPct(gainPct(h))}) on {inr(h.invested)} put in
        </p>
        <p className="mt-1 text-sm font-medium text-muted">Value as of {dayMonYear(h.asOf)}</p>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-m bg-surface p-5">
        <Fact label="Return">{ret.value} <span className="font-medium text-muted">{ret.label}</span></Fact>
        <Fact label="Started">{dayMonYear(h.startDate)}</Fact>
        <Fact label="Money in">{plural(flows.filter((f) => f.amount > 0).length, "payment")}{flows.some((f) => f.amount < 0) ? `, ${plural(flows.filter((f) => f.amount < 0).length, "withdrawal")}` : ""}</Fact>
        <Fact label="Monthly SIP">{h.sipMonthly ? inr(h.sipMonthly) : "None"}</Fact>
        {h.maturityDate && <Fact label="Matures">{dayMonYear(h.maturityDate)}</Fact>}
        {lockedUntil && <Fact label="Locked until">{dayMonYear(lockedUntil)}</Fact>}
        <Fact label="For goal">{goal ? goal.name : "Not linked"}</Fact>
      </dl>

      <div className="space-y-4">
        {r.note && (
          <div>
            <p className="text-sm font-semibold text-muted">Can I take it out?</p>
            <p className="mt-1 text-base text-ink-2">{r.note}</p>
          </div>
        )}
        {r.tax && (
          <div>
            <p className="text-sm font-semibold text-muted">Tax</p>
            <p className="mt-1 text-base text-ink-2">{r.tax}</p>
          </div>
        )}
        {h.note && (
          <div>
            <p className="text-sm font-semibold text-muted">Your note</p>
            <p className="mt-1 text-base text-ink-2">{h.note}</p>
          </div>
        )}
      </div>

      {confirm ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-m bg-danger-tint px-5 py-4">
          <p className="min-w-0 flex-1 text-[15px] font-medium text-danger-text">Remove {h.name}? This can't be undone.</p>
          <Button variant="ghost" size="sm" onClick={() => setConfirm(false)}>Keep it</Button>
          <Button variant="danger" size="sm" onClick={() => { wealth.removeHolding(h.id); onClose(); }}>Remove</Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <button type="button" onClick={() => setConfirm(true)} className="text-sm font-semibold text-danger-text hover:underline">
            Remove
          </button>
          <Button variant="dark" className="ml-auto" onClick={onEdit}>Edit</Button>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- list */

function Row({ h, asOf, onOpen }: { h: Holding; asOf: string; onOpen: () => void }) {
  const r = redeemInfo(h, asOf);
  const ret = returnText(h);
  const gp = gainPct(h);
  const lock = !r.now || h.kind === "fd" ? redeemLine(h, r, asOf) : null;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="group -mx-3 flex w-[calc(100%+24px)] items-center gap-3 rounded-m px-3 py-2.5 text-left transition-colors hover:bg-surface focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-0 focus-visible:outline-accent-500"
      >
        <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface text-[17px]">{KIND_EMOJI[h.kind]}</span>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-[15px] font-extrabold leading-snug text-ink sm:truncate">{h.name}</p>
          {lock && <p className="truncate text-[13px] font-medium text-muted">🔒 {lock}</p>}
          <span className="sr-only">{KIND_LABEL[h.kind]}</span>
        </div>
        <div className="hidden w-[72px] shrink-0 text-right sm:block" title={ret.label}>
          <p className="text-[14px] font-semibold tabular-nums text-ink-2">{ret.value}</p>
          <p className="text-[12px] font-medium text-muted">{ret.value === "New" ? "" : "a year"}</p>
        </div>
        <div className="min-w-[96px] shrink-0 whitespace-nowrap text-right sm:w-[104px]">
          <p className="text-[15px] font-extrabold tabular-nums text-ink">{inr(h.current)}</p>
          <p className={clsx("text-[12px] font-semibold tabular-nums", gp >= 0.05 ? "text-success-text" : gp <= -0.05 ? "text-danger-text" : "text-muted")}>
            {signedPct(gp)}
            <span className="font-medium text-muted sm:hidden"> · {ret.value}{ret.value !== "New" ? "/yr" : ""}</span>
          </p>
        </div>
        <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5" strokeWidth={1.75} />
      </button>
    </li>
  );
}

export default function HoldingsCard({ holdings, goals, asOf }: { holdings: Holding[]; goals: Goal[]; asOf: string }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const open = holdings.find((h) => h.id === openId) ?? null;
  const total = holdings.reduce((s, h) => s + h.current, 0);

  const groups = GROUP_ORDER
    .map((key) => {
      const items = holdings.filter((h) => GROUP_OF[h.kind] === key).sort((a, b) => b.current - a.current);
      return { key, items, value: items.reduce((s, h) => s + h.current, 0) };
    })
    .filter((g) => g.items.length);

  const close = () => { setOpenId(null); setEditing(false); };

  return (
    <Card>
      <CardTitle>{plural(holdings.length, "holding")}, {inr(total)}</CardTitle>

      <div className="mt-5 space-y-5">
        {groups.map((g) => (
          <section key={g.key} aria-label={GROUP_LABEL[g.key]}>
            <div className="flex items-baseline gap-3 border-b border-line pb-2">
              <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: GROUP_COLOR[g.key] }} />
              <h4 className="min-w-0 flex-1 truncate text-[15px] font-black text-ink">{GROUP_LABEL[g.key]}</h4>
              <span className="hidden text-sm font-medium tabular-nums text-muted sm:inline">{pctText(total > 0 ? (g.value / total) * 100 : 0, 0)}</span>
              <span className="shrink-0 text-right text-[15px] font-extrabold tabular-nums text-ink sm:w-[104px]">{inr(g.value)}</span>
              <span className="w-4" aria-hidden />
            </div>
            <ul className="mt-1">
              {g.items.map((h) => <Row key={h.id} h={h} asOf={asOf} onOpen={() => setOpenId(h.id)} />)}
            </ul>
          </section>
        ))}
      </div>

      <Modal open={!!open} onClose={close} title={open ? (editing ? `Edit ${open.name}` : open.name) : ""} width="max-w-[560px]">
        {open && (editing ? (
          <HoldingForm initial={open} onDone={() => setEditing(false)} />
        ) : (
          <HoldingDetail h={open} goals={goals} asOf={asOf} onEdit={() => setEditing(true)} onClose={close} />
        ))}
      </Modal>
    </Card>
  );
}

