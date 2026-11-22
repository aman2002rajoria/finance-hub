"use client";

/*
 * Ledger as a list (design.md §7 List item): one row per transaction with a
 * merchant avatar, the name, one quiet line saying how it's counted, and the
 * amount. Rows are grouped under a quiet day header with that day's spend.
 * Hovering a row swaps the quiet line for the bank's own description, so the
 * raw text is there when you want it and out of the way when you don't.
 */

import clsx from "clsx";
import React, { useMemo } from "react";

import { inr } from "@/lib/format";
import type { Transaction } from "@/lib/types";

import { categoryPath, dayMonth } from "./format";
import { initial, txnName } from "./merchant";
import { Amount, needsTag } from "./primitives";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type Row = Pick<
  Transaction,
  | "id" | "date" | "description" | "amount" | "type" | "merchant_name" | "category" | "subcategory"
  | "is_internal_transfer" | "is_credit_card_payment" | "is_emi" | "is_refund"
>;

/** True when a row is left out of spend and income (card bills, own transfers). */
export function isExcluded(t: Pick<Row, "is_internal_transfer" | "is_credit_card_payment">) {
  return t.is_internal_transfer || t.is_credit_card_payment;
}

function weekday(iso: string | null | undefined) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!m) return "";
  return WEEKDAYS[new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay()];
}

/** The one quiet line under the name: how this row is counted. */
export function countedAs(t: Row): React.ReactNode {
  if (t.is_credit_card_payment) return "Card bill, already counted as purchases";
  if (t.is_internal_transfer) return "Between your accounts, not counted";
  if (needsTag(t)) return <span className="font-semibold text-warning-text">Needs a tag</span>;
  const path = categoryPath(t.category, t.subcategory);
  const extra = [t.is_emi && "EMI", t.is_refund && "Refund"].filter(Boolean).join(" · ");
  return extra ? `${path} · ${extra}` : path;
}

export function MerchantAvatar({ name, warn, className }: { name: string; warn?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={clsx(
        "grid h-10 w-10 shrink-0 place-items-center rounded-full text-[15px] font-extrabold",
        warn ? "bg-warning-tint text-warning-text" : "bg-surface-2 text-ink-2",
        className,
      )}
    >
      {initial(name)}
    </span>
  );
}

export function TxnRow<T extends Row>({
  t, onOpen, selected, showDate,
}: {
  t: T;
  onOpen?: (t: T) => void;
  selected?: boolean;
  /** Put the date in the quiet line (when rows aren't grouped by day). */
  showDate?: boolean;
}) {
  const name = txnName(t);
  const excluded = isExcluded(t);
  const quiet = countedAs(t);
  return (
    <div
      data-ledger-row
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      aria-label={onOpen ? `${name}, ${dayMonth(t.date)}, open details` : undefined}
      onClick={onOpen ? () => onOpen(t) : undefined}
      onKeyDown={onOpen ? e => { if (e.key === "Enter") onOpen(t); } : undefined}
      className={clsx(
        "group flex items-center gap-3 rounded-m px-3 py-2.5 transition-colors duration-150 focus-visible:bg-surface",
        onOpen && "cursor-pointer hover:bg-surface",
        selected && "bg-surface",
      )}
    >
      <MerchantAvatar name={name} warn={needsTag(t)} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-semibold leading-snug text-ink">{name}</p>
        <p className="truncate text-[13px] font-medium leading-snug text-muted">
          <span className="group-hover:hidden group-focus-visible:hidden">
            {showDate && <>{dayMonth(t.date)} · </>}{quiet}
          </span>
          <span className="hidden font-mono text-[12px] group-hover:inline group-focus-visible:inline">
            {t.description}
          </span>
        </p>
      </div>
      <Amount
        amount={t.amount}
        type={t.type}
        className={clsx("text-[15px]", excluded && "!text-muted !font-medium")}
      />
    </div>
  );
}

interface Day<T> { key: string; date: string; rows: T[]; spent: number }

function groupByDay<T extends Row>(rows: T[]): Day<T>[] {
  const out: Day<T>[] = [];
  for (const r of rows) {
    const key = (r.date ?? "").slice(0, 10);
    let d = out[out.length - 1];
    if (!d || d.key !== key) { d = { key, date: r.date, rows: [], spent: 0 }; out.push(d); }
    d.rows.push(r);
    if (r.type === "debit" && !isExcluded(r)) d.spent += Math.abs(r.amount);
  }
  return out;
}

export function TxnList<T extends Row>({
  rows, onOpen, selectedId, groupByDate = true, label,
}: {
  rows: T[];
  onOpen?: (t: T) => void;
  selectedId?: string | null;
  /** Group under day headers. Turn off when the list isn't sorted by date. */
  groupByDate?: boolean;
  label?: string;
}) {
  const days = useMemo(() => (groupByDate ? groupByDay(rows) : []), [rows, groupByDate]);

  if (!groupByDate) {
    return (
      <div className="p-2" role="list" aria-label={label}>
        {rows.map(t => (
          <div role="listitem" key={t.id}>
            <TxnRow t={t} onOpen={onOpen} selected={t.id === selectedId} showDate />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="p-2" aria-label={label}>
      {days.map((d, i) => (
        <section key={d.key || i} aria-label={dayMonth(d.date)} className={clsx(i > 0 && "mt-2")}>
          <header className="flex items-baseline justify-between gap-3 px-3 pb-1 pt-3">
            <h3 className="text-[13px] font-semibold text-ink-2">
              {dayMonth(d.date)} <span className="font-medium text-muted">{weekday(d.date)}</span>
            </h3>
            {d.spent > 0 && (
              <p className="text-[13px] font-medium tabular-nums text-muted">{inr(d.spent)} spent</p>
            )}
          </header>
          <div role="list">
            {d.rows.map(t => (
              <div role="listitem" key={t.id}>
                <TxnRow t={t} onOpen={onOpen} selected={t.id === selectedId} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function TxnListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading" className="p-2">
      <div className="skeleton mx-3 mb-3 mt-3 h-3 w-24" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-2.5">
          <div className="skeleton h-10 w-10 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1">
            <div className="skeleton h-3.5 w-40" />
            <div className="skeleton mt-2 h-3 w-28" />
          </div>
          <div className="skeleton h-3.5 w-14" />
        </div>
      ))}
    </div>
  );
}
