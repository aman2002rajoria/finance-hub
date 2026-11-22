"use client";

/*
 * Ledger table (design.md §7 Table): 13/600 muted header, 48px rows,
 * hairline dividers, surface hover, right-aligned tabular amounts. Below
 * 640px each row becomes a stacked card. Rows are focusable when they can
 * be opened, so J/K + Enter work (see useJkFocus).
 */

import clsx from "clsx";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import React from "react";

import type { TxnType } from "@/lib/types";

import { dayMonth } from "./format";
import { Amount } from "./primitives";

export interface LedgerRow {
  id: string;
  date: string | null;
  description: string;
  amount: number;
  type: TxnType;
}

export interface TxnColumn<T> {
  key: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  align?: "left" | "right";
  className?: string;
  headClassName?: string;
  /** When set, the header becomes a sort button. */
  onSort?: () => void;
  /** null = sortable but not active. */
  sortDir?: "asc" | "desc" | null;
}

export function SortHeader({
  label, dir, onClick, align,
}: {
  label: React.ReactNode;
  dir: "asc" | "desc" | null | undefined;
  onClick: () => void;
  align?: "left" | "right";
}) {
  const Icon = dir === "asc" ? ArrowUp : dir === "desc" ? ArrowDown : ArrowUpDown;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : undefined}
      className={clsx(
        "inline-flex items-center gap-1 rounded-pill font-semibold transition-colors hover:text-ink",
        dir && "text-ink",
        align === "right" && "flex-row-reverse",
      )}
    >
      {label}
      <Icon className={clsx("h-3.5 w-3.5", !dir && "opacity-40")} strokeWidth={1.75} aria-hidden />
    </button>
  );
}

export function TxnTable<T extends LedgerRow>({
  rows,
  columns,
  onRowOpen,
  mobileCard,
  rowClassName,
  maxHeight,
  label,
}: {
  rows: T[];
  columns: TxnColumn<T>[];
  onRowOpen?: (row: T) => void;
  /** Custom stacked card for < 640px; defaults to date, description, amount. */
  mobileCard?: (row: T) => React.ReactNode;
  rowClassName?: (row: T) => string | undefined;
  maxHeight?: string;
  label?: string;
}) {
  function openFromEvent(e: React.MouseEvent | React.KeyboardEvent, row: T) {
    if (!onRowOpen) return;
    const el = e.target as HTMLElement;
    if (el.closest("button,select,input,label,a,textarea")) return;
    onRowOpen(row);
  }

  return (
    <>
      {/* Desktop and tablet: the table. */}
      <div className={clsx("hidden overflow-auto sm:block", maxHeight)}>
        <table className="min-w-full text-[15px]" aria-label={label}>
          <thead className="sticky top-0 z-10 bg-card text-[13px] font-semibold text-muted shadow-[inset_0_-1px_0_var(--line)]">
            <tr>
              {columns.map(c => (
                <th
                  key={c.key}
                  scope="col"
                  className={clsx(
                    "h-11 whitespace-nowrap px-4 font-semibold",
                    c.align === "right" ? "text-right" : "text-left",
                    c.headClassName,
                  )}
                >
                  {c.onSort ? (
                    <SortHeader label={c.header} dir={c.sortDir} onClick={c.onSort} align={c.align} />
                  ) : c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr
                key={row.id}
                data-ledger-row
                tabIndex={onRowOpen ? 0 : undefined}
                onClick={onRowOpen ? e => openFromEvent(e, row) : undefined}
                onKeyDown={onRowOpen ? e => { if (e.key === "Enter") openFromEvent(e, row); } : undefined}
                className={clsx(
                  "row-hover h-12 border-b border-line transition-colors duration-150 last:border-b-0 focus-visible:bg-surface focus-visible:outline-offset-[-3px]",
                  onRowOpen && "cursor-pointer",
                  rowClassName?.(row),
                )}
              >
                {columns.map(c => (
                  <td
                    key={c.key}
                    className={clsx(
                      "px-4 py-2 align-middle text-ink",
                      c.align === "right" && "text-right tabular-nums",
                      c.className,
                    )}
                  >
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Phones: stacked cards in the same order. */}
      <ul className={clsx("space-y-2 p-2 sm:hidden", maxHeight && "overflow-auto", maxHeight)} aria-label={label}>
        {rows.map(row => (
          <li key={row.id}>
            <div
              data-ledger-row
              role={onRowOpen ? "button" : undefined}
              tabIndex={onRowOpen ? 0 : undefined}
              onClick={onRowOpen ? e => openFromEvent(e, row) : undefined}
              onKeyDown={onRowOpen ? e => { if (e.key === "Enter") openFromEvent(e, row); } : undefined}
              className={clsx("rounded-m p-4 transition-colors", onRowOpen && "cursor-pointer active:bg-surface")}
            >
              {mobileCard ? mobileCard(row) : <DefaultMobileCard row={row} />}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function DefaultMobileCard({ row }: { row: LedgerRow }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-[13px] font-semibold text-muted">{dayMonth(row.date)}</p>
        <p className="mt-0.5 line-clamp-2 break-words text-[15px] font-semibold text-ink">{row.description}</p>
      </div>
      <Amount amount={row.amount} type={row.type} className="text-[15px]" />
    </div>
  );
}
